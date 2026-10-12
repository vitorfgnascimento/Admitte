-- Migração aditiva: verificação em duas etapas (TOTP) para rh, admin e master.
-- Seguro de rodar mais de uma vez. O segredo fica cifrado pelo servidor
-- (AES-256-GCM) e os códigos de recuperação só existem como hash.

alter table usuarios add column if not exists mfa_ativo boolean not null default false;
alter table usuarios add column if not exists mfa_segredo text;
alter table usuarios add column if not exists mfa_codigos jsonb not null default '[]'::jsonb;
alter table usuarios add column if not exists mfa_ultimo_passo bigint not null default 0;
