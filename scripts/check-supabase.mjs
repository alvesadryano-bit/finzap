/**
 * Passo 1 — confere a conexão com o seu Supabase e o estado do schema.
 *
 * Uso:
 *   SUPABASE_URL=... SUPABASE_SERVICE_KEY=... node scripts/check-supabase.mjs
 *   (ou crie um .env com essas duas variáveis)
 *
 * Não deixa nada gravado: o insert de teste é apagado em seguida.
 */
import '../lib/env.js';
import { createRequire } from 'node:module';
if (typeof globalThis.WebSocket === 'undefined') {
  try { globalThis.WebSocket = createRequire(import.meta.url)('ws'); } catch {}
}
import { createClient } from '@supabase/supabase-js';

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_KEY;

if (!url || !key) {
  console.error('❌ Faltam SUPABASE_URL e SUPABASE_SERVICE_KEY (no .env ou no ambiente).');
  console.error('   No Supabase: Settings → API → "Project URL" e a chave "service_role".');
  process.exit(1);
}

const sb = createClient(url, key, { auth: { persistSession: false } });
console.log(` Conectando a ${url} …\n`);

let todasOk = true;

try {
  for (const t of ['lancamentos', 'perfis', 'baileys_auth']) {
    const { count, error } = await sb.from(t).select('id', { count: 'exact', head: true });
    if (error) {
      todasOk = false;
      const falta = /does not exist|schema cache/i.test(error.message);
      console.error(`   ❌ ${t}: ${falta ? 'tabela não existe — rode supabase/schema.sql no SQL Editor' : error.message}`);
    } else {
      console.log(`   ✅ ${t}: existe (${count} linhas)`);
    }
  }

  // teste de escrita: insere e apaga em seguida
  const idTeste = `teste_${Date.now().toString(36)}`;
  const { error: eIns } = await sb.from('lancamentos').insert({
    id: idTeste, autor: '__teste__', valor: 1, tipo: 'saida',
    categoria: 'outros', data: '2026-01-01',
  });
  if (eIns) {
    todasOk = false;
    console.error(`   ❌ escrita em lancamentos falhou: ${eIns.message}`);
  } else {
    const { error: eDel } = await sb.from('lancamentos').delete().eq('id', idTeste);
    if (eDel) console.error(`   ⚠️ insert ok, mas delete falhou: ${eDel.message}`);
    else console.log('   ✅ escrita + leitura + exclusão funcionando');
  }
} catch (e) {
  console.error(`\n❌ Não consegui falar com o Supabase: ${e.message}`);
  console.error('   Confira se a URL e a chave service_role estão certas.');
  process.exit(2);
}

if (todasOk) {
  console.log('\n🎉 Supabase pronto. Podemos ir para o Passo 2 (Render + sessão do Baileys no banco).');
} else {
  console.log('\n⚠️ Há pendências acima. Rode supabase/schema.sql no SQL Editor e tente de novo.');
  process.exit(2);
}
