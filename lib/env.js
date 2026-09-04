/**
 * Carrega .env da raiz do projeto ANTES de qualquer outro módulo ler process.env.
 * Importe este arquivo PRIMEIRO (primeira linha de import) para garantir a ordem.
 * Variáveis já presentes no ambiente têm precedência sobre o .env.
 */
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const raiz = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const alvo = path.join(raiz, '.env');

if (existsSync(alvo)) {
  for (const linha of readFileSync(alvo, 'utf8').split('\n')) {
    const m = linha.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, '').trim();
    }
  }
}
