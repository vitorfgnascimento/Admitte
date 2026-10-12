-- Liga o Row Level Security (RLS) em todas as tabelas, SEM nenhuma política.
--
-- Efeito: a chave pública do projeto (anon/publishable) deixa de ler ou gravar
-- qualquer linha pela API REST. Somente o servidor Express, que usa a chave
-- secret/service_role (SUPABASE_SERVICE_KEY, que ignora o RLS), acessa o banco.
--
-- ORDEM: aplique este arquivo SOMENTE depois de o servidor (local e produção)
-- já estar rodando com SUPABASE_SERVICE_KEY definida. Se o aplicativo ainda
-- estiver usando a chave pública, todas as leituras e gravações passam a falhar.
--
-- Seguro de rodar mais de uma vez.

alter table usuarios       enable row level security;
alter table sessoes        enable row level security;
alter table candidatos     enable row level security;
alter table mensagens_chat enable row level security;
alter table etiquetas      enable row level security;
alter table configuracoes  enable row level security;
alter table recuperacoes_senha enable row level security;
alter table auditoria      enable row level security;
alter table solicitacoes_titular enable row level security;
alter table limites_taxa enable row level security;

-- Reforço: remove também as permissões diretas dos papéis públicos da API.
revoke all on table usuarios, sessoes, candidatos, mensagens_chat, etiquetas, configuracoes,
  recuperacoes_senha, auditoria, solicitacoes_titular, limites_taxa
  from anon, authenticated;
