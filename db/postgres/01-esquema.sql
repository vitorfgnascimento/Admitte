-- Esquema completo para Postgres PRÓPRIO (BANCO_DRIVER=postgres), sem Supabase.
-- Equivale a supabase/schema.sql + todas as migrações, sem RLS (o acesso é só
-- do servidor, com o usuário do banco definido em DATABASE_URL).
-- Seguro de rodar mais de uma vez.

create table if not exists usuarios (
  id text primary key,
  nome text not null,
  email text not null unique,
  senha_salt text,
  senha_hash text,
  tipo text not null default 'candidato',
  google_id text,
  cpf text,
  data_nascimento text,
  ativo boolean not null default true,
  token_ativacao text,
  consentimento_cadastro jsonb,
  foto text,
  mfa_ativo boolean not null default false,
  mfa_segredo text,
  mfa_codigos jsonb not null default '[]'::jsonb,
  mfa_ultimo_passo bigint not null default 0,
  criado_em timestamptz not null default now()
);

create table if not exists sessoes (
  token text primary key,
  usuario_id text not null references usuarios(id) on delete cascade,
  criado_em bigint not null,
  expira_em bigint not null
);

create table if not exists candidatos (
  id text primary key,
  nome_completo text,
  cpf text,
  email text,
  whatsapp text,
  genero text,
  cep text,
  logradouro text,
  bairro text,
  numero text,
  complemento text,
  data_nascimento text,
  status text not null default 'EM_ANALISE',
  cpf_incluso_na_identidade boolean default false,
  documentos jsonb,
  decisao_final text,
  decisao_final_em timestamptz,
  usuario_id text references usuarios(id) on delete set null,
  contrato jsonb,
  consentimento_ficha_lgpd jsonb,
  consentimento_contrato_lgpd jsonb,
  integracao_ponto jsonb,
  ficha_pdf text,
  banco_talentos boolean not null default false,
  banco_talentos_em timestamptz,
  tags jsonb not null default '[]'::jsonb,
  anonimizado_em timestamptz,
  criado_em timestamptz not null default now(),
  atualizado_em timestamptz not null default now()
);

create table if not exists mensagens_chat (
  id text primary key,
  candidato_id text not null references candidatos(id) on delete cascade,
  autor text not null,
  nome_autor text,
  texto text not null,
  "timestamp" timestamptz not null default now(),
  ip text
);
create index if not exists idx_mensagens_chat_candidato on mensagens_chat(candidato_id);

create table if not exists configuracoes (
  id text primary key,
  mensagem_boas_vindas text,
  documentos_obrigatorios jsonb,
  email_contato_rh text,
  foto_rh text,
  titulo_contratacao_concluida text,
  mensagem_contratacao_concluida text,
  atualizado_em timestamptz not null default now()
);

insert into configuracoes (id, mensagem_boas_vindas, documentos_obrigatorios, email_contato_rh)
values (
  'geral',
  'Bem-vindo(a) ao processo admissional! Preencha seus dados e anexe os documentos solicitados para dar andamento à sua contratação.',
  '{"identidade":true,"cpf":true,"comprovanteResidencia":true,"comprovanteEscolaridade":true,"reservista":true,"carteiraTrabalho":true}'::jsonb,
  ''
)
on conflict (id) do nothing;

create table if not exists etiquetas (
  id text primary key,
  nome text not null default '',
  cor text not null,
  criado_em timestamptz not null default now(),
  atualizado_em timestamptz not null default now()
);

create table if not exists recuperacoes_senha (
  id text primary key,
  usuario_id text not null references usuarios(id) on delete cascade,
  token_hash text not null,
  senha_temp_hash text not null,
  finalidade text not null default 'recuperacao',
  tentativas integer not null default 0,
  usado boolean not null default false,
  criado_em bigint not null,
  expira_em bigint not null
);
create index if not exists idx_recuperacoes_token on recuperacoes_senha(token_hash);
create index if not exists idx_recuperacoes_usuario on recuperacoes_senha(usuario_id);

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
create index if not exists idx_auditoria_ocorrido on auditoria(ocorrido_em);

create table if not exists solicitacoes_titular (
  id text primary key,
  usuario_id text not null,
  candidato_id text,
  tipo text not null default 'exclusao',
  status text not null default 'pendente',
  motivo_recusa text,
  criado_em timestamptz not null default now(),
  resolvido_em timestamptz,
  resolvido_por text
);
create index if not exists idx_solicitacoes_status on solicitacoes_titular(status);
create index if not exists idx_solicitacoes_usuario on solicitacoes_titular(usuario_id);
