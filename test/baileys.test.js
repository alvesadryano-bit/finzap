import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizarMensagemBaileys, processarMensagem } from '../lib/whatsappBaileys.js';

const MEU = '5511999998888@s.whatsapp.net';
const OUTRO = '5511888887777@s.whatsapp.net';

const texto = (key, body) => ({ key, message: { conversation: body } });
const audio = (key, mime = 'audio/ogg') => ({ key, message: { audioMessage: { mimetype: mime } } });
const imagem = (key, caption = '') => ({ key, message: { imageMessage: { mimetype: 'image/jpeg', caption } } });

test('aceita mensagem minha no chat comigo mesmo', () => {
  const m = normalizarMensagemBaileys(
    texto({ id: 'A1', fromMe: true, remoteJid: MEU }, 'gastei 45,90 no uber'),
    { meuJid: MEU, jaEnviadas: new Set() },
  );
  assert.equal(m.tipo, 'texto');
  assert.equal(m.texto, 'gastei 45,90 no uber');
  assert.equal(m.nome, 'Você');
});

test('IGNORA minha mensagem enviada em outra conversa (não é para o bot)', () => {
  const m = normalizarMensagemBaileys(
    texto({ id: 'A2', fromMe: true, remoteJid: OUTRO }, 'oi mãe, gastei 45 no uber'),
    { meuJid: MEU, jaEnviadas: new Set() },
  );
  assert.equal(m, null);
});

test('IGNORA o eco da resposta do próprio bot (evita loop infinito)', () => {
  const m = normalizarMensagemBaileys(
    texto({ id: 'BOT1', fromMe: true, remoteJid: MEU }, '💸 Gasto registrado'),
    { meuJid: MEU, jaEnviadas: new Set(['BOT1']) },
  );
  assert.equal(m, null);
});

test('ignora mensagem de terceiros quando não há owner configurado', () => {
  const m = normalizarMensagemBaileys(
    texto({ id: 'A3', fromMe: false, remoteJid: OUTRO }, 'gastei 100'),
    { meuJid: MEU, jaEnviadas: new Set() },
  );
  assert.equal(m, null);
});

test('aceita terceiros quando owner está configurado', () => {
  const m = normalizarMensagemBaileys(
    texto({ id: 'A4', fromMe: false, remoteJid: OUTRO }, 'gastei 100 no mercado'),
    { meuJid: MEU, ownerJid: '5511888887777', jaEnviadas: new Set() },
  );
  assert.equal(m.texto, 'gastei 100 no mercado');
});

test('rejeita terceiro diferente do owner', () => {
  const m = normalizarMensagemBaileys(
    texto({ id: 'A5', fromMe: false, remoteJid: '5521777776666@s.whatsapp.net' }, 'gastei 100'),
    { meuJid: MEU, ownerJid: '5511888887777', jaEnviadas: new Set() },
  );
  assert.equal(m, null);
});

test('ignora reação, edição e status', () => {
  const opts = { meuJid: MEU, jaEnviadas: new Set() };
  assert.equal(normalizarMensagemBaileys({ key: { id: 'R1', fromMe: true, remoteJid: MEU }, message: { reactionMessage: { text: '👍' } } }, opts), null);
  assert.equal(normalizarMensagemBaileys({ key: { id: 'R2', fromMe: true, remoteJid: MEU }, message: { protocolMessage: {} } }, opts), null);
  assert.equal(normalizarMensagemBaileys({ key: { id: 'R3', fromMe: true, remoteJid: 'status@broadcast' }, message: { conversation: 'oi' } }, opts), null);
  assert.equal(normalizarMensagemBaileys(null, opts), null);
});

test('identifica áudio e imagem com legenda', () => {
  const opts = { meuJid: MEU, jaEnviadas: new Set() };
  const a = normalizarMensagemBaileys(audio({ id: 'M1', fromMe: true, remoteJid: MEU }), opts);
  assert.equal(a.tipo, 'audio');
  assert.equal(a.mimetype, 'audio/ogg');

  const i = normalizarMensagemBaileys(imagem({ id: 'M2', fromMe: true, remoteJid: MEU }, 'almoço de ontem'), opts);
  assert.equal(i.tipo, 'imagem');
  assert.equal(i.legenda, 'almoço de ontem');
});

test('ignora mensagem minha vazia', () => {
  const m = normalizarMensagemBaileys(
    { key: { id: 'E1', fromMe: true, remoteJid: MEU }, message: {} },
    { meuJid: MEU, jaEnviadas: new Set() },
  );
  assert.equal(m, null);
});

test('processarMensagem registra o gasto sem tocar na rede (texto puro)', async () => {
  const guardadas = [];
  const store = {
    adicionar: (t) => guardadas.push(t),
    listar: () => guardadas,
    removerUltimo: () => null,
    getOrcamento: () => 2000,
  };
  const resposta = await processarMensagem(
    { de: MEU, tipo: 'texto', texto: 'paguei 89,90 no ifood', media: null, legenda: '' },
    store,
  );
  assert.equal(guardadas.length, 1);
  assert.equal(guardadas[0].valor, 89.9);
  assert.equal(guardadas[0].categoria, 'alimentacao');
  assert.match(resposta, /Gasto registrado/);
  assert.match(resposta, /89,90/);
});
