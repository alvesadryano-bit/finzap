-- ============================================================
-- FinZap — schema Supabase (Postgres) · IDEMPOTENTE (pode rodar de novo)
-- Rode no SQL Editor do Supabase. Multi-usuário por número de WhatsApp.
-- ============================================================

-- Lançamentos financeiros de cada usuário
create table if not exists public.lancamentos (
  id            text primary key,
  autor         text not null,                      -- número de WhatsApp (jid) ou id do usuário
  valor         numeric(12,2) not null check (valor >= 0),
  tipo          text not null check (tipo in ('entrada','saida')),
  categoria     text not null default 'outros',
  data          date not null default current_date,
  descricao     text,
  forma         text,
  parcelas      int,
  fonte         text default 'texto',               -- texto | audio | imagem
  texto_original text,
  criado_em     timestamptz not null default now()
);

-- Perfil/orçamento por usuário
create table if not exists public.perfis (
  autor         text primary key,
  orcamento     numeric(12,2) not null default 0,
  atualizado_em timestamptz not null default now()
);

-- Sessão do Baileys (Passo 2) — pra o QR sobreviver a restart do Render
create table if not exists public.baileys_auth (
  sessao        text not null,
  chave         text not null,                      -- 'creds' | 'pre-key-N' | 'session-X'
  dado          jsonb not null,
  atualizado_em timestamptz not null default now(),
  primary key (sessao, chave)
);

create index if not exists idx_lanc_autor_data on public.lancamentos (autor, data desc);
create index if not exists idx_auth_sessao     on public.baileys_auth (sessao);

-- ------------------------------------------------------------
-- Row Level Security
-- ------------------------------------------------------------
alter table public.lancamentos enable row level security;
alter table public.perfis      enable row level security;
alter table public.baileys_auth enable row level security;

-- recria as políticas (idempotente)
drop policy if exists "dono le seus lancamentos"   on public.lancamentos;
drop policy if exists "dono escreve seus lancamentos" on public.lancamentos;
drop policy if exists "dono atualiza seus lancamentos" on public.lancamentos;
drop policy if exists "dono le seu perfil"  on public.perfis;
drop policy if exists "dono grava seu perfil" on public.perfis;
drop policy if exists "dono atualiza seu perfil" on public.perfis;

create policy "dono le seus lancamentos" on public.lancamentos for select
  using (autor = auth.uid()::text);
create policy "dono escreve seus lancamentos" on public.lancamentos for insert
  with check (autor = auth.uid()::text);
create policy "dono atualiza seus lancamentos" on public.lancamentos for delete
  using (autor = auth.uid()::text);

create policy "dono le seu perfil" on public.perfis for select
  using (autor = auth.uid()::text);
create policy "dono grava seu perfil" on public.perfis for insert
  with check (autor = auth.uid()::text);
create policy "dono atualiza seu perfil" on public.perfis for update
  using (autor = auth.uid()::text);
