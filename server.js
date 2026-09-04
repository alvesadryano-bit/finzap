/**
 * FinZap — servidor
 *
 *   GET  /                          painel + simulador de chat
 *   GET  /api/whatsapp/webhook      verificação da Meta
 *   POST /api/whatsapp/webhook      mensagens recebidas do WhatsApp
 *   POST /api/simulate              endpoint usado pelo simulador (texto/áudio/imagem)
 *   GET  /api/transacoes            lista
 *   GET  /api/resumo                resumo do mês
 *   GET  /api/status                modo de operação e provedores
 */

import './lib/env.js';
import express from 'express';
import multer from 'multer';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseTransaction, montarResposta, resumirMes } from './lib/parseTransaction.js';
import { normalizarWebhook, tratarMensagem, verificarWebhook, enviarTexto, estaConfigurado } from './lib/whatsapp.js';
import {
  iniciarBaileys, deslogarBaileys, pareamento, estaConectado, enviar as enviarBaileys,
} from './lib/whatsappBaileys.js';
import { transcreverAudio, lerRecibo, providerInfo } from './lib/ai.js';
import { store } from './lib/store.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

/* ---------------- status ---------------- */

/**
 * Modo de conexão:
 *   WHATSAPP_MODE=cloud    -> só webhook oficial da Meta
 *   WHATSAPP_MODE=baileys  -> QR Code com o seu número (padrão quando não há credenciais Meta)
 *   WHATSAPP_MODE=demo     -> nenhum dos dois, só o simulador
 */
const MODO = (process.env.WHATSAPP_MODE || (estaConfigurado() ? 'cloud' : 'baileys')).toLowerCase();

app.get('/api/status', (_req, res) => {
  res.json({
    whatsapp: estaConfigurado() ? 'conectado' : estaConectado() ? 'conectado' : MODO === 'demo' ? 'demo' : pareamento.status,
    modo: MODO,
    pareamento: { status: pareamento.status, usuario: pareamento.usuario, modoChat: pareamento.modoChat },
    ia: providerInfo(),
    banco: store.supabase ? 'supabase' : (process.env.FINZAP_DB ? 'arquivo' : 'memoria'),
    autores: store.autores(),
    transacoes: store.listar().length,
  });
});

/* ---------------- pareamento Baileys ---------------- */

app.get('/parear', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'parear.html')));

app.get('/api/parear', (_req, res) => res.json(pareamento));

app.post('/api/parear/reiniciar', async (_req, res) => {
  if (MODO === 'demo') return res.status(400).json({ erro: 'WHATSAPP_MODE=demo: conector desligado' });
  Object.assign(pareamento, { status: 'iniciando', qr: null, erro: null });
  res.json({ ok: true });
  setTimeout(() => iniciarBaileys({ store }).catch((e) => console.error('[baileys]', e.message)), 300);
});

app.post('/api/parear/sair', async (_req, res) => {
  const ok = await deslogarBaileys();
  res.json({ ok });
});

/** Responde "oi" / "ping" no chat para conferir se a ponte está viva. */
app.post('/api/parear/teste', async (req, res) => {
  if (!estaConectado()) return res.status(409).json({ erro: 'Ainda não está conectado. Escaneie o QR.' });
  const alvo = req.body?.jid || pareamento.usuario?.jid;
  if (!alvo) return res.status(400).json({ erro: 'Sem jid de destino.' });
  await enviarBaileys(alvo, '✅ FinZap está no ar! Manda um gasto aqui, tipo “gastei 20 no mercado”.');
  res.json({ ok: true, alvo });
});

/* ---------------- dados ---------------- */

app.get('/api/transacoes', (_req, res) => res.json(store.listar()));

app.get('/api/resumo', (req, res) => {
  const ano = req.query.ano ? Number(req.query.ano) : new Date().getFullYear();
  const mes = req.query.mes ? Number(req.query.mes) - 1 : new Date().getMonth();
  res.json(resumirMes(store.listar(), { agora: new Date(ano, mes, 15), orcamento: store.getOrcamento() }));
});

app.get('/api/orcamento', (_req, res) => res.json({ orcamento: store.getOrcamento() }));
app.post('/api/orcamento', (req, res) => res.json({ orcamento: store.setOrcamento(req.body?.valor) }));
app.delete('/api/transacoes/:id', (req, res) => {
  const r = store.remover(req.params.id);
  res.json({ removida: r });
});
app.delete('/api/transacoes', (_req, res) => { store.limpar(); res.json({ ok: true }); });

