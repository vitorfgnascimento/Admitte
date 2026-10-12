-- Migração aditiva: direitos do titular (LGPD, art. 18) - pedidos de exclusão e
-- marca de ficha anonimizada. Seguro de rodar mais de uma vez.

create table if not exists solicitacoes_titular (
  id text primary key,
  usuario_id text not null,
  candidato_id text,
  tipo text not null default 'exclusao',            -- 'exclusao'
  status text not null default 'pendente',          -- 'pendente' | 'executada' | 'recusada'
  motivo_recusa text,
  criado_em timestamptz not null default now(),
  resolvido_em timestamptz,
  resolvido_por text
);
create index if not exists idx_solicitacoes_status on solicitacoes_titular(status);
create index if not exists idx_solicitacoes_usuario on solicitacoes_titular(usuario_id);

-- Fichas anonimizadas (a pedido do titular ou pela política de retenção).
alter table candidatos add column if not exists anonimizado_em timestamptz;

-- O RLS de solicitacoes_titular e ligado por ativar_rls.sql (com chave secret).
alter table solicitacoes_titular enable row level security;
revoke all on table solicitacoes_titular from anon, authenticated;
