/**
 * Conector WhatsApp via Baileys (WhatsApp Web multi-device, não oficial).
 *
 * Liga o SEU número por QR Code, sem conta Meta e sem custo por mensagem.
 *
 * IMPORTANTE — com quem você conversa:
 *   O Baileys loga como se fosse o WhatsApp Web do seu número. O bot É o seu número.
 *   Então, por padrão, você conversa com você mesmo: no WhatsApp, abra a conversa
 *   "Você" (busque seu próprio nome) e mande "gastei 20 no mercado".
 *   O FinZap lê a sua própria mensagem e responde ali mesmo.
 *
 *   Alternativa: defina BAILEYS_OWNER_JID=5511999998888 e o bot só responde
 *   mensagens vindas desse número (útil se você ligar um chip secundário).
 *
 * AVISO: o WhatsApp não permite clientes não oficiais. Existe risco real de banimento
 * do número. Use um número que você pode perder, ou prefira a Cloud API em produção.
 */

import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  downloadContentFromMessage,
  jidNormalizedUser,
} from '@whiskeysockets/baileys';
import QRCode from 'qrcode';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseTransaction, montarResposta, resumirMes, formatarBRL } from './parseTransaction.js';
import { transcreverAudio, lerRecibo } from './ai.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PASTA_AUTH = process.env.BAILEYS_AUTH || path.join(__dirname, '..', '.baileys-auth');

/** Estado exposto para a página /parear */
export const pareamento = {
  status: 'parado',      // parado | iniciando | qr | conectando | conectado | desconectado | erro
  qr: null,              // data URL do QR, quando status === 'qr'
  qrGeradoEm: null,
  usuario: null,         // { nome, jid, numero }
  erro: null,
  atualizadoEm: new Date().toISOString(),
  modoChat: process.env.BAILEYS_OWNER_JID ? 'contato' : 'consigo-mesmo',
};

let sock = null;
let pronto = false;

/**
 * Converte número ou JID em JID normalizado.
 * jidNormalizedUser devolve "" para entrada sem sufixo, então completamos antes.
 */
export function paraJid(entrada) {
  if (!entrada) return '';
  const s = String(entrada).trim();
  const comSufixo = s.includes('@') ? s : `${s.replace(/\D/g, '')}@s.whatsapp.net`;
  return jidNormalizedUser(comSufixo) || comSufixo;
}

/** ids de mensagens que o próprio bot enviou — para não processar o eco */
const enviadasPeloBot = new Set();

function setEstado(patch) {
  Object.assign(pareamento, patch, { atualizadoEm: new Date().toISOString() });
}

async function streamParaBuffer(stream) {
  const partes = [];
  for await (const parte of stream) partes.push(parte);
  return Buffer.concat(partes);
}

/* ------------------------------------------------------------------ */
/* Normalização: mensagem do Baileys -> formato comum                  */
/* ------------------------------------------------------------------ */

/**
 * Decide se a mensagem deve ser processada e a converte para o formato
 * que tratarMensagemBaileys entende. Retorna null para o que ignoramos.
 *
 * Exportado para teste: é aqui que mora a lógica de "não responder ao próprio eco".
 */
