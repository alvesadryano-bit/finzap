/**
 * Conector WhatsApp — API Oficial (Meta WhatsApp Cloud API).
 *
 * O que é preciso para ligar de verdade:
 *   1. App em https://developers.facebook.com -> adicionar produto "WhatsApp"
 *   2. Um número (o de teste gratuito serve para começar)
 *   3. WHATSAPP_TOKEN  = token de acesso permanente
 *   4. WHATSAPP_PHONE_ID = id do número (aparece na tela de configuração)
 *   5. Um webhook público apontando para  https://SEU_DOMINIO/api/whatsapp/webhook
 *      (em dev: cloudflared tunnel --url http://localhost:3000  ou  ngrok http 3000)
 *   6. WHATSAPP_VERIFY_TOKEN = qualquer string, a mesma que você digita no painel da Meta
 *
 * Sem essas variáveis o servidor continua no ar em MODO DEMO (simulador no navegador).
 */

import { parseTransaction, montarResposta, resumirMes, formatarBRL } from './parseTransaction.js';
import { transcreverAudio, lerRecibo } from './ai.js';

const GRAPH = 'https://graph.facebook.com/v21.0';

export function estaConfigurado() {
  return Boolean(process.env.WHATSAPP_TOKEN && process.env.WHATSAPP_PHONE_ID);
}

/* ------------------------------------------------------------------ */
/* Envio                                                               */
/* ------------------------------------------------------------------ */

export async function enviarTexto(para, texto) {
  if (!estaConfigurado()) {
    console.log(`[demo] -> ${para}: ${texto.replace(/\n/g, ' / ')}`);
    return { demo: true };
  }
  const res = await fetch(`${GRAPH}/${process.env.WHATSAPP_PHONE_ID}/messages`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to: para.replace(/\D/g, ''),
      type: 'text',
      text: { preview_url: false, body: texto },
    }),
  });
  if (!res.ok) throw new Error(`WhatsApp send ${res.status}: ${await res.text()}`);
  return res.json();
}

/** Baixa uma mídia enviada pelo usuário (a Meta devolve só um id, não o arquivo). */
async function baixarMidia(mediaId) {
  if (!estaConfigurado()) {
    throw new Error('mídia recebida sem WHATSAPP_TOKEN/WHATSAPP_PHONE_ID configurados');
  }
  const metaRes = await fetch(`${GRAPH}/${mediaId}`, {
    headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}` },
  });
  const meta = await metaRes.json();
  if (!metaRes.ok || !meta.url) {
    throw new Error(`não consegui localizar a mídia ${mediaId}: ${meta?.error?.message || metaRes.status}`);
  }
  const bin = await fetch(meta.url, { headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}` } });
  if (!bin.ok) throw new Error(`download da mídia falhou (${bin.status})`);
  return { buffer: Buffer.from(await bin.arrayBuffer()), mimeType: meta.mime_type };
}

/* ------------------------------------------------------------------ */
/* Recepção                                                            */
/* ------------------------------------------------------------------ */

/**
 * Transforma o payload do webhook da Meta em algo simples de tratar.
 * Retorna null para eventos que não são mensagem (status de entrega, etc).
 */
export function normalizarWebhook(body) {
  const entry = body?.entry?.[0];
  const change = entry?.changes?.[0]?.value;
  const msg = change?.messages?.[0];
  if (!msg) return null;
  const contato = change?.contacts?.[0];
  return {
    id: msg.id,
    de: msg.from,
    nome: contato?.profile?.name || msg.from,
    tipo: msg.type,            // text | audio | image | document | sticker | video | location
    texto: msg.text?.body || '',
    mediaId: msg.audio?.id || msg.image?.id || msg.document?.id || null,
    mimeType: msg.audio?.mime_type || msg.image?.mime_type || null,
    legenda: msg.image?.caption || msg.document?.caption || '',
  };
}

/**
 * Trata uma mensagem e devolve a resposta a enviar.
 * `store` precisa expor: listar(), adicionar(t), removerUltimo(), getOrcamento().
 */
export async function tratarMensagem(msg, store) {
  const autor = msg.de;
  let texto = msg.texto || '';
  let fonte = 'texto';

  try {
    if (msg.tipo === 'audio' && msg.mediaId) {
      const { buffer, mimeType } = await baixarMidia(msg.mediaId);
      texto = await transcreverAudio(buffer, mimeType);
      fonte = 'audio';
      await enviarTexto(autor, `🎧 Ouvi: “${texto}”`);
    } else if ((msg.tipo === 'image' || msg.tipo === 'document') && msg.mediaId) {
      const { buffer, mimeType } = await baixarMidia(msg.mediaId);
      const lido = await lerRecibo(buffer, mimeType);
      texto = msg.legenda ? `${msg.legenda}\n${lido}` : lido;
      fonte = 'imagem';
    }
  } catch (erro) {
    console.error('[whatsapp] falha ao processar mídia:', erro.message);
    return '😕 Não consegui processar essa mídia agora. Pode mandar o valor por texto? (ex.: “mercado 87,30”)';
  }

  const resultado = parseTransaction(texto, { agora: new Date(), fonte, autor });

  if (resultado.ok) {
    store.adicionar(resultado.transacao);
    const resumo = resumirMes(store.listar(autor), { agora: new Date(), orcamento: store.getOrcamento(autor) });
    return montarResposta(resultado, resumo);
  }

  if (resultado.motivo === 'desfazer') {
    const removida = store.removerUltimo(autor);
    return removida
      ? `🗑 Removi: ${removida.tipo === 'saida' ? '-' : '+'} ${formatarBRL(removida.valor)} (${removida.descricao}).`
      : 'Não achei nenhum lançamento seu para remover.';
  }

  const resumo = resumirMes(store.listar(autor), { agora: new Date(), orcamento: store.getOrcamento(autor) });
  return montarResposta(resultado, resumo);
}

/** Verificação de webhook exigida pela Meta (GET com hub.challenge). */
export function verificarWebhook(query) {
  const esperado = process.env.WHATSAPP_VERIFY_TOKEN;
  if (!esperado) return null;
  if (query['hub.mode'] === 'subscribe' && query['hub.verify_token'] === esperado) {
    return query['hub.challenge'];
  }
  return null;
}
