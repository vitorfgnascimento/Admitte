// Bateria de testes de segurança, repetível e isolada.
//
//   npm run teste:seguranca
//
// Sobe um Supabase FALSO (scripts/supabase-falso.js) e uma instância do
// servidor em portas e pasta de dados temporárias: nada toca o Supabase real
// nem a pasta uploads/ do projeto. Para testar uma instância já em execução:
//   TESTE_BASE=http://localhost:3001 node scripts/teste-seguranca.js
//
// Cada teste cita o item do roadmap (ex.: "2.1"). Testes marcados como
// PENDENTE cobrem itens ainda não tratados e não derrubam a bateria.
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const RAIZ = path.join(__dirname, '..');
const PORTA_FALSO = 54330;
const PORTA_APP = 3010;
const PORTA_PROD = 3011;
const POSTGRES = process.env.TESTE_DRIVER === 'postgres';
let BASE_PROD = null;
const processos = [];
let pastaTemp = null;

const resultados = [];
function t(item, grupo, nome, ok, detalhe, pendente = false) {
  resultados.push({ item, grupo, nome, ok: !!ok, detalhe: detalhe === undefined ? '' : String(detalhe), pendente });
}

async function aguardar(url, tentativas = 120) {
  for (let i = 0; i < tentativas; i += 1) {
    try { const r = await fetch(url); if (r.status < 500) return; } catch (e) { /* ainda subindo */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('Servidor não respondeu em ' + url);
}

async function iniciarAmbiente() {
  pastaTemp = fs.mkdtempSync(path.join(os.tmpdir(), 'onboarding-teste-'));
  const falso = spawn(process.execPath, [path.join(__dirname, 'supabase-falso.js')], {
    env: { ...process.env, FALSO_PORTA: String(PORTA_FALSO) }, stdio: 'ignore'
  });
  processos.push(falso);
  await aguardar(`http://127.0.0.1:${PORTA_FALSO}/__objetos`);

  // TESTE_DRIVER=postgres: o servidor roda com o driver Postgres (db/repositorio-pg.js)
  // sobre um Postgres em memória (pg-mem), com o mesmo esquema do banco do cliente.
  const argumentosApp = POSTGRES ? [path.join(__dirname, 'app-postgres-teste.js')] : ['index.js'];
  const extraPg = (porta) => (POSTGRES ? { BANCO_DRIVER: 'postgres', DATABASE_URL: 'postgres://teste@memoria/teste', PORTA_TESTE: String(porta) } : {});
  const app = spawn(process.execPath, argumentosApp, {
    cwd: RAIZ,
    env: {
      ...process.env,
      ...extraPg(PORTA_APP),
      NODE_ENV: 'test', PORT: String(PORTA_APP), DIRETORIO_DADOS: pastaTemp,
      SUPABASE_URL: `http://127.0.0.1:${PORTA_FALSO}`, SUPABASE_KEY: 'chave-de-teste', SUPABASE_SERVICE_KEY: '',
      ARMAZENAMENTO_DRIVER: 'local', SENHA_RH_TESTE: '', API_KEY_ADMISSOES: 'chave-api-de-teste-0123456789',
      MASTER_EMAIL: 'master@exemplo.test', MASTER_SENHA: 'Master-Senha-Forte-123',
      LIMITE_MFA_15MIN: '200', LIMITE_CADASTROS_HORA: '20', LIMITE_FICHAS_HORA: '12', LIMITE_UPLOADS_HORA: '200', LIMITE_MENSAGENS_10MIN: '200'
    },
    stdio: 'ignore'
  });
  processos.push(app);
  await aguardar(`http://localhost:${PORTA_APP}/login.html`);

  // Segunda instância, em MODO PRODUÇÃO (NODE_ENV=production), no mesmo banco falso.
  const argumentosProd = POSTGRES ? [path.join(__dirname, 'app-postgres-teste.js')] : ['-e', `require('./index.js').listen(${PORTA_PROD})`];
  const prod = spawn(process.execPath, argumentosProd, {
    cwd: RAIZ,
    env: {
      ...process.env,
      ...extraPg(PORTA_PROD),
      NODE_ENV: 'production', DIRETORIO_DADOS: pastaTemp, MFA_OBRIGATORIO: '1', LIMITE_CADASTROS_HORA: '1000', LIMITE_RECUPERACOES_IP_HORA: '1000',
      MARCA_NOME: 'Acme <b>RH', MARCA_LOGO_URL: 'https://cdn.exemplo.test/logo.svg', MARCA_COR: '#1E40AF',
      SUPABASE_URL: `http://127.0.0.1:${PORTA_FALSO}`, SUPABASE_KEY: 'chave-de-teste', SUPABASE_SERVICE_KEY: '',
      ARMAZENAMENTO_DRIVER: 'local', SENHA_RH_TESTE: '', MASTER_EMAIL: '', MASTER_SENHA: ''
    },
    stdio: 'ignore'
  });
  processos.push(prod);
  await aguardar(`http://localhost:${PORTA_PROD}/login.html`);
  BASE_PROD = `http://localhost:${PORTA_PROD}`;
  return `http://localhost:${PORTA_APP}`;
}

function encerrarAmbiente() {
  processos.forEach((p) => { try { p.kill(); } catch (e) { /* já encerrado */ } });
  if (pastaTemp) { try { fs.rmSync(pastaTemp, { recursive: true, force: true }); } catch (e) { /* ignora */ } }
}

async function suite(BASE, urlFalso) {
  const J = { 'Content-Type': 'application/json' };
  const req = (m, p, { token, body, form, headers } = {}) => fetch(BASE + p, {
    method: m,
    headers: Object.assign({}, form ? {} : (body ? J : {}), token ? { Authorization: 'Bearer ' + token } : {}, headers || {}),
    body: form || (body ? JSON.stringify(body) : undefined)
  });
  const sufixo = Date.now().toString(36);
  const senhaOk = 'Senha-Teste-123';
  const ficha = (extra = {}) => Object.assign({
    nomeCompleto: 'Fulano de Tal', dataNascimento: '10/05/1990', cpf: '123.456.789-09', cep: '01310-930',
    logradouro: 'Av Teste', bairro: 'Centro', numero: '100', complemento: '', email: 'f@exemplo.test',
    whatsapp: '(11) 98765-4321', genero: 'Feminino', consentimentoLGPD: true
  }, extra);
  const pdfForm = (tipo, conteudo, nome = 'doc.pdf') => {
    const f = new FormData(); f.append('tipoDocumento', tipo);
    f.append('arquivo', new File([conteudo], nome, { type: 'application/pdf' })); return f;
  };
  const novaConta = async (email) => {
    const r = await (await req('POST', '/api/auth/registrar', { body: { nome: 'Pessoa Teste', email, senha: senhaOk, confirmarSenha: senhaOk, dataNascimento: '01/01/1990', cpf: '529.982.247-25', aceiteTermos: true } })).json();
    return (await (await req('POST', '/api/auth/ativar', { body: { token: r.tokenAtivacao } })).json()).token;
  };

  // ---- contas e fichas usadas pelos testes (antes dos testes de limite) ----
  const rh = (await (await req('POST', '/api/auth/login', { body: { email: 'rh@onboarding.local', senha: 'onboarding123' } })).json()).token;
  const dono = await novaConta(`dono${sufixo}@exemplo.test`);
  const outro = await novaConta(`outro${sufixo}@exemplo.test`);
  const id = (await (await req('POST', '/api/candidato', { token: dono, body: ficha({ email: `dono${sufixo}@exemplo.test` }) })).json()).candidato.id;
  const up = await (await req('POST', `/api/candidato/${id}/documento`, { token: dono, form: pdfForm('identidade', '%PDF-1.4\nSIGILOSO\n%%EOF') })).json();
  const arquivo = up.candidato.documentos.identidade.arquivo;

  // ---- 5.1 Portabilidade: todo acesso ao banco passa por db/repositorio.js ----
  const fontePrincipal = fs.readFileSync(path.join(RAIZ, 'index.js'), 'utf8');
  t('5.1', 'Portabilidade', 'index.js não chama o Supabase diretamente (só db/repositorio.js)', !/supabase\.(from|rpc|storage|auth)\b/.test(fontePrincipal) && !/require\(['"]\.\/db\/supabase['"]\)/.test(fontePrincipal), '');
  const fonteRepo = fs.readFileSync(path.join(RAIZ, 'db', 'repositorio-supabase.js'), 'utf8');
  const exportadas = (/module\.exports = \{([\s\S]*)\};/.exec(fonteRepo) || [, ''])[1].split(',').map((s) => s.replace(/driver: 'supabase'|\s/g, '')).filter(Boolean);
  const usadas = [...new Set([...fontePrincipal.matchAll(/\brepo\.([a-zA-Z]+)\(/g)].map((m) => m[1]))];
  t('5.1', 'Portabilidade', 'Toda função usada via repo.* existe no repositório', usadas.every((u) => exportadas.includes(u)), usadas.filter((u) => !exportadas.includes(u)).join(','));
  // 5.4: nenhuma particularidade de hospedagem fora de lib/plataforma.js.
  const plataformaLib = require('../lib/plataforma');
  const fontesComVercel = ['index.js', 'db/repositorio.js', 'db/repositorio-pg.js', 'db/repositorio-supabase.js', 'storage/armazenamento.js', 'lib/email.js', 'lib/marca.js', 'lib/mfa.js']
    .filter((f) => /process\.env\.VERCEL/.test(fs.readFileSync(path.join(RAIZ, f), 'utf8')));
  t('5.4', 'Portabilidade', 'process.env.VERCEL só é lido em lib/plataforma.js', fontesComVercel.length === 0, fontesComVercel.join(','));
  const pc = (env) => plataformaLib.detectar(env, '/projeto');
  t('5.4', 'Portabilidade', 'Servidor comum: grava na pasta do projeto, sem proxy por padrão', pc({}).diretorioDados === '/projeto' && !pc({}).serverless && !pc({}).confiarNoProxy, JSON.stringify(pc({})));
  t('5.4', 'Portabilidade', 'Vercel é detectada: serverless, proxy confiável e diretório temporário', pc({ VERCEL: '1' }).nome === 'vercel' && pc({ VERCEL: '1' }).serverless && pc({ VERCEL: '1' }).confiarNoProxy && pc({ VERCEL: '1' }).diretorioDados !== '/projeto', JSON.stringify(pc({ VERCEL: '1' })));
  t('5.4', 'Portabilidade', 'SERVERLESS=1 vale para qualquer outra hospedagem', pc({ SERVERLESS: '1' }).serverless && pc({ SERVERLESS: '1' }).nome === 'serverless', '');
  t('5.4', 'Portabilidade', 'DIRETORIO_DADOS e TRUST_PROXY=1 sempre prevalecem', pc({ VERCEL: '1', DIRETORIO_DADOS: '/dados' }).diretorioDados === '/dados' && pc({ TRUST_PROXY: '1' }).confiarNoProxy, '');

  // 5.3: o driver Postgres tem exatamente a mesma interface do driver Supabase.
  const funcoesPg = Object.keys(require('../db/repositorio-pg')).filter((k) => !['driver', 'criar'].includes(k));
  t('5.3', 'Portabilidade', 'Driver Postgres e driver Supabase expõem as mesmas funções', funcoesPg.length === exportadas.length && exportadas.every((f) => funcoesPg.includes(f)), `pg=${funcoesPg.length} supabase=${exportadas.length}`);

  // ---- 5.2 Marca configurável (white-label) ----
  const htmlLogin = await (await fetch(BASE + '/login.html')).text();
  const htmlRaizMarca = await (await fetch(BASE + '/')).text();
  t('5.2', 'Marca', 'Marca padrão "Admitte" em login.html e na raiz, sem o nome antigo', htmlLogin.includes('<title>Admitte - Entrar</title>') && !htmlLogin.includes('Onboarding Digital') && htmlRaizMarca.includes('Admitte'), '');
  t('5.2', 'Marca', 'Telas de ficha e RH também usam a marca', (await (await fetch(BASE + '/ficha.html')).text()).includes('Admitte') && !(await (await fetch(BASE + '/rh.html')).text()).includes('Onboarding Digital'), '');
  const marcaApi = await (await fetch(BASE + '/api/marca')).json();
  t('5.2', 'Marca', 'GET /api/marca informa nome, logo e cores', marcaApi.nome === 'Admitte' && marcaApi.logoUrl === '/marca/logo.png', JSON.stringify(marcaApi));
  t('5.2', 'Marca', 'As telas usam o símbolo da Admitte no lugar do ícone genérico', htmlLogin.includes('<img class="ic ic-logo" src="/marca/logo.png"'), '');
  t('5.2', 'Marca', 'Pop-up de termos cita o nome da marca', (await (await fetch(BASE + '/termos-privacidade.js')).text()).includes('plataforma Admitte'), '');
  const marcaLib = require('../lib/marca');
  const logos = ['javascript:alert(1)', 'http://x.test/a.svg', '//evil.test/a.svg', '/../segredo.svg', '/arquivo.html', 'https://x.test/a.svg"onerror="x'];
  t('5.2', 'Marca', 'Logo inseguro (javascript:, http, //, .., não-imagem, aspas) é descartado', logos.every((l) => marcaLib.carregar({ MARCA_NOME: 'Cliente', MARCA_LOGO_URL: l }).logoUrl === null), '');
  t('5.2', 'Marca', 'Logo local e https de imagem são aceitos', marcaLib.carregar({ MARCA_LOGO_URL: '/marca/logo.svg' }).logoUrl === '/marca/logo.svg' && marcaLib.carregar({ MARCA_LOGO_URL: 'https://cdn.x.test/logo.png' }).logoUrl === 'https://cdn.x.test/logo.png', '');
  t('5.2', 'Marca', 'O símbolo da Admitte é o logo padrão só com o nome padrão (cliente com nome próprio não herda)', marcaLib.carregar({}).logoUrl === '/marca/logo.png' && marcaLib.carregar({ MARCA_NOME: 'Acme' }).logoUrl === null, '');
  t('5.2', 'Marca', 'O arquivo do logo padrão existe e é servido', (await fetch(BASE + '/marca/logo.png')).headers.get('content-type') === 'image/png', '');
  t('5.2', 'Marca', 'Cor fora do formato #RRGGBB é descartada (sem injeção de CSS)', marcaLib.carregar({ MARCA_COR: 'red; } body{display:none' }).css === '' && marcaLib.carregar({ MARCA_COR: '#1E40AF' }).css.includes('--verde: #1E40AF'), '');

  // ---- 2.1 Cabeçalhos ----
  const h = (await req('GET', '/login.html')).headers;
  t('2.1', 'Cabeçalhos', 'Content-Security-Policy com frame-ancestors e object-src none', /frame-ancestors/.test(h.get('content-security-policy') || '') && /object-src 'none'/.test(h.get('content-security-policy') || ''), h.get('content-security-policy') ? 'presente' : 'ausente');
  t('2.1', 'Cabeçalhos', 'X-Content-Type-Options: nosniff', h.get('x-content-type-options') === 'nosniff', h.get('x-content-type-options') || 'ausente');
  t('2.1', 'Cabeçalhos', 'X-Frame-Options (anti clickjacking)', !!h.get('x-frame-options'), h.get('x-frame-options') || 'ausente');
  t('2.1', 'Cabeçalhos', 'Referrer-Policy', !!h.get('referrer-policy'), h.get('referrer-policy') || 'ausente');
  t('2.1', 'Cabeçalhos', 'X-Powered-By oculto', !h.get('x-powered-by'), h.get('x-powered-by') || 'oculto');

  // ---- Superfície exposta ----
  for (const p of ['/.env', '/package.json', '/index.js', '/supabase/schema.sql', '/db/supabase.js', '/storage/armazenamento.js', '/.git/config', '/..%2f..%2findex.js']) {
    const r = await fetch(BASE + p);
    t('-', 'Superfície', `GET ${p} não exposto`, [400, 403, 404].includes(r.status), `HTTP ${r.status}`);
  }
  t('1.5', 'Superfície', '/testes.html é servido fora de produção (em produção fica oculto: ver testes de produção)', (await fetch(BASE + '/testes.html')).status === 200, '');

  // ---- Autorização ----
  for (const [nome, p] of [['GET /api/candidatos', '/api/candidatos'], [`GET /api/candidato/:id`, `/api/candidato/${id}`], ['GET /api/rh/fichas', '/api/rh/fichas'], [`GET /api/candidato/:id/mensagens`, `/api/candidato/${id}/mensagens`]]) {
    t('-', 'Autorização', `${nome} sem login é recusado`, (await req('GET', p)).status === 401, '');
  }
  t('-', 'Autorização', 'Outro candidato não lê a ficha (403)', (await req('GET', `/api/candidato/${id}`, { token: outro })).status === 403, '');
  t('-', 'Autorização', 'RH não escreve como Candidato no chat (403)', (await req('POST', `/api/candidato/${id}/mensagens`, { token: rh, body: { autor: 'Candidato', texto: 'x' } })).status === 403, '');

  // ---- Documentos (1.2 / 1.3 / 2.2) ----
  const semAssinatura = await fetch(`${BASE}/${arquivo}`);
  t('1.2', 'Documentos', 'Arquivo sem URL assinada é recusado (403)', semAssinatura.status === 403, `HTTP ${semAssinatura.status}`);
  const sig = await (await req('POST', '/api/arquivos/assinar', { token: dono, body: { arquivo } })).json();
  const entrega = sig.url ? await fetch(BASE + sig.url) : null;
  t('1.2', 'Documentos', 'Dono baixa o próprio arquivo pela URL assinada', entrega && entrega.status === 200 && (await entrega.text()).includes('SIGILOSO'), entrega ? `HTTP ${entrega.status}` : 'sem URL');
  t('1.2', 'Documentos', 'Outro candidato não recebe URL assinada (403)', (await req('POST', '/api/arquivos/assinar', { token: outro, body: { arquivo } })).status === 403, '');
  const u = sig.url ? new URL(BASE + sig.url) : null;
  if (u) {
    const nome = decodeURIComponent(u.pathname.split('/').pop());
    t('1.2', 'Documentos', 'Assinatura adulterada é recusada', (await fetch(`${BASE}/uploads/${nome}?exp=${u.searchParams.get('exp')}&sig=${'0'.repeat(64)}`)).status === 403, '');
    t('1.2', 'Documentos', 'Link expirado é recusado', (await fetch(`${BASE}/uploads/${nome}?exp=${Date.now() - 1000}&sig=${u.searchParams.get('sig')}`)).status === 403, '');
  }
  t('2.2', 'Upload', 'HTML disfarçado de PDF é recusado', (await req('POST', `/api/candidato/${id}/documento`, { token: dono, form: pdfForm('cpf', '<html><script>x</script></html>', 'cpf.pdf') })).status === 400, '');
  t('2.2', 'Upload', 'Tipo de documento inexistente é recusado', (await req('POST', `/api/candidato/${id}/documento`, { token: dono, form: pdfForm('../../x', '%PDF-1.4\n%%EOF') })).status === 400, '');
  t('2.2', 'Upload', 'Nome do arquivo gerado pelo servidor (id-tipo-aleatório)', new RegExp(`^uploads/${id}-identidade-[0-9a-f]{16}\\.pdf$`).test(arquivo), arquivo);

  // ---- 2.4 Senha, CPF e tamanho de campos ----
  const registrarCom = (extra) => req('POST', '/api/auth/registrar', { body: Object.assign({ nome: 'Fraca Teste', email: `fraca${sufixo}${Math.random().toString(36).slice(2, 6)}@exemplo.test`, senha: senhaOk, confirmarSenha: senhaOk, dataNascimento: '01/01/1990', cpf: '529.982.247-25', aceiteTermos: true }, extra) });
  for (const [rotulo, senha] of [['12345678 (comum)', '12345678'], ['curta (Ab1)', 'Ab1'], ['sem número (SomenteLetras)', 'SomenteLetras'], ['sem letra (98765432)', '98765432'], ['senha123 (comum)', 'senha123']]) {
    t('2.4', 'Senha/CPF', `Senha fraca recusada: ${rotulo}`, (await registrarCom({ senha, confirmarSenha: senha })).status === 400, '');
  }
  t('2.4', 'Senha/CPF', 'CPF com dígito verificador inválido recusado no cadastro', (await registrarCom({ cpf: '123.456.789-00' })).status === 400, '');
  t('2.4', 'Senha/CPF', 'CPF com todos os dígitos iguais recusado na ficha', (await req('POST', '/api/candidato', { token: dono, body: ficha({ cpf: '111.111.111-11' }) })).status === 400, '');
  t('2.4', 'Senha/CPF', 'CPF válido continua aceito na ficha', (await req('POST', '/api/candidato', { token: dono, body: ficha({ cpf: '529.982.247-25' }) })).status === 201, '');
  t('2.4', 'Senha/CPF', 'Complemento muito longo é recusado', (await req('POST', '/api/candidato', { token: dono, body: ficha({ complemento: 'x'.repeat(5000) }) })).status === 400, '');
  t('2.4', 'Senha/CPF', 'Mensagem de chat acima de 2000 caracteres é recusada', (await req('POST', `/api/candidato/${id}/mensagens`, { token: dono, body: { autor: 'Candidato', texto: 'a'.repeat(2001) } })).status === 400, '');

  // ---- 2.6 IDs imprevisíveis ----
  t('2.6', 'IDs', 'IDs de ficha são UUID (gerador criptográfico)', /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-/.test(id), id);

  // ---- 2.8 Sessões: o banco só guarda o hash do token ----
  if (urlFalso) {
    const sessoes = await (await fetch(`${urlFalso}/rest/v1/sessoes`)).json();
    const hashDono = require('crypto').createHash('sha256').update(dono).digest('hex');
    t('2.8', 'Sessões', 'Token em texto puro NÃO está no banco', !sessoes.some((s) => s.token === dono || s.token === rh), `${sessoes.length} sessões`);
    t('2.8', 'Sessões', 'O hash SHA-256 do token está no banco', sessoes.some((s) => s.token === hashDono), '');
  }
  const semSessao = await req('GET', '/api/auth/sessao', { token: 'a'.repeat(64) });
  t('2.8', 'Sessões', 'Token inventado continua recusado (401)', semSessao.status === 401, `HTTP ${semSessao.status}`);

  // ---- 2.7 Integridade: mudanças em paralelo em fichas diferentes não se desfazem ----
  const ids = [];
  for (let i = 0; i < 6; i += 1) {
    ids.push((await (await req('POST', '/api/candidato', { token: dono, body: ficha({ nomeCompleto: `Paralelo Numero${i} Teste` }) })).json()).candidato.id);
  }
  await Promise.all(ids.map((x) => req('PATCH', `/api/candidato/${x}/status`, { token: rh, body: { status: 'PENDENTE_ASSINATURA' } })));
  const estados = await Promise.all(ids.map(async (x) => (await (await req('GET', `/api/candidato/${x}`, { token: rh })).json()).status));
  t('2.7', 'Integridade', '6 alterações simultâneas em fichas diferentes foram todas gravadas', estados.every((e) => e === 'PENDENTE_ASSINATURA'), estados.join(','));

  // ---- 1.4 Auditoria: eventos gravados na tabela (não só em arquivo local) ----
  if (urlFalso) {
    const eventos = await (await fetch(`${urlFalso}/rest/v1/auditoria`)).json();
    const tipos = new Set(eventos.map((e) => e.tipo_evento));
    t('1.4', 'Auditoria', 'Eventos são gravados na tabela auditoria do banco', eventos.length > 10, `${eventos.length} eventos`);
    t('1.4', 'Auditoria', 'Login, consentimento da ficha e criação de conta estão na trilha', ['login', 'consentimento_ficha_lgpd', 'consentimento_cadastro'].every((x) => tipos.has(x)), [...tipos].slice(0, 6).join(','));
    t('1.4', 'Auditoria', 'Cada evento guarda IP e data', eventos.every((e) => e.ip && e.ocorrido_em), '');
  }
  const audRh = await req('GET', `/api/rh/fichas/${id}/auditoria`, { token: rh });
  const audJson = await audRh.json().catch(() => ({}));
  t('1.4', 'Auditoria', 'RH consulta a trilha de uma ficha', audRh.status === 200 && Array.isArray(audJson.eventos) && audJson.eventos.length > 0, `HTTP ${audRh.status}, ${(audJson.eventos || []).length} eventos`);
  t('1.4', 'Auditoria', 'Candidato não consulta a trilha (403)', (await req('GET', `/api/rh/fichas/${id}/auditoria`, { token: dono })).status === 403, '');
  t('1.4', 'Auditoria', 'Sem login a trilha é recusada (401)', (await req('GET', `/api/rh/fichas/${id}/auditoria`)).status === 401, '');

  // ---- Itens ainda pendentes (aparecem como PENDENTE até serem tratados) ----
  const dupResp = await req('POST', '/api/auth/registrar', { body: { nome: 'Dup', email: `dono${sufixo}@exemplo.test`, senha: senhaOk, confirmarSenha: senhaOk, dataNascimento: '01/01/1990', cpf: '529.982.247-25', aceiteTermos: true } });
  const dup = await dupResp.json();
  t('3.3', 'Enumeração', 'Cadastro com e-mail existente responde 201 sem dizer que já existe', dupResp.status === 201 && !/já existe/i.test(JSON.stringify(dup)), `HTTP ${dupResp.status}`);
  t('3.3', 'Enumeração', 'Cadastro repetido não devolve token de ativação nem cria sessão', !dup.tokenAtivacao && !dup.linkAtivacao && !dup.token, Object.keys(dup).join(','));

  // ---- Páginas: raiz = login; ficha renomeada; redirecionamento legado ----
  const raiz = await fetch(BASE + '/');
  const htmlRaiz = await raiz.text();
  t('pág.', 'Páginas', 'A raiz "/" é a tela de login', raiz.status === 200 && /Esqueci minha senha/.test(htmlRaiz), `HTTP ${raiz.status}`);
  const legado = await fetch(BASE + '/index.html?id=abc-123', { redirect: 'manual' });
  t('pág.', 'Páginas', '/index.html redireciona para /ficha.html preservando o ?id=', legado.status === 301 && legado.headers.get('location') === '/ficha.html?id=abc-123', `${legado.status} ${legado.headers.get('location')}`);
  const fichaHtml = await (await fetch(BASE + '/ficha.html')).text();
  t('pág.', 'Páginas', '/ficha.html existe e não tem mais a caixa de consentimento LGPD', fichaHtml.includes('data-termos-privacidade="ficha"') && !fichaHtml.includes('checkConsentimentoFicha'), '');
  const loginHtml = await (await fetch(BASE + '/login.html')).text();
  t('pág.', 'Páginas', 'Cadastro com frase + link "Termos de privacidade" (sem checkbox)', loginHtml.includes('data-termos-privacidade="cadastro"') && !loginHtml.includes('checkAceiteTermos'), '');
  const jsTermos = await (await fetch(BASE + '/termos-privacidade.js')).text();
  t('pág.', 'Páginas', 'Pop-up cita direitos do art. 18, finalidade, base legal e consentimento', ['art. 18', 'Por que coletamos', 'Base legal', 'Consentimento', 'Termos de privacidade', 'concorda com as políticas de privacidade e os termos de uso'].every((x) => jsTermos.includes(x)), '');
  t('pág.', 'Cadastro', 'Servidor ainda exige o aceite dos termos (aceiteTermos=false -> 400)', (await registrarCom({ aceiteTermos: false })).status === 400, '');

  // ---- Papéis: master, admin e operadores ----
  const login = async (email, senha) => {
    const r = await req('POST', '/api/auth/login', { body: { email, senha } });
    const j = await r.json().catch(() => ({}));
    return { status: r.status, token: j.token, usuario: j.usuario };
  };
  const senhaMaster = 'Master-Senha-Forte-123';
  const m = await login('master@exemplo.test', senhaMaster);
  t('papéis', 'Master', 'Conta master (definida no ambiente do servidor) entra', m.status === 200 && m.usuario && m.usuario.tipo === 'master', `HTTP ${m.status}`);
  t('papéis', 'Master', 'Master NÃO acessa fichas de candidatos (403)', (await req('GET', '/api/rh/fichas', { token: m.token })).status === 403, '');
  t('papéis', 'Master', 'Master NÃO lê uma ficha (403)', (await req('GET', `/api/candidato/${id}`, { token: m.token })).status === 403, '');
  t('papéis', 'Master', 'Candidato não acessa a gestão do master (403)', (await req('GET', '/api/master/admins', { token: dono })).status === 403, '');
  t('papéis', 'Master', 'RH não acessa a gestão do master (403)', (await req('GET', '/api/master/admins', { token: rh })).status === 403, '');
  t('papéis', 'Master', 'Sem login a gestão do master é recusada (401)', (await req('GET', '/api/master/admins')).status === 401, '');

  // master cria o administrador (cliente); ele define a senha pelo link + senha temporária
  const novoAdmin = await (await req('POST', '/api/master/admins', { token: m.token, body: { nome: 'Admin Cliente', email: `admin${sufixo}@cliente.test` } })).json();
  t('papéis', 'Master', 'Master cria a conta admin do cliente', !!(novoAdmin.conta && novoAdmin.conta.tipo === 'admin' && novoAdmin.linkRecuperacao && novoAdmin.senhaTemporaria), JSON.stringify(novoAdmin).slice(0, 80));
  const tokenLink = (novoAdmin.linkRecuperacao || '').split('token=')[1];
  t('papéis', 'Master', 'Admin sem senha definida ainda não consegue entrar', (await login(`admin${sufixo}@cliente.test`, 'Qualquer-Senha-1')).status === 401, '');

  const redefinir = (corpo) => req('POST', '/api/auth/redefinir-senha', { body: corpo });
  t('recup.', 'Senha', 'Senha temporária errada é recusada', (await redefinir({ token: tokenLink, senhaTemporaria: 'ErradaErrada', novaSenha: 'Nova-Senha-Forte-1', confirmarSenha: 'Nova-Senha-Forte-1' })).status === 400, '');
  t('recup.', 'Senha', 'Nova senha fraca é recusada', (await redefinir({ token: tokenLink, senhaTemporaria: novoAdmin.senhaTemporaria, novaSenha: '12345678', confirmarSenha: '12345678' })).status === 400, '');
  t('recup.', 'Senha', 'Confirmação diferente da nova senha é recusada', (await redefinir({ token: tokenLink, senhaTemporaria: novoAdmin.senhaTemporaria, novaSenha: 'Nova-Senha-Forte-1', confirmarSenha: 'Outra-Senha-Forte-2' })).status === 400, '');
  const okRedef = await redefinir({ token: tokenLink, senhaTemporaria: novoAdmin.senhaTemporaria, novaSenha: 'Nova-Senha-Forte-1', confirmarSenha: 'Nova-Senha-Forte-1' });
  t('recup.', 'Senha', 'Token + senha temporária + nova senha confirmada trocam a senha', okRedef.status === 200, `HTTP ${okRedef.status}`);
  t('recup.', 'Senha', 'O mesmo link não pode ser reutilizado', (await redefinir({ token: tokenLink, senhaTemporaria: novoAdmin.senhaTemporaria, novaSenha: 'Outra-Nova-Senha-3', confirmarSenha: 'Outra-Nova-Senha-3' })).status === 400, '');

  const admin = await login(`admin${sufixo}@cliente.test`, 'Nova-Senha-Forte-1');
  t('papéis', 'Admin', 'Admin entra com a senha que definiu', admin.status === 200 && admin.usuario.tipo === 'admin', `HTTP ${admin.status}`);
  t('papéis', 'Admin', 'Admin tem todos os acessos do RH (lista fichas)', (await req('GET', '/api/rh/fichas', { token: admin.token })).status === 200, '');
  t('papéis', 'Admin', 'Admin NÃO acessa a gestão do master (403)', (await req('GET', '/api/master/admins', { token: admin.token })).status === 403, '');
  t('papéis', 'Admin', 'Operador de RH não acessa a gestão de operadores (403)', (await req('GET', '/api/admin/operadores', { token: rh })).status === 403, '');

  const novoOp = await (await req('POST', '/api/admin/operadores', { token: admin.token, body: { nome: 'Operadora RH', email: `op${sufixo}@cliente.test` } })).json();
  t('papéis', 'Admin', 'Admin cria operador do RH', !!(novoOp.conta && novoOp.conta.tipo === 'rh' && novoOp.senhaTemporaria), '');
  t('papéis', 'Admin', 'Admin não cria conta com e-mail já existente (409)', (await req('POST', '/api/admin/operadores', { token: admin.token, body: { nome: 'Dup', email: `op${sufixo}@cliente.test` } })).status === 409, '');
  await redefinir({ token: (novoOp.linkRecuperacao || '').split('token=')[1], senhaTemporaria: novoOp.senhaTemporaria, novaSenha: 'Operadora-Senha-1', confirmarSenha: 'Operadora-Senha-1' });
  const op = await login(`op${sufixo}@cliente.test`, 'Operadora-Senha-1');
  t('papéis', 'Operador', 'Operador define a senha e acessa o painel do RH', op.status === 200 && (await req('GET', '/api/rh/fichas', { token: op.token })).status === 200, '');
  t('papéis', 'Operador', 'Operador não vira admin: sem acesso à gestão (403)', (await req('GET', '/api/admin/operadores', { token: op.token })).status === 403, '');
  const idDono = (await (await req('GET', '/api/auth/sessao', { token: dono })).json()).usuario.id;
  t('papéis', 'Admin', 'Admin não gerencia outra conta admin nem a si mesmo (404)', (await req('PATCH', `/api/admin/operadores/${admin.usuario.id}`, { token: admin.token, body: { ativo: false } })).status === 404, '');
  t('papéis', 'Admin', 'Admin não gerencia conta de candidato (404)', (await req('PATCH', `/api/admin/operadores/${idDono}`, { token: admin.token, body: { ativo: false } })).status === 404, '');
  t('papéis', 'Admin', 'Admin renomeia o operador (200)', (await req('PATCH', `/api/admin/operadores/${op.usuario.id}`, { token: admin.token, body: { nome: 'Operadora Renomeada' } })).status === 200, '');

  const desativar = await req('PATCH', `/api/admin/operadores/${op.usuario.id}`, { token: admin.token, body: { ativo: false } });
  t('papéis', 'Admin', 'Admin desativa o operador', desativar.status === 200, `HTTP ${desativar.status}`);
  t('papéis', 'Admin', 'Sessão do operador desativado é encerrada (401)', (await req('GET', '/api/rh/fichas', { token: op.token })).status === 401, '');
  t('papéis', 'Admin', 'Operador desativado não consegue entrar', (await login(`op${sufixo}@cliente.test`, 'Operadora-Senha-1')).status !== 200, '');

  // ---- Recuperação de senha (esqueci minha senha) ----
  const recDesconhecido = await (await req('POST', '/api/auth/recuperar-senha', { body: { email: `ninguem${sufixo}@exemplo.test` } })).json();
  const recAdmin = await (await req('POST', '/api/auth/recuperar-senha', { body: { email: `admin${sufixo}@cliente.test` } })).json();
  t('recup.', 'Recuperação', 'Resposta igual exista a conta ou não (não revela cadastros)', recDesconhecido.mensagem === recAdmin.mensagem, '');
  t('recup.', 'Recuperação', 'Conta existente recebe link e senha temporária (modo teste)', !!(recAdmin.linkRecuperacao && recAdmin.senhaTemporaria), '');
  const antigaSessao = admin.token;
  const trocou = await redefinir({ token: (recAdmin.linkRecuperacao || '').split('token=')[1], senhaTemporaria: recAdmin.senhaTemporaria, novaSenha: 'Senha-Recuperada-7', confirmarSenha: 'Senha-Recuperada-7' });
  t('recup.', 'Recuperação', 'Redefinição por e-mail troca a senha', trocou.status === 200, `HTTP ${trocou.status}`);
  t('recup.', 'Recuperação', 'Trocar a senha encerra as sessões abertas', (await req('GET', '/api/auth/sessao', { token: antigaSessao })).status === 401, '');
  t('recup.', 'Recuperação', 'A senha antiga deixa de valer', (await login(`admin${sufixo}@cliente.test`, 'Nova-Senha-Forte-1')).status === 401, '');
  t('recup.', 'Recuperação', 'A nova senha vale', (await login(`admin${sufixo}@cliente.test`, 'Senha-Recuperada-7')).status === 200, '');
  const recMaster = await (await req('POST', '/api/auth/recuperar-senha', { body: { email: 'master@exemplo.test' } })).json();
  t('recup.', 'Recuperação', 'A conta master não usa a recuperação por e-mail', !recMaster.linkRecuperacao, '');
  const tentativas = [];
  const recTent = await (await req('POST', '/api/auth/recuperar-senha', { body: { email: `dono${sufixo}@exemplo.test` } })).json();
  for (let i = 0; i < 6; i += 1) tentativas.push((await redefinir({ token: (recTent.linkRecuperacao || '').split('token=')[1], senhaTemporaria: 'Errada-Errada-' + i, novaSenha: 'Qualquer-Senha-9', confirmarSenha: 'Qualquer-Senha-9' })).status);
  t('recup.', 'Recuperação', 'Após 5 senhas temporárias erradas o link é invalidado', (await redefinir({ token: (recTent.linkRecuperacao || '').split('token=')[1], senhaTemporaria: recTent.senhaTemporaria, novaSenha: 'Qualquer-Senha-9', confirmarSenha: 'Qualquer-Senha-9' })).status === 400, tentativas.join(','));

  // ---- 3.2 LGPD: direitos do titular (exportar, excluir) e retenção ----
  const adminLgpd = await login(`admin${sufixo}@cliente.test`, 'Senha-Recuperada-7');
  const novoTitular = async (rotulo) => {
    const email = `${rotulo}${sufixo}@exemplo.test`;
    const token = await novaConta(email);
    const cand = (await (await req('POST', '/api/candidato', { token, body: ficha({ nomeCompleto: `Titular ${rotulo} Teste`, email }) })).json()).candidato;
    return { token, email, id: cand.id };
  };
  const tA = await novoTitular('tita');
  const upA = await (await req('POST', `/api/candidato/${tA.id}/documento`, { token: tA.token, form: pdfForm('identidade', '%PDF-1.4\nDADO-DO-TITULAR\n%%EOF') })).json();
  const arquivoA = upA.candidato && upA.candidato.documentos.identidade.arquivo;
  await req('POST', `/api/candidato/${tA.id}/mensagens`, { token: tA.token, body: { autor: 'Candidato', texto: 'MENSAGEM-SIGILOSA-DO-TITULAR' } });

  t('3.2', 'LGPD', 'Exportar dados sem login é recusado (401)', (await req('GET', '/api/meus-dados/exportar')).status === 401, '');
  const exp = await req('GET', '/api/meus-dados/exportar', { token: tA.token });
  const expTexto = await exp.text();
  let expJson = {};
  try { expJson = JSON.parse(expTexto); } catch (e) { /* segue com {} */ }
  t('3.2', 'LGPD', 'Titular exporta os próprios dados (ficha, e-mail, mensagens)', exp.status === 200 && expJson.titular && expJson.titular.email === tA.email && expJson.fichas && expJson.fichas.length === 1 && expTexto.includes('MENSAGEM-SIGILOSA-DO-TITULAR'), `HTTP ${exp.status}`);
  t('3.2', 'LGPD', 'A exportação não contém senha, hash nem token', !/senha_?hash|senha_?salt|token_?ativacao|"token"/i.test(expTexto), '');
  t('3.2', 'LGPD', 'A exportação traz só os dados do titular (nada de outro candidato)', !expTexto.includes(`dono${sufixo}@exemplo.test`), '');
  t('3.2', 'LGPD', 'Pedido de exclusão exige confirmação explícita (400)', (await req('POST', '/api/meus-dados/solicitar-exclusao', { token: tA.token, body: {} })).status === 400, '');
  t('3.2', 'LGPD', 'Equipe do RH não usa o pedido de titular de candidato (403)', (await req('POST', '/api/meus-dados/solicitar-exclusao', { token: rh, body: { confirmar: true } })).status === 403, '');
  const pedidoA = await (await req('POST', '/api/meus-dados/solicitar-exclusao', { token: tA.token, body: { confirmar: true } })).json();
  t('3.2', 'LGPD', 'Titular registra o pedido de exclusão', !!pedidoA.solicitacaoId, JSON.stringify(pedidoA).slice(0, 80));
  const repetido = await (await req('POST', '/api/meus-dados/solicitar-exclusao', { token: tA.token, body: { confirmar: true } })).json();
  t('3.2', 'LGPD', 'Pedido repetido não duplica (idempotente)', repetido.jaExistia === true && repetido.solicitacaoId === pedidoA.solicitacaoId, '');
  const minhas = await (await req('GET', '/api/meus-dados/solicitacoes', { token: tA.token })).json();
  t('3.2', 'LGPD', 'Titular vê o status do próprio pedido', Array.isArray(minhas) && minhas.length === 1 && minhas[0].status === 'pendente', '');

  t('3.2', 'LGPD', 'Sem login a lista de pedidos é recusada (401)', (await req('GET', '/api/rh/solicitacoes-titular')).status === 401, '');
  t('3.2', 'LGPD', 'Candidato não lista pedidos de titulares (403)', (await req('GET', '/api/rh/solicitacoes-titular', { token: tA.token })).status === 403, '');
  t('3.2', 'LGPD', 'Candidato não executa o próprio pedido (403)', (await req('POST', `/api/rh/solicitacoes-titular/${pedidoA.solicitacaoId}/executar`, { token: tA.token })).status === 403, '');
  const listaRh = await (await req('GET', '/api/rh/solicitacoes-titular', { token: rh })).json();
  t('3.2', 'LGPD', 'RH vê o pedido pendente', Array.isArray(listaRh) && listaRh.some((s) => s.id === pedidoA.solicitacaoId && s.status === 'pendente'), '');
  t('3.2', 'LGPD', 'Pedido inexistente retorna 404', (await req('POST', '/api/rh/solicitacoes-titular/inexistente/executar', { token: rh })).status === 404, '');

  const exec = await req('POST', `/api/rh/solicitacoes-titular/${pedidoA.solicitacaoId}/executar`, { token: rh });
  t('3.2', 'LGPD', 'RH executa a exclusão (200)', exec.status === 200, `HTTP ${exec.status}`);
  const fichaApos = await (await req('GET', `/api/candidato/${tA.id}`, { token: rh })).json();
  const cA = fichaApos.candidato || fichaApos;
  t('3.2', 'LGPD', 'Ficha anonimizada: nome genérico e sem CPF/e-mail/WhatsApp', cA.nomeCompleto === 'Dados removidos a pedido do titular' && !cA.cpf && !cA.email && !cA.whatsapp, cA.nomeCompleto);
  const msgApos = await (await req('GET', `/api/candidato/${tA.id}/mensagens`, { token: rh })).text();
  t('3.2', 'LGPD', 'Mensagens do chat foram apagadas', !msgApos.includes('MENSAGEM-SIGILOSA-DO-TITULAR'), '');
  let arquivoApagado = true;
  if (arquivoA) {
    const sA = await req('POST', '/api/arquivos/assinar', { token: rh, body: { arquivo: arquivoA } });
    const sAj = await sA.json().catch(() => ({}));
    arquivoApagado = sA.status !== 200 || !sAj.url || (await fetch(BASE + sAj.url)).status !== 200;
  }
  t('3.2', 'LGPD', 'O PDF do titular foi removido do armazenamento', !!arquivoA && arquivoApagado, arquivoA || 'sem arquivo');
  t('3.2', 'LGPD', 'A sessão do titular excluído deixa de valer (401)', (await req('GET', '/api/auth/sessao', { token: tA.token })).status === 401, '');
  t('3.2', 'LGPD', 'O titular excluído não entra mais (login recusado)', (await login(tA.email, senhaOk)).status === 401, '');
  t('3.2', 'LGPD', 'Pedido executado não pode ser executado de novo (404)', (await req('POST', `/api/rh/solicitacoes-titular/${pedidoA.solicitacaoId}/executar`, { token: rh })).status === 404, '');
  if (urlFalso) {
    const aud = await (await fetch(`${urlFalso}/rest/v1/auditoria`)).json();
    const tiposAud = new Set(aud.map((e) => e.tipo_evento));
    t('3.2', 'LGPD', 'Trilha registra exportação, pedido, anonimização e exclusão da conta', ['dados_exportados', 'exclusao_solicitada', 'ficha_anonimizada', 'conta_excluida'].every((x) => tiposAud.has(x)), [...tiposAud].join(','));
  }

  // Pedido recusado com motivo (o titular fica sabendo do motivo)
  const tB = await novoTitular('titb');
  const pedidoB = await (await req('POST', '/api/meus-dados/solicitar-exclusao', { token: tB.token, body: { confirmar: true } })).json();
  t('3.2', 'LGPD', 'Recusar exige motivo (400)', (await req('POST', `/api/rh/solicitacoes-titular/${pedidoB.solicitacaoId}/recusar`, { token: rh, body: { motivo: 'x' } })).status === 400, '');
  t('3.2', 'LGPD', 'Candidato não recusa pedidos (403)', (await req('POST', `/api/rh/solicitacoes-titular/${pedidoB.solicitacaoId}/recusar`, { token: tB.token, body: { motivo: 'Motivo qualquer' } })).status === 403, '');
  t('3.2', 'LGPD', 'RH recusa o pedido com motivo (200)', (await req('POST', `/api/rh/solicitacoes-titular/${pedidoB.solicitacaoId}/recusar`, { token: rh, body: { motivo: 'Documentos necessários para o processo seletivo em curso.' } })).status === 200, '');
  const minhasB = await (await req('GET', '/api/meus-dados/solicitacoes', { token: tB.token })).json();
  t('3.2', 'LGPD', 'Titular vê o pedido recusado e o motivo; a conta continua ativa', minhasB[0] && minhasB[0].status === 'recusada' && /processo seletivo/.test(minhasB[0].motivoRecusa || '') && (await req('GET', '/api/auth/sessao', { token: tB.token })).status === 200, '');

  // Candidato contratado: retenção legal (409 ao executar)
  if (urlFalso) {
    const tC = await novoTitular('titc');
    await fetch(`${urlFalso}/rest/v1/candidatos?id=eq.${tC.id}`, { method: 'PATCH', headers: J, body: JSON.stringify({ status: 'CONTRATACAO_CONCLUIDA' }) });
    const pedidoC = await (await req('POST', '/api/meus-dados/solicitar-exclusao', { token: tC.token, body: { confirmar: true } })).json();
    t('3.2', 'LGPD', 'Pedido de contratado avisa sobre a retenção legal', pedidoC.retencaoLegal === true, JSON.stringify(pedidoC).slice(0, 80));
    const execC = await req('POST', `/api/rh/solicitacoes-titular/${pedidoC.solicitacaoId}/executar`, { token: rh });
    t('3.2', 'LGPD', 'Ficha de contratado NÃO é excluída (409)', execC.status === 409, `HTTP ${execC.status}`);
    const fichaC = await (await req('GET', `/api/candidato/${tC.id}`, { token: rh })).json();
    t('3.2', 'LGPD', 'Ficha do contratado segue íntegra após a tentativa', (fichaC.candidato || fichaC).nomeCompleto === 'Titular titc Teste', '');
  }

  // Retenção (só o admin): simulação não altera nada
  t('3.2', 'Retenção', 'Operador de RH não roda a retenção (403)', (await req('POST', '/api/admin/retencao', { token: rh, body: {} })).status === 403, '');
  t('3.2', 'Retenção', 'Candidato não roda a retenção (403)', (await req('POST', '/api/admin/retencao', { token: tB.token, body: {} })).status === 403, '');
  const simGrande = await (await req('POST', '/api/admin/retencao', { token: adminLgpd.token, body: { simular: true, dias: 3650 } })).json();
  t('3.2', 'Retenção', 'Simulação com prazo longo não encontra fichas', simGrande.simulacao === true && simGrande.total === 0, JSON.stringify(simGrande).slice(0, 80));
  const simCurta = await (await req('POST', '/api/admin/retencao', { token: adminLgpd.token, body: { simular: true, dias: 0.000001 } })).json();
  t('3.2', 'Retenção', 'Simulação com prazo curto lista fichas elegíveis sem alterar nada', simCurta.simulacao === true && simCurta.total > 0, `total ${simCurta.total}`);
  const aindaIntacta = await (await req('GET', `/api/candidato/${id}`, { token: rh })).json();
  t('3.2', 'Retenção', 'A simulação não anonimizou nenhuma ficha', (aindaIntacta.candidato || aindaIntacta).nomeCompleto === 'Fulano de Tal', '');

  // ---- 3.4 MFA (verificação em duas etapas, TOTP) ----
  const mfaLib = require('../lib/mfa');
  const opMfa = await (async () => {
    const email = `opmfa${sufixo}@cliente.test`;
    const novo = await (await req('POST', '/api/admin/operadores', { token: adminLgpd.token, body: { nome: 'Operador MFA', email } })).json();
    await redefinir({ token: (novo.linkRecuperacao || '').split('token=')[1], senhaTemporaria: novo.senhaTemporaria, novaSenha: 'Operador-Senha-9', confirmarSenha: 'Operador-Senha-9' });
    const l = await login(email, 'Operador-Senha-9');
    return { email, id: l.usuario && l.usuario.id, token: l.token };
  })();
  const mfaPost = (caminho, token, body) => req('POST', caminho, { token, body: body || {} });

  t('3.4', 'MFA', 'Status sem login é recusado (401)', (await req('GET', '/api/auth/mfa/status')).status === 401, '');
  t('3.4', 'MFA', 'Candidato não configura MFA (403)', (await mfaPost('/api/auth/mfa/configurar', outro)).status === 403, '');
  const cfg = await (await mfaPost('/api/auth/mfa/configurar', opMfa.token)).json();
  t('3.4', 'MFA', 'Operador inicia a configuração: segredo, URI otpauth e QR code', !!cfg.segredo && /^otpauth:\/\/totp\//.test(cfg.uri || '') && /^data:image\/png/.test(cfg.qr || ''), Object.keys(cfg).join(','));
  if (urlFalso) {
    const linhas = await (await fetch(`${urlFalso}/rest/v1/usuarios?id=eq.${opMfa.id}`)).json();
    const guardado = (linhas[0] || {}).mfa_segredo || '';
    t('3.4', 'MFA', 'O segredo TOTP fica cifrado no banco (nunca em texto puro)', guardado.startsWith('v1:') && !guardado.includes(cfg.segredo), guardado.slice(0, 12));
  }
  t('3.4', 'MFA', 'Código errado não ativa o MFA (400)', (await mfaPost('/api/auth/mfa/ativar', opMfa.token, { codigo: '000000' })).status === 400, '');
  const passoAtivacao = mfaLib.passoAtual();
  const ativar = await (await mfaPost('/api/auth/mfa/ativar', opMfa.token, { codigo: mfaLib.codigoTotp(cfg.segredo, passoAtivacao) })).json();
  t('3.4', 'MFA', 'Código correto ativa o MFA e entrega 10 códigos de recuperação', Array.isArray(ativar.codigosRecuperacao) && ativar.codigosRecuperacao.length === 10, JSON.stringify(ativar).slice(0, 70));
  const codigosRec = ativar.codigosRecuperacao || [];
  if (urlFalso) {
    const linhas = await (await fetch(`${urlFalso}/rest/v1/usuarios?id=eq.${opMfa.id}`)).json();
    const guardados = JSON.stringify((linhas[0] || {}).mfa_codigos || []);
    t('3.4', 'MFA', 'Códigos de recuperação ficam só como hash no banco', codigosRec.length > 0 && !codigosRec.some((c) => guardados.includes(c.replace('-', ''))) && !codigosRec.some((c) => guardados.includes(c)), '');
  }

  const loginSenha = await (await req('POST', '/api/auth/login', { body: { email: opMfa.email, senha: 'Operador-Senha-9' } })).json();
  t('3.4', 'MFA', 'Com MFA ativo, a senha sozinha NÃO gera sessão (pede o código)', loginSenha.mfaNecessario === true && !!loginSenha.desafio && !loginSenha.token, Object.keys(loginSenha).join(','));
  t('3.4', 'MFA', 'Desafio inventado é recusado (401)', (await mfaPost('/api/auth/mfa/verificar', null, { desafio: 'x.y', codigo: '123456' })).status === 401, '');
  t('3.4', 'MFA', 'Código errado no login é recusado (401)', (await mfaPost('/api/auth/mfa/verificar', null, { desafio: loginSenha.desafio, codigo: '000000' })).status === 401, '');
  const codigoLogin = mfaLib.codigoTotp(cfg.segredo, passoAtivacao + 1);
  t('3.4', 'MFA', 'O código usado na ativação não vale de novo (anti-replay)', (await mfaPost('/api/auth/mfa/verificar', null, { desafio: loginSenha.desafio, codigo: mfaLib.codigoTotp(cfg.segredo, passoAtivacao) })).status === 401, '');
  const okMfa = await mfaPost('/api/auth/mfa/verificar', null, { desafio: loginSenha.desafio, codigo: codigoLogin });
  const okMfaJson = await okMfa.json();
  t('3.4', 'MFA', 'Senha + código do aplicativo geram a sessão', okMfa.status === 200 && !!okMfaJson.token && okMfaJson.usuario.tipo === 'rh', `HTTP ${okMfa.status}`);
  t('3.4', 'MFA', 'A sessão obtida com MFA acessa o painel do RH', (await req('GET', '/api/rh/fichas', { token: okMfaJson.token })).status === 200, '');
  const desafio2 = await (await req('POST', '/api/auth/login', { body: { email: opMfa.email, senha: 'Operador-Senha-9' } })).json();
  t('3.4', 'MFA', 'O mesmo código não pode ser reutilizado em outro login (replay)', (await mfaPost('/api/auth/mfa/verificar', null, { desafio: desafio2.desafio, codigo: codigoLogin })).status === 401, '');
  const recOk = await mfaPost('/api/auth/mfa/verificar', null, { desafio: desafio2.desafio, codigo: codigosRec[0] });
  const recJson = await recOk.json();
  t('3.4', 'MFA', 'Código de recuperação substitui o aplicativo e informa quantos restam', recOk.status === 200 && recJson.codigosRestantes === 9, `HTTP ${recOk.status}`);
  const desafio3 = await (await req('POST', '/api/auth/login', { body: { email: opMfa.email, senha: 'Operador-Senha-9' } })).json();
  t('3.4', 'MFA', 'Código de recuperação vale uma única vez (401)', (await mfaPost('/api/auth/mfa/verificar', null, { desafio: desafio3.desafio, codigo: codigosRec[0] })).status === 401, '');

  const tentativasMfa = [];
  for (let i = 0; i < 6; i += 1) tentativasMfa.push((await mfaPost('/api/auth/mfa/verificar', null, { desafio: desafio3.desafio, codigo: String(100000 + i) })).status);
  t('3.4', 'MFA', 'Erros seguidos de código bloqueiam a conta (429)', tentativasMfa.includes(429), tentativasMfa.join(','));
  t('3.4', 'MFA', 'Durante o bloqueio nem o código certo entra (429)', (await mfaPost('/api/auth/mfa/verificar', null, { desafio: desafio3.desafio, codigo: codigosRec[1] })).status === 429, '');

  t('3.4', 'MFA', 'Operador não redefine o MFA de outra conta (403)', (await mfaPost(`/api/admin/operadores/${opMfa.id}/mfa/resetar`, rh)).status === 403, '');
  t('3.4', 'MFA', 'Candidato não redefine MFA (403)', (await mfaPost(`/api/admin/operadores/${opMfa.id}/mfa/resetar`, outro)).status === 403, '');
  t('3.4', 'MFA', 'Master não redefine conta que não é admin (404)', (await mfaPost(`/api/master/admins/${opMfa.id}/mfa/resetar`, m.token)).status === 404, '');
  const reset = await mfaPost(`/api/admin/operadores/${opMfa.id}/mfa/resetar`, adminLgpd.token);
  t('3.4', 'MFA', 'Admin redefine o MFA do operador (200)', reset.status === 200, `HTTP ${reset.status}`);
  const aposReset = await (await req('POST', '/api/auth/login', { body: { email: opMfa.email, senha: 'Operador-Senha-9' } })).json();
  t('3.4', 'MFA', 'Depois do reset o operador entra só com a senha e pode reconfigurar', !!aposReset.token && !aposReset.mfaNecessario, Object.keys(aposReset).join(','));
  t('3.4', 'MFA', 'Sessões antigas do operador foram encerradas no reset (401)', (await req('GET', '/api/rh/fichas', { token: okMfaJson.token })).status === 401, '');

  // Reativar e desativar (exige senha + código)
  const cfg2 = await (await mfaPost('/api/auth/mfa/configurar', aposReset.token)).json();
  const passo2 = mfaLib.passoAtual();
  await mfaPost('/api/auth/mfa/ativar', aposReset.token, { codigo: mfaLib.codigoTotp(cfg2.segredo, passo2) });
  t('3.4', 'MFA', 'Desativar com senha errada é recusado (401)', (await mfaPost('/api/auth/mfa/desativar', aposReset.token, { senha: 'Senha-Errada-1', codigo: mfaLib.codigoTotp(cfg2.segredo, passo2 + 1) })).status === 401, '');
  const desat = await mfaPost('/api/auth/mfa/desativar', aposReset.token, { senha: 'Operador-Senha-9', codigo: mfaLib.codigoTotp(cfg2.segredo, passo2 + 1) });
  t('3.4', 'MFA', 'Desativar com senha + código corretos (200)', desat.status === 200, `HTTP ${desat.status}`);
  t('3.4', 'MFA', 'Depois de desativado o login volta a ser só senha', !!(await (await req('POST', '/api/auth/login', { body: { email: opMfa.email, senha: 'Operador-Senha-9' } })).json()).token, '');
  if (urlFalso) {
    const aud = await (await fetch(`${urlFalso}/rest/v1/auditoria`)).json();
    const tiposAud = new Set(aud.map((e) => e.tipo_evento));
    t('3.4', 'MFA', 'Trilha registra ativação, falha, uso de código de recuperação, reset e desativação', ['mfa_ativado', 'mfa_falha', 'mfa_codigo_recuperacao_usado', 'mfa_resetado', 'mfa_desativado'].every((x) => tiposAud.has(x)), [...tiposAud].filter((x) => /mfa/.test(x)).join(','));
  }

  // ---- 2.3 Limites de taxa (por último: consomem o orçamento da janela) ----
  const falhas = [];
  for (let i = 0; i < 6; i += 1) falhas.push((await req('POST', '/api/auth/login', { body: { email: `ninguem${sufixo}@exemplo.test`, senha: 'errada' + i } })).status);
  t('-', 'Limites', 'Login: 5 falhas seguidas levam a 429', falhas.slice(0, 5).every((s) => s === 401) && falhas[5] === 429, falhas.join(','));
  const cad = [];
  for (let i = 0; i < 24; i += 1) cad.push((await req('POST', '/api/auth/registrar', { body: { nome: 'A', email: 'invalido', senha: '1', confirmarSenha: '1' } })).status);
  t('2.3', 'Limites', 'Cadastro tem limite por hora (429)', cad.includes(429), `${cad.filter((s) => s === 429).length} de 16 bloqueadas`);
  const fichas = [];
  for (let i = 0; i < 16; i += 1) fichas.push((await req('POST', '/api/candidato', { token: dono, body: ficha() })).status);
  t('2.3', 'Limites', 'Criação de fichas tem limite por hora (429)', fichas.includes(429), `${fichas.filter((s) => s === 429).length} de 16 bloqueadas`);

  // ---- 3.2 Retenção: execução (por último, porque anonimiza as fichas de teste) ----
  const execRet = await (await req('POST', '/api/admin/retencao', { token: adminLgpd.token, body: { simular: false, dias: 0.000001 } })).json();
  t('3.2', 'Retenção', 'Execução anonimiza as fichas elegíveis', execRet.simulacao === false && execRet.fichasAnonimizadas > 0, JSON.stringify(execRet).slice(0, 100));
  const aposRet = await (await req('GET', `/api/candidato/${id}`, { token: rh })).json();
  t('3.2', 'Retenção', 'A ficha vencida (em análise) foi anonimizada', (aposRet.candidato || aposRet).nomeCompleto === 'Dados removidos a pedido do titular', '');
  t('3.2', 'Retenção', 'A conta com outras fichas ainda ativas (pendente de assinatura) não é excluída', (await req('GET', '/api/auth/sessao', { token: dono })).status === 200, '');
  if (urlFalso) {
    const c = await (await fetch(`${urlFalso}/rest/v1/candidatos`)).json();
    t('3.2', 'Retenção', 'Ficha de contratado não é tocada pela retenção', c.filter((x) => x.status === 'CONTRATACAO_CONCLUIDA').every((x) => !x.anonimizado_em), '');
    const segunda = await (await req('POST', '/api/admin/retencao', { token: adminLgpd.token, body: { simular: true, dias: 0.000001 } })).json();
    t('3.2', 'Retenção', 'Fichas já anonimizadas não entram de novo na retenção', segunda.total === 0 || !segunda.fichas.some((f) => f.id === id), `total ${segunda.total}`);
  }
}

async function suiteProducao(BASE, BASE_APP) {
  const J = { 'Content-Type': 'application/json' };
  const sufixo = Date.now().toString(36);
  const t404 = await fetch(BASE + '/testes.html');
  t('1.5', 'Produção', '/testes.html não é servido em produção (404)', t404.status === 404, `HTTP ${t404.status}`);
  const reg = await fetch(BASE + '/api/auth/registrar', { method: 'POST', headers: J, body: JSON.stringify({ nome: 'Pessoa Producao', email: `prod${sufixo}@exemplo.test`, senha: 'Senha-Teste-123', confirmarSenha: 'Senha-Teste-123', dataNascimento: '01/01/1990', cpf: '529.982.247-25', aceiteTermos: true }) });
  const corpo = await reg.json();
  t('2', 'Produção', 'Cadastro não devolve link nem token de ativação em produção', reg.status === 201 && !corpo.tokenAtivacao && !corpo.linkAtivacao, Object.keys(corpo).join(','));
  const dados = { nome: 'Pessoa Producao', senha: 'Senha-Teste-123', confirmarSenha: 'Senha-Teste-123', dataNascimento: '01/01/1990', cpf: '529.982.247-25', aceiteTermos: true };
  const novoReg = await (await fetch(BASE + '/api/auth/registrar', { method: 'POST', headers: J, body: JSON.stringify({ ...dados, email: `novo${sufixo}@exemplo.test` }) })).json();
  const repReg = await fetch(BASE + '/api/auth/registrar', { method: 'POST', headers: J, body: JSON.stringify({ ...dados, email: `prod${sufixo}@exemplo.test` }) });
  const repJson = await repReg.json();
  t('3.3', 'Produção', 'Cadastro novo e cadastro repetido têm resposta idêntica (status e corpo)', repReg.status === 201 && JSON.stringify(repJson) === JSON.stringify(novoReg), JSON.stringify(repJson).slice(0, 90));
  const rec = await (await fetch(BASE + '/api/auth/recuperar-senha', { method: 'POST', headers: J, body: JSON.stringify({ email: `prod${sufixo}@exemplo.test` }) })).json();
  t('6.4', 'Produção', 'Recuperação de senha não devolve link nem senha temporária em produção', !rec.linkRecuperacao && !rec.senhaTemporaria, Object.keys(rec).join(','));
  // Marca por cliente (instância de produção com MARCA_* definidos)
  const htmlMarca = await (await fetch(BASE + '/login.html')).text();
  t('5.2', 'Produção', 'Nome da marca do cliente aparece escapado (sem HTML injetado)', htmlMarca.includes('Acme &lt;b&gt;RH') && !htmlMarca.includes('Acme <b>RH'), '');
  t('5.2', 'Produção', 'Logo do cliente substitui o ícone padrão nas telas', htmlMarca.includes('<img class="ic ic-logo" src="https://cdn.exemplo.test/logo.svg"') && !htmlMarca.includes('<use href="#i-logo"/></svg>\n        <span>'), '');
  t('5.2', 'Produção', 'Cor da marca é injetada como variável de tema', htmlMarca.includes('<style id="marca-cores">:root { --verde: #1E40AF'), '');
  const marcaProd = await (await fetch(BASE + '/api/marca')).json();
  t('5.2', 'Produção', '/api/marca reflete a configuração do ambiente', marcaProd.nome === 'Acme <b>RH' && marcaProd.logoUrl === 'https://cdn.exemplo.test/logo.svg', JSON.stringify(marcaProd));
  // 5.5 Limites compartilhados: falhas em UMA instancia contam na OUTRA (mesmo banco).
  if (BASE_APP) {
    const alvo = `limite${sufixo}@exemplo.test`;
    const falha = (b) => fetch(b + '/api/auth/login', { method: 'POST', headers: J, body: JSON.stringify({ email: alvo, senha: 'errada-' + Math.random() }) }).then((r) => r.status);
    const parte1 = [await falha(BASE_APP), await falha(BASE_APP), await falha(BASE_APP)];
    const parte2 = [await falha(BASE), await falha(BASE)];
    const sexta = await falha(BASE);
    const naOutra = await falha(BASE_APP);
    t('5.5', 'Limites compartilhados', 'Falhas de login somadas entre duas instâncias: a 6ª é bloqueada (429)', [...parte1, ...parte2].every((s) => s === 401) && sexta === 429, [...parte1, ...parte2, sexta].join(','));
    t('5.5', 'Limites compartilhados', 'O bloqueio vale também na outra instância (429)', naOutra === 429, `HTTP ${naOutra}`);
  }  // MFA_OBRIGATORIO=1: a equipe sem MFA entra, mas só alcança a página de segurança
  const rhProd = await fetch(BASE + '/api/auth/login', { method: 'POST', headers: J, body: JSON.stringify({ email: 'rh@onboarding.local', senha: 'onboarding123' }) });
  const rhProdJson = await rhProd.json();
  t('3.4', 'Produção', 'Com MFA obrigatório, o login do RH sem MFA sinaliza a configuração obrigatória', rhProd.status === 200 && rhProdJson.mfaConfiguracaoObrigatoria === true, `HTTP ${rhProd.status}`);
  const painelProd = await fetch(BASE + '/api/rh/fichas', { headers: { Authorization: 'Bearer ' + rhProdJson.token } });
  const painelProdJson = await painelProd.json().catch(() => ({}));
  t('3.4', 'Produção', 'Sem MFA configurado o painel do RH responde 403 mfa_obrigatoria', painelProd.status === 403 && painelProdJson.codigo === 'mfa_obrigatoria', `HTTP ${painelProd.status}`);
  const stProd = await fetch(BASE + '/api/auth/mfa/status', { headers: { Authorization: 'Bearer ' + rhProdJson.token } });
  const stProdJson = await stProd.json().catch(() => ({}));
  t('3.4', 'Produção', 'A página de segurança continua acessível para configurar (status obrigatório)', stProd.status === 200 && stProdJson.obrigatorio === true, `HTTP ${stProd.status}`);
  const h = (await fetch(BASE + '/login.html')).headers;
  t('2.1', 'Produção', 'Cabeçalhos de segurança presentes em produção', !!h.get('content-security-policy') && h.get('x-content-type-options') === 'nosniff', '');
}
async function main() {
  let base = process.env.TESTE_BASE;
  try {
    if (!base) base = await iniciarAmbiente();
    // Com o driver Postgres (pg-mem) não há Supabase falso: os testes que
    // inspecionam as linhas do banco pelo PostgREST são pulados.
    await suite(base, process.env.TESTE_BASE || POSTGRES ? null : `http://127.0.0.1:${PORTA_FALSO}`);
    if (BASE_PROD) await suiteProducao(BASE_PROD, !POSTGRES && !process.env.TESTE_BASE ? base : null);
  } catch (erro) {
    console.error('ERRO ao executar a bateria:', erro.message);
    encerrarAmbiente();
    process.exit(2);
  }
  encerrarAmbiente();

  let grupoAtual = '';
  resultados.forEach((r) => {
    if (r.grupo !== grupoAtual) { grupoAtual = r.grupo; console.log(`\n## ${grupoAtual}`); }
    const marca = r.ok ? '[ OK  ]' : (r.pendente ? '[PEND.]' : '[FALHA]');
    console.log(`${marca} (${r.item}) ${r.nome}${r.detalhe && !r.ok ? ' -> ' + r.detalhe : ''}`);
  });
  const ok = resultados.filter((r) => r.ok).length;
  const pend = resultados.filter((r) => !r.ok && r.pendente).length;
  const falhas = resultados.filter((r) => !r.ok && !r.pendente).length;
  console.log(`\nTotal: ${resultados.length} testes | ${ok} ok | ${pend} pendentes (itens do roadmap) | ${falhas} falhas`);
  process.exit(falhas ? 1 : 0);
}

main();