export function normalizarMensagemBaileys(msg, { meuJid, ownerJid = null, jaEnviadas = enviadasPeloBot } = {}) {
  if (!msg || msg.key?.fromMe === undefined) return null;
  if (msg.message?.protocolMessage) return null;        // edição/revogação
  if (msg.message?.reactionMessage) return null;        // emoji de reação
  if (enviadasPeloBot.has(msg.key.id) || jaEnviadas.has(msg.key.id)) return null; // eco do bot

  const remoto = msg.key.remoteJid;
  if (!remoto || remoto === 'status@broadcast') return null;
  const ehGrupo = remoto.endsWith('@g.us');

  // mensagens minhas: só processa se foi no chat comigo mesmo
  if (msg.key.fromMe) {
    const chatProprio = meuJid && remoto === meuJid;
    if (!chatProprio) return null;
  } else if (ownerJid) {
    // modo contato: só aceita o número autorizado
    if (paraJid(remoto) !== paraJid(ownerJid)) return null;
  } else if (!ehGrupo) {
    // sem owner definido e não é fromMe: ignora conversa de terceiros
    return null;
  }

  const m = msg.message || {};
  let tipo = 'texto';
  let texto = '';
  let media = null;
  let legenda = '';

  if (m.audioMessage) { tipo = 'audio'; media = m.audioMessage; }
  else if (m.imageMessage) { tipo = 'imagem'; media = m.imageMessage; legenda = m.imageMessage.caption || ''; }
  else if (m.documentMessage) { tipo = 'imagem'; media = m.documentMessage; legenda = m.documentMessage.caption || ''; }
  else if (m.videoMessage) return null;
  else if (m.conversation) { texto = m.conversation; }
  else if (m.extendedTextMessage) { texto = m.extendedTextMessage.text || ''; }
  else return null;

  if (msg.key.fromMe && !texto && !media) return null;

  return {
    id: msg.key.id,
    jid: remoto,
    de: msg.key.fromMe ? (meuJid || remoto) : remoto,
    nome: msg.pushName || (msg.key.fromMe ? 'Você' : remoto.split('@')[0]),
    tipo,
    texto,
    legenda,
    media,
    mimetype: media?.mimetype || null,
  };
}

/* ------------------------------------------------------------------ */
/* Tratamento                                                          */
/* ------------------------------------------------------------------ */

/** Baixa e processa a mídia, devolvendo o texto a analisar. */
export async function extrairTextoDaMidia(normalizada) {
  if (!normalizada.media) return normalizada.texto;

  const tipoBaileys = normalizada.tipo === 'audio' ? 'audio' : 'image';
  const stream = await downloadContentFromMessage(normalizada.media, tipoBaileys);
  const buffer = await streamParaBuffer(stream);
  const mime = normalizada.mimetype || (tipoBaileys === 'audio' ? 'audio/ogg' : 'image/jpeg');

  if (normalizada.tipo === 'audio') {
    const transcrito = await transcreverAudio(buffer, mime);
    return [normalizada.texto, transcrito].filter(Boolean).join(' ');
  }
  const lido = await lerRecibo(buffer, mime);
  return [normalizada.legenda, lido].filter(Boolean).join('\n');
}

/**
 * Processa uma mensagem já normalizada e devolve a resposta.
 * Mantém a mesma forma de `tratarMensagem` do conector da Meta.
 */
export async function processarMensagem(normalizada, store) {
  let texto;
  let fonte = 'texto';

  try {
    texto = await extrairTextoDaMidia(normalizada);
    if (normalizada.media) fonte = normalizada.tipo === 'audio' ? 'audio' : 'imagem';
  } catch (erro) {
    console.error('[baileys] falha na mídia:', erro.message);
    return '😕 Não consegui processar essa mídia agora. Pode mandar o valor por texto? (ex.: “mercado 87,30”)';
  }

  const resultado = parseTransaction(texto, { agora: new Date(), fonte, autor: normalizada.de });

  if (resultado.ok) {
    store.adicionar(resultado.transacao);
    const resumo = resumirMes(store.listar(normalizada.de), { agora: new Date(), orcamento: store.getOrcamento(normalizada.de) });
    return montarResposta(resultado, resumo);
  }

  if (resultado.motivo === 'desfazer') {
    const removida = store.removerUltimo(normalizada.de);
    return removida
      ? `🗑 Removi: ${removida.descricao} — ${formatarBRL(removida.valor)}`
      : 'Não achei nenhum lançamento seu para remover.';
  }

  const resumo = resumirMes(store.listar(normalizada.de), { agora: new Date(), orcamento: store.getOrcamento(normalizada.de) });
  return montarResposta(resultado, resumo);
}

/* ------------------------------------------------------------------ */
/* Conexão                                                             */
/* ------------------------------------------------------------------ */

