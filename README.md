# OnboardingDigital

**Status do Projeto:** MVP em Desenvolvimento Ativo. Etapa 1 (Jornada e Ficha do Candidato) Concluída. Etapa 2 (Módulo do RH) Concluída. Etapa 3 (Documentação, LGPD e Preparação para Deploy) em consolidação. Etapa 4 (Autenticação e Contratação) em consolidação.

Sistema de admissão digital para coleta de aceite de documentos trabalhistas, com trilha de auditoria e conformidade com a LGPD.

O projeto centraliza os dados do candidato em uma ficha única e acompanha o andamento do processo admissional por um sistema de cores: vermelho para pendente, amarelo para em análise e verde para aprovado. Isso facilita a leitura rápida de pendências pelo time de RH.

Para cada aceite ou alteração realizada, o sistema registra um log de auditoria imutável, com IP, data e hora - atendendo aos requisitos da LGPD.

A interface também foi pensada com acessibilidade em mente, com HTML semântico e suporte a ferramentas de Libras como o VLibras.

## Arquitetura do Projeto

O MVP é dividido em dois módulos, servidos pelo mesmo backend Express e comunicando-se pela mesma API:

```
public/
  login.html    -> Autenticação: entrar, criar conta, entrar com o Google
  ficha.html    -> Módulo Candidato: ficha de admissão, upload de documentos, chat, banner de decisão, aceite de contrato
  rh.html       -> Módulo RH: painel de gestão, pendências, decisão final, contrato, exportação e impressão (acesso restrito)
  testes.html   -> bateria de testes automatizados contra a API em execução

index.js        -> servidor Express único, expõe as rotas dos módulos
db/supabase.js  -> cliente Supabase compartilhado (exige SUPABASE_URL e SUPABASE_SERVICE_KEY; aceita SUPABASE_KEY só em desenvolvimento)
supabase/       -> schema.sql + migrações SQL para criar/atualizar as tabelas

auditoria.json  -> trilha de auditoria (arquivo local, não versionado - LGPD)
uploads/        -> PDFs enviados pelos candidatos e contratos assinados (disco local, não versionado - LGPD)
relatorio_geral_admissoes.xlsx -> planilha Mestre, regenerada a cada gravação (não versionada - LGPD)
```

### Onde cada dado é guardado (persistência híbrida)

| Dado | Onde fica | Observação |
|---|---|---|
| Fichas, usuários, sessões, chat, etiquetas, configurações do RH | **Supabase** (Postgres) | Tabelas `candidatos`, `usuarios`, `sessoes`, `mensagens_chat`, `etiquetas`, `configuracoes`. Compartilhado: qualquer instância com as mesmas credenciais enxerga os mesmos dados. |
| Trilha de auditoria (`auditoria.json`) | **Disco local** | Fica na máquina/instância que rodou o servidor. |
| PDFs enviados, contratos assinados e ficha em PDF | **Armazenamento configurável** (`ARMAZENAMENTO_DRIVER`) | `local` (padrão): pasta `uploads/` do servidor. `supabase`: bucket privado do Supabase Storage, que persiste na Vercel. Veja "Armazenamento de arquivos". |
| Planilha Mestre (`.xlsx`) | **Disco local** | Gerada a partir do Supabase a cada gravação. |

> **Atenção (deploy na Vercel):** a Vercel é serverless e só permite gravar em `/tmp`, que é efêmero. Lá, `auditoria.json` e a planilha Mestre **não persistem** entre execuções (a trilha de auditoria ainda precisa migrar para uma tabela do Supabase - veja "Próximas fases"). Os PDFs persistem se `ARMAZENAMENTO_DRIVER=supabase`.

### Segurança: cabeçalhos, limites e testes

