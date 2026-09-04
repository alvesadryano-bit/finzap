import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTransaction, extrairValor, extrairData, resumirMes, formatarBRL } from '../lib/parseTransaction.js';

const AGORA = new Date(2026, 8, 3, 12, 0, 0); // 03/09/2026, quinta-feira

test('extrai valores em formatos brasileiros', () => {
  assert.equal(extrairValor('gastei R$ 1.234,56 no mercado'), 1234.56);
  assert.equal(extrairValor('uber 45,90'), 45.9);
  assert.equal(extrairValor('mercado 320'), 320);
  assert.equal(extrairValor('gastei 2k na viagem'), 2000);
  assert.equal(extrairValor('comprei por 1,5 mil'), 1500);
  assert.equal(extrairValor('paguei 50 reais'), 50);
  assert.equal(extrairValor('paguei 45.90'), 45.9);
  assert.equal(extrairValor('oi, tudo bem?'), null);
});

test('não confunde data/hora com valor', () => {
  assert.equal(extrairValor('paguei 45 no dia 05/09'), 45);
  assert.equal(extrairValor('gasto às 18:30 de 25'), 25);
});

test('classifica saída, categoria e descrição', () => {
  const r = parseTransaction('gastei 45,90 no uber', { agora: AGORA });
  assert.equal(r.ok, true);
  assert.equal(r.transacao.tipo, 'saida');
  assert.equal(r.transacao.valor, 45.9);
  assert.equal(r.transacao.categoria, 'transporte');
  assert.equal(r.transacao.descricao, 'uber');
  assert.equal(r.transacao.forma, 'outro');
});

test('classifica entrada', () => {
  const r = parseTransaction('recebi 3.500 de salário', { agora: AGORA });
  assert.equal(r.transacao.tipo, 'entrada');
  assert.equal(r.transacao.valor, 3500);
  assert.equal(r.transacao.categoria, 'salario');
});

test('estorno não vira gasto', () => {
  const r = parseTransaction('estorno do ifood 32,90', { agora: AGORA });
  assert.equal(r.transacao.tipo, 'entrada');
});

test('datas relativas', () => {
  assert.equal(parseTransaction('ontem gastei 80 no cinema', { agora: AGORA }).transacao.data, '2026-09-02');
  assert.equal(parseTransaction('anteontem 20 de padaria', { agora: AGORA }).transacao.data, '2026-09-01');
  assert.equal(parseTransaction('segunda-feira paguei 150 de luz', { agora: AGORA }).transacao.data, '2026-08-31');
  assert.equal(parseTransaction('mercado 200', { agora: AGORA }).transacao.data, '2026-09-03');
});

test('data explícita', () => {
  assert.equal(parseTransaction('05/09 gastei 60', { agora: AGORA }).transacao.data, '2026-09-05');
  assert.equal(parseTransaction('gastei 60 em 3 de agosto', { agora: AGORA }).transacao.data, '2026-08-03');
});

test('parcelamento calcula o total', () => {
  const r = parseTransaction('comprei um tênis em 10x de 89,90', { agora: AGORA });
  assert.equal(r.transacao.parcelas, 10);
  assert.equal(r.transacao.valor, 899);
  assert.equal(r.transacao.categoria, 'compras');
});

test('texto de recibo (OCR)', () => {
  const ocr = [
    'SUPERMERCADO PAO DE ACUCAR',
    'CNPJ 12.345.678/0001-90',
    'ARROZ 5KG 28,90',
    'CARNE 45,60',
    'SUBTOTAL 274,50',
    'TOTAL 274,50',
    'CARTAO DEBITO VISA 274,50',
  ].join('\n');
  const r = parseTransaction(ocr, { agora: AGORA, fonte: 'imagem' });
  assert.equal(r.ok, true);
  assert.equal(r.transacao.valor, 274.5);
  assert.equal(r.transacao.categoria, 'mercado');
  assert.equal(r.transacao.forma, 'cartao');
});

test('transcrição de áudio', () => {
  const r = parseTransaction('oi, acabei de gastar trinta e cinco reais no mercado, anota aí', { agora: AGORA, fonte: 'audio' });
  assert.equal(r.ok, true);
  assert.equal(r.transacao.valor, 35);
  assert.equal(r.transacao.categoria, 'mercado');
});

test('mensagens sem valor pedem esclarecimento', () => {
  assert.equal(parseTransaction('oi tudo bem', { agora: AGORA }).motivo, 'saudacao');
  assert.equal(parseTransaction('preciso comprar pão', { agora: AGORA }).motivo, 'sem_valor');
  assert.equal(parseTransaction('quanto gastei esse mês?', { agora: AGORA }).motivo, 'consulta');
  assert.equal(parseTransaction('desfaz o último', { agora: AGORA }).motivo, 'desfazer');
});

test('resumo do mês agrega por categoria', () => {
  const ts = [
    parseTransaction('mercado 200', { agora: AGORA }).transacao,
    parseTransaction('uber 50', { agora: AGORA }).transacao,
    parseTransaction('recebi 1000', { agora: AGORA }).transacao,
    parseTransaction('mercado 100 em 03/08', { agora: AGORA }).transacao, // mês anterior
  ];
  const r = resumirMes(ts, { agora: AGORA, orcamento: 1000 });
  assert.equal(r.saidas, 250);
  assert.equal(r.entradas, 1000);
  assert.equal(r.saldo, 750);
  assert.equal(r.porCategoria.mercado, 200);
  assert.equal(r.quantidade, 3);
  assert.equal(r.top[0][1], 200);
});

test('formata moeda em pt-BR', () => {
  assert.equal(formatarBRL(1234.5).replace(/\u00a0/g, ' '), 'R$ 1.234,50');
});
