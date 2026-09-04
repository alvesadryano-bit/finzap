/**
 * Store com três modos:
 *   1. Memória (sempre) — cache rápido e síncrono usado pelos fluxos.
 *   2. Arquivo JSON (opcional, FINZAP_DB=./dados.json) — dev local.
 *   3. Supabase (opcional, SUPABASE_URL + SUPABASE_SERVICE_KEY) — produção/multi-usuário.
 *      Write-through: toda escrita vai pra memória e, em segundo plano, pro Postgres.
 *
 * Multi-usuário: cada transação tem `autor` (o número de WhatsApp). Todas as leituras
 * aceitam um autor opcional para isolar os dados de cada número.
 *
 * Para produção, a mesma interface pode ser trocada por Postgres direto —
 * o schema está em supabase/schema.sql.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';

// Node < 22 não tem WebSocket global; o realtime do supabase-js exige um.
import { createRequire } from 'node:module';
if (typeof globalThis.WebSocket === 'undefined') {
  try { globalThis.WebSocket = createRequire(import.meta.url)('ws'); } catch { /* sem ws */ }
}

import { createClient } from '@supabase/supabase-js';

const ARQUIVO = process.env.FINZAP_DB || null;

function criarSupabase() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false } });
}

class Store {
  constructor() {
    this.transacoes = [];
    this.orcamentos = new Map(); // autor -> valor
    this.orcamentoPadrao = 2500;
    this.supabase = criarSupabase();

    if (ARQUIVO && existsSync(ARQUIVO)) {
      try {
        const d = JSON.parse(readFileSync(ARQUIVO, 'utf8'));
        this.transacoes = d.transacoes || [];
        this.orcamentoPadrao = d.orcamento ?? this.orcamentoPadrao;
        if (d.orcamentos) this.orcamentos = new Map(Object.entries(d.orcamentos));
        console.log(`[store] carregadas ${this.transacoes.length} transações de ${ARQUIVO}`);
      } catch (e) {
        console.warn('[store] não consegui ler o arquivo, começando vazio:', e.message);
      }
    }
  }

  _salvarArquivo() {
    if (!ARQUIVO) return;
    writeFileSync(ARQUIVO, JSON.stringify({
      transacoes: this.transacoes,
      orcamento: this.orcamentoPadrao,
      orcamentos: Object.fromEntries(this.orcamentos),
    }, null, 2));
  }

  /** Write-through pro Supabase (não bloqueia o fluxo). */
  _salvarSupabase(operacao, payload) {
    if (!this.supabase) return;
    const promessas = {
      insert: () => this.supabase.from('lancamentos').insert(this._paraLinha(payload)),
      delete: () => this.supabase.from('lancamentos').delete().eq('id', payload),
      upsertPerfil: (autor, orcamento) => this.supabase.from('perfis').upsert({
        autor, orcamento, atualizado_em: new Date().toISOString(),
      }),
    };
    const fn = operacao === 'insert' ? promessas.insert
      : operacao === 'delete' ? promessas.delete
      : () => promessas.upsertPerfil(...payload);
    Promise.resolve()
      .then(fn)
      .then(({ error }) => { if (error) console.error('[supabase] erro:', error.message); })
      .catch((e) => console.error('[supabase] falha de rede:', e.message));
  }

  _paraLinha(t) {
    return {
      id: t.id,
      autor: t.autor || 'eu',
      valor: t.valor,
      tipo: t.tipo,
      categoria: t.categoria,
      data: t.data,
      descricao: t.descricao || null,
      forma: t.forma || null,
      parcelas: t.parcelas || null,
      fonte: t.fonte || 'texto',
      texto_original: t.textoOriginal || null,
    };
  }

  _daLinha(r) {
    return {
      id: r.id,
      autor: r.autor,
      valor: Number(r.valor),
      tipo: r.tipo,
      categoria: r.categoria,
      data: typeof r.data === 'string' ? r.data.slice(0, 10) : r.data,
      descricao: r.descricao || 'Lançamento',
      forma: r.forma || 'outro',
      parcelas: r.parcelas || null,
      fonte: r.fonte || 'texto',
      textoOriginal: r.texto_original || '',
      criadoEm: r.criado_em,
    };
  }

  /** Carrega tudo do Supabase (chamado uma vez no boot). */
  async carregar() {
    if (!this.supabase) return { origem: 'memoria', total: this.transacoes.length };
    try {
      const [l, p] = await Promise.all([
        this.supabase.from('lancamentos').select('*'),
        this.supabase.from('perfis').select('*'),
      ]);
      if (l.error) throw l.error;
      if (p.error) throw p.error;
      this.transacoes = (l.data || []).map((r) => this._daLinha(r));
      for (const row of p.data || []) this.orcamentos.set(row.autor, Number(row.orcamento));
      console.log(`[supabase] carregadas ${this.transacoes.length} transações, ${p.data?.length || 0} perfis`);
      return { origem: 'supabase', total: this.transacoes.length };
    } catch (e) {
      console.error('[supabase] falha ao carregar, usando memória:', e.message);
      return { origem: 'memoria', total: this.transacoes.length, erro: e.message };
    }
  }

  /* ---------------- leituras (autor opcional = isolamento) ---------------- */

  listar(autor = null) {
    const base = autor ? this.transacoes.filter((t) => (t.autor || 'eu') === autor) : this.transacoes;
    return [...base].sort((a, b) => (a.data < b.data ? 1 : a.data > b.data ? -1 : 0));
  }

  autores() {
    return [...new Set(this.transacoes.map((t) => t.autor || 'eu'))];
  }

  adicionar(t) {
    this.transacoes.push(t);
    this._salvarArquivo();
    this._salvarSupabase('insert', t);
    return t;
  }

  remover(id) {
    const i = this.transacoes.findIndex((t) => t.id === id);
    if (i < 0) return null;
    const [removida] = this.transacoes.splice(i, 1);
    this._salvarArquivo();
    this._salvarSupabase('delete', id);
    return removida;
  }

  removerUltimo(autor = null) {
    const ordenadas = this.listar(autor);
    const alvo = ordenadas[0];
    return alvo ? this.remover(alvo.id) : null;
  }

  /* ---------------- orçamento por autor ---------------- */

  getOrcamento(autor = null) {
    if (autor && this.orcamentos.has(autor)) return this.orcamentos.get(autor);
    return this.orcamentoPadrao;
  }

  setOrcamento(v, autor = null) {
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0) return this.getOrcamento(autor);
    const valor = Math.round(n * 100) / 100;
    if (autor) {
      this.orcamentos.set(autor, valor);
      this._salvarSupabase('upsertPerfil', [autor, valor]);
    } else {
      this.orcamentoPadrao = valor;
    }
    this._salvarArquivo();
    return valor;
  }

  limpar() {
    this.transacoes = [];
    this._salvarArquivo();
  }
}

export const store = new Store();
export { Store };