- **Cabeçalhos:** todas as respostas levam CSP, `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, `Permissions-Policy` e, em HTTPS, HSTS. A CSP libera só as origens usadas pelas telas (Google, VLibras, pdf.js, ViaCEP); ao adicionar um serviço externo, inclua a origem em `POLITICA_CSP` (`index.js`).
- **Limites de taxa:** login, cadastro, ativação, criação de ficha, envio de documentos e chat têm limite por IP ou usuário (variáveis `LIMITE_*` no `.env.example`).
- **Contas e dados:** senha de 8 a 72 caracteres com letras e números (fora de uma lista de senhas comuns); CPF validado pelos dígitos verificadores; campos de texto com limite de tamanho; IDs novos em UUID.
- **Sessões:** o token entregue ao navegador não é guardado: a tabela `sessoes` só tem o SHA-256 dele.
- **Gravações:** cada operação grava apenas as fichas/usuários alterados, evitando que ações simultâneas se desfaçam.
- **Bateria de testes de segurança:** `npm run teste:seguranca` sobe um banco falso e uma instância isolada (sem tocar no Supabase real) e confere cabeçalhos, autorização, acesso aos documentos, upload e limites. Itens do roadmap ainda não tratados aparecem como PENDENTE.

### Armazenamento de arquivos

Os PDFs passam por uma interface única (`storage/armazenamento.js`: `salvar`, `ler`, `existe`, `remover`), então trocar de plataforma é trocar o *driver*:

| `ARMAZENAMENTO_DRIVER` | Onde ficam os PDFs | Quando usar |
|---|---|---|
| `local` (padrão) | Pasta `uploads/` do servidor | Servidor próprio com disco persistente, desenvolvimento |
| `supabase` | Bucket privado do Supabase Storage | Vercel e demais ambientes sem disco persistente |

Para usar o driver `supabase`:

1. No SQL Editor, crie o bucket **privado**: `insert into storage.buckets (id, name, public) values ('documentos', 'documentos', false) on conflict (id) do nothing;`
2. Defina `ARMAZENAMENTO_DRIVER=supabase`. O bucket padrão é `documentos` (altere com `ARMAZENAMENTO_BUCKET`).
3. Use a mesma chave **secret/service_role** em `SUPABASE_SERVICE_KEY` (só no servidor, nunca no navegador). Sem ela, o driver usa `SUPABASE_KEY` e o bucket exigiria políticas de acesso.

Os PDFs não são servidos publicamente: o acesso é por URL assinada de 5 minutos (`POST /api/arquivos/assinar`), emitida só ao RH ou à conta dona da ficha. Defina `ARQUIVOS_SEGREDO` (16+ caracteres) para assinar essas URLs.

**Módulo Candidato** (`public/ficha.html`): formulário de dados pessoais com máscaras e validação estrita, upload dos 6 documentos obrigatórios, envio unificado da ficha, chat com o RH e reabertura pontual de documentos com pendência. Uma ficha já enviada pode ser revisitada pelo link `http://localhost:3001/ficha.html?id=<candidatoId>` (o antigo `/index.html` redireciona para `/ficha.html`).

> **Nota sobre testes/arquitetura:** o botão "Copiar link" do candidato, no Painel do RH, gera exatamente esse link direto (`?id=<candidatoId>`). É um **recurso utilitário exclusivo da versão MVP/Dev**, pensado para agilizar a validação de testes locais (acessar a ficha de um candidato específico sem precisar procurar o `id` manualmente). Ele **não deve fazer parte do fluxo de produção final**: o lançamento da busca por nome/CPF (ver Etapa 2) cobre essa necessidade de localizar um candidato de forma adequada para uso real, sem depender de compartilhar links com identificadores de ficha.

**Módulo RH** (`public/rh.html`): painel de gestão com cards de resumo, filtros por decisão, alteração de status, abertura de pendências, decisão final (Aprovar/Reprovar), chat, exportação de relatório em Excel (.xlsx) e impressão/PDF da ficha individual.

**Backend** (`index.js`): API REST em Express, upload de arquivos com Multer, dados cadastrais no Supabase (Postgres) e arquivos (PDFs, auditoria, planilha Mestre) em disco local - ver "Onde cada dado é guardado".