/* ---------------- simulador (usado pelo painel web) ---------------- */

/**
 * Recebe texto OU arquivo (áudio/imagem) e responde como o bot responderia no WhatsApp.
 * multipart/form-data: campo "arquivo" + campo "texto"
 */
app.post('/api/simulate', upload.single('arquivo'), async (req, res) => {
  try {
    let texto = (req.body?.texto || '').trim();
    let transcricao = null;
    let ocr = null;
    let fonte = 'texto';
    let preview = null;

    if (req.file) {
      const mime = req.file.mimetype || '';
      const buf = req.file.buffer;
      const id = `m_${Date.now().toString(36)}`;
      if (mime.startsWith('audio/')) {
        transcricao = await transcreverAudio(buf, mime);
        texto = [texto, transcricao].filter(Boolean).join(' ');
        fonte = 'audio';
        preview = `data:${mime};base64,${buf.toString('base64')}`;
        void id;
      } else if (mime.startsWith('image/')) {
        ocr = await lerRecibo(buf, mime);
        texto = [texto, ocr].filter(Boolean).join('\n');
        fonte = 'imagem';
        preview = `data:${mime};base64,${buf.toString('base64')}`;
      } else {
        return res.status(415).json({ erro: `Tipo não suportado: ${mime}` });
      }
    }

    if (!texto) return res.status(400).json({ erro: 'Mande um texto, um áudio ou uma imagem.' });

    const resultado = parseTransaction(texto, { agora: new Date(), fonte, autor: 'eu' });

    if (resultado.ok) {
      store.adicionar(resultado.transacao);
    } else if (resultado.motivo === 'desfazer') {
      const removida = store.removerUltimo('eu');
      return res.json({
        transcricao, ocr, preview, fonte,
        ok: false, motivo: 'desfazer',
        resposta: removida
          ? `🗑 Removi: ${removida.descricao} — R$ ${removida.valor.toFixed(2).replace('.', ',')}`
          : 'Não achei nenhum lançamento para remover.',
      });
    }

    const resumo = resumirMes(store.listar(), { agora: new Date(), orcamento: store.getOrcamento() });
    res.json({
      ok: resultado.ok,
      motivo: resultado.motivo,
      transcricao,
      ocr,
      preview,
      fonte,
      transacao: resultado.transacao || null,
      resposta: montarResposta(resultado, resumo),
      resumo,
    });
  } catch (erro) {
    console.error('[simulate]', erro);
    res.status(500).json({ erro: erro.message });
  }
});

/* ---------------- WhatsApp oficial ---------------- */

app.get('/api/whatsapp/webhook', (req, res) => {
  const challenge = verificarWebhook(req.query);
  if (challenge != null) return res.status(200).send(challenge);
  res.status(403).send('Verificação de token falhou');
});

app.post('/api/whatsapp/webhook', async (req, res) => {
  // responde 200 na hora: a Meta reenvia se demorarmos > 20s
  res.sendStatus(200);
  try {
    const msg = normalizarWebhook(req.body);
    if (!msg) return;
    console.log(`[whatsapp] ${msg.nome} (${msg.tipo}): ${msg.texto || msg.mediaId}`);
    const resposta = await tratarMensagem(msg, store);
    if (resposta) await enviarTexto(msg.de, resposta);
  } catch (erro) {
    console.error('[whatsapp] erro ao tratar mensagem:', erro);
  }
});

/* ---------------- */

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n💰 FinZap no ar: http://localhost:${PORT}`);
  console.log(`   Modo WhatsApp: ${MODO}`);
  if (MODO === 'baileys') {
    console.log(`   🔗 Conectar seu número: http://localhost:${PORT}/parear`);
    console.log(`      Chat: ${process.env.BAILEYS_OWNER_JID ? `só responde ${process.env.BAILEYS_OWNER_JID}` : 'conversa "Você" (consigo mesmo)'}`);
  } else if (MODO === 'cloud') {
    console.log(`   Webhook: POST /api/whatsapp/webhook`);
  } else {
    console.log(`   ⚠️  modo demo (só simulador no navegador)`);
  }
  console.log(`   IA: ${providerInfo().nome}\n`);

  store.carregar().then((info) => {
    if (info.origem === 'supabase') console.log(`   🗄  Dados: Supabase (${info.total} lançamentos)`);
  });

  if (MODO === 'baileys') {
    iniciarBaileys({ store }).catch((erro) => {
      console.error('[baileys] não consegui iniciar:', erro.message);
      pareamento.status = 'erro';
      pareamento.erro = erro.message;
    });
  }
});
