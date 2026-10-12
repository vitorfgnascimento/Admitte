-- Migração aditiva: recuperação/definição de senha por link + senha temporária.
-- Guarda apenas HASHES: o token do link (SHA-256) e a senha temporária (bcrypt).
-- Seguro de rodar mais de uma vez.

create table if not exists recuperacoes_senha (
  id text primary key,
  usuario_id text not null references usuarios(id) on delete cascade,
  token_hash text not null,
  senha_temp_hash text not null,
  finalidade text not null default 'recuperacao',  -- 'recuperacao' | 'definicao' (acesso inicial)
  tentativas integer not null default 0,
  usado boolean not null default false,
  criado_em bigint not null,
  expira_em bigint not null
);
create index if not exists idx_recuperacoes_token on recuperacoes_senha(token_hash);
create index if not exists idx_recuperacoes_usuario on recuperacoes_senha(usuario_id);

-- O RLS desta tabela e ligado, junto com o das demais, por ativar_rls.sql: aplique
-- aquele arquivo depois que o servidor estiver usando SUPABASE_SERVICE_KEY.