## Resumo técnico da Etapa 1

A interface do candidato está funcional, cobrindo:

- **Validações de formulário** - exigência de sobrenome e bloqueio de sequências repetidas de caracteres no nome, validação estrita de e-mail (formato e domínio), e verificação de CPF (11 dígitos), CEP (8 dígitos), WhatsApp (10 ou 11 dígitos) e data de nascimento (data de calendário real, não só o formato) tanto no frontend quanto no backend - a ficha não é aceita com nenhum campo obrigatório incompleto.
- **Máscaras dinâmicas** - formatação em tempo real de CPF, CEP, telefone/WhatsApp e data de nascimento durante a digitação, preservando a posição exata do cursor ao editar ou apagar caracteres no meio do texto.
- **Autopreenchimento de endereço via CEP (ViaCEP)** - ao completar o CEP, os campos de Logradouro e Bairro são preenchidos automaticamente pela API pública do ViaCEP; CEP inválido ou falha de rede libera o preenchimento manual com um aviso.
- **Validação estrita de PDF (10 MB)** - o frontend recusa qualquer arquivo acima de 10 MB antes mesmo de enviar (mensagem inline, sem travar a tela), e o backend aplica o mesmo limite via Multer, retornando 400 caso o frontend seja contornado.
- **Manipulação e exclusão de arquivos PDF** - anexo por arrastar-e-soltar em cada documento, exibição do nome do arquivo com botão de exclusão individual e rota de backend que remove o arquivo físico e limpa a referência.
- **Trava de segurança da ficha** - após a submissão unificada, a ficha entra em modo somente leitura: todos os campos, seletores, caixas de seleção e áreas de upload são bloqueados e um aviso confirma que a ficha está em análise pelo RH.

### Regras de negócio da jornada

