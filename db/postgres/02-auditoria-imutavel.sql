-- Trilha de auditoria SOMENTE DE ACRÉSCIMO: o banco recusa alterar, apagar ou
-- truncar eventos, mesmo para o usuário da aplicação. Para expurgar por prazo
-- de retenção é preciso desativar o gatilho conscientemente, como administrador
-- do banco. Requer PostgreSQL 14 ou superior.

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
