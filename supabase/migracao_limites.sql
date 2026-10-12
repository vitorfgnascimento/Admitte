-- Migração aditiva: limites de taxa COMPARTILHADOS entre instâncias (réplicas e
-- serverless somam as mesmas tentativas). A chave guardada é o SHA-256 do
-- IP/e-mail/id: nenhum dado pessoal fica nesta tabela. Seguro de rodar mais de
-- uma vez. Sem esta migração o sistema continua funcionando, com o contador em
-- memória de cada instância.

create table if not exists limites_taxa (
  chave text primary key,
  contagem integer not null,
  expira_em bigint not null
);
create index if not exists idx_limites_expira on limites_taxa(expira_em);

-- Incremento atômico: reinicia a janela quando vence e soma 1 senão.
create or replace function incrementar_limite(p_chave text, p_agora bigint, p_fim bigint)
returns table (contagem integer, expira_em bigint)
language plpgsql as $$
begin
  return query
  insert into limites_taxa as l (chave, contagem, expira_em)
  values (p_chave, 1, p_fim)
  on conflict (chave) do update set
    contagem = case when l.expira_em <= p_agora then 1 else l.contagem + 1 end,
    expira_em = case when l.expira_em <= p_agora then p_fim else l.expira_em end
  returning l.contagem, l.expira_em;
end;
$$;

-- RLS ligado e sem políticas, como as demais tabelas: só o servidor (chave
-- secret) acessa. A função não é exposta às chaves públicas.
alter table limites_taxa enable row level security;
revoke all on table limites_taxa from anon, authenticated;
revoke all on function incrementar_limite(text, bigint, bigint) from public, anon, authenticated;