- Barras expansíveis (accordion) na cor Verde Intelbras (#00A335), uma por documento obrigatório.
- "CPF incluso na Identidade": ao marcar, a barra do CPF é desabilitada e herda o status da Identidade.
- Certificado de Reservista: exigido apenas para o gênero Masculino; nos demais casos a barra é dispensada e marcada automaticamente como Aprovado (verde).

## Resumo técnico da Etapa 2

O Painel de Gestão do RH (`public/rh.html`) está em construção, cobrindo até aqui:

- **Cards de resumo estatístico** - Total de Fichas, Não avaliados, Em Análise e Aprovados, calculados em tempo real a partir das fichas recebidas.
- **Tabela de gestão** - lista as fichas com Nome do Candidato, CPF, Data de Envio e Status Atual.
- **Automação do status geral da ficha** - toda ficha nasce como "Não avaliado" (vermelho); o status muda sozinho para "Em Análise" (amarelo) na primeira interação do RH com ela - abrir um PDF, aceitar ou marcar pendência num documento, ou responder no chat (mensagem do próprio candidato não conta). Não existe mais botão manual de troca de status na tabela.
- **Ações individuais por documento** - em cada documento já enviado, dois botões: "Aceitar Documento" (verde, marca aquele documento como Aprovado) e "Marcar pendência / Exigir reenvio" (vermelho, com justificativa obrigatória - ver abaixo). Documento aceito mostra um selo "✓ Documento aceito".
- **Visualização/download de PDFs** - cada documento enviado abre num visualizador embutido em nova aba; documentos dispensados por regra ou ainda não enviados mostram "Não exigido"/"Pendente".
- **Reabertura pontual de pendências** - o RH marca um documento já enviado como "Com Pendência", com justificativa obrigatória; só aquele documento é liberado para reenvio na Ficha do Candidato (o resto continua travado), e a pendência se encerra automaticamente quando o candidato reenvia o PDF.
- **Chat RH ↔ Candidato** - conversa simples, com histórico persistido junto da ficha (ordenado por data/hora), disponível tanto no Painel do RH quanto na Ficha do Candidato (a partir do primeiro envio); Enter envia a mensagem, Shift+Enter quebra linha.
- **Decisão final do processo** - botões "Aprovar Candidato"/"Reprovar Candidato" no Painel do RH; a Ficha do Candidato exibe um banner de sucesso ou de agradecimento e trava totalmente para edição, sem exceção (nem pendências residuais reabrem campos).
- **Filtros e ordenação** - filtra a lista por Todos/Não avaliados/Em Análise/Aprovados/Reprovados; candidatos "Não avaliados" ficam sempre no topo. **Migração visual controlada:** aceitar um documento, marcar pendência ou abrir um PDF mudam o status real na hora, mas a tela só reflete a migração de aba/grupo quando a lista é recarregada de verdade (botão "Atualizar lista", troca de aba de filtro, ou ao expandir o painel de uma ficha) - evita a lista "pular" sozinha enquanto o RH está no meio de uma ação.
- **Busca por nome ou CPF** - campo de busca no topo do painel, com filtragem em tempo real (a cada tecla digitada) e combinável com o filtro ativo.
- **Exportação de relatório em Excel** - botão no cabeçalho da tabela baixa o arquivo `relatorio_geral_admissoes.xlsx` (uma aba "Relatório de Admissões", cabeçalho destacado, filtro automático e coluna de status colorida), sempre com todas as fichas do sistema, atualizado no momento do download. Inclui 23 colunas: dados cadastrais (Nome Completo, CPF, E-mail, Telefone, Gênero, CEP, Endereço, Número, Complemento), status e datas (Status Atual, Data de Submissão, Última Atualização), trilha de auditoria LGPD (Consentimento LGPD, Timestamp LGPD, IP LGPD), situação documental (Status Documentos, CPF no RG, Reservista), aceite do contrato (Aceite Contratual, Timestamp Aceite Contrato, Hash Contrato) e integração com sistema de ponto externo/B2B (Exportado Ponto, Sistema Ponto Alvo).
- **Relatório individual em PDF** - cada candidato tem um botão "Imprimir/Gerar PDF da Ficha" que gera, no backend (`pdfkit`), um PDF real com dados pessoais, documentos e declaração de consentimento LGPD com o timestamp real de submissão; o arquivo abre no visualizador de PDF embutido do navegador, de onde o RH baixa ou imprime pelos próprios controles do visualizador.
- **Copiar link do candidato** *(recurso MVP/Dev - ver nota na Arquitetura do Projeto)* - botão que copia o link direto da ficha de um candidato para a área de transferência.

Rotas do backend dedicadas ao painel: `GET /api/rh/fichas`, `PATCH /api/rh/fichas/:id/status`, `PATCH /api/rh/fichas/:id/documento/:tipo/pendencia`, `PATCH /api/rh/fichas/:id/documento/:tipo/aceitar`, `PATCH /api/rh/fichas/:id/documento/:tipo/visualizado`, `PATCH /api/rh/fichas/:id/decisao`, `GET /api/rh/exportar-relatorio` (download da planilha Excel; substituiu a antiga `/api/rh/exportar-csv`). Rotas compartilhadas com o candidato: `GET /api/candidato/:id` (retorno via link `?id=`) e `POST /api/candidato/:id/mensagens` (chat).

> **Massa de dados de testes:** a base (tabela `candidatos` no Supabase) mantém a candidata fictícia **"Maria Gadu"**, usada para validar manualmente o Painel do RH (e, na Etapa 4, o fluxo completo de login/aprovação/contrato). Ela não é recriada automaticamente no boot - é mantida manualmente. Como o Supabase é compartilhado, **quem usa as mesmas credenciais vê e altera os mesmos dados**: para testes pessoais, use um projeto Supabase próprio.

## Resumo técnico da Etapa 3 (em consolidação)

Foco em documentação, conformidade com a LGPD e preparação para publicar o MVP em um serviço de nuvem:

- **Trilha de auditoria (LGPD) ampliada** - além de alterações de status, pendências de documento e decisão final, agora **toda mensagem de chat** (RH ou candidato) também é registrada em `auditoria.json` com timestamp ISO e IP de origem da requisição; a própria mensagem, em `candidatos.json`, também carrega seu IP de origem.
- **Porta configurável via `PORT`** - o servidor lê `process.env.PORT` (padrão das plataformas de deploy em nuvem, como Render e Railway, que injetam essa variável automaticamente), caindo para `3001` em execução local. Arquivo `.env.example` documenta a variável.
- **README consolidado** - arquitetura completa do projeto, todas as funcionalidades das Etapas 1 e 2 documentadas, e as duas formas de rodar localmente.

## Resumo técnico da Etapa 4 (em consolidação)

Módulo de Autenticação e Contratação:

- **Login e Registro** (`public/login.html`) - entrar com e-mail/senha, criar conta, ou entrar com o Google (Google Identity Services). Senhas usam hash `bcrypt` (via `bcryptjs`, nunca texto puro); sessão via token opaco (`Authorization: Bearer`), persistido na tabela `sessoes` do Supabase (7 dias de validade). A confirmação do cadastro é simulada: fora de produção, a API devolve o link de ativação (usado pelo modal de teste do login); com `NODE_ENV=production` o link **não** é devolvido (só aparece no log do servidor), porque o envio real de e-mail ainda não existe - nesse ambiente, contas novas entram pelo Google ou são ativadas por quem opera o servidor.
- **Google Sign-In** requer uma credencial OAuth real (`GOOGLE_CLIENT_ID`, ver `.env.example`) gerada no Google Cloud Console pelo Líder de Projeto; sem ela, o botão aparece desabilitado com o aviso "Login com Google indisponível no momento". Veja o passo a passo em [Login com o Google](#login-com-o-google). Ao entrar pelo Google, o nome e a foto da conta Google são usados no perfil.
- **Foto de perfil** - candidatos (card "Seu perfil" na ficha) e RH (Configurações) podem enviar uma foto, recortada e reduzida no navegador (JPEG ~256x256, até 200 KB) e guardada em `usuarios.foto` / `configuracoes.foto_rh`. A foto do candidato aparece para o RH e a do RH para os candidatos. Migração: `supabase/migracao_fotos_mensagem_contratacao.sql`.
- **Mensagem de contratação concluída** - título e texto do card exibido ao candidato contratado são editáveis em Configurações do RH.
- **Primeira página** - `/` e qualquer página restrita sem sessão levam ao login, que devolve o usuário à página pedida (somente caminhos internos do mesmo tipo de conta).
- **Autopreenchimento da ficha** - Nome e E-mail são preenchidos automaticamente a partir do perfil autenticado ao abrir `public/ficha.html` (campos continuam editáveis).
- **Vínculo ficha ↔ perfil** - toda ficha criada por um candidato logado grava `usuarioId`; `GET /api/auth/minhas-fichas` devolve só as fichas do usuário autenticado. O acesso direto por link (`?id=`) continua funcionando por compatibilidade com o recurso "Copiar link" do RH.
- **Painel do RH protegido** - `public/rh.html` exige sessão do tipo `rh`; sem ela, redireciona para o login. As rotas `/api/rh/*` exigem o mesmo token no backend.
- **Aceite Virtual de Contratos por Clique (Assinatura Eletrônica Simples)** - liberado para fichas com status `APROVADO`: lista de documentos (Contrato de Trabalho, Termo de Confidencialidade, Política de Privacidade/LGPD), cada um com download da minuta e um botão "Li e Aceito os Termos" próprio. O botão unificado "Concluir Assinatura Digital" só libera quando todos os documentos forem aceitos, e grava timestamp ISO, IP, CPF e um hash SHA-256 das minutas na auditoria. O Painel do RH ganha o card "Contrato de Trabalho - Aceite Digital" (mesmo layout dos cards de documento) com o botão "Validar Contratação", que move o status para o estado terminal `CONTRATACAO_CONCLUIDA`.

> **Conta de RH de testes:** semeada de forma idempotente no boot do servidor (não recriada se já existir) - `rh@onboarding.local` / `onboarding123`. A senha é pública de propósito, para que qualquer pessoa consiga testar a aplicação; para usar outra, defina `SENHA_RH_TESTE` no ambiente (vale também para uma conta de RH já existente, após reiniciar). O formulário público de registro sempre cria contas do tipo `candidato`.

## Funcionalidades adicionais do painel do RH

Recursos incluídos depois das Etapas 1 a 4 (cobertos pelas migrações em `supabase/`):

- **Banco de Talentos** - candidatos podem ser arquivados (saem da lista ativa) e reativados; a ficha guarda `banco_talentos` e a data do arquivamento.
- **Etiquetas** - catálogo de etiquetas coloridas (estilo Trello), com nome e cor editáveis, anexáveis a várias fichas; editar uma etiqueta reflete em todas as fichas que a usam.
- **Configurações do RH** - mensagem de boas-vindas, documentos obrigatórios, e-mail de contato do RH, foto do RH e mensagem de contratação concluída.
- **Planilha Mestre** - `relatorio_geral_admissoes.xlsx` é regenerada a cada gravação de ficha, e também no boot.
- **Relatório do painel em PDF** - `GET /api/relatorio/dashboard-pdf`.
- **API REST v1 para sistemas externos (B2B)** - `GET /api/v1/admissoes`, protegida por API Key (header `x-api-key` ou `Authorization: Bearer <chave>`). Defina `API_KEY_ADMISSOES` (mínimo de 16 caracteres) no ambiente; sem ela a API fica desativada e responde 503 - não existe chave padrão.

## Papéis, contas e recuperação de senha

| Papel | Quem é | O que acessa |
|---|---|---|
| `master` | Dono da plataforma (externo) | `/master.html`: cria e gerencia as contas **admin** dos clientes. **Não** acessa fichas nem documentos de candidatos |
| `admin` | Administrador da empresa contratante | Todo o painel do RH (`/rh.html`) + `/admin.html`: cria, desativa e reenvia acesso dos **operadores** |
| `rh` | Operador do RH da empresa | Painel do RH (`/rh.html`) |
| `candidato` | Quem está sendo admitido | A própria ficha (`/ficha.html`) |

- **Conta master:** definida no ambiente do servidor (`MASTER_EMAIL` e `MASTER_SENHA`, senha de 12+ caracteres), nunca no código nem no banco de testes. Sem essas variáveis ela não existe.
- **Contas novas (admin e operador):** criadas sem senha. O titular recebe por e-mail um link e uma **senha temporária**; em `/recuperar-senha.html` informa a senha temporária, a nova senha e a confirmação. O link e a senha temporária valem 30 minutos e só funcionam juntos.
- **Esqueci minha senha:** botão na tela de login. Envia o mesmo link + senha temporária para o e-mail cadastrado; a resposta é igual exista a conta ou não. Trocar a senha encerra as sessões abertas.
- **E-mail:** configure `SMTP_URL` (ou `SMTP_HOST`/`SMTP_PORT`/`SMTP_USER`/`SMTP_PASS`), `EMAIL_REMETENTE` e `APP_URL`. Sem SMTP o envio é simulado no log do servidor e, fora de produção, o link e a senha temporária aparecem na tela para teste.
- **Banco:** rode `supabase/migracao_recuperacao_senha.sql` (tabela `recuperacoes_senha`, só com hashes).

## Conformidade LGPD nos 3 Momentos da Jornada

- **Momento 1 (login.html):** frase + link "Termos de privacidade" (pop-up) ao lado do botão "Criar Conta"; o servidor exige o aceite (`aceiteTermos`) e grava `consentimentoCadastro` no usuário.
- **Momento 2 (ficha.html):** frase "Ao continuar você concorda com as políticas de privacidade e os termos de uso" + link "Termos de privacidade" (pop-up com finalidade, base legal, consentimento e direitos do art. 18) ao lado do botão de envio; backend grava `consentimentoFichaLGPD` na ficha.
- **Momento 3 (ficha.html):** a mesma frase e link ao lado do botão que conclui a assinatura digital (o pop-up traz a cláusula sobre a validade da assinatura eletrônica); backend grava `consentimentoContratoLGPD` (com hash SHA-256 das minutas) na ficha.
- **Painel do RH (rh.html):** card "Trilha de Auditoria e Conformidade LGPD" mostra o status dos dois consentimentos (data/hora e IP) e um botão "Visualizar Log de Auditoria" que exibe o JSON bruto dos eventos daquela ficha (`GET /api/rh/fichas/:id/auditoria`).

## Próximas fases do roteiro de desenvolvimento

- Mover a trilha de auditoria para uma tabela no Supabase, para que persista em ambientes serverless (pré-requisito do deploy). Os PDFs já têm persistência via `ARMAZENAMENTO_DRIVER=supabase`.
- Deploy do MVP em nuvem (a configuração atual já inclui `vercel.json`; Render/Railway continuam possíveis via a variável `PORT`).
- Gestão de credenciais reais do Google OAuth para o ambiente de produção.
- URLs amigáveis sem `.html` (planejado no roadmap, mantido fora do repositório).

## Como Executar o Projeto Localmente

### Pré-requisitos
- Git instalado na máquina
- **Um projeto Supabase** (gratuito) com as tabelas criadas - veja "Configurar o Supabase" abaixo. Sem `SUPABASE_URL` e uma chave (`SUPABASE_SERVICE_KEY`, ou `SUPABASE_KEY` em desenvolvimento) o servidor não inicia.
- Opção 1: Docker e Docker Compose instalados
- Opção 2: Node.js **22 ou superior** instalado na máquina (exigido pelas dependências `@supabase/supabase-js` e `google-auth-library`)

### Clonar o repositório

```bash
git clone https://github.com/vitorfgnascimento/OnboardingDigital.git
cd OnboardingDigital
```

### Variáveis de ambiente (opcional)

Copie `.env.example` para `.env` e preencha ao menos `SUPABASE_URL` e `SUPABASE_SERVICE_KEY` (para conferir que a chave pública não acessa o banco: `npm run verificar:rls`):

```bash
cp .env.example .env
```

| Variável | Padrão | Descrição |
|---|---|---|
| `SUPABASE_URL` | *(obrigatória)* | URL do projeto Supabase (Project Settings > API). |
| `SUPABASE_SERVICE_KEY` | *(obrigatória em produção)* | Chave **secret/service_role** do projeto. Só no servidor (`.env` ou variável da plataforma), nunca no navegador nem no Git. Com ela, o RLS fica ligado e a chave pública não acessa nada. |
| `SUPABASE_KEY` | *(opcional)* | Chave pública (`anon`/`publishable`). Só é usada se `SUPABASE_SERVICE_KEY` não estiver definida (modo de desenvolvimento, com aviso no log). |
| `API_KEY_ADMISSOES` | *(vazia = API desativada)* | Chave da API REST v1 (`/api/v1/admissoes`), mínimo de 16 caracteres. |
| `ARMAZENAMENTO_DRIVER` | `local` | Onde ficam os PDFs: `local` ou `supabase` (ver "Armazenamento de arquivos"). |
| `ARMAZENAMENTO_BUCKET` | `documentos` | Nome do bucket privado, quando o driver é `supabase`. |
| `SUPABASE_SERVICE_KEY` | *(vazia)* | Chave secret/service_role, só no servidor, usada pelo driver `supabase`. |
| `ARQUIVOS_SEGREDO` | *(deriva da chave do Supabase)* | Segredo (16+ caracteres) que assina as URLs de acesso aos PDFs. |
| `SENHA_RH_TESTE` | `onboarding123` | Senha da conta de RH de testes `rh@onboarding.local`. Opcional: define outra senha (e a aplica a uma conta já existente ao reiniciar). |
| `PORT` | `3001` | Porta em que o servidor escuta. Injetada automaticamente por plataformas de deploy em nuvem (Render, Railway, etc.). |
| `GOOGLE_CLIENT_ID` | *(vazio)* | Client ID OAuth 2.0 do Google (Google Cloud Console), necessário para o botão "Entrar com o Google" funcionar de verdade. Sem ela, o botão fica desabilitado e a rota `/api/auth/google` responde 400. |

### Configurar o Supabase

1. Crie um projeto em [supabase.com](https://supabase.com) e copie a **URL** e a chave **anon public** (Project Settings > API) para o `.env`.
2. No **SQL Editor**, execute os arquivos da pasta `supabase/` nesta ordem:
   1. `schema.sql` - tabelas base (`usuarios`, `sessoes`, `candidatos`, `mensagens_chat`)
   2. `migracao_banco_talentos_configuracoes.sql` - Banco de Talentos e Configurações do RH
   3. `migracao_etiquetas.sql` - etiquetas
   4. `migracao_fotos_mensagem_contratacao.sql` - fotos de perfil e mensagem de contratação
   4b. `migracao_recuperacao_senha.sql` - recuperação/definição de senha (tabela `recuperacoes_senha`)
   5. `ativar_rls.sql` - **liga o RLS** nas 6 tabelas, sem políticas: só o servidor (chave secret) acessa o banco. Aplique somente depois que o servidor já estiver rodando com `SUPABASE_SERVICE_KEY`.
3. Para testes pessoais, use um projeto Supabase próprio, para não alterar dados compartilhados.

### Login com o Google

1. Acesse o [Google Cloud Console](https://console.cloud.google.com/), crie (ou escolha) um projeto e abra **APIs e Serviços > Tela de consentimento OAuth** para configurá-la (tipo externo; basta nome do app e e-mail de contato).
2. Em **APIs e Serviços > Credenciais > Criar credenciais > ID do cliente OAuth**, escolha o tipo **Aplicativo da Web**.
3. Em **Origens JavaScript autorizadas**, adicione `http://localhost:3001` (desenvolvimento) e o domínio de produção da Vercel (ex.: `https://seu-projeto.vercel.app`). Não é preciso informar URIs de redirecionamento.
4. Copie o **ID do cliente** (termina em `.apps.googleusercontent.com`) e defina `GOOGLE_CLIENT_ID` no arquivo `.env` (local) e em **Settings > Environment Variables** do projeto na Vercel (depois faça um novo deploy).
5. Reinicie o servidor: o botão "Entrar com o Google" passa a funcionar. Contas novas viram candidatos; se o e-mail do Google já existir no sistema, a conta é reaproveitada.

### Opção 1 (Docker)

> O contêiner lê as variáveis do arquivo `.env` da raiz (via `env_file` no `docker-compose.yml`); o `.env` não é copiado para dentro da imagem. Crie-o antes (ver "Variáveis de ambiente"). A imagem usa Node 22.

1. Subir a aplicação em um contêiner:
```bash
docker compose up --build
```

2. Acessar a aplicação no navegador: `http://localhost:3001`

### Opção 2 (Node.js - recomendada hoje)

1. Instalar as dependências do projeto:
```bash
npm install
```

2. Iniciar o servidor local:
```bash
node index.js
```

3. Acessar a aplicação no navegador: `http://localhost:3001`

## Tecnologias

Node.js, Express e Multer no backend (`bcryptjs` para senhas, `pdfkit` e `exceljs` para relatórios, `google-auth-library` para o login Google); HTML5, CSS3 e JavaScript puro (Vanilla JS) no frontend; Supabase (Postgres) para os dados e disco local para PDFs e auditoria; Git e GitHub para versionamento; Docker e Docker Compose para conteinerização; Vercel como alvo de deploy.

## Licença

MIT
