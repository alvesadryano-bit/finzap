import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../lib/store.js';

// store.js exporta a classe? Não — só a instância. Recriamos aqui via import da classe.
// (store.js precisa exportar Store; ajustamos o import abaixo conforme exportação real.)

function nova() {
  // cria uma store nova sem tocar em env (sem arquivo, sem supabase)
  return new Store();
}

const mk = (id, autor, valor, tipo = 'saida') => ({
  id, autor, valor, tipo, categoria: 'outros', data: '2026-09-01',
  descricao: 'x', forma: 'outro', fonte: 'texto', textoOriginal: '',
});

test('isola lançamentos por autor (multi-usuário)', () => {
  const s = nova();
  s.adicionar(mk('a1', '5511AAA', 10));
  s.adicionar(mk('a2', '5511BBB', 20));
  s.adicionar(mk('a3', '5511AAA', 30));

  assert.equal(s.listar('5511AAA').length, 2);
  assert.equal(s.listar('5511BBB').length, 1);
  assert.equal(s.listar().length, 3); // sem autor: tudo (painel demo)
  assert.deepEqual(s.autores().sort(), ['5511AAA', '5511BBB']);
});

test('removerUltimo respeita o autor', () => {
  const s = nova();
  s.adicionar(mk('a1', 'AAA', 10));
  s.adicionar(mk('a2', 'BBB', 99));
  const r = s.removerUltimo('AAA');
  assert.equal(r.id, 'a1');
  assert.equal(s.listar('AAA').length, 0);
  assert.equal(s.listar('BBB').length, 1); // BBB intocado
});

test('orçamento por autor com fallback ao padrão', () => {
  const s = nova();
  assert.equal(s.getOrcamento('NOVO'), 2500);      // fallback
  s.setOrcamento(1000, 'AAA');
  assert.equal(s.getOrcamento('AAA'), 1000);
  assert.equal(s.getOrcamento('BBB'), 2500);       // BBB não herdou AAA
});

test('serialização Supabase ida e volta', () => {
  const s = nova();
  const t = mk('z1', 'AAA', 45.9);
  t.fonte = 'audio'; t.textoOriginal = 'gastei no uber';
  const linha = s._paraLinha(t);
  assert.equal(linha.texto_original, 'gastei no uber');
  assert.equal(linha.autor, 'AAA');
  const volta = s._daLinha({ ...linha, criado_em: '2026-09-01T00:00:00Z' });
  assert.equal(volta.textoOriginal, 'gastei no uber');
  assert.equal(volta.valor, 45.9);
  assert.equal(volta.autor, 'AAA');
});

test('write-through chama insert no Supabase (cliente fake)', async () => {
  const s = nova();
  const chamadas = [];
  s.supabase = {
    from: (tabela) => ({
      insert: (row) => { chamadas.push({ tabela, op: 'insert', row }); return Promise.resolve({ error: null }); },
      delete: () => ({ eq: () => { chamadas.push({ tabela, op: 'delete' }); return Promise.resolve({ error: null }); } }),
    }),
  };

  s.adicionar(mk('w1', 'AAA', 10));
  s.remover('w1');
  await new Promise((r) => setTimeout(r, 20)); // deixa o write-through assíncrono rodar

  assert.equal(chamadas.length, 2);
  assert.equal(chamadas[0].op, 'insert');
  assert.equal(chamadas[0].row.id, 'w1');
  assert.equal(chamadas[1].op, 'delete');
});

test('carregar() puxa do Supabase e mapeia linhas (cliente fake)', async () => {
  const s = nova();
  s.supabase = {
    from: (tabela) => ({
      select: () => Promise.resolve(
        tabela === 'lancamentos'
          ? { error: null, data: [{ id: 'c1', autor: 'AAA', valor: '12.5', tipo: 'saida', categoria: 'mercado', data: '2026-09-02', texto_original: 'mercado' }] }
          : { error: null, data: [{ autor: 'AAA', orcamento: '800' }] },
      ),
    }),
  };
  const info = await s.carregar();
  assert.equal(info.origem, 'supabase');
  assert.equal(info.total, 1);
  assert.equal(s.listar('AAA')[0].valor, 12.5);
  assert.equal(s.getOrcamento('AAA'), 800);
});
