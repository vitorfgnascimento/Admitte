-- Migração aditiva: trilha de auditoria (LGPD) em tabela SOMENTE DE ACRÉSCIMO.
-- Substitui o auditoria.json local, que se perdia em ambientes sem disco
-- persistente (ex.: Vercel). Seguro de rodar mais de uma vez.

create table if not exists auditoria (
  id text primary key,
  tipo_evento text not null,
  usuario_id text,
  candidato_id text,
  ip text,
  ocorrido_em timestamptz not null default now(),
  dados jsonb not null default '{}'::jsonb
);
create index if not exists idx_auditoria_candidato on auditoria(candidato_id);
create index if not exists idx_auditoria_usuario on auditoria(usuario_id);
create index if not exists idx_auditoria_ocorrido on auditoria(ocorrido_em desc);

-- Imutabilidade: o banco recusa alterar, apagar ou truncar eventos (vale
-- também para a chave secret). Para expurgar por prazo de retenção, é preciso
-- desativar o gatilho conscientemente, com acesso de administrador do banco.
create or replace function auditoria_somente_acrescimo() returns trigger
language plpgsql as $$
begin
  raise exception 'A tabela auditoria e somente de acrescimo (append-only).';
end;
$$;

create or replace trigger trg_auditoria_sem_alteracao
  before update or delete on auditoria
  for each row execute function auditoria_somente_acrescimo();

create or replace trigger trg_auditoria_sem_truncate
  before truncate on auditoria
  for each statement execute function auditoria_somente_acrescimo();

-- O RLS desta tabela e ligado, junto com o das demais, por ativar_rls.sql: aplique
-- aquele arquivo depois que o servidor estiver usando SUPABASE_SERVICE_KEY.