export async function iniciarBaileys({ store, onLog = console.log } = {}) {
  if (pronto) return { jaIniciado: true, estado: pareamento };
  pronto = true;
  setEstado({ status: 'iniciando', erro: null, qr: null });

  const { state, saveCreds } = await useMultiFileAuthState(PASTA_AUTH);
  const ownerJid = process.env.BAILEYS_OWNER_JID
    ? paraJid(process.env.BAILEYS_OWNER_JID)
    : null;

  sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
    browser: ['FinZap', 'Chrome', '20.0.04'],
    markOnlineOnConnect: false,
    syncFullHistory: false,
    logger: { level: process.env.BAILEYS_LOG || 'warn', info: () => {}, warn: console.warn, error: console.error, debug: () => {}, trace: () => {}, child: () => ({ level: 'warn', info: () => {}, warn: console.warn, error: console.error, debug: () => {}, trace: () => {} }) },
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      try {
        const dataUrl = await QRCode.toDataURL(qr, { margin: 1, width: 320 });
        setEstado({ status: 'qr', qr: dataUrl, qrGeradoEm: new Date().toISOString(), erro: null });
        onLog('[baileys] QR gerado — abra /parear para escanear');
      } catch (e) {
        setEstado({ status: 'erro', erro: `Falha ao gerar QR: ${e.message}` });
      }
    }

    if (connection === 'connecting') setEstado({ status: 'conectando', qr: null });

    if (connection === 'open') {
      const jid = sock.user?.id ? paraJid(sock.user.id) : null;
      setEstado({
        status: 'conectado',
        qr: null,
        erro: null,
        usuario: {
          nome: sock.user?.name || 'Você',
          jid,
          numero: jid ? jid.split('@')[0].split(':')[0] : null,
        },
      });
      onLog(`[baileys] ✅ conectado como ${sock.user?.name} (${jid})`);
    }

    if (connection === 'close') {
      const codigo = lastDisconnect?.error?.output?.statusCode;
      const loggedOut = codigo === DisconnectReason.loggedOut;
      setEstado({
        status: loggedOut ? 'desconectado' : 'iniciando',
        qr: null,
        usuario: null,
        erro: loggedOut ? 'Sessão encerrada no celular. Escaneie o QR de novo.' : `Desconectado (código ${codigo}). Tentando de novo…`,
      });
      if (loggedOut) {
        pronto = false;
        onLog('[baileys] logout — precisa escanear de novo');
      } else {
        // o próprio Baileys reconecta; se não, tentamos de novo
        setTimeout(() => { if (pareamento.status !== 'conectado') iniciarBaileys({ store, onLog }).catch(() => {}); }, 3000);
      }
    }
  });

  sock.ev.on('messages.upsert', async ({ messages }) => {
    for (const msg of messages) {
      try {
        const meuJid = sock.user?.id ? paraJid(sock.user.id) : null;
        const normalizada = normalizarMensagemBaileys(msg, { meuJid, ownerJid });
        if (!normalizada) continue;

        onLog(`[baileys] ${normalizada.nome} (${normalizada.tipo}): ${normalizada.texto || normalizada.mimetype || ''}`);
        const resposta = await processarMensagem(normalizada, store);
        if (resposta) await enviar(normalizada.jid, resposta);
      } catch (erro) {
        console.error('[baileys] erro ao tratar mensagem:', erro);
      }
    }
  });

  return { iniciado: true, estado: pareamento };
}

/** Envia texto e marca o id como "do bot" para não reprocessar o eco. */
export async function enviar(jid, texto) {
  if (!sock || pareamento.status !== 'conectado') {
    onDemo(jid, texto);
    return { demo: true };
  }
  const r = await sock.sendMessage(jid, { text: texto });
  if (r?.key?.id) enviadasPeloBot.add(r.key.id);
  if (enviadasPeloBot.size > 500) {
    for (const id of Array.from(enviadasPeloBot).slice(0, 250)) enviadasPeloBot.delete(id);
  }
  return r;
}

function onDemo(jid, texto) {
  console.log(`[baileys:demo] -> ${jid}: ${texto.replace(/\n/g, ' / ')}`);
}

export async function deslogarBaileys() {
  if (!sock) return false;
  try { await sock.logout(); } catch { /* já estava fora */ }
  setEstado({ status: 'desconectado', qr: null, usuario: null, erro: null });
  return true;
}

export function estaConectado() {
  return pareamento.status === 'conectado';
}
