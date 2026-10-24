// Carrega variáveis de ambiente de um .env local (desenvolvimento) antes de
// qualquer outro módulo ser inicializado - em nuvem e em contêiner isso é um
// no-op, pois a plataforma já injeta as variáveis de ambiente nativamente.
require('dotenv').config();

const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const bcrypt = require('bcryptjs');
const PDFDocument = require('pdfkit');
const ExcelJS = require('exceljs');
const { OAuth2Client } = require('google-auth-library');
const repo = require('./db/repositorio');
const { enviarEmail } = require('./lib/email');
const mfa = require('./lib/mfa');
const marca = require('./lib/marca');
const QRCode = require('qrcode');
const plataforma = require('./lib/plataforma');

const app = express();

// Atrás de proxy reverso (nuvem, Nginx, Caddy...) o IP real do cliente vem em
// X-Forwarded-For; sem isto req.ip seria o do proxy - o que quebraria o limite
// de tentativas de login e o IP gravado na trilha de auditoria.
if (plataforma.confiarNoProxy) {
  app.set('trust proxy', 1);
}

// ---------------------------------------------------------------------------
// CABEÇALHOS DE SEGURANÇA (aplicados a todas as respostas)
// A CSP libera só as origens que as telas realmente usam (fontes, Google
// Identity, VLibras, pdf.js, ViaCEP). 'unsafe-inline' é necessário porque as
// páginas têm scripts e estilos embutidos; o restante da política continua
// bloqueando scripts e quadros de origens desconhecidas, objetos e clickjacking.
// ---------------------------------------------------------------------------
app.disable('x-powered-by');
const POLITICA_CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' https://accounts.google.com https://vlibras.gov.br https://*.vlibras.gov.br https://cdn.jsdelivr.net https://cdnjs.cloudflare.com",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://accounts.google.com https://vlibras.gov.br https://*.vlibras.gov.br https://cdn.jsdelivr.net",
  "font-src 'self' data: https://fonts.gstatic.com https://vlibras.gov.br https://*.vlibras.gov.br",
  "img-src 'self' data: blob: https:",
  "media-src 'self' blob: https://vlibras.gov.br https://*.vlibras.gov.br",
  "connect-src 'self' https://viacep.com.br https://accounts.google.com https://vlibras.gov.br https://*.vlibras.gov.br https://cdn.jsdelivr.net https://cdnjs.cloudflare.com",
  "frame-src 'self' https://accounts.google.com https://vlibras.gov.br https://*.vlibras.gov.br",
  "worker-src 'self' blob: https://cdnjs.cloudflare.com",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'self'"
].join('; ');

app.use((req, res, next) => {
  res.set({
    'Content-Security-Policy': POLITICA_CSP,
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'SAMEORIGIN',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
    'Cross-Origin-Opener-Policy': 'same-origin-allow-popups'
  });
  // HSTS só faz sentido (e só é honrado) em HTTPS; req.secure respeita o trust proxy.
  if (req.secure) res.set('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
  next();
});

// 400 KB: comporta a foto de perfil (até ~200 KB) em base64 dentro do JSON.
app.use(express.json({ limit: '400kb' }));

// A primeira tela do sistema é o login, não a ficha do candidato - só depois
// de entrar (ou criar conta) é que o candidato é levado à Ficha de Admissão.
// A página principal ("/") é a própria tela de login (arquivo login.html),
// servida por servirComMarca (mais abaixo).

// MARCA (white-label): nome, logo e cores desta instalação (ver lib/marca.js).
const MARCA = marca.carregar();
app.get('/api/marca', (req, res) => res.status(200).json(MARCA.publico()));

// Atalho para a entrada da equipe de RH (útil em apresentações e links).
app.get('/rh', (req, res) => res.redirect(302, '/rh-login.html'));

// Compatibilidade: o antigo /index.html (ficha do candidato) agora é /ficha.html.
// Links já enviados (ex.: "?id=...") continuam funcionando.
app.get('/index.html', (req, res) => {
  const consulta = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
  return res.redirect(301, '/ficha.html' + consulta);
});

// Caminho absoluto (não relativo ao cwd) - na Vercel (serverless), o
// diretório de trabalho durante a execução da função não é garantidamente a
// raiz do projeto, então 'public' relativo pode não resolver para a pasta
// certa e todo pedido de página estática (login.html, rh.html etc.) falha
// com "Cannot GET" mesmo com os arquivos presentes no projeto.
// A bateria de testes da interface (testes.html) dispara chamadas reais à API e
// cria dados: só é servida fora de produção, ou com EXPOR_TESTES=1.
const EXPOR_TESTES = process.env.NODE_ENV !== 'production' || process.env.EXPOR_TESTES === '1';
app.get('/testes.html', (req, res, next) => {
  if (EXPOR_TESTES) return next();
  return res.status(404).type('text/plain').send('Not found');
});

// Páginas HTML (e o script dos termos) passam pela marca da instalação antes de
// sair; o resto (css, js, imagens) é servido direto. O resultado fica em cache
// por arquivo e é refeito se o arquivo mudar.
const DIRETORIO_PUBLICO = path.join(__dirname, 'public');
const cachePaginas = new Map();
function servirComMarca(req, res, next) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return next();
  let caminho;
  try { caminho = req.path === '/' ? '/login.html' : decodeURIComponent(req.path); } catch (e) { return next(); }
  const ehHtml = caminho.endsWith('.html');
  if (!ehHtml && caminho !== '/termos-privacidade.js') return next();

  const arquivo = path.join(DIRETORIO_PUBLICO, caminho);
  if (!arquivo.startsWith(DIRETORIO_PUBLICO + path.sep)) return next();
  let info;
  try { info = fs.statSync(arquivo); } catch (e) { return next(); }
  if (!info.isFile()) return next();

  let entrada = cachePaginas.get(arquivo);
  if (!entrada || entrada.mtimeMs !== info.mtimeMs) {
    entrada = { mtimeMs: info.mtimeMs, corpo: MARCA.aplicar(fs.readFileSync(arquivo, 'utf8'), { html: ehHtml }) };
    cachePaginas.set(arquivo, entrada);
  }
  res.set('Cache-Control', 'no-cache');
  return res.type(ehHtml ? 'text/html; charset=utf-8' : 'application/javascript; charset=utf-8').send(entrada.corpo);
}
app.use(servirComMarca);

app.use(express.static(DIRETORIO_PUBLICO));

// Diretório gravável dos arquivos locais (PDFs com ARMAZENAMENTO_DRIVER=local,
// planilha Mestre, reserva da auditoria). Vem de lib/plataforma.js: a pasta do
// projeto (ou DIRETORIO_DADOS, ex.: um volume Docker); em hospedagem serverless
// o disco do projeto é somente leitura e usa-se o diretório temporário, que é
// EFÊMERO - lá os dados precisam estar no banco e os PDFs em armazenamento
// externo (ARMAZENAMENTO_DRIVER).
const DIRETORIO_DADOS = plataforma.diretorioDados;

// Caminho absoluto do arquivo de persistência local (banco de dados simples em JSON)
const ARQUIVO_CANDIDATOS = path.join(DIRETORIO_DADOS, 'candidatos.json');

// Caminho absoluto da trilha de auditoria (registro imutável de eventos do RH)
const ARQUIVO_AUDITORIA = path.join(DIRETORIO_DADOS, 'auditoria.json');

// Caminho absoluto da base de contas de usuário (login/registro/Google)
const ARQUIVO_USUARIOS = path.join(DIRETORIO_DADOS, 'usuarios.json');

// Caminho absoluto dos tokens de sessão ativos (login persiste entre reinícios)
const ARQUIVO_SESSOES = path.join(DIRETORIO_DADOS, 'sessoes.json');

// Pasta onde os documentos PDF dos candidatos são armazenados
const PASTA_UPLOADS = path.join(DIRETORIO_DADOS, 'uploads');

// Garante que a pasta de uploads exista antes de qualquer envio
if (!fs.existsSync(PASTA_UPLOADS)) {
  fs.mkdirSync(PASTA_UPLOADS, { recursive: true });
}

// Armazenamento dos PDFs dos candidatos (documentos, contratos assinados e
// ficha em PDF) atrás de uma interface única - ver storage/armazenamento.js.
// As minutas dos contratos são modelos gerados pelo próprio código e ficam
// sempre na pasta local.
const armazenamento = require('./storage/armazenamento').criarArmazenamento({ pastaLocal: PASTA_UPLOADS });

// "uploads/arquivo.pdf" (referência gravada na ficha) -> "arquivo.pdf"
const nomeDoArquivo = (referencia) => String(referencia || '').replace(/^\/?uploads\//, '');

// Converte um PDFDocument (PDFKit) em Buffer, para entregar ao armazenamento.
function pdfParaBuffer(doc) {
  return new Promise((resolve, reject) => {
    const partes = [];
    doc.on('data', (parte) => partes.push(parte));
    doc.on('end', () => resolve(Buffer.concat(partes)));
    doc.on('error', reject);
  });
}

// Serve os PDFs enviados pelos candidatos para visualização/download pelo RH
// (candidato.documentos[tipo].arquivo é salvo como "uploads/arquivo.pdf")
// Os PDFs NÃO são mais servidos como arquivos estáticos públicos: contêm
// documentos pessoais. O acesso é por URL assinada de curta duração (ver
// "ACESSO AOS ARQUIVOS" mais abaixo), emitida só ao RH ou ao dono da ficha.

// Tipos de documento aceitos na jornada de admissão (uma aba para cada)
const TIPOS_DOCUMENTO = [
  'identidade',
  'cpf',
  'comprovanteResidencia',
  'comprovanteEscolaridade',
  'reservista',
  'carteiraTrabalho'
];

// Opções válidas para o campo de gênero
const GENEROS_VALIDOS = ['Masculino', 'Feminino', 'Outro', 'Prefiro não informar'];

// ---------------------------------------------------------------------------
// VALIDAÇÃO DOS DADOS PESSOAIS (espelha as regras do frontend - defesa em
// profundidade, já que a rota pode ser chamada diretamente, sem passar pela UI)
// ---------------------------------------------------------------------------

const somenteDigitos = (valor) => String(valor || '').replace(/\D/g, '');

// Verifica se DD/MM/AAAA (já sem máscara) é uma data de calendário real.
function dataNascimentoValida(digitosData) {
  if (digitosData.length !== 8) return false;
  const dia = Number(digitosData.slice(0, 2));
  const mes = Number(digitosData.slice(2, 4));
  const ano = Number(digitosData.slice(4, 8));

  if (mes < 1 || mes > 12) return false;
  const diasNoMes = new Date(ano, mes, 0).getDate();
  if (dia < 1 || dia > diasNoMes) return false;
  if (ano < 1900 || ano > new Date().getFullYear()) return false;

  return true;
}

const REGEX_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const REGEX_REPETICAO = /(.)\1{2,}/i;

// VALIDAR_CPF=0 desliga SÓ a conferência dos dígitos verificadores (o CPF ainda precisa
// ter 11 dígitos). Existe para gravações de demonstração com dados fictícios; em uso
// real deixe ligada (padrão).
const VALIDAR_DIGITOS_CPF = process.env.VALIDAR_CPF !== '0';
if (!VALIDAR_DIGITOS_CPF) console.warn('AVISO: VALIDAR_CPF=0 - a conferência dos dígitos do CPF está DESLIGADA (modo demonstração).');

// CPF válido: 11 dígitos, não todos iguais e com os dois dígitos verificadores corretos.
function cpfValido(valor) {
  const d = somenteDigitos(valor);
  if (d.length !== 11) return false;
  if (!VALIDAR_DIGITOS_CPF) return true;
  if (/^(\d)\1{10}$/.test(d)) return false;
  const digito = (n) => {
    let soma = 0;
    for (let i = 0; i < n; i += 1) soma += Number(d[i]) * (n + 1 - i);
    const resto = (soma * 10) % 11;
    return resto === 10 ? 0 : resto;
  };
  return digito(9) === Number(d[9]) && digito(10) === Number(d[10]);
}

// Política de senha: 8 a 72 caracteres (o bcrypt ignora o que passa de 72),
// com letras e números, e fora de uma lista de senhas triviais. Retorna a
// mensagem de erro ou null se a senha é aceitável.
const SENHAS_COMUNS = new Set([
  '12345678', '123456789', '1234567890', '11111111', '00000000', 'password', 'password1', 'senha123',
  'senha1234', 'qwerty123', 'abc12345', 'admin123', 'onboarding', 'mudar123', 'brasil123', 'abcd1234'
]);
function erroSenhaFraca(senha) {
  const s = String(senha || '');
  if (s.length < 8 || s.length > 72) return 'A senha deve ter de 8 a 72 caracteres.';
  if (!/[A-Za-z]/.test(s) || !/\d/.test(s)) return 'A senha deve conter letras e números.';
  if (SENHAS_COMUNS.has(s.toLowerCase())) return 'Esta senha é muito comum. Escolha outra.';
  return null;
}

// Retorna a lista de erros de validação dos dados pessoais (vazia = tudo ok).
function validarDadosPessoais(dados) {
  const erros = [];
  const nome = String(dados.nomeCompleto || '').trim();
  const possuiSobrenome = nome.split(' ').filter((p) => p.length > 0).length >= 2;

  if (!nome || !possuiSobrenome || REGEX_REPETICAO.test(nome)) {
    erros.push('Nome completo inválido (informe nome e sobrenome, sem sequências repetidas).');
  }
  if (!dados.email || !REGEX_EMAIL.test(String(dados.email).trim())) {
    erros.push('E-mail inválido.');
  }
  if (!dados.genero || !GENEROS_VALIDOS.includes(dados.genero)) {
    erros.push('Gênero inválido.');
  }
  if (!cpfValido(dados.cpf)) {
    erros.push('CPF incompleto ou inválido.');
  }
  // Limites de tamanho: evitam abuso de armazenamento e textos gigantes na tela.
  const limites = [['nomeCompleto', 120], ['email', 254], ['logradouro', 150], ['bairro', 80], ['numero', 20], ['complemento', 80]];
  if (limites.some(([campo, max]) => String(dados[campo] || '').length > max)) {
    erros.push('Algum campo excede o tamanho permitido.');
  }
  if (somenteDigitos(dados.cep).length !== 8) {
    erros.push('CEP incompleto ou inválido.');
  }
  if (!dataNascimentoValida(somenteDigitos(dados.dataNascimento))) {
    erros.push('Data de nascimento incompleta ou inválida.');
  }
  const digitosWhatsapp = somenteDigitos(dados.whatsapp);
  if (digitosWhatsapp.length !== 10 && digitosWhatsapp.length !== 11) {
    erros.push('WhatsApp/Telefone incompleto.');
  }
  if (!String(dados.logradouro || '').trim()) erros.push('Logradouro não informado.');
  if (!String(dados.bairro || '').trim()) erros.push('Bairro não informado.');
  if (!String(dados.numero || '').trim()) erros.push('Número não informado.');

  return erros;
}

// ---------------------------------------------------------------------------
// PERSISTÊNCIA
// ---------------------------------------------------------------------------

// Mapeia uma linha da tabela "candidatos" (snake_case, Postgres) + as
// mensagens de chat já carregadas para o objeto camelCase que o resto deste
// arquivo e os dois frontends (public/ficha.html, public/rh.html) esperam.
function candidatoParaCamelCase(row, mensagens) {
  return {
    id: row.id,
    nomeCompleto: row.nome_completo,
    cpf: row.cpf,
    email: row.email,
    whatsapp: row.whatsapp,
    genero: row.genero,
    cep: row.cep,
    logradouro: row.logradouro,
    bairro: row.bairro,
    numero: row.numero,
    complemento: row.complemento,
    dataNascimento: row.data_nascimento,
    status: row.status,
    cpfInclusoNaIdentidade: row.cpf_incluso_na_identidade,
    documentos: row.documentos,
    decisaoFinal: row.decisao_final,
    decisaoFinalEm: row.decisao_final_em,
    usuarioId: row.usuario_id,
    contrato: row.contrato,
    consentimentoFichaLGPD: row.consentimento_ficha_lgpd,
    consentimentoContratoLGPD: row.consentimento_contrato_lgpd,
    integracaoPonto: row.integracao_ponto,
    fichaPdf: row.ficha_pdf,
    criadoEm: row.criado_em,
    atualizadoEm: row.atualizado_em,
    anonimizadoEm: row.anonimizado_em || null,
    bancoTalentos: !!row.banco_talentos,
    bancoTalentosEm: row.banco_talentos_em || null,
    tags: Array.isArray(row.tags) ? row.tags : [],
    mensagens: mensagens || []
  };
}

// Mapeia um candidato (camelCase, formato do app) para a linha snake_case da
// tabela "candidatos" - "mensagens" fica de fora de propósito, pois tem
// caminho de gravação próprio (tabela "mensagens_chat", ver rota POST
// /api/candidato/:id/mensagens) e não deve ser reescrito num upsert genérico.
function candidatoParaSnakeCase(c) {
  return {
    id: c.id,
    nome_completo: c.nomeCompleto,
    cpf: c.cpf,
    email: c.email,
    whatsapp: c.whatsapp,
    genero: c.genero,
    cep: c.cep,
    logradouro: c.logradouro,
    bairro: c.bairro,
    numero: c.numero,
    complemento: c.complemento,
    data_nascimento: c.dataNascimento,
    status: c.status,
    cpf_incluso_na_identidade: !!c.cpfInclusoNaIdentidade,
    documentos: c.documentos,
    decisao_final: c.decisaoFinal || null,
    decisao_final_em: c.decisaoFinalEm || null,
    usuario_id: c.usuarioId || null,
    contrato: c.contrato,
    consentimento_ficha_lgpd: c.consentimentoFichaLGPD,
    consentimento_contrato_lgpd: c.consentimentoContratoLGPD,
    integracao_ponto: c.integracaoPonto,
    ficha_pdf: c.fichaPdf || null,
    criado_em: c.criadoEm,
    // Sempre com um valor explícito (nunca undefined): um candidato recém
    // criado ainda não tem atualizadoEm - cai para criadoEm. Isso evita um
    // problema real do PostgREST em upserts em lote: se um objeto do lote
    // não tem a chave (undefined) enquanto outros têm, o PostgREST manda
    // NULL para essa linha, violando a coluna NOT NULL da tabela.
    atualizado_em: c.atualizadoEm || c.criadoEm || new Date().toISOString(),
    // Sempre explícitos pelo mesmo motivo do upsert em lote descrito acima
    // (colunas banco_talentos e tags são NOT NULL).
    banco_talentos: !!c.bancoTalentos,
    banco_talentos_em: c.bancoTalentosEm || null,
    tags: Array.isArray(c.tags) ? c.tags : []
  };
}

// Mapeia uma linha da tabela "mensagens_chat" para o formato camelCase já
// usado pelo chat (candidato_id fica de fora - é implícito, o array já está
// aninhado dentro do candidato correspondente).
function mensagemParaCamelCase(row) {
  return {
    id: row.id,
    autor: row.autor,
    nomeAutor: row.nome_autor,
    texto: row.texto,
    timestamp: row.timestamp,
    ip: row.ip
  };
}

// Lê a lista de candidatos do Supabase (tabela "candidatos" + mensagens de
// chat embutidas a partir de "mensagens_chat"). Mantém exatamente o mesmo
// formato (camelCase, array) que o restante do arquivo sempre esperou.
async function lerCandidatos() {
  const linhas = await repo.listarCandidatos();
  const mensagensLinhas = await repo.listarMensagens();

  const mensagensPorCandidato = {};
  mensagensLinhas.forEach((m) => {
    if (!mensagensPorCandidato[m.candidato_id]) mensagensPorCandidato[m.candidato_id] = [];
    mensagensPorCandidato[m.candidato_id].push(mensagemParaCamelCase(m));
  });

  const candidatos = linhas.map((row) => candidatoParaCamelCase(row, mensagensPorCandidato[row.id] || []));
  // Foto do estado lido (antes das migrações abaixo): salvarCandidatos grava só
  // as fichas que mudaram em relação a ela.
  candidatos.forEach((c) => marcarEstadoLido(c, candidatoParaSnakeCase));

  // Migração leve: fichas criadas antes do módulo de contratação/autenticação
  // não têm os campos "contrato"/"usuarioId" preenchidos - aplica o mesmo
  // valor padrão que já existia na época dos arquivos JSON.
  candidatos.forEach((c) => {
    if (!c.contrato || !c.contrato.documentos) c.contrato = criarContratoInicial();
    TIPOS_CONTRATO.forEach((tipo) => {
      if (c.contrato.documentos[tipo] && c.contrato.documentos[tipo].arquivoAssinado === undefined) {
        c.contrato.documentos[tipo].arquivoAssinado = null;
      }
    });
    if (c.usuarioId === undefined) c.usuarioId = null;
    if (c.consentimentoFichaLGPD === undefined) c.consentimentoFichaLGPD = null;
    if (c.consentimentoContratoLGPD === undefined) c.consentimentoContratoLGPD = null;
    if (c.integracaoPonto === undefined) c.integracaoPonto = criarIntegracaoPontoInicial();

    // Migração: fichas gravadas antes da consolidação para 4 status ainda têm
    // os valores antigos (VERMELHO/AMARELO/APROVADO) - normaliza para o
    // modelo atual assim que lidas, sem precisar recriar a base de dados.
    if (c.status === 'VERMELHO' || c.status === 'AMARELO') c.status = 'EM_ANALISE';
    else if (c.status === 'APROVADO') c.status = 'PENDENTE_ASSINATURA';
  });

  return candidatos;
}

// Grava (upsert) a lista completa de candidatos no Supabase - "mensagens" é
// excluído do upsert de propósito (ver candidatoParaSnakeCase). Toda gravação
// (nova ficha, mudança de status, decisão, contrato etc.) também dispara a
// atualização da planilha Mestre em Excel, em segundo plano - não bloqueia a
// resposta da requisição que originou a gravação.
async function salvarCandidatos(lista) {
  // Só as fichas alteradas (ou novas) são gravadas: regravar a lista inteira com
  // os dados lidos antes desfazia, em silêncio, mudanças feitas em paralelo em
  // outras fichas.
  const linhas = linhasAlteradas(lista, candidatoParaSnakeCase);
  if (linhas.length) await repo.gravarCandidatos(linhas);
  atualizarPlanilhaMestre();
}

// Guarda, fora do objeto (propriedade não enumerável), a linha como foi lida.
function marcarEstadoLido(objeto, paraLinha) {
  Object.defineProperty(objeto, '__lido', {
    value: JSON.stringify(paraLinha(objeto)), enumerable: false, writable: true, configurable: true
  });
}

// Linhas (já no formato do banco) dos itens novos ou alterados desde a leitura.
function linhasAlteradas(lista, paraLinha) {
  return lista
    .map((item) => ({ item, linha: paraLinha(item) }))
    .filter(({ item, linha }) => item.__lido === undefined || item.__lido !== JSON.stringify(linha))
    .map(({ linha }) => linha);
}

// Gera um identificador único e imprevisível (UUID v4, do gerador criptográfico).
// Fichas, usuários e eventos criados antes desta mudança mantêm o formato antigo.
function gerarId() {
  return crypto.randomUUID();
}

// ---------------------------------------------------------------------------
// TRILHA DE AUDITORIA (LGPD) - registro imutável de eventos do RH
// ---------------------------------------------------------------------------

// A trilha fica na tabela "auditoria" do Supabase, que é somente de acréscimo
// (um gatilho no banco recusa UPDATE, DELETE e TRUNCATE - ver
// supabase/migracao_auditoria.sql) e sobrevive a reinícios e a ambientes sem
// disco persistente. O arquivo auditoria.json local só recebe o evento como
// RESERVA, se a gravação no banco falhar (ex.: migração ainda não aplicada).

// Reserva local: acrescenta o evento ao auditoria.json.
function gravarAuditoriaLocal(evento) {
  let eventos = [];
  try {
    const conteudo = fs.existsSync(ARQUIVO_AUDITORIA) ? fs.readFileSync(ARQUIVO_AUDITORIA, 'utf-8').trim() : '';
    if (conteudo) eventos = JSON.parse(conteudo);
  } catch (erro) {
    eventos = [];
  }
  eventos.push(evento);
  fs.writeFileSync(ARQUIVO_AUDITORIA, JSON.stringify(eventos, null, 2), 'utf-8');
}

// Acrescenta um evento à trilha de auditoria. Devolve uma Promise que NUNCA
// rejeita: chame com "await" nas rotas, para o registro terminar antes de a
// resposta sair (em serverless a função pode ser congelada logo depois).
async function registrarEventoAuditoria(evento) {
  try {
    await repo.inserirAuditoria({
      id: String(evento.id || gerarId()),
      tipo_evento: String(evento.tipoEvento || 'evento'),
      usuario_id: evento.usuarioId || null,
      candidato_id: evento.candidatoId || null,
      ip: evento.ip || null,
      ocorrido_em: evento.timestamp || new Date().toISOString(),
      dados: evento
    });
  } catch (erro) {
    console.error('Falha ao gravar auditoria no banco (usando reserva local):', erro.message);
    try {
      gravarAuditoriaLocal(evento);
    } catch (erroLocal) {
      console.error('Falha também na reserva local da auditoria:', erroLocal.message);
    }
  }
}

// Eventos de auditoria de uma ficha (do candidato e das ações sobre ela).
async function lerAuditoriaDaFicha(candidato, limite = 200) {
  const consultas = [repo.listarAuditoria({ candidatoId: candidato.id, limite })];
  if (candidato.usuarioId) consultas.push(repo.listarAuditoria({ usuarioId: candidato.usuarioId, limite }));
  const resultados = await Promise.all(consultas);
  const vistos = new Map();
  resultados.forEach((linhas) => linhas.forEach((linha) => vistos.set(linha.id, linha)));
  return [...vistos.values()]
    .sort((a, b) => String(b.ocorrido_em).localeCompare(String(a.ocorrido_em)))
    .slice(0, limite)
    .map((l) => ({ id: l.id, tipoEvento: l.tipo_evento, ocorridoEm: l.ocorrido_em, ip: l.ip, usuarioId: l.usuario_id, candidatoId: l.candidato_id, dados: l.dados }));
}

// ---------------------------------------------------------------------------
// AUTENTICAÇÃO: PERSISTÊNCIA DE USUÁRIOS E SESSÕES
// ---------------------------------------------------------------------------

// Mapeia uma linha da tabela "usuarios" (snake_case) para o objeto camelCase
// que o restante do arquivo espera.
function usuarioParaCamelCase(row) {
  return {
    id: row.id,
    nome: row.nome,
    email: row.email,
    senhaSalt: row.senha_salt,
    senhaHash: row.senha_hash,
    tipo: row.tipo,
    googleId: row.google_id,
    foto: row.foto || null,
    cpf: row.cpf,
    dataNascimento: row.data_nascimento,
    ativo: row.ativo,
    tokenAtivacao: row.token_ativacao,
    consentimentoCadastro: row.consentimento_cadastro,
    // Verificação em duas etapas (ver migracao_mfa.sql). Ausente = desativada.
    mfaAtivo: row.mfa_ativo === true,
    mfaSegredo: row.mfa_segredo || null,
    mfaCodigos: Array.isArray(row.mfa_codigos) ? row.mfa_codigos : [],
    mfaUltimoPasso: Number(row.mfa_ultimo_passo) || 0,
    criadoEm: row.criado_em
  };
}

// Mapeia um usuário (camelCase) para a linha snake_case da tabela "usuarios".
function usuarioParaSnakeCase(u) {
  return {
    id: u.id,
    nome: u.nome,
    email: u.email,
    senha_salt: u.senhaSalt || null,
    senha_hash: u.senhaHash || null,
    tipo: u.tipo,
    google_id: u.googleId || null,
    foto: u.foto || null,
    cpf: u.cpf || null,
    data_nascimento: u.dataNascimento || null,
    ativo: u.ativo !== false,
    token_ativacao: u.tokenAtivacao || null,
    consentimento_cadastro: u.consentimentoCadastro || null,
    criado_em: u.criadoEm
    // As colunas mfa_* NÃO entram aqui de propósito: só as rotas de MFA as
    // gravam (por update pontual), e assim um upsert de usuário nunca
    // sobrescreve o segredo nem falha em bancos ainda sem a migração.
  };
}

async function lerUsuarios() {
  const usuarios = (await repo.listarUsuarios()).map(usuarioParaCamelCase);
  usuarios.forEach((u) => marcarEstadoLido(u, usuarioParaSnakeCase));
  return usuarios;
}

// Busca um único usuário pelo id (usado a cada requisição autenticada).
async function buscarUsuarioPorId(id) {
  const linha = await repo.buscarUsuario(id);
  return linha ? usuarioParaCamelCase(linha) : null;
}

async function salvarUsuarios(lista) {
  const linhas = linhasAlteradas(lista, usuarioParaSnakeCase);
  if (!linhas.length) return;
  await repo.gravarUsuarios(linhas);
}

// SESSÕES
// O token entregue ao navegador é aleatório (256 bits) e NUNCA é guardado: a
// tabela "sessoes" só tem o SHA-256 dele. Quem ler o banco (backup, acesso
// indevido) não consegue usar as sessões. Cada operação mexe em uma linha só,
// sem regravar a tabela inteira.
const hashToken = (token) => crypto.createHash('sha256').update(String(token)).digest('hex');
const REGEX_HASH_TOKEN = /^[0-9a-f]{64}$/;

async function inserirSessao(token, usuarioId, criadoEm, expiraEm) {
  await repo.inserirSessao({
    token: hashToken(token), usuario_id: usuarioId, criado_em: criadoEm, expira_em: expiraEm
  });
}

async function removerSessaoPorToken(token) {
  await repo.removerSessao(hashToken(token));
}

// Remove sessões antigas: expiradas e as gravadas no formato legado (token em
// texto puro, anterior ao hash). Melhor esforço, roda no boot.
async function limparSessoesAntigas() {
  const agora = Date.now();
  const obsoletas = (await repo.listarSessoes()).filter((s) => !REGEX_HASH_TOKEN.test(String(s.token)) || Number(s.expira_em) <= agora);
  for (const s of obsoletas) {
    await repo.removerSessao(s.token);
  }
  return obsoletas.length;
}

// Tempo de validade de um token de sessão: 7 dias.
const DURACAO_SESSAO_MS = 7 * 24 * 60 * 60 * 1000;

// Gera hash de senha com bcrypt. O salt fica embutido no próprio hash (não
// precisa de um campo separado) - senha nunca é armazenada em texto puro.
function gerarHashSenha(senha) {
  const hash = bcrypt.hashSync(String(senha), 10);
  return { salt: null, hash };
}

// Contas criadas antes da migração para bcrypt ainda têm senhaSalt preenchido
// (hash gerado com scrypt, nativo do Node) - continuam funcionando via essa
// verificação legada, sem exigir que o usuário redefina a senha.
function senhaConfereScryptLegado(senha, salt, hashEsperado) {
  const hash = crypto.scryptSync(senha, salt, 64).toString('hex');
  // Comparação em tempo constante para evitar timing attacks.
  const bufA = Buffer.from(hash, 'hex');
  const bufB = Buffer.from(hashEsperado, 'hex');
  return bufA.length === bufB.length && crypto.timingSafeEqual(bufA, bufB);
}

function senhaConfere(senha, salt, hashEsperado) {
  if (salt) return senhaConfereScryptLegado(String(senha), salt, hashEsperado);
  return bcrypt.compareSync(String(senha), hashEsperado);
}

function dadosPublicosUsuario(usuario) {
  return {
    id: usuario.id,
    nome: usuario.nome,
    email: usuario.email,
    tipo: usuario.tipo,
    cpf: usuario.cpf || null,
    dataNascimento: usuario.dataNascimento || null,
    foto: usuario.foto || null
  };
}

// ---------------------------------------------------------------------------
// FOTO DE PERFIL: data URL guardada em texto (usuarios.foto / configuracoes.foto_rh).
// O navegador já entrega a imagem recortada e reduzida (~256x256 JPEG); aqui
// só se valida formato, assinatura do arquivo e tamanho antes de gravar.
// ---------------------------------------------------------------------------
const MAX_BYTES_FOTO = 200 * 1024;
const REGEX_FOTO_DATA_URL = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/]+={0,2})$/;

// Retorna true se for uma data URL de imagem válida (formato, base64, assinatura e tamanho).
function fotoValida(valor) {
  if (typeof valor !== 'string' || valor.length > Math.ceil(MAX_BYTES_FOTO * 4 / 3) + 64) return false;
  const m = REGEX_FOTO_DATA_URL.exec(valor);
  if (!m || m[2].length % 4 !== 0) return false;
  const bytes = Buffer.from(m[2], 'base64');
  if (!bytes.length || bytes.length > MAX_BYTES_FOTO) return false;
  if (m[1] === 'jpeg') return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (m[1] === 'png') return bytes.length > 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  return bytes.length > 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
}

// Baixa a foto de perfil do Google e devolve como data URL, ou null se algo
// fugir do esperado (nunca lança: o login não pode falhar por causa da foto).
// Só aceita https em domínios googleusercontent.com, sem seguir redirecionamentos (evita SSRF).
async function baixarFotoGoogle(url) {
  try {
    const alvo = new URL(String(url || ''));
    if (alvo.protocol !== 'https:' || !(alvo.hostname === 'googleusercontent.com' || alvo.hostname.endsWith('.googleusercontent.com'))) return null;
    alvo.href = alvo.href.replace(/=s\d+(-c)?$/, '=s256-c');
    const resposta = await fetch(alvo, { redirect: 'error', signal: AbortSignal.timeout(3000) });
    const tipo = String(resposta.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (!resposta.ok || !['image/jpeg', 'image/png', 'image/webp'].includes(tipo)) return null;
    const tamanho = Number(resposta.headers.get('content-length'));
    if (tamanho > MAX_BYTES_FOTO) return null;
    const bytes = Buffer.from(await resposta.arrayBuffer());
    if (bytes.length > MAX_BYTES_FOTO) return null;
    const dataUrl = `data:${tipo};base64,${bytes.toString('base64')}`;
    return fotoValida(dataUrl) ? dataUrl : null;
  } catch (erro) {
    return null;
  }
}

// Cria uma sessão para o usuário e persiste o token (login e registro reutilizam isso).
async function criarSessao(usuarioId) {
  const token = crypto.randomBytes(32).toString('hex');
  const agora = Date.now();
  await inserirSessao(token, usuarioId, agora, agora + DURACAO_SESSAO_MS);
  return token;
}

// Resolve o usuário autenticado a partir do header Authorization: Bearer <token>.
// Retorna null se o token estiver ausente, inválido ou expirado.
async function resolverUsuarioPorToken(req) {
  const cabecalho = req.headers.authorization || '';
  const token = cabecalho.startsWith('Bearer ') ? cabecalho.slice(7) : null;
  if (!token) return null;

  const sessao = await repo.buscarSessao(hashToken(token));
  if (!sessao || Number(sessao.expira_em) <= Date.now()) return null;

  return buscarUsuarioPorId(sessao.usuario_id);
}

// Middleware: exige sessão válida (qualquer papel) e anexa req.usuario.
async function autenticar(req, res, next) {
  try {
    const usuario = await resolverUsuarioPorToken(req);
    if (!usuario) return res.status(401).json({ erro: 'Sessão inválida ou expirada. Faça login novamente.' });
    req.usuario = usuario;
    next();
  } catch (erro) {
    console.error('Falha ao resolver sessão:', erro.message);
    return res.status(500).json({ erro: 'Falha ao validar a sessão.' });
  }
}

// Middleware: anexa req.usuario se houver um token válido, mas não bloqueia a
// requisição caso não haja sessão (usado no cadastro da ficha, que continua
// funcionando de forma anônima por compatibilidade).
async function autenticarOpcional(req, res, next) {
  try {
    req.usuario = await resolverUsuarioPorToken(req);
  } catch (erro) {
    console.error('Falha ao resolver sessão (opcional):', erro.message);
    req.usuario = null;
  }
  next();
}

// PAPÉIS
//   candidato  preenche a própria ficha
//   rh         operador do RH da empresa contratante
//   admin      administrador da empresa contratante: tem todos os acessos do RH
//              e cria/gerencia os operadores (rh)
//   master     dono da plataforma (externo): só cria/gerencia contas admin e
//              NÃO acessa fichas nem documentos de candidatos
const PAPEIS_EQUIPE_RH = ['rh', 'admin'];
const ehEquipeRh = (usuario) => !!usuario && PAPEIS_EQUIPE_RH.includes(usuario.tipo);

// Verificação em duas etapas (TOTP). Opcional por padrão (a conta pública de
// demonstração do RH não a usa); MFA_OBRIGATORIO=1 exige para rh, admin e master.
const MFA_OBRIGATORIO = process.env.MFA_OBRIGATORIO === '1';
const mfaPendente = (usuario) => MFA_OBRIGATORIO && usuario.tipo !== 'candidato' && !usuario.mfaAtivo;

// Fábrica de middleware: exige sessão válida e um dos papéis informados.
function exigirPapeis(papeis, mensagem) {
  return async (req, res, next) => {
    try {
      const usuario = await resolverUsuarioPorToken(req);
      if (!usuario) return res.status(401).json({ erro: 'Sessão inválida ou expirada. Faça login novamente.' });
      if (!papeis.includes(usuario.tipo)) return res.status(403).json({ erro: mensagem });
      if (mfaPendente(usuario)) {
        return res.status(403).json({ erro: 'Ative a verificação em duas etapas para continuar.', codigo: 'mfa_obrigatoria' });
      }
      req.usuario = usuario;
      return next();
    } catch (erro) {
      console.error('Falha ao resolver sessão:', erro.message);
      return res.status(500).json({ erro: 'Falha ao validar a sessão.' });
    }
  };
}

// Painel do RH: operadores (rh) e administradores (admin) da empresa.
const exigirRh = exigirPapeis(PAPEIS_EQUIPE_RH, 'Acesso restrito à equipe de RH.');
const exigirAdmin = exigirPapeis(['admin'], 'Acesso restrito ao administrador da empresa.');
const exigirMaster = exigirPapeis(['master'], 'Acesso restrito ao administrador da plataforma.');

// Regra de acesso a uma ficha individual: o RH vê qualquer ficha; o candidato
// só vê a própria (vinculada à conta pelo usuarioId; fichas antigas, criadas
// sem login, caem no e-mail da conta).
function usuarioEhDonoDaFicha(usuario, candidato) {
  if (!usuario || !candidato || usuario.tipo !== 'candidato') return false;
  if (candidato.usuarioId) return candidato.usuarioId === usuario.id;
  const emailFicha = String(candidato.email || '').trim().toLowerCase();
  return emailFicha !== '' && emailFicha === String(usuario.email || '').trim().toLowerCase();
}

function usuarioPodeVerFicha(usuario, candidato) {
  if (!usuario || !candidato) return false;
  return ehEquipeRh(usuario) || usuarioEhDonoDaFicha(usuario, candidato);
}

const ERRO_FICHA_DE_OUTRA_CONTA = 'Esta ficha pertence a outra conta.';

// ---------------------------------------------------------------------------
// REGRAS DE NEGÓCIO DOS DOCUMENTOS
// ---------------------------------------------------------------------------

// Cria a estrutura inicial dos 6 documentos, já aplicando a regra do reservista.
function criarDocumentosIniciais(genero) {
  const documentos = {};

  TIPOS_DOCUMENTO.forEach((tipo) => {
    documentos[tipo] = { arquivo: null, status: 'VERMELHO', atualizadoEm: null, pendencia: null };
  });

  // Regra do Certificado de Reservista: obrigatório apenas para gênero Masculino.
  // Nos demais casos a aba é dispensada e o status já nasce APROVADO (VERDE).
  if (genero !== 'Masculino') {
    documentos.reservista.status = 'VERDE';
    documentos.reservista.atualizadoEm = new Date().toISOString();
  }

  return documentos;
}

// Estrutura inicial do controle de integração com o sistema de ponto/RH
// externo (Arquitetura B2B) - nasce como "não exportado"; fica marcado
// manualmente pelo RH (ou por uma futura integração automática) quando os
// dados do candidato admitido são enviados ao sistema de ponto de destino.
function criarIntegracaoPontoInicial() {
  return { exportado: false, timestamp: null, sistemaAlvo: null };
}

// Reavalia a regra do reservista quando o gênero do candidato muda.
function aplicarRegraReservista(candidato) {
  const doc = candidato.documentos.reservista;

  if (candidato.genero !== 'Masculino') {
    // Dispensado: aba desabilitada e status automático VERDE
    doc.status = 'VERDE';
    doc.arquivo = null;
    doc.atualizadoEm = new Date().toISOString();
  } else if (doc.status === 'VERDE' && !doc.arquivo) {
    // Voltou a ser obrigatório e ainda não há PDF enviado: retorna a PENDENTE
    doc.status = 'VERMELHO';
    doc.atualizadoEm = new Date().toISOString();
  }
}

// Quando "CPF incluso na identidade" está marcado, a aba CPF herda o status da Identidade.
function aplicarRegraCpfIncluso(candidato) {
  if (candidato.cpfInclusoNaIdentidade) {
    candidato.documentos.cpf.status = candidato.documentos.identidade.status;
    candidato.documentos.cpf.arquivo = null;
    candidato.documentos.cpf.atualizadoEm = new Date().toISOString();
  }
}


// ---------------------------------------------------------------------------
// ACESSO AOS ARQUIVOS (PDFs em uploads/): URL assinada de curta duração
// O navegador não envia o token de sessão em <iframe>/<a href>, então o
// cliente pede uma URL assinada (POST /api/arquivos/assinar), que só é
// emitida ao RH ou à conta dona da ficha. A assinatura é um HMAC-SHA256 do
// nome do arquivo + validade, com um segredo do servidor.
// ---------------------------------------------------------------------------
const VALIDADE_URL_ARQUIVO_MS = 5 * 60 * 1000;
const REGEX_NOME_ARQUIVO = /^[\w.-]+\.pdf$/i;

// Segredo de assinatura: ARQUIVOS_SEGREDO (recomendado). Sem ele, deriva da
// chave secret do Supabase (só existe no servidor) - funciona, mas trocar a
// chave invalida as URLs já emitidas. Nunca derive da chave pública.
function segredoArquivos() {
  const dedicado = process.env.ARQUIVOS_SEGREDO || '';
  if (dedicado.length >= 16) return dedicado;
  return 'arquivos-v1|' + (process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY || process.env.DATABASE_URL || 'sem-chave');
}

function assinarArquivo(nome, expiraEm) {
  return crypto.createHmac('sha256', segredoArquivos()).update(`${nome}|${expiraEm}`).digest('hex');
}

function assinaturaArquivoValida(nome, expiraEm, assinatura) {
  const exp = Number(expiraEm);
  if (!Number.isFinite(exp) || exp < Date.now()) return false;
  const esperada = Buffer.from(assinarArquivo(nome, exp), 'hex');
  let recebida;
  try { recebida = Buffer.from(String(assinatura || ''), 'hex'); } catch (e) { return false; }
  return recebida.length === esperada.length && crypto.timingSafeEqual(recebida, esperada);
}

// Ficha a que um arquivo pertence (documento enviado, contrato assinado ou PDF da ficha).
async function fichaDoArquivo(nome) {
  const caminho = 'uploads/' + nome;
  const candidatos = await lerCandidatos();
  return candidatos.find((c) => {
    if (nome === `ficha-${c.id}.pdf`) return true;
    if (Object.values(c.documentos || {}).some((d) => d && d.arquivo === caminho)) return true;
    return Object.values((c.contrato && c.contrato.documentos) || {}).some((d) => d && d.arquivoAssinado === caminho);
  }) || null;
}

// Emite a URL assinada. Corpo: { arquivo: "uploads/nome.pdf" }.
app.post('/api/arquivos/assinar', autenticar, async (req, res) => {
  try {
    const bruto = String((req.body || {}).arquivo || '');
    const nome = bruto.replace(/^\/?uploads\//, '');
    if (!REGEX_NOME_ARQUIVO.test(nome)) return res.status(400).json({ erro: 'Arquivo inválido.' });
    if (!(await armazenamento.existe(nome))) return res.status(404).json({ erro: 'Arquivo não encontrado.' });

    const ficha = await fichaDoArquivo(nome);
    if (!ficha || !usuarioPodeVerFicha(req.usuario, ficha)) {
      return res.status(403).json({ erro: 'Você não tem acesso a este arquivo.' });
    }

    const expiraEm = Date.now() + VALIDADE_URL_ARQUIVO_MS;
    return res.status(200).json({
      url: `/uploads/${encodeURIComponent(nome)}?exp=${expiraEm}&sig=${assinarArquivo(nome, expiraEm)}`,
      expiraEm
    });
  } catch (erro) {
    console.error('Falha ao assinar URL de arquivo:', erro.message);
    return res.status(500).json({ erro: 'Falha ao liberar o arquivo.' });
  }
});

// Entrega o PDF somente com assinatura válida e não expirada. As minutas dos
// contratos são modelos públicos (também disponíveis em /api/contrato/minuta).
app.get('/uploads/:nome', async (req, res) => {
  try {
    const nome = String(req.params.nome || '');
    if (!REGEX_NOME_ARQUIVO.test(nome)) return res.status(400).json({ erro: 'Arquivo inválido.' });

    const minutaPublica = /^minuta-[A-Za-z]+\.pdf$/.test(nome);
    if (!minutaPublica && !assinaturaArquivoValida(nome, req.query.exp, req.query.sig)) {
      return res.status(403).json({ erro: 'Link inválido ou expirado. Abra o documento novamente pelo sistema.' });
    }

    // Minutas (modelos) ficam na pasta local; os documentos dos candidatos, no armazenamento.
    const conteudo = minutaPublica
      ? (fs.existsSync(path.join(PASTA_UPLOADS, nome)) ? fs.readFileSync(path.join(PASTA_UPLOADS, nome)) : null)
      : await armazenamento.ler(nome);
    if (!conteudo) return res.status(404).json({ erro: 'Arquivo não encontrado.' });

    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="${nome}"`,
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff'
    });
    return res.status(200).send(conteudo);
  } catch (erro) {
    console.error('Falha ao entregar arquivo:', erro.message);
    return res.status(500).json({ erro: 'Falha ao abrir o arquivo.' });
  }
});

// ---------------------------------------------------------------------------
// UPLOAD DE PDF (multer)
// ---------------------------------------------------------------------------

// Em memoria: nada e gravado antes de a ficha, o dono e as regras serem validados;
// o nome do arquivo e gerado pelo servidor ao salvar no armazenamento.
const armazenamentoMemoria = multer.memoryStorage();

// Aceita somente arquivos PDF.
// Alguns navegadores (sobretudo no Windows) enviam o PDF com mimetype
// 'application/octet-stream' ou 'application/x-pdf'; por isso também
// validamos pela extensão do nome do arquivo.
const MIMETYPES_PDF = ['application/pdf', 'application/x-pdf', 'application/octet-stream'];

const filtroPdf = (req, file, cb) => {
  const extensaoPdf = path.extname(file.originalname).toLowerCase() === '.pdf';
  const mimetypeAceito = MIMETYPES_PDF.includes(file.mimetype);

  if (extensaoPdf && mimetypeAceito) {
    cb(null, true);
  } else {
    cb(new Error('Apenas arquivos PDF são aceitos.'));
  }
};

const upload = multer({
  storage: armazenamentoMemoria,
  fileFilter: filtroPdf,
  limits: { fileSize: 10 * 1024 * 1024 } // 10 MB por arquivo
});

// ---------------------------------------------------------------------------
// LIMITES DE TAXA (anti spam e abuso de custo)
// Contadores compartilhados entre instâncias (banco, lib/limites.js); sem o
// banco, cada processo conta sozinho. Valores ajustáveis por variável de
// ambiente (ver .env.example).
// ---------------------------------------------------------------------------
function limiteDoAmbiente(nome, padrao) {
  const valor = Number(process.env[nome]);
  return Number.isFinite(valor) && valor > 0 ? valor : padrao;
}

// Os contadores ficam no banco (lib/limites.js), compartilhados entre as
// instancias; sem banco disponivel, cada processo conta sozinho.
const contadores = require('./lib/limites').criar({ repo, compartilhado: process.env.LIMITES_COMPARTILHADOS !== '0' });

// `nome` separa os contadores de cada limitador (a chave compartilhada e
// `lim|nome|chave`) e precisa ser estavel entre versoes.
function criarLimitador({ nome, janelaMs, max, chave, mensagem }) {
  return async (req, res, next) => {
    const { contagem, fim } = await contadores.incrementar(`lim|${nome}|${chave(req)}`, janelaMs);
    if (contagem > max) {
      res.set('Retry-After', String(Math.max(1, Math.ceil((fim - Date.now()) / 1000))));
      return res.status(429).json({ erro: mensagem });
    }
    return next();
  };
}

const HORA_MS = 60 * 60 * 1000;
const porIp = (req) => `ip|${req.ip}`;
const porUsuarioOuIp = (req) => (req.usuario ? `u|${req.usuario.id}` : `ip|${req.ip}`);

const limiteCadastros = criarLimitador({ nome: 'limiteCadastros',
  janelaMs: HORA_MS, max: limiteDoAmbiente('LIMITE_CADASTROS_HORA', 20), chave: porIp,
  mensagem: 'Muitos cadastros a partir deste endereço. Tente novamente mais tarde.'
});
const limiteAtivacoes = criarLimitador({ nome: 'limiteAtivacoes',
  janelaMs: 15 * 60 * 1000, max: limiteDoAmbiente('LIMITE_ATIVACOES_15MIN', 30), chave: porIp,
  mensagem: 'Muitas tentativas de ativação. Aguarde alguns minutos.'
});
const limiteFichas = criarLimitador({ nome: 'limiteFichas',
  janelaMs: HORA_MS, max: limiteDoAmbiente('LIMITE_FICHAS_HORA', 30), chave: porUsuarioOuIp,
  mensagem: 'Limite de fichas por hora atingido. Tente novamente mais tarde.'
});
const limiteUploads = criarLimitador({ nome: 'limiteUploads',
  janelaMs: HORA_MS, max: limiteDoAmbiente('LIMITE_UPLOADS_HORA', 120), chave: porUsuarioOuIp,
  mensagem: 'Limite de envios de documentos por hora atingido. Tente novamente mais tarde.'
});
const limiteMensagens = criarLimitador({ nome: 'limiteMensagens',
  janelaMs: 10 * 60 * 1000, max: limiteDoAmbiente('LIMITE_MENSAGENS_10MIN', 60), chave: porUsuarioOuIp,
  mensagem: 'Muitas mensagens em pouco tempo. Aguarde um instante.'
});

// ---------------------------------------------------------------------------
// ROTAS DE AUTENTICAÇÃO (registro, login, Google Sign-In, sessão, logout)
// ---------------------------------------------------------------------------

const REGEX_EMAIL_AUTH = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

// Cliente do Google verificado com o Client ID configurado via variável de
// ambiente. Sem essa variável, o botão "Entrar com o Google" continua visível
// no frontend, mas a rota /api/auth/google responde 400 explicando a causa -
// é uma limitação de credenciais (o Líder de Projeto precisa gerar as suas
// próprias no Google Cloud Console), não uma falha de implementação.
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const clienteGoogle = GOOGLE_CLIENT_ID ? new OAuth2Client(GOOGLE_CLIENT_ID) : null;

// Versão vigente dos Termos de Uso / Política de Privacidade exibidos no
// cadastro - referenciada nos logs de consentimento para rastreabilidade
// caso o texto dos termos mude no futuro.
const VERSAO_TERMOS_CADASTRO = 'v1.0';

// Link/token de ativação só é devolvido na resposta fora de produção (NODE_ENV).
const EXIBIR_LINK_ATIVACAO = process.env.NODE_ENV !== 'production';

// Resposta única do cadastro, exista a conta ou não (não revela e-mails cadastrados).
const MENSAGEM_CADASTRO_RECEBIDO = 'Cadastro recebido! Enviamos um e-mail para o endereço informado com as próximas instruções. Se não chegar em alguns minutos, verifique o spam.';

app.post('/api/auth/registrar', limiteCadastros, async (req, res) => {
  try {
  const { nome, email, senha, confirmarSenha, dataNascimento, cpf, aceiteTermos } = req.body;
  const nomeAparado = String(nome || '').trim();
  const emailAparado = String(email || '').trim().toLowerCase();

  if (!nomeAparado) return res.status(400).json({ erro: 'Informe seu nome.' });
  if (nomeAparado.length > 120 || emailAparado.length > 254) return res.status(400).json({ erro: 'Nome ou e-mail acima do tamanho permitido.' });
  if (!REGEX_EMAIL_AUTH.test(emailAparado)) return res.status(400).json({ erro: 'E-mail inválido.' });
  const erroSenha = erroSenhaFraca(senha);
  if (erroSenha) return res.status(400).json({ erro: erroSenha });
  if (senha !== confirmarSenha) {
    return res.status(400).json({ erro: 'As senhas não coincidem.' });
  }
  if (!dataNascimentoValida(somenteDigitos(dataNascimento))) {
    return res.status(400).json({ erro: 'Data de nascimento incompleta ou inválida.' });
  }
  if (!cpfValido(cpf)) {
    return res.status(400).json({ erro: 'CPF incompleto ou inválido.' });
  }
  if (aceiteTermos !== true) {
    return res.status(400).json({ erro: 'É necessário aceitar os Termos de Uso e a Política de Privacidade para criar a conta.' });
  }

  // O hash é calculado antes de consultar o e-mail: cadastro novo e repetido
  // levam o mesmo tempo e a resposta é a mesma (não revela quem já tem conta).
  const { salt, hash } = gerarHashSenha(String(senha));
  const usuarios = await lerUsuarios();
  if (usuarios.some((u) => u.email === emailAparado)) {
    await enviarEmail({
      para: emailAparado,
      assunto: `Você já tem cadastro - ${MARCA.nome}`,
      texto: `Olá.\n\nAlguém tentou criar uma conta no ${MARCA.nome} com este e-mail, que já está cadastrado.\n\nSe foi você, entre normalmente ou use "Esqueci minha senha" na tela de login: ${urlBase(req)}/\n\nSe não foi você, ignore este e-mail. Nenhuma alteração foi feita na sua conta.`
    });
    return res.status(201).json({ mensagem: MENSAGEM_CADASTRO_RECEBIDO });
  }

  const agora = new Date().toISOString();
  const novoUsuario = {
    id: gerarId(),
    nome: nomeAparado,
    email: emailAparado,
    dataNascimento,
    cpf,
    senhaSalt: salt,
    senhaHash: hash,
    tipo: 'candidato',
    googleId: null,
    // Conta criada mas ainda não confirmada - só é ativada ao clicar no link
    // de ativação (simulado no console/modal de teste, ver /api/auth/ativar).
    ativo: false,
    tokenAtivacao: crypto.randomBytes(24).toString('hex'),
    // Aceite inicial dos Termos de Uso/Política de Privacidade (LGPD -
    // Momento 1 da jornada), com evidência de quando e de onde partiu.
    consentimentoCadastro: { aceito: true, timestamp: agora, ip: req.ip, versaoTermo: VERSAO_TERMOS_CADASTRO },
    criadoEm: agora
  };

  usuarios.push(novoUsuario);
  await salvarUsuarios(usuarios);

  await registrarEventoAuditoria({
    id: gerarId(),
    tipoEvento: 'consentimento_cadastro',
    usuarioId: novoUsuario.id,
    email: emailAparado,
    versaoTermo: VERSAO_TERMOS_CADASTRO,
    timestamp: agora,
    ip: req.ip
  });

  // Link de ativação por e-mail (SMTP configurado) ou simulado no log do servidor.
  await enviarEmail({
    para: emailAparado,
    assunto: `Confirme o seu cadastro - ${MARCA.nome}`,
    texto: `Olá, ${nomeAparado}.\n\nPara ativar a sua conta, abra o link:\n${urlBase(req)}/login.html?ativacao=${novoUsuario.tokenAtivacao}\n\nSe você não fez este cadastro, ignore este e-mail.`
  });

  // Em desenvolvimento a resposta devolve o link/token para o modal de teste do
  // login. Em produção isso NUNCA pode ir na resposta - quem cadastrasse o
  // e-mail de outra pessoa ativaria a conta sem ter acesso à caixa de entrada.
  if (!EXIBIR_LINK_ATIVACAO) {
    return res.status(201).json({ mensagem: MENSAGEM_CADASTRO_RECEBIDO });
  }

  return res.status(201).json({
    mensagem: MENSAGEM_CADASTRO_RECEBIDO + ' (Ambiente de testes: o link de ativação está no console do servidor.)',
    linkAtivacao: `/login.html?ativacao=${novoUsuario.tokenAtivacao}`,
    tokenAtivacao: novoUsuario.tokenAtivacao
  });
  } catch (erro) {
    console.error('Falha ao registrar usuário:', erro.message);
    return res.status(500).json({ erro: 'Falha ao criar a conta.' });
  }
});

// Ativa a conta a partir do token de ativação enviado (simulado) por e-mail,
// e já cria a sessão em seguida (auto-login pós-confirmação).
app.post('/api/auth/ativar', limiteAtivacoes, async (req, res) => {
  try {
  const { token } = req.body;
  if (!token) return res.status(400).json({ erro: 'Token de ativação ausente.' });

  const usuarios = await lerUsuarios();
  const usuario = usuarios.find((u) => u.tokenAtivacao === token);
  if (!usuario) {
    return res.status(404).json({ erro: 'Link de ativação inválido ou já utilizado.' });
  }

  usuario.ativo = true;
  usuario.tokenAtivacao = null;
  await salvarUsuarios(usuarios);

  const sessaoToken = await criarSessao(usuario.id);
  return res.status(200).json({ mensagem: 'Conta ativada com sucesso!', token: sessaoToken, usuario: dadosPublicosUsuario(usuario) });
  } catch (erro) {
    console.error('Falha ao ativar conta:', erro.message);
    return res.status(500).json({ erro: 'Falha ao ativar a conta.' });
  }
});

// ---------------------------------------------------------------------------
// LIMITE DE TENTATIVAS DE LOGIN (anti força bruta)
// Contadores compartilhados entre instâncias (lib/limites.js); sem banco,
// cada processo conta sozinho.
// Duas chaves: IP + e-mail (5 falhas) e IP sozinho (30 falhas) em 15 minutos.
// Chaveado também pelo IP, um terceiro não bloqueia a conta da vítima.
// ---------------------------------------------------------------------------
const JANELA_LOGIN_MS = 15 * 60 * 1000;
const MAX_FALHAS_LOGIN_POR_CONTA = 5;
const MAX_FALHAS_LOGIN_POR_IP = 30;
// Falhas por chave (login e MFA), na janela de JANELA_LOGIN_MS.
const falhasAtuais = (chave) => contadores.contagem('falha|' + chave);
const registrarFalhaLogin = (chave) => contadores.incrementar('falha|' + chave, JANELA_LOGIN_MS);
const limparFalhas = (chave) => contadores.zerar('falha|' + chave);

// Hash descartável: quando o e-mail não existe, o bcrypt roda mesmo assim, para
// que o tempo de resposta não revele quais e-mails têm conta.
let hashFalsoLogin = null;
function hashFalso() {
  if (!hashFalsoLogin) hashFalsoLogin = bcrypt.hashSync(crypto.randomBytes(16).toString('hex'), 10);
  return hashFalsoLogin;
}

// Material do segredo do servidor para o desafio do MFA e a cifra do segredo TOTP.
// MFA_CHAVE (recomendado) deve ser estável: trocá-la exige reconfigurar o MFA.
const materialMfa = () => 'mfa|' + (process.env.MFA_CHAVE || segredoArquivos());

function respostaDesafioMfa(usuario) {
  return {
    mfaNecessario: true,
    desafio: mfa.emitirDesafio(usuario.id, materialMfa()),
    mensagem: 'Informe o código de 6 dígitos do aplicativo autenticador (ou um código de recuperação).'
  };
}

function respostaLoginCompleto(usuario, token, mensagem) {
  const corpo = { mensagem, token, usuario: dadosPublicosUsuario(usuario) };
  if (mfaPendente(usuario)) corpo.mfaConfiguracaoObrigatoria = true;
  return corpo;
}

app.post('/api/auth/login', async (req, res) => {
  try {
  const { email, senha } = req.body;
  const emailAparado = String(email || '').trim().toLowerCase();

  const chaveConta = `${req.ip}|${emailAparado}`;
  const chaveIp = `ip|${req.ip}`;
  if ((await falhasAtuais(chaveConta)) >= MAX_FALHAS_LOGIN_POR_CONTA || (await falhasAtuais(chaveIp)) >= MAX_FALHAS_LOGIN_POR_IP) {
    res.set('Retry-After', String(Math.ceil(JANELA_LOGIN_MS / 1000)));
    return res.status(429).json({ erro: 'Muitas tentativas de login. Aguarde alguns minutos e tente novamente.' });
  }

  const usuarios = await lerUsuarios();
  const usuario = usuarios.find((u) => u.email === emailAparado);

  const senhaOk = usuario && usuario.senhaHash
    ? senhaConfere(String(senha || ''), usuario.senhaSalt, usuario.senhaHash)
    : (bcrypt.compareSync(String(senha || ''), hashFalso()), false);

  if (!senhaOk) {
    await registrarFalhaLogin(chaveConta);
    await registrarFalhaLogin(chaveIp);
    return res.status(401).json({ erro: 'E-mail ou senha incorretos.' });
  }

  await limparFalhas(chaveConta);

  if (usuario.ativo === false) {
    return res.status(403).json({ erro: 'Conta ainda não ativada. Verifique o link de confirmação enviado no cadastro (ou o console do servidor, neste ambiente de testes).' });
  }

  // Segunda etapa: a senha estava certa, mas a sessão só sai com o código do
  // aplicativo autenticador (ou um código de recuperação).
  if (usuario.mfaAtivo) return res.status(200).json(respostaDesafioMfa(usuario));

  const token = await criarSessao(usuario.id);

  // Trilha de auditoria (LGPD): registra quem entrou, quando e de onde -
  // mesmo padrão já usado para o consentimento de cadastro e o chat.
  await registrarEventoAuditoria({
    id: gerarId(),
    tipoEvento: 'login',
    usuarioId: usuario.id,
    email: usuario.email,
    tipo: usuario.tipo,
    timestamp: new Date().toISOString(),
    ip: req.ip
  });

  return res.status(200).json(respostaLoginCompleto(usuario, token, 'Login realizado com sucesso!'));
  } catch (erro) {
    console.error('Falha ao fazer login:', erro.message);
    return res.status(500).json({ erro: 'Falha ao fazer login.' });
  }
});

// Login/registro via Google Sign-In (Google Identity Services). O frontend
// envia o "credential" (ID Token JWT) emitido pelo Google; o backend valida
// a assinatura e a audiência junto ao Google antes de confiar nos dados.
app.post('/api/auth/google', async (req, res) => {
  const { credential } = req.body;
  if (!credential) return res.status(400).json({ erro: 'Credencial do Google ausente.' });

  if (!clienteGoogle) {
    return res.status(400).json({
      erro: 'Login com Google não está configurado neste ambiente. Defina a variável GOOGLE_CLIENT_ID (ver .env.example).'
    });
  }

  let payload;
  try {
    const ticket = await clienteGoogle.verifyIdToken({ idToken: credential, audience: GOOGLE_CLIENT_ID });
    payload = ticket.getPayload();
  } catch (erro) {
    return res.status(401).json({ erro: 'Não foi possível validar a credencial do Google.' });
  }

  const emailGoogle = String(payload.email || '').trim().toLowerCase();
  if (!emailGoogle) return res.status(400).json({ erro: 'A conta Google não possui e-mail associado.' });
  if (payload.email_verified === false) return res.status(400).json({ erro: 'O e-mail da conta Google não foi verificado.' });

  let usuarios;
  let usuario;
  try {
    usuarios = await lerUsuarios();
    usuario = usuarios.find((u) => u.email === emailGoogle);

    if (!usuario) {
      usuario = {
        id: gerarId(),
        nome: payload.name || emailGoogle,
        email: emailGoogle,
        senhaSalt: null,
        senhaHash: null,
        tipo: 'candidato',
        googleId: payload.sub,
        foto: await baixarFotoGoogle(payload.picture),
        ativo: true,
        criadoEm: new Date().toISOString()
      };
      usuarios.push(usuario);
      await salvarUsuarios(usuarios);
    } else if (usuario.googleId && usuario.googleId !== payload.sub) {
      return res.status(401).json({ erro: 'Este e-mail já está vinculado a outra conta Google.' });
    } else {
      // Conta já existente (cadastro por senha ou RH): vincula o Google, completa a foto
      // se faltar e ativa a conta (o Google já confirmou a posse do e-mail).
      let alterado = false;
      if (!usuario.googleId) { usuario.googleId = payload.sub; alterado = true; }
      if (usuario.ativo === false) { usuario.ativo = true; usuario.tokenAtivacao = null; alterado = true; }
      if (!usuario.foto) {
        const foto = await baixarFotoGoogle(payload.picture);
        if (foto) { usuario.foto = foto; alterado = true; }
      }
      if (alterado) await salvarUsuarios(usuarios);
    }

    // Contas com MFA também passam pela segunda etapa quando entram pelo Google.
    if (usuario.mfaAtivo) return res.status(200).json(respostaDesafioMfa(usuario));

    const token = await criarSessao(usuario.id);
    return res.status(200).json(respostaLoginCompleto(usuario, token, 'Login com Google realizado com sucesso!'));
  } catch (erro) {
    console.error('Falha no login com Google:', erro.message);
    return res.status(500).json({ erro: 'Falha ao autenticar com o Google.' });
  }
});

// Informa ao frontend se o Google Sign-In está configurado neste ambiente
// (e o Client ID a usar) - evita renderizar o botão do Google sem propósito.
app.get('/api/auth/google-client-id', (req, res) => {
  return res.status(200).json({ clientId: GOOGLE_CLIENT_ID || null });
});

// Foto de perfil do próprio usuário (id vem sempre da sessão): data URL ou null para remover.
app.put('/api/auth/foto', autenticar, async (req, res) => {
  try {
    const foto = (req.body || {}).foto;
    if (foto !== null && !fotoValida(foto)) {
      return res.status(400).json({ erro: 'Foto inválida: envie uma imagem JPEG, PNG ou WebP de até 200 KB.' });
    }
    const usuarios = await lerUsuarios();
    const usuario = usuarios.find((u) => u.id === req.usuario.id);
    if (!usuario) return res.status(401).json({ erro: 'Sessão inválida ou expirada. Faça login novamente.' });
    usuario.foto = foto;
    await salvarUsuarios(usuarios);

    await registrarEventoAuditoria({
      id: gerarId(),
      tipoEvento: 'foto_perfil_alterada',
      usuarioId: usuario.id,
      escopo: usuario.tipo,
      removida: foto === null,
      timestamp: new Date().toISOString(),
      ip: req.ip
    });
    return res.status(200).json({ usuario: dadosPublicosUsuario(usuario) });
  } catch (erro) {
    console.error('Falha ao salvar foto de perfil:', erro.message);
    return res.status(500).json({ erro: 'Falha ao salvar a foto.' });
  }
});

app.get('/api/auth/sessao', autenticar, (req, res) => {
  return res.status(200).json({ usuario: dadosPublicosUsuario(req.usuario) });
});

app.post('/api/auth/logout', async (req, res) => {
  try {
    const cabecalho = req.headers.authorization || '';
    const token = cabecalho.startsWith('Bearer ') ? cabecalho.slice(7) : null;
    if (token) {
      await removerSessaoPorToken(token);
    }
    return res.status(200).json({ mensagem: 'Sessão encerrada.' });
  } catch (erro) {
    console.error('Falha ao encerrar sessão:', erro.message);
    return res.status(500).json({ erro: 'Falha ao encerrar a sessão.' });
  }
});

// Fichas vinculadas ao usuário autenticado (vínculo estrito ficha <-> perfil).
app.get('/api/auth/minhas-fichas', autenticar, async (req, res) => {
  try {
  const candidatos = await lerCandidatos();
  const minhasFichas = candidatos.filter((c) => c.usuarioId === req.usuario.id);
  return res.status(200).json(minhasFichas);
  } catch (erro) {
    console.error('Falha ao buscar minhas fichas:', erro.message);
    return res.status(500).json({ erro: 'Falha ao buscar suas fichas.' });
  }
});

// ---------------------------------------------------------------------------
// ROTA: cadastro de nova ficha de candidato (Etapa 1 - Dados Pessoais)
// ---------------------------------------------------------------------------
// Versão vigente do Termo de Consentimento LGPD exibido no envio da ficha
// (Momento 2 da jornada) - referenciada no log de auditoria.
const VERSAO_TERMO_FICHA_LGPD = '1.0';
const FINALIDADE_TERMO_FICHA_LGPD = 'Processo Admissional e Validação de Documentos';

app.post('/api/candidato', autenticarOpcional, limiteFichas, async (req, res) => {
  try {
  const {
    nomeCompleto,
    dataNascimento,
    cpf,
    logradouro,
    bairro,
    cep,
    numero,
    complemento,
    email,
    whatsapp,
    genero,
    consentimentoLGPD
  } = req.body;

  const errosValidacao = validarDadosPessoais({
    nomeCompleto, dataNascimento, cpf, logradouro, bairro, cep, numero, complemento, email, whatsapp, genero
  });

  if (errosValidacao.length) {
    return res.status(400).json({ erro: errosValidacao.join(' ') });
  }
  if (consentimentoLGPD !== true) {
    return res.status(400).json({ erro: 'É necessário concordar com o tratamento dos dados e documentos (LGPD) para enviar a ficha.' });
  }

  const agora = new Date().toISOString();

  const novoCandidato = {
    id: gerarId(),
    nomeCompleto,
    dataNascimento,
    cpf,
    logradouro,
    bairro,
    cep,
    numero,
    complemento,
    email,
    whatsapp,
    genero: genero || null,
    status: 'EM_ANALISE',
    cpfInclusoNaIdentidade: false,
    documentos: criarDocumentosIniciais(genero),
    decisaoFinal: null,
    decisaoFinalEm: null,
    mensagens: [],
    // Vínculo estrito com o perfil autenticado que originou a ficha (se houver sessão).
    usuarioId: req.usuario ? req.usuario.id : null,
    contrato: criarContratoInicial(),
    // Consentimento LGPD do envio da ficha (Momento 2 da jornada) - evidência
    // de quando, de onde e sob qual finalidade os dados foram autorizados.
    consentimentoFichaLGPD: {
      aceito: true,
      dataHora: agora,
      ip: req.ip,
      versaoTermo: VERSAO_TERMO_FICHA_LGPD,
      finalidade: FINALIDADE_TERMO_FICHA_LGPD
    },
    consentimentoContratoLGPD: null,
    integracaoPonto: criarIntegracaoPontoInicial(),
    criadoEm: agora
  };

  const candidatos = await lerCandidatos();
  candidatos.push(novoCandidato);
  await salvarCandidatos(candidatos);

  await registrarEventoAuditoria({
    id: gerarId(),
    tipoEvento: 'consentimento_ficha_lgpd',
    candidatoId: novoCandidato.id,
    versaoTermo: VERSAO_TERMO_FICHA_LGPD,
    finalidade: FINALIDADE_TERMO_FICHA_LGPD,
    timestamp: agora,
    ip: req.ip
  });

  // Sem dados pessoais nos logs (LGPD): só o identificador da ficha.
  console.log('--- Novo Candidato Recebido --- ID:', novoCandidato.id);

  return res.status(201).json({
    mensagem: 'Ficha do candidato cadastrada com sucesso!',
    candidato: novoCandidato
  });
  } catch (erro) {
    console.error('Falha ao cadastrar candidato:', erro.message);
    return res.status(500).json({ erro: 'Falha ao cadastrar a ficha.' });
  }
});

// ---------------------------------------------------------------------------
// ROTA: atualização dos dados pessoais / regras (gênero e CPF incluso)
// Exige login: só a conta dona da ficha altera.
// ---------------------------------------------------------------------------
app.patch('/api/candidato/:id/dados', autenticar, async (req, res) => {
  try {
  const { id } = req.params;
  const { genero, cpfInclusoNaIdentidade } = req.body;

  const candidatos = await lerCandidatos();
  const candidato = candidatos.find((c) => c.id === id);

  if (!candidato) {
    return res.status(404).json({ erro: 'Candidato não encontrado.' });
  }

  if (!usuarioEhDonoDaFicha(req.usuario, candidato)) {
    return res.status(403).json({ erro: ERRO_FICHA_DE_OUTRA_CONTA });
  }

  if (genero !== undefined) {
    if (!GENEROS_VALIDOS.includes(genero)) {
      return res.status(400).json({ erro: 'Gênero inválido.' });
    }
    candidato.genero = genero;
    aplicarRegraReservista(candidato);
  }

  if (cpfInclusoNaIdentidade !== undefined) {
    candidato.cpfInclusoNaIdentidade = Boolean(cpfInclusoNaIdentidade);
    aplicarRegraCpfIncluso(candidato);
  }

  candidato.atualizadoEm = new Date().toISOString();
  await salvarCandidatos(candidatos);

  return res.status(200).json({
    mensagem: 'Dados do candidato atualizados com sucesso!',
    candidato
  });
  } catch (erro) {
    console.error('Falha ao atualizar dados do candidato:', erro.message);
    return res.status(500).json({ erro: 'Falha ao atualizar os dados do candidato.' });
  }
});

// ---------------------------------------------------------------------------
// ROTA: envio de um documento PDF para uma das abas
// Exige login (antes do multer, para que visitantes anônimos não gravem
// arquivos em disco); só a conta dona da ficha envia.
// ---------------------------------------------------------------------------
app.post('/api/candidato/:id/documento', autenticar, limiteUploads, (req, res) => {
  upload.single('arquivo')(req, res, async (erroUpload) => {
    if (erroUpload) {
      if (erroUpload.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({ erro: 'Arquivo excedeu o tamanho limite de 10 MB' });
      }
      return res.status(400).json({ erro: erroUpload.message });
    }

    const { id } = req.params;
    const { tipoDocumento, cpfIncluso } = req.body;
    const tipo = tipoDocumento;

    if (!TIPOS_DOCUMENTO.includes(tipo)) {
      return res.status(400).json({ erro: 'Tipo de documento inválido.' });
    }

    if (!req.file) {
      return res.status(400).json({ erro: 'Nenhum arquivo PDF foi enviado.' });
    }

    try {
    const candidatos = await lerCandidatos();
    const candidato = candidatos.find((c) => c.id === id);

    if (!candidato) {
      return res.status(404).json({ erro: 'Candidato não encontrado.' });
    }

    if (!usuarioEhDonoDaFicha(req.usuario, candidato)) {
      return res.status(403).json({ erro: ERRO_FICHA_DE_OUTRA_CONTA });
    }

    // Ficha com decisão final (Aprovado/Reprovado) não aceita mais nenhum envio
    if (candidato.decisaoFinal) {
      return res.status(400).json({
        erro: 'Esta ficha já foi decidida e está bloqueada para novos envios.'
      });
    }

    const documentoAtual = candidato.documentos[tipo];
    const pendenciaAtiva = documentoAtual && documentoAtual.pendencia && documentoAtual.pendencia.ativa;

    // Documento já enviado só pode ser reenviado se o RH abriu uma pendência para ele
    if (documentoAtual && documentoAtual.arquivo && !pendenciaAtiva) {
      return res.status(400).json({
        erro: 'Este documento já foi enviado e a ficha está bloqueada para edição. Aguarde o RH sinalizar uma pendência para reenviar.'
      });
    }

    // Regra: reservista dispensado para gênero diferente de Masculino
    if (tipo === 'reservista' && candidato.genero !== 'Masculino') {
      return res.status(400).json({
        erro: 'Certificado de Reservista não é exigido para este candidato.'
      });
    }

    // Regra: aba CPF desabilitada quando o CPF está incluso na identidade
    if (tipo === 'cpf' && candidato.cpfInclusoNaIdentidade) {
      return res.status(400).json({
        erro: 'A aba CPF está desabilitada (CPF incluso na Identidade).'
      });
    }

    // O arquivo precisa ser mesmo um PDF: o nome e o MIME vêm do cliente e não
    // provam nada, então confere a assinatura "%PDF-" no começo do conteúdo.
    if (req.file.buffer.subarray(0, 5).toString('latin1') !== '%PDF-') {
      return res.status(400).json({ erro: 'O arquivo enviado não é um PDF válido.' });
    }

    // Nome gerado pelo servidor (id validado + tipo da lista + sufixo aleatório),
    // nunca derivado de texto enviado pelo cliente.
    const nomeArquivo = `${candidato.id}-${tipo}-${crypto.randomBytes(8).toString('hex')}.pdf`;
    await armazenamento.salvar(nomeArquivo, req.file.buffer);

    // Se havia um PDF anterior (reenvio após pendência), remove o arquivo antigo
    if (documentoAtual && documentoAtual.arquivo) {
      armazenamento.remover(nomeDoArquivo(documentoAtual.arquivo)).catch((erro) => {
        console.error('Falha ao excluir PDF antigo:', documentoAtual.arquivo, erro.message);
      });
    }

    // Registra o arquivo enviado, move o documento para "Em Análise" (AMARELO) e
    // encerra qualquer pendência aberta (o reenvio pedido pelo RH foi atendido)
    candidato.documentos[tipo] = {
      arquivo: 'uploads/' + nomeArquivo,
      status: 'AMARELO',
      atualizadoEm: new Date().toISOString(),
      pendencia: null
    };

    // Na aba Identidade o candidato pode declarar que o CPF está incluso no RG
    if (tipo === 'identidade' && cpfIncluso !== undefined) {
      candidato.cpfInclusoNaIdentidade = cpfIncluso === 'true' || cpfIncluso === true;
      aplicarRegraCpfIncluso(candidato);
    }

    await salvarCandidatos(candidatos);

    console.log(`--- Documento recebido --- ID: ${id} | Tipo: ${tipo} | Arquivo: ${nomeArquivo}`);

    return res.status(201).json({
      mensagem: 'Documento enviado com sucesso!',
      candidato
    });
    } catch (erro) {
      console.error('Falha ao salvar documento:', erro.message);
      return res.status(500).json({ erro: 'Falha ao salvar o documento.' });
    }
  });
});

// ---------------------------------------------------------------------------
// ROTA: exclusão de um documento PDF já anexado
// Exige login: só a conta dona da ficha exclui.
// ---------------------------------------------------------------------------
app.delete('/api/candidato/:id/documento/:tipo', autenticar, async (req, res) => {
  try {
  const { id, tipo } = req.params;

  if (!TIPOS_DOCUMENTO.includes(tipo)) {
    return res.status(400).json({ erro: 'Tipo de documento inválido.' });
  }

  const candidatos = await lerCandidatos();
  const candidato = candidatos.find((c) => c.id === id);

  if (!candidato) {
    return res.status(404).json({ erro: 'Candidato não encontrado.' });
  }

  if (!usuarioEhDonoDaFicha(req.usuario, candidato)) {
    return res.status(403).json({ erro: ERRO_FICHA_DE_OUTRA_CONTA });
  }

  if (candidato.decisaoFinal) {
    return res.status(400).json({ erro: 'Esta ficha já foi decidida e está bloqueada para edição.' });
  }

  const documento = candidato.documentos[tipo];

  // Remove o arquivo do armazenamento (se houver), ignorando "arquivo inexistente".
  if (documento && documento.arquivo) {
    armazenamento.remover(nomeDoArquivo(documento.arquivo)).catch((erro) => {
      console.error('Falha ao excluir arquivo:', documento.arquivo, erro.message);
    });
  }

  // Limpa a referência do documento (volta a PENDENTE), preservando uma eventual
  // pendência aberta pelo RH - remover o PDF antigo não deve travar o reenvio.
  candidato.documentos[tipo] = {
    arquivo: null,
    status: 'VERMELHO',
    atualizadoEm: new Date().toISOString(),
    pendencia: (documento && documento.pendencia) || null
  };

  // Reaplica as regras que podem manter o status automático mesmo sem arquivo
  if (tipo === 'reservista') aplicarRegraReservista(candidato);
  if (tipo === 'identidade') aplicarRegraCpfIncluso(candidato);

  await salvarCandidatos(candidatos);

  console.log(`--- Documento excluído --- ID: ${id} | Tipo: ${tipo}`);

  return res.status(200).json({
    mensagem: 'Documento excluído com sucesso!',
    candidato
  });
  } catch (erro) {
    console.error('Falha ao excluir documento:', erro.message);
    return res.status(500).json({ erro: 'Falha ao excluir o documento.' });
  }
});

// ---------------------------------------------------------------------------
// ROTA: listagem completa de candidatos (consumida pelo painel do RH)
// Restrita ao RH: devolve CPF e demais dados pessoais de todas as fichas.
// ---------------------------------------------------------------------------
app.get('/api/candidatos', exigirRh, async (req, res) => {
  try {
    const candidatos = await lerCandidatos();
    return res.status(200).json(await comFotosDosCandidatos(candidatos));
  } catch (erro) {
    console.error('Falha ao listar candidatos:', erro.message);
    return res.status(500).json({ erro: 'Falha ao listar candidatos.' });
  }
});

// ---------------------------------------------------------------------------
// ROTA: alteração do status geral do candidato pelo RH (EM_ANALISE ou
// PENDENTE_ASSINATURA) - restrita ao RH.
// ---------------------------------------------------------------------------
app.patch('/api/candidato/:id/status', exigirRh, async (req, res) => {
  try {
  const { id } = req.params;
  const { status } = req.body;

  if (status !== 'EM_ANALISE' && status !== 'PENDENTE_ASSINATURA') {
    return res.status(400).json({
      erro: "Status inválido. Use 'EM_ANALISE' (Em Análise) ou 'PENDENTE_ASSINATURA' (Pendente de Assinatura)."
    });
  }

  const candidatos = await lerCandidatos();
  const candidato = candidatos.find((c) => c.id === id);

  if (!candidato) {
    return res.status(404).json({ erro: 'Candidato não encontrado.' });
  }

  candidato.status = status;
  candidato.atualizadoEm = new Date().toISOString();
  await salvarCandidatos(candidatos);

  console.log(`--- Status atualizado --- ID: ${id} | Novo status: ${status}`);

  return res.status(200).json({
    mensagem: 'Status do candidato atualizado com sucesso!',
    candidato
  });
  } catch (erro) {
    console.error('Falha ao atualizar status:', erro.message);
    return res.status(500).json({ erro: 'Falha ao atualizar o status.' });
  }
});

// ---------------------------------------------------------------------------
// ROTA: listagem de fichas para o Painel de Gestão do RH (Etapa 2)
// ---------------------------------------------------------------------------
// Acrescenta a foto de perfil (usuarios.foto) a cada ficha, só na resposta -
// nada disso é gravado na tabela "candidatos".
async function comFotosDosCandidatos(candidatos) {
  const fotos = new Map((await lerUsuarios()).filter((u) => u.foto).map((u) => [u.id, u.foto]));
  return candidatos.map((c) => ({ ...c, foto: (c.usuarioId && fotos.get(c.usuarioId)) || null }));
}

app.get('/api/rh/fichas', exigirRh, async (req, res) => {
  try {
    const candidatos = await lerCandidatos();
    return res.status(200).json(await comFotosDosCandidatos(candidatos));
  } catch (erro) {
    console.error('Falha ao listar fichas do RH:', erro.message);
    return res.status(500).json({ erro: 'Falha ao listar as fichas.' });
  }
});


// ---------------------------------------------------------------------------
// BANCO DE TALENTOS: candidato arquivado sai da lista ativa de Gestão e das
// métricas, sem alterar o status. A ficha continua acessível por link.
// ---------------------------------------------------------------------------
const MAX_TAGS_BANCO_TALENTOS = 10; // máximo de etiquetas por ficha
const MAX_TAMANHO_TAG = 30;
const MAX_ETIQUETAS_CATALOGO = 50;
const COR_ETIQUETA_PADRAO = '#6b7280';
const REGEX_COR_ETIQUETA = /^#[0-9a-f]{6}$/i;

// ---------------------------------------------------------------------------
// ETIQUETAS (estilo Trello): catálogo global (cor + nome opcional). A coluna
// candidatos.tags guarda os IDs das etiquetas anexadas à ficha.
// ---------------------------------------------------------------------------
function etiquetaParaCamelCase(row) {
  return {
    id: row.id,
    nome: row.nome || '',
    cor: row.cor,
    criadoEm: row.criado_em,
    atualizadoEm: row.atualizado_em
  };
}

function etiquetaParaSnakeCase(e) {
  return {
    id: e.id,
    nome: e.nome || '',
    cor: e.cor,
    criado_em: e.criadoEm,
    atualizado_em: e.atualizadoEm || e.criadoEm
  };
}

async function lerEtiquetas() {
  return (await repo.listarEtiquetas()).map(etiquetaParaCamelCase);
}

async function salvarEtiquetas(lista) {
  if (!lista.length) return;
  await repo.gravarEtiquetas(lista.map(etiquetaParaSnakeCase));
}

// Chave de comparação de nomes: sem acento, sem diferenciar maiúsculas.
function chaveNomeEtiqueta(nome) {
  return String(nome || '').normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase();
}

// Valida nome (opcional, até 30) e cor (#RRGGBB). Retorna { nome?, cor? } ou { erro }.
function validarCamposEtiqueta(corpo, { corObrigatoria }) {
  const saida = {};
  if (corpo.nome !== undefined && corpo.nome !== null) {
    if (typeof corpo.nome !== 'string') return { erro: 'O nome da etiqueta deve ser um texto.' };
    const nome = corpo.nome.trim();
    if (nome.length > MAX_TAMANHO_TAG) return { erro: `O nome da etiqueta pode ter no máximo ${MAX_TAMANHO_TAG} caracteres.` };
    saida.nome = nome;
  }
  if (corpo.cor === undefined || corpo.cor === null) {
    if (corObrigatoria) return { erro: 'Escolha uma cor para a etiqueta.' };
  } else {
    if (typeof corpo.cor !== 'string' || !REGEX_COR_ETIQUETA.test(corpo.cor.trim())) {
      return { erro: 'Cor inválida: use o formato #RRGGBB.' };
    }
    saida.cor = corpo.cor.trim().toLowerCase();
  }
  return saida;
}

// Converte tags legadas (texto) em etiquetas do catálogo: reaproveita a de
// mesmo nome (sem acento/caixa) ou cria uma nova cinza. Muta "catalogo" e
// devolve { ids, novas }; quem chama é responsável por gravar as novas.
function resolverTagsLegadas(textos, catalogo) {
  const ids = [];
  const novas = [];
  const agora = new Date().toISOString();
  textos.forEach((texto) => {
    const chave = chaveNomeEtiqueta(texto);
    if (!chave) return;
    let etiqueta = catalogo.find((e) => chaveNomeEtiqueta(e.nome) === chave);
    if (!etiqueta) {
      etiqueta = { id: gerarId(), nome: String(texto).trim().slice(0, MAX_TAMANHO_TAG), cor: COR_ETIQUETA_PADRAO, criadoEm: agora, atualizadoEm: agora };
      catalogo.push(etiqueta);
      novas.push(etiqueta);
    }
    if (!ids.includes(etiqueta.id)) ids.push(etiqueta.id);
  });
  return { ids, novas };
}

// Migração idempotente: fichas antigas guardam o NOME da tag em
// candidatos.tags. Cada texto que não é id do catálogo vira (ou reaproveita)
// uma etiqueta e é substituído pelo id. Nenhuma tag se perde.
async function migrarTagsLegadasParaEtiquetas() {
  const catalogo = await lerEtiquetas();
  const idsConhecidos = new Set(catalogo.map((e) => e.id));
  const linhas = await repo.listarTagsDasFichas();

  const pendentes = linhas.filter((l) => Array.isArray(l.tags) && l.tags.some((t) => typeof t === 'string' && !idsConhecidos.has(t)));
  if (!pendentes.length) return;

  const todasNovas = [];
  const atualizacoes = [];
  pendentes.forEach((linha) => {
    const textos = linha.tags.filter((t) => typeof t === 'string' && !idsConhecidos.has(t));
    const { ids, novas } = resolverTagsLegadas(textos, catalogo);
    todasNovas.push(...novas);
    const mantidos = linha.tags.filter((t) => typeof t === 'string' && idsConhecidos.has(t));
    atualizacoes.push({ id: linha.id, tags: [...new Set([...mantidos, ...ids])] });
  });

  // Grava o catálogo antes das fichas: se algo falhar no meio, as tags
  // legadas continuam nas fichas e a próxima execução termina o trabalho.
  await salvarEtiquetas(todasNovas);
  for (const a of atualizacoes) {
    await repo.atualizarCandidato(a.id, { tags: a.tags });
  }
  console.log(`Migração de tags: ${todasNovas.length} etiqueta(s) criada(s), ${atualizacoes.length} ficha(s) atualizada(s).`);
}

async function registrarAuditoriaEtiqueta(req, tipoEvento, extra) {
  await registrarEventoAuditoria({
    id: gerarId(),
    tipoEvento,
    ...extra,
    usuarioId: req.usuario.id,
    usuarioEmail: req.usuario.email,
    timestamp: new Date().toISOString(),
    ip: req.ip
  });
}

app.get('/api/rh/etiquetas', exigirRh, async (req, res) => {
  try {
    return res.status(200).json(await lerEtiquetas());
  } catch (erro) {
    console.error('Falha ao listar etiquetas:', erro.message);
    return res.status(500).json({ erro: 'Falha ao listar as etiquetas.' });
  }
});

app.post('/api/rh/etiquetas', exigirRh, async (req, res) => {
  try {
    const campos = validarCamposEtiqueta(req.body || {}, { corObrigatoria: true });
    if (campos.erro) return res.status(400).json({ erro: campos.erro });

    const catalogo = await lerEtiquetas();
    if (catalogo.length >= MAX_ETIQUETAS_CATALOGO) {
      return res.status(400).json({ erro: `O catálogo pode ter no máximo ${MAX_ETIQUETAS_CATALOGO} etiquetas.` });
    }
    const agora = new Date().toISOString();
    const etiqueta = { id: gerarId(), nome: campos.nome || '', cor: campos.cor, criadoEm: agora, atualizadoEm: agora };
    await salvarEtiquetas([etiqueta]);
    await registrarAuditoriaEtiqueta(req, 'etiqueta_criada', { etiquetaId: etiqueta.id, nome: etiqueta.nome, cor: etiqueta.cor });
    return res.status(201).json({ mensagem: 'Etiqueta criada.', etiqueta });
  } catch (erro) {
    console.error('Falha ao criar etiqueta:', erro.message);
    return res.status(500).json({ erro: 'Falha ao criar a etiqueta.' });
  }
});

app.patch('/api/rh/etiquetas/:id', exigirRh, async (req, res) => {
  try {
    const campos = validarCamposEtiqueta(req.body || {}, { corObrigatoria: false });
    if (campos.erro) return res.status(400).json({ erro: campos.erro });

    const catalogo = await lerEtiquetas();
    const etiqueta = catalogo.find((e) => e.id === req.params.id);
    if (!etiqueta) return res.status(404).json({ erro: 'Etiqueta não encontrada.' });

    if (campos.nome !== undefined) etiqueta.nome = campos.nome;
    if (campos.cor !== undefined) etiqueta.cor = campos.cor;
    etiqueta.atualizadoEm = new Date().toISOString();
    await salvarEtiquetas([etiqueta]);
    await registrarAuditoriaEtiqueta(req, 'etiqueta_editada', { etiquetaId: etiqueta.id, nome: etiqueta.nome, cor: etiqueta.cor });
    return res.status(200).json({ mensagem: 'Etiqueta atualizada.', etiqueta });
  } catch (erro) {
    console.error('Falha ao editar etiqueta:', erro.message);
    return res.status(500).json({ erro: 'Falha ao editar a etiqueta.' });
  }
});

app.delete('/api/rh/etiquetas/:id', exigirRh, async (req, res) => {
  try {
    const { id } = req.params;
    const catalogo = await lerEtiquetas();
    const etiqueta = catalogo.find((e) => e.id === id);
    if (!etiqueta) return res.status(404).json({ erro: 'Etiqueta não encontrada.' });

    // Retira o id das fichas antes de apagar do catálogo (updates pontuais, só
    // nas fichas afetadas, para não regravar a base inteira).
    const afetadas = (await repo.listarTagsDasFichas()).filter((l) => Array.isArray(l.tags) && l.tags.includes(id));
    const agora = new Date().toISOString();
    for (const linha of afetadas) {
      await repo.atualizarCandidato(linha.id, { tags: linha.tags.filter((t) => t !== id), atualizado_em: agora });
    }
    await repo.excluirEtiqueta(id);

    await registrarAuditoriaEtiqueta(req, 'etiqueta_excluida', { etiquetaId: id, nome: etiqueta.nome, cor: etiqueta.cor, fichasAfetadas: afetadas.length });
    return res.status(200).json({ mensagem: 'Etiqueta excluída.', fichasAfetadas: afetadas.length });
  } catch (erro) {
    console.error('Falha ao excluir etiqueta:', erro.message);
    return res.status(500).json({ erro: 'Falha ao excluir a etiqueta.' });
  }
});

// Valida uma lista de ids de etiquetas contra o catálogo. Retorna { ids } ou { erro }.
function sanitizarIdsEtiquetas(entrada, catalogo) {
  if (entrada === undefined || entrada === null) return { ids: [] };
  if (!Array.isArray(entrada)) return { erro: 'As etiquetas devem ser uma lista de identificadores.' };
  const ids = [];
  for (const item of entrada) {
    if (typeof item !== 'string' || !item.trim()) return { erro: 'Cada etiqueta deve ser um identificador válido.' };
    if (!catalogo.some((e) => e.id === item)) return { erro: 'Uma ou mais etiquetas não existem.' };
    if (!ids.includes(item)) ids.push(item);
  }
  if (ids.length > MAX_TAGS_BANCO_TALENTOS) return { erro: `Use no máximo ${MAX_TAGS_BANCO_TALENTOS} etiquetas por ficha.` };
  return { ids };
}

app.patch('/api/rh/fichas/:id/etiquetas', exigirRh, async (req, res) => {
  try {
    const { id } = req.params;
    if (!req.body || !Array.isArray(req.body.etiquetas)) {
      return res.status(400).json({ erro: 'Informe a lista de etiquetas da ficha.' });
    }
    const catalogo = await lerEtiquetas();
    const resultado = sanitizarIdsEtiquetas(req.body.etiquetas, catalogo);
    if (resultado.erro) return res.status(400).json({ erro: resultado.erro });

    const candidatos = await lerCandidatos();
    const candidato = candidatos.find((c) => c.id === id);
    if (!candidato) return res.status(404).json({ erro: 'Candidato não encontrado.' });

    candidato.tags = resultado.ids;
    candidato.atualizadoEm = new Date().toISOString();
    await salvarCandidatos(candidatos);
    await registrarAuditoriaEtiqueta(req, 'etiquetas_ficha_alteradas', { candidatoId: id, etiquetas: resultado.ids });
    return res.status(200).json({ mensagem: 'Etiquetas da ficha atualizadas.', candidato });
  } catch (erro) {
    console.error('Falha ao anexar etiquetas à ficha:', erro.message);
    return res.status(500).json({ erro: 'Falha ao atualizar as etiquetas da ficha.' });
  }
});

// Retorna { tags } saneadas ou { erro } (trim, sem vazias/duplicadas) - formato
// legado (texto livre), convertido em etiquetas pela rota do Banco de Talentos.
function sanitizarTags(entrada) {
  if (entrada === undefined || entrada === null) return { tags: [] };
  if (!Array.isArray(entrada)) return { erro: 'As tags devem ser uma lista de textos.' };
  const tags = [];
  const vistas = new Set();
  for (const item of entrada) {
    if (typeof item !== 'string') return { erro: 'Cada tag deve ser um texto.' };
    const tag = item.trim();
    if (!tag) continue;
    if (tag.length > MAX_TAMANHO_TAG) return { erro: `Cada tag pode ter no máximo ${MAX_TAMANHO_TAG} caracteres.` };
    const chave = chaveNomeEtiqueta(tag);
    if (vistas.has(chave)) continue;
    vistas.add(chave);
    tags.push(tag);
  }
  if (tags.length > MAX_TAGS_BANCO_TALENTOS) return { erro: `Use no máximo ${MAX_TAGS_BANCO_TALENTOS} tags.` };
  return { tags };
}

app.patch('/api/rh/fichas/:id/banco-talentos', exigirRh, async (req, res) => {
  try {
    const { id } = req.params;
    const corpo = req.body || {};
    const legadas = sanitizarTags(corpo.tags);
    if (legadas.erro) return res.status(400).json({ erro: legadas.erro });
    const catalogo = await lerEtiquetas();
    const porIds = sanitizarIdsEtiquetas(corpo.etiquetas, catalogo);
    if (porIds.erro) return res.status(400).json({ erro: porIds.erro });

    const candidatos = await lerCandidatos();
    const candidato = candidatos.find((c) => c.id === id);
    if (!candidato) return res.status(404).json({ erro: 'Candidato não encontrado.' });
    if (candidato.bancoTalentos) {
      return res.status(400).json({ erro: 'Este candidato já está no Banco de Talentos.' });
    }

    // Tags em texto (legado) viram etiquetas do catálogo (reuso por nome).
    const { ids: idsLegadas, novas } = resolverTagsLegadas(legadas.tags, catalogo);
    if (novas.length && catalogo.length > MAX_ETIQUETAS_CATALOGO) {
      return res.status(400).json({ erro: `O catálogo pode ter no máximo ${MAX_ETIQUETAS_CATALOGO} etiquetas.` });
    }
    const todas = [...new Set([...porIds.ids, ...idsLegadas])];
    if (todas.length > MAX_TAGS_BANCO_TALENTOS) {
      return res.status(400).json({ erro: `Use no máximo ${MAX_TAGS_BANCO_TALENTOS} etiquetas por ficha.` });
    }
    await salvarEtiquetas(novas);

    const agora = new Date().toISOString();
    candidato.bancoTalentos = true;
    candidato.bancoTalentosEm = agora;
    candidato.tags = todas;
    candidato.atualizadoEm = agora;
    await salvarCandidatos(candidatos);

    await registrarEventoAuditoria({
      id: gerarId(),
      tipoEvento: 'banco_talentos_mover',
      candidatoId: id,
      tags: todas,
      timestamp: agora,
      ip: req.ip
    });

    return res.status(200).json({ mensagem: 'Candidato movido para o Banco de Talentos.', candidato });
  } catch (erro) {
    console.error('Falha ao mover para o Banco de Talentos:', erro.message);
    return res.status(500).json({ erro: 'Falha ao mover o candidato para o Banco de Talentos.' });
  }
});

app.patch('/api/rh/fichas/:id/reativar', exigirRh, async (req, res) => {
  try {
    const { id } = req.params;
    const candidatos = await lerCandidatos();
    const candidato = candidatos.find((c) => c.id === id);
    if (!candidato) return res.status(404).json({ erro: 'Candidato não encontrado.' });
    if (!candidato.bancoTalentos) {
      return res.status(400).json({ erro: 'Este candidato não está no Banco de Talentos.' });
    }

    const agora = new Date().toISOString();
    candidato.bancoTalentos = false;
    candidato.bancoTalentosEm = null; // as tags são mantidas
    candidato.atualizadoEm = agora;
    await salvarCandidatos(candidatos);

    await registrarEventoAuditoria({
      id: gerarId(),
      tipoEvento: 'banco_talentos_reativar',
      candidatoId: id,
      timestamp: agora,
      ip: req.ip
    });

    return res.status(200).json({ mensagem: 'Candidato reativado com sucesso.', candidato });
  } catch (erro) {
    console.error('Falha ao reativar candidato:', erro.message);
    return res.status(500).json({ erro: 'Falha ao reativar o candidato.' });
  }
});

// ---------------------------------------------------------------------------
// CONFIGURAÇÕES DO RH (tabela "configuracoes", linha única id = 'geral')
// ---------------------------------------------------------------------------
const MENSAGEM_BOAS_VINDAS_PADRAO = 'Bem-vindo(a) ao processo admissional! Preencha seus dados e anexe os documentos solicitados para dar andamento à sua contratação.';
const MAX_MENSAGEM_BOAS_VINDAS = 500;
const TITULO_CONTRATACAO_PADRAO = 'Contratação concluída!';
const MENSAGEM_CONTRATACAO_PADRAO = 'Seja bem-vindo(a) à equipe. Estamos muito felizes em ter você com a gente.';
const MAX_TITULO_CONTRATACAO = 80;
const MAX_MENSAGEM_CONTRATACAO = 500;

function configuracoesPadrao() {
  const documentosObrigatorios = {};
  TIPOS_DOCUMENTO.forEach((t) => { documentosObrigatorios[t] = true; });
  return { mensagemBoasVindas: MENSAGEM_BOAS_VINDAS_PADRAO, documentosObrigatorios,
    emailContatoRh: '',
    tituloContratacaoConcluida: TITULO_CONTRATACAO_PADRAO,
    mensagemContratacaoConcluida: MENSAGEM_CONTRATACAO_PADRAO,
    fotoRh: null
  };
}

// Completa/normaliza uma linha possivelmente nula ou incompleta com os padrões
// - o app nunca pode quebrar por falta de configuração.
function configuracoesDeLinha(row) {
  const padrao = configuracoesPadrao();
  if (!row) return padrao;
  const docs = row.documentos_obrigatorios && typeof row.documentos_obrigatorios === 'object' ? row.documentos_obrigatorios : {};
  TIPOS_DOCUMENTO.forEach((t) => {
    if (typeof docs[t] === 'boolean') padrao.documentosObrigatorios[t] = docs[t];
  });
  // Mensagem vazia é uma escolha válida do RH (oculta o card); só null (linha incompleta) volta ao padrão.
  const mensagemBoasVindas = typeof row.mensagem_boas_vindas === 'string' ? row.mensagem_boas_vindas : padrao.mensagemBoasVindas;
  const emailContatoRh = typeof row.email_contato_rh === 'string' ? row.email_contato_rh : '';
  // Título/mensagem da contratação não podem ficar vazios: texto em branco volta ao padrão.
  const tituloContratacaoConcluida = (row.titulo_contratacao_concluida || '').trim() || padrao.tituloContratacaoConcluida;
  const mensagemContratacaoConcluida = (row.mensagem_contratacao_concluida || '').trim() || padrao.mensagemContratacaoConcluida;
  const fotoRh = fotoValida(row.foto_rh) ? row.foto_rh : null;
  return {
    mensagemBoasVindas,
    documentosObrigatorios: padrao.documentosObrigatorios,
    emailContatoRh,
    tituloContratacaoConcluida,
    mensagemContratacaoConcluida,
    fotoRh
  };
}

async function lerConfiguracoes() {
  try {
    return configuracoesDeLinha(await repo.buscarConfiguracoes('geral'));
  } catch (erro) {
    console.error('Falha ao ler configurações (usando padrões):', erro.message);
    return configuracoesPadrao();
  }
}

async function salvarConfiguracoes(config) {
  await repo.gravarConfiguracoes({
    id: 'geral',
    mensagem_boas_vindas: config.mensagemBoasVindas,
    documentos_obrigatorios: config.documentosObrigatorios,
    email_contato_rh: config.emailContatoRh,
    titulo_contratacao_concluida: config.tituloContratacaoConcluida,
    mensagem_contratacao_concluida: config.mensagemContratacaoConcluida,
    foto_rh: config.fotoRh || null,
    atualizado_em: new Date().toISOString()
  });
}

app.get('/api/rh/configuracoes', exigirRh, async (req, res) => {
  return res.status(200).json(await lerConfiguracoes());
});

// Mensagem vazia é permitida: o card de boas-vindas fica oculto na ficha.
app.put('/api/rh/configuracoes', exigirRh, async (req, res) => {
  try {
    const corpo = req.body || {};
    const { mensagemBoasVindas, documentosObrigatorios, emailContatoRh, tituloContratacaoConcluida, mensagemContratacaoConcluida } = corpo;

    if (typeof mensagemBoasVindas !== 'string') {
      return res.status(400).json({ erro: 'A mensagem de boas-vindas deve ser um texto.' });
    }
    const mensagem = mensagemBoasVindas.trim();
    if (mensagem.length > MAX_MENSAGEM_BOAS_VINDAS) {
      return res.status(400).json({ erro: `A mensagem de boas-vindas pode ter no máximo ${MAX_MENSAGEM_BOAS_VINDAS} caracteres.` });
    }

    if (!documentosObrigatorios || typeof documentosObrigatorios !== 'object' || Array.isArray(documentosObrigatorios)) {
      return res.status(400).json({ erro: 'Informe a lista de documentos obrigatórios.' });
    }
    const chaves = Object.keys(documentosObrigatorios);
    const chavesOk = chaves.length === TIPOS_DOCUMENTO.length && TIPOS_DOCUMENTO.every((t) => chaves.includes(t));
    if (!chavesOk || !TIPOS_DOCUMENTO.every((t) => typeof documentosObrigatorios[t] === 'boolean')) {
      return res.status(400).json({ erro: 'Documentos obrigatórios inválidos: informe exatamente os 6 documentos com valores verdadeiro/falso.' });
    }
    if (!TIPOS_DOCUMENTO.some((t) => documentosObrigatorios[t])) {
      return res.status(400).json({ erro: 'Pelo menos um documento deve permanecer obrigatório.' });
    }

    if (emailContatoRh !== undefined && emailContatoRh !== null && typeof emailContatoRh !== 'string') {
      return res.status(400).json({ erro: 'E-mail de contato inválido.' });
    }
    const email = String(emailContatoRh || '').trim();
    if (email && !REGEX_EMAIL.test(email)) {
      return res.status(400).json({ erro: 'E-mail de contato do RH inválido.' });
    }

    // Campos ausentes mantêm o valor atual; texto vazio volta ao padrão.
    for (const [valor, rotulo] of [[tituloContratacaoConcluida, 'O título'], [mensagemContratacaoConcluida, 'A mensagem']]) {
      if (valor !== undefined && valor !== null && typeof valor !== 'string') {
        return res.status(400).json({ erro: `${rotulo} da contratação concluída deve ser um texto.` });
      }
    }
    const titulo = tituloContratacaoConcluida === undefined ? undefined : String(tituloContratacaoConcluida || '').trim();
    const mensagemContratacao = mensagemContratacaoConcluida === undefined ? undefined : String(mensagemContratacaoConcluida || '').trim();
    if (titulo && titulo.length > MAX_TITULO_CONTRATACAO) {
      return res.status(400).json({ erro: `O título da contratação concluída pode ter no máximo ${MAX_TITULO_CONTRATACAO} caracteres.` });
    }
    if (mensagemContratacao && mensagemContratacao.length > MAX_MENSAGEM_CONTRATACAO) {
      return res.status(400).json({ erro: `A mensagem da contratação concluída pode ter no máximo ${MAX_MENSAGEM_CONTRATACAO} caracteres.` });
    }

    const docs = {};
    TIPOS_DOCUMENTO.forEach((t) => { docs[t] = documentosObrigatorios[t]; });
    const atual = await lerConfiguracoes();
    const config = {
      mensagemBoasVindas: mensagem,
      documentosObrigatorios: docs,
      emailContatoRh: email,
      tituloContratacaoConcluida: titulo === undefined ? atual.tituloContratacaoConcluida : (titulo || TITULO_CONTRATACAO_PADRAO),
      mensagemContratacaoConcluida: mensagemContratacao === undefined ? atual.mensagemContratacaoConcluida : (mensagemContratacao || MENSAGEM_CONTRATACAO_PADRAO),
      fotoRh: atual.fotoRh
    };
    await salvarConfiguracoes(config);

    await registrarEventoAuditoria({
      id: gerarId(),
      tipoEvento: 'configuracoes_alteradas',
      usuarioId: req.usuario.id,
      usuarioEmail: req.usuario.email,
      timestamp: new Date().toISOString(),
      ip: req.ip
    });

    return res.status(200).json(config);
  } catch (erro) {
    console.error('Falha ao salvar configurações:', erro.message);
    return res.status(500).json({ erro: 'Falha ao salvar as configurações.' });
  }
});

// Foto de perfil do RH (única, institucional): data URL ou null para remover.
app.put('/api/rh/configuracoes/foto', exigirRh, async (req, res) => {
  try {
    const foto = (req.body || {}).foto;
    if (foto !== null && !fotoValida(foto)) {
      return res.status(400).json({ erro: 'Foto inválida: envie uma imagem JPEG, PNG ou WebP de até 200 KB.' });
    }
    const config = await lerConfiguracoes();
    config.fotoRh = foto;
    await salvarConfiguracoes(config);

    await registrarEventoAuditoria({
      id: gerarId(),
      tipoEvento: 'foto_perfil_alterada',
      usuarioId: req.usuario.id,
      escopo: 'rh',
      removida: foto === null,
      timestamp: new Date().toISOString(),
      ip: req.ip
    });
    return res.status(200).json(config);
  } catch (erro) {
    console.error('Falha ao salvar foto do RH:', erro.message);
    return res.status(500).json({ erro: 'Falha ao salvar a foto.' });
  }
});

// Pública (sem autenticação): consumida pela ficha do candidato.
app.get('/api/configuracoes/publicas', async (req, res) => {
  const { mensagemBoasVindas, documentosObrigatorios, emailContatoRh, tituloContratacaoConcluida, mensagemContratacaoConcluida, fotoRh } = await lerConfiguracoes();
  return res.status(200).json({ mensagemBoasVindas, documentosObrigatorios, emailContatoRh, tituloContratacaoConcluida, mensagemContratacaoConcluida, fotoRh });
});

// Status que o RH pode atribuir a uma ficha pelo Painel de Gestão.
const STATUS_VALIDOS_RH = ['EM_ANALISE', 'PENDENTE_ASSINATURA'];

// ---------------------------------------------------------------------------
// ROTA: alteração de status de uma ficha pelo RH, com registro na trilha de
// auditoria (LGPD): quem, quando (timestamp) e de onde (IP) a alteração partiu.
// ---------------------------------------------------------------------------
app.patch('/api/rh/fichas/:id/status', exigirRh, async (req, res) => {
  try {
  const { id } = req.params;
  const { status } = req.body;

  if (!STATUS_VALIDOS_RH.includes(status)) {
    return res.status(400).json({
      erro: "Status inválido. Use 'EM_ANALISE' (Em Análise) ou 'PENDENTE_ASSINATURA' (Pendente de Assinatura)."
    });
  }

  const candidatos = await lerCandidatos();
  const candidato = candidatos.find((c) => c.id === id);

  if (!candidato) {
    return res.status(404).json({ erro: 'Candidato não encontrado.' });
  }

  const statusAnterior = candidato.status;
  const agora = new Date().toISOString();

  candidato.status = status;
  candidato.atualizadoEm = agora;
  await salvarCandidatos(candidatos);

  const evento = {
    id: gerarId(),
    candidatoId: id,
    statusAnterior,
    statusNovo: status,
    timestamp: agora,
    ip: req.ip
  };
  await registrarEventoAuditoria(evento);

  console.log(`--- [Auditoria] Status alterado pelo RH --- ID: ${id} | ${statusAnterior} -> ${status} | IP: ${req.ip}`);

  return res.status(200).json({
    mensagem: 'Status da ficha atualizado com sucesso!',
    candidato,
    evento
  });
  } catch (erro) {
    console.error('Falha ao atualizar status (RH):', erro.message);
    return res.status(500).json({ erro: 'Falha ao atualizar o status da ficha.' });
  }
});

// ---------------------------------------------------------------------------
// ROTA: busca de uma única ficha por id (usada pelo candidato para retornar
// à própria ficha - via link com ?id= - e ver pendências, mensagens e decisão)
// Exige login: o RH acessa qualquer ficha; o candidato, somente a própria.
// ---------------------------------------------------------------------------
app.get('/api/candidato/:id', autenticar, async (req, res) => {
  try {
    const candidatos = await lerCandidatos();
    const candidato = candidatos.find((c) => c.id === req.params.id);

    if (!candidato) {
      return res.status(404).json({ erro: 'Candidato não encontrado.' });
    }

    if (!usuarioPodeVerFicha(req.usuario, candidato)) {
      return res.status(403).json({ erro: ERRO_FICHA_DE_OUTRA_CONTA });
    }

    const [comFoto] = await comFotosDosCandidatos([candidato]);
    return res.status(200).json(comFoto);
  } catch (erro) {
    console.error('Falha ao buscar candidato:', erro.message);
    return res.status(500).json({ erro: 'Falha ao buscar o candidato.' });
  }
});

// Quem pode enviar uma mensagem no chat da ficha.
const AUTORES_VALIDOS = ['RH', 'Candidato'];

// ---------------------------------------------------------------------------
// ROTA: consulta das mensagens do chat via HTTP Polling - o front-end chama
// isto periodicamente (a cada poucos segundos) enquanto o chat está visível.
// Escolhido no lugar de um stream SSE mantido aberto porque funciona de
// forma segura em ambiente serverless (Vercel): cada chamada é uma
// requisição curta e independente, sem depender de uma conexão HTTP
// mantida aberta (que seria encerrada pelo limite de execução da função) nem
// de estado em memória compartilhado entre instâncias/invocações diferentes.
// Aceita ?apos=<timestamp ISO> para retornar só as mensagens novas desde a
// última consulta do front-end, evitando reenviar o histórico inteiro a
// cada poll.
// ---------------------------------------------------------------------------
app.get('/api/candidato/:id/mensagens', autenticar, async (req, res) => {
  try {
    const { id } = req.params;
    const { apos } = req.query;

    // Consulta direta em mensagens_chat (tabela própria, normalizada) - mais
    // eficiente do que carregar a lista inteira de candidatos só para filtrar
    // o array embutido de mensagens de um único candidato.
    const candidatoRow = await repo.buscarCandidato(id);
    if (!candidatoRow) return res.status(404).json({ erro: 'Candidato não encontrado.' });
    if (!usuarioPodeVerFicha(req.usuario, { usuarioId: candidatoRow.usuario_id, email: candidatoRow.email })) {
      return res.status(403).json({ erro: ERRO_FICHA_DE_OUTRA_CONTA });
    }

    const linhas = await repo.listarMensagensDaFicha(id, apos ? new Date(apos).toISOString() : null);
    const mensagens = linhas.map(mensagemParaCamelCase);
    return res.status(200).json({ mensagens });
  } catch (erro) {
    console.error('Falha ao buscar mensagens:', erro.message);
    return res.status(500).json({ erro: 'Falha ao buscar as mensagens.' });
  }
});

// ---------------------------------------------------------------------------
// ROTA: envio de mensagem no chat da ficha (RH <-> Candidato), com histórico
// ordenado por data/hora persistido junto da ficha em candidatos.json
// ---------------------------------------------------------------------------
app.post('/api/candidato/:id/mensagens', autenticar, limiteMensagens, async (req, res) => {
  try {
    const { id } = req.params;
    const { autor, texto, nomeAutor } = req.body;

    if (!AUTORES_VALIDOS.includes(autor)) {
      return res.status(400).json({ erro: "Autor inválido. Use 'RH' ou 'Candidato'." });
    }

    // O papel do autor vem da sessão, não do corpo: só o RH escreve como 'RH'
    // e só a conta dona da ficha escreve como 'Candidato'.
    if ((autor === 'RH') !== ehEquipeRh(req.usuario)) {
      return res.status(403).json({ erro: `Sua conta não pode enviar mensagens como '${autor}'.` });
    }

    const textoAparado = String(texto || '').trim();
    if (!textoAparado) {
      return res.status(400).json({ erro: 'Mensagem vazia.' });
    }
    if (textoAparado.length > 2000) {
      return res.status(400).json({ erro: 'A mensagem pode ter no máximo 2000 caracteres.' });
    }

    // Busca só a linha do candidato (não a lista inteira) - o suficiente para
    // validar existência e a regra de bloqueio por REPROVADO.
    const candidatoRow = await repo.buscarCandidato(id);

    if (!candidatoRow) {
      return res.status(404).json({ erro: 'Candidato não encontrado.' });
    }

    if (autor === 'Candidato' && !usuarioEhDonoDaFicha(req.usuario, { usuarioId: candidatoRow.usuario_id, email: candidatoRow.email })) {
      return res.status(403).json({ erro: ERRO_FICHA_DE_OUTRA_CONTA });
    }

    // Bloqueio definitivo: processo finalizado (reprovado) não recebe mais
    // mensagens de nenhum dos dois lados.
    if (candidatoRow.status === 'REPROVADO') {
      return res.status(400).json({ erro: 'Atendimento encerrado. Este processo admissional foi finalizado.' });
    }

    // Nome exibido junto da mensagem: do candidato sempre vem da própria ficha
    // (nunca confia no valor enviado pelo cliente); do RH, o nome informado
    // pelo painel ou, na falta dele, "RH".
    const nomeAutorFinal = autor === 'Candidato'
      ? candidatoRow.nome_completo
      : (String(nomeAutor || '').trim() || 'RH');

    const agora = new Date().toISOString();
    const novaMensagem = {
      id: gerarId(),
      autor,
      nomeAutor: nomeAutorFinal,
      texto: textoAparado,
      timestamp: agora,
      ip: req.ip
    };

    // Insere a mensagem diretamente na tabela própria (mensagens_chat), sem
    // passar pelo upsert da ficha inteira - evita sobrescrever concorrentemente
    // o restante dos dados do candidato só para acrescentar uma mensagem.
    await repo.inserirMensagem({
      id: novaMensagem.id,
      candidato_id: id,
      autor: novaMensagem.autor,
      nome_autor: novaMensagem.nomeAutor,
      texto: novaMensagem.texto,
      timestamp: novaMensagem.timestamp,
      ip: novaMensagem.ip
    });

    // Só o carimbo de atualização da ficha muda - um update pontual, não um
    // upsert da linha inteira.
    await repo.atualizarCandidato(id, { atualizado_em: agora });

    // Trilha de auditoria (LGPD): quem escreveu, quando e de onde.
    await registrarEventoAuditoria({
      id: gerarId(),
      tipoEvento: 'mensagem_chat',
      candidatoId: id,
      autor,
      timestamp: agora,
      ip: req.ip
    });

    // Devolve a ficha completa (mesmo formato de sempre) para o frontend
    // atualizar seu cache local e a lista de mensagens em tela.
    const mensagensLinhas = await repo.listarMensagensDaFicha(id);

    candidatoRow.atualizado_em = agora;
    const candidato = candidatoParaCamelCase(candidatoRow, mensagensLinhas.map(mensagemParaCamelCase));

    return res.status(201).json({ mensagem: 'Mensagem enviada.', candidato });
  } catch (erro) {
    console.error('Falha ao enviar mensagem:', erro.message);
    return res.status(500).json({ erro: 'Falha ao enviar a mensagem.' });
  }
});

// ---------------------------------------------------------------------------
// ROTA: RH marca um documento já enviado como "Com Pendência / Exige Reenvio",
// com justificativa obrigatória. Libera especificamente aquele documento para
// o candidato reenviar, e registra o evento na trilha de auditoria (LGPD).
// ---------------------------------------------------------------------------
app.patch('/api/rh/fichas/:id/documento/:tipo/pendencia', exigirRh, async (req, res) => {
  try {
  const { id, tipo } = req.params;
  const { justificativa } = req.body;

  if (!TIPOS_DOCUMENTO.includes(tipo)) {
    return res.status(400).json({ erro: 'Tipo de documento inválido.' });
  }

  const justificativaAparada = String(justificativa || '').trim();
  if (!justificativaAparada) {
    return res.status(400).json({ erro: 'Informe a justificativa da pendência.' });
  }

  const candidatos = await lerCandidatos();
  const candidato = candidatos.find((c) => c.id === id);

  if (!candidato) {
    return res.status(404).json({ erro: 'Candidato não encontrado.' });
  }

  const documento = candidato.documentos[tipo];
  if (!documento || !documento.arquivo) {
    return res.status(400).json({ erro: 'Só é possível marcar pendência em um documento já enviado.' });
  }

  const agora = new Date().toISOString();
  documento.pendencia = { ativa: true, justificativa: justificativaAparada, criadoEm: agora };
  documento.status = 'VERMELHO';
  documento.atualizadoEm = agora;

  // CPF incluso na Identidade: acompanha automaticamente o status da Identidade.
  if (tipo === 'identidade' && candidato.cpfInclusoNaIdentidade) {
    candidato.documentos.cpf.status = 'VERMELHO';
    candidato.documentos.cpf.atualizadoEm = agora;
  }

  candidato.atualizadoEm = agora;
  await salvarCandidatos(candidatos);

  await registrarEventoAuditoria({
    id: gerarId(),
    tipoEvento: 'pendencia_documento',
    candidatoId: id,
    documentoTipo: tipo,
    justificativa: justificativaAparada,
    timestamp: agora,
    ip: req.ip
  });

  console.log(`--- [Auditoria] Pendência aberta --- ID: ${id} | Documento: ${tipo} | IP: ${req.ip}`);

  return res.status(200).json({
    mensagem: 'Pendência registrada. O candidato poderá reenviar este documento.',
    candidato
  });
  } catch (erro) {
    console.error('Falha ao registrar pendência:', erro.message);
    return res.status(500).json({ erro: 'Falha ao registrar a pendência.' });
  }
});

// ---------------------------------------------------------------------------
// ROTA: RH aceita um documento já enviado (marca como Aprovado/Ok a nível de
// documento). Encerra uma eventual pendência aberta e conta como primeira
// interação do RH com a ficha.
// ---------------------------------------------------------------------------
app.patch('/api/rh/fichas/:id/documento/:tipo/aceitar', exigirRh, async (req, res) => {
  try {
  const { id, tipo } = req.params;

  if (!TIPOS_DOCUMENTO.includes(tipo)) {
    return res.status(400).json({ erro: 'Tipo de documento inválido.' });
  }

  const candidatos = await lerCandidatos();
  const candidato = candidatos.find((c) => c.id === id);

  if (!candidato) {
    return res.status(404).json({ erro: 'Candidato não encontrado.' });
  }

  const documento = candidato.documentos[tipo];
  if (!documento || !documento.arquivo) {
    return res.status(400).json({ erro: 'Só é possível aceitar um documento já enviado.' });
  }

  const agora = new Date().toISOString();
  documento.status = 'VERDE';
  documento.pendencia = null;
  documento.atualizadoEm = agora;

  // CPF incluso na Identidade: acompanha automaticamente o status da Identidade.
  if (tipo === 'identidade' && candidato.cpfInclusoNaIdentidade) {
    candidato.documentos.cpf.status = 'VERDE';
    candidato.documentos.cpf.pendencia = null;
    candidato.documentos.cpf.atualizadoEm = agora;
  }

  candidato.atualizadoEm = agora;
  await salvarCandidatos(candidatos);

  await registrarEventoAuditoria({
    id: gerarId(),
    tipoEvento: 'documento_aceito',
    candidatoId: id,
    documentoTipo: tipo,
    timestamp: agora,
    ip: req.ip
  });

  console.log(`--- [Auditoria] Documento aceito --- ID: ${id} | Documento: ${tipo} | IP: ${req.ip}`);

  return res.status(200).json({ mensagem: 'Documento aceito com sucesso!', candidato });
  } catch (erro) {
    console.error('Falha ao aceitar documento:', erro.message);
    return res.status(500).json({ erro: 'Falha ao aceitar o documento.' });
  }
});

// ---------------------------------------------------------------------------
// ROTA: RH abriu/visualizou um documento (clique em "Visualizar/Baixar PDF").
// Não altera nada no documento em si; apenas registra o evento na auditoria.
// ---------------------------------------------------------------------------
app.patch('/api/rh/fichas/:id/documento/:tipo/visualizado', exigirRh, async (req, res) => {
  try {
  const { id, tipo } = req.params;

  if (!TIPOS_DOCUMENTO.includes(tipo)) {
    return res.status(400).json({ erro: 'Tipo de documento inválido.' });
  }

  const candidatos = await lerCandidatos();
  const candidato = candidatos.find((c) => c.id === id);

  if (!candidato) {
    return res.status(404).json({ erro: 'Candidato não encontrado.' });
  }

  const agora = new Date().toISOString();

  await registrarEventoAuditoria({
    id: gerarId(),
    tipoEvento: 'documento_visualizado',
    candidatoId: id,
    documentoTipo: tipo,
    timestamp: agora,
    ip: req.ip
  });

  return res.status(200).json({ mensagem: 'ok', candidato });
  } catch (erro) {
    console.error('Falha ao registrar visualização:', erro.message);
    return res.status(500).json({ erro: 'Falha ao registrar a visualização.' });
  }
});

// Decisões finais válidas para o processo admissional.
const DECISOES_VALIDAS = ['APROVADO', 'REPROVADO'];

// ---------------------------------------------------------------------------
// ROTA: decisão final do processo (Aprovar/Reprovar), com registro na trilha
// de auditoria. A ficha do candidato passa a ficar travada para edição.
// ---------------------------------------------------------------------------
app.patch('/api/rh/fichas/:id/decisao', exigirRh, async (req, res) => {
  try {
  const { id } = req.params;
  const { decisao } = req.body;

  if (!DECISOES_VALIDAS.includes(decisao)) {
    return res.status(400).json({ erro: "Decisão inválida. Use 'APROVADO' ou 'REPROVADO'." });
  }

  const candidatos = await lerCandidatos();
  const candidato = candidatos.find((c) => c.id === id);

  if (!candidato) {
    return res.status(404).json({ erro: 'Candidato não encontrado.' });
  }

  const agora = new Date().toISOString();
  const decisaoAnterior = candidato.decisaoFinal;

  candidato.decisaoFinal = decisao;
  candidato.decisaoFinalEm = agora;
  // O status geral da ficha passa a refletir definitivamente a decisão: a
  // partir daqui ela sai de "Em Análise" e passa a existir exclusivamente em
  // "Pendente de Assinatura" (aprovado, aguardando aceite/assinatura do
  // contrato) ou "Reprovado".
  candidato.status = decisao === 'APROVADO' ? 'PENDENTE_ASSINATURA' : 'REPROVADO';
  candidato.atualizadoEm = agora;
  await salvarCandidatos(candidatos);

  await registrarEventoAuditoria({
    id: gerarId(),
    tipoEvento: 'decisao_final',
    candidatoId: id,
    decisaoAnterior,
    decisaoNova: decisao,
    timestamp: agora,
    ip: req.ip
  });

  console.log(`--- [Auditoria] Decisão final --- ID: ${id} | Decisão: ${decisao} | IP: ${req.ip}`);

  return res.status(200).json({
    mensagem: 'Decisão registrada com sucesso!',
    candidato
  });
  } catch (erro) {
    console.error('Falha ao registrar decisão:', erro.message);
    return res.status(500).json({ erro: 'Falha ao registrar a decisão.' });
  }
});

// Rótulos do status (documento/ficha em análise) usados no relatório exportado.
const ROTULO_STATUS_CSV = {
  EM_ANALISE: 'EM ANÁLISE',
  PENDENTE_ASSINATURA: 'PENDENTE DE ASSINATURA',
  REPROVADO: 'REPROVADO',
  CONTRATACAO_CONCLUIDA: 'CONTRATAÇÃO CONCLUÍDA'
};

// Rótulos do status a nível de documento individual (VERMELHO/AMARELO/VERDE
// - independente do status geral da ficha), usados apenas para o Certificado
// de Reservista no relatório.
const ROTULO_STATUS_DOCUMENTO = {
  VERMELHO: 'PENDENTE',
  AMARELO: 'EM ANÁLISE',
  VERDE: 'APROVADO'
};

// Rótulo textual do Certificado de Reservista para o relatório: segue a
// mesma regra de dispensa por gênero usada no resto do sistema.
function rotuloReservistaRelatorio(candidato) {
  if (candidato.genero !== 'Masculino') return 'Não exigido';
  const status = candidato.documentos.reservista?.status;
  return ROTULO_STATUS_DOCUMENTO[status] || status || '';
}

// Resumo compacto do status dos 6 documentos obrigatórios (quantos já foram
// enviados e quantos já foram aceitos/aprovados pelo RH) para uma única
// célula do relatório.
function resumoStatusDocumentosRelatorio(candidato) {
  let enviados = 0;
  let aceitos = 0;
  TIPOS_DOCUMENTO.forEach((tipo) => {
    const documento = candidato.documentos[tipo] || {};
    if (documento.arquivo || documento.status === 'VERDE') enviados++;
    if (documento.status === 'VERDE') aceitos++;
  });
  return `${enviados}/${TIPOS_DOCUMENTO.length} enviados | ${aceitos}/${TIPOS_DOCUMENTO.length} aceitos`;
}

// Cabeçalho completo do relatório de admissões (CSV legado e planilha Mestre
// em Excel compartilham exatamente as mesmas 23 colunas).
const CABECALHO_RELATORIO = [
  'Nome Completo', 'CPF', 'E-mail', 'Telefone', 'Gênero', 'CEP', 'Endereço', 'Número', 'Complemento',
  'Status Atual', 'Data de Submissão', 'Última Atualização',
  'Consentimento LGPD', 'Timestamp LGPD', 'IP LGPD',
  'Status Documentos', 'CPF no RG', 'Reservista',
  'Aceite Contratual', 'Timestamp Aceite Contrato', 'Hash Contrato',
  'Exportado Ponto', 'Sistema Ponto Alvo'
];

// Monta a linha (array de 23 valores brutos, sem formatação de célula) de um
// candidato para o relatório de admissões - usada pela planilha Mestre em
// Excel. Fica centralizada aqui para nunca haver divergência de colunas.
function montarLinhaRelatorio(c) {
  const endereco = [c.logradouro, c.bairro].filter(Boolean).join(', ');
  const statusTexto = ROTULO_STATUS_CSV[c.status] || c.status || '';
  const consentimentoFicha = c.consentimentoFichaLGPD;
  const assinatura = c.contrato?.assinaturaConcluida;
  const integracaoPonto = c.integracaoPonto || criarIntegracaoPontoInicial();

  return [
    c.nomeCompleto,
    c.cpf,
    c.email,
    c.whatsapp,
    c.genero,
    c.cep,
    endereco,
    c.numero,
    c.complemento,
    statusTexto,
    formatarDataBr(c.criadoEm),
    formatarDataBr(c.atualizadoEm),
    consentimentoFicha?.aceito ? 'Sim' : 'Não',
    consentimentoFicha ? formatarDataBr(consentimentoFicha.dataHora) : '',
    consentimentoFicha?.ip || '',
    resumoStatusDocumentosRelatorio(c),
    c.cpfInclusoNaIdentidade ? 'Sim' : 'Não',
    rotuloReservistaRelatorio(c),
    assinatura ? 'Sim' : 'Não',
    assinatura ? formatarDataBr(assinatura.timestamp) : '',
    assinatura?.hash || '',
    integracaoPonto.exportado ? 'Sim' : 'Não',
    integracaoPonto.sistemaAlvo || ''
  ];
}

// ---------------------------------------------------------------------------
// PLANILHA MESTRE (Excel .xlsx) - relatorio_geral_admissoes.xlsx na raiz do
// projeto, regenerada automaticamente a cada gravação de candidatos.json
// (nova ficha, mudança de status, decisão, contrato etc. - ver o hook dentro
// de salvarCandidatos()), sempre refletindo os dados mais recentes do sistema.
// ---------------------------------------------------------------------------
const ARQUIVO_PLANILHA_MESTRE = path.join(DIRETORIO_DADOS, 'relatorio_geral_admissoes.xlsx');

// Cores de destaque (fundo/texto) por status, aplicadas na coluna "Status
// Atual" de cada linha - o equivalente visual de uma formatação condicional,
// calculado no momento da geração (o arquivo é sempre recriado do zero, então
// não há necessidade de uma regra dinâmica do Excel).
const ESTILO_STATUS_PLANILHA = {
  'CONTRATAÇÃO CONCLUÍDA': { fundo: 'FF00A335', texto: 'FFFFFFFF' },
  'PENDENTE DE ASSINATURA': { fundo: 'FFF97316', texto: 'FFFFFFFF' },
  'EM ANÁLISE': { fundo: 'FFF5E40B', texto: 'FF1A1A1A' },
  REPROVADO: { fundo: 'FFFF0303', texto: 'FFFFFFFF' }
};

const BORDA_FINA_PLANILHA = {
  top: { style: 'thin' }, left: { style: 'thin' }, bottom: { style: 'thin' }, right: { style: 'thin' }
};

// Colunas de código, data ou status ficam centralizadas nas linhas de dados
// (o texto livre - nome, e-mail, endereço, complemento e o sistema de ponto
// - continua alinhado à esquerda, mais legível para conteúdo longo).
const COLUNAS_CENTRALIZADAS_PLANILHA = new Set([
  'CPF', 'Telefone', 'Gênero', 'CEP', 'Número',
  'Status Atual', 'Data de Submissão', 'Última Atualização',
  'Consentimento LGPD', 'Timestamp LGPD', 'IP LGPD',
  'Status Documentos', 'CPF no RG', 'Reservista',
  'Aceite Contratual', 'Timestamp Aceite Contrato', 'Hash Contrato',
  'Exportado Ponto'
]);

// Gera (ou recria por completo) a planilha Mestre a partir do estado atual
// de candidatos.json - lê sempre do disco, nunca de um parâmetro em memória,
// para que a última gravação da fila (ver atualizarPlanilhaMestre) sempre
// reflita o estado mais recente, mesmo sob gravações concorrentes.
async function gerarOuAtualizarPlanilhaMestre() {
  const candidatos = await lerCandidatos();

  const workbook = new ExcelJS.Workbook();
  const planilha = workbook.addWorksheet('Relatório de Admissões');

  const linhaCabecalho = planilha.addRow(CABECALHO_RELATORIO);
  linhaCabecalho.eachCell((celula) => {
    celula.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    celula.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF005623' } };
    celula.alignment = { horizontal: 'center', vertical: 'middle' };
    celula.border = BORDA_FINA_PLANILHA;
  });

  const indiceColunaStatus = CABECALHO_RELATORIO.indexOf('Status Atual') + 1;
  const indicesCentralizados = CABECALHO_RELATORIO
    .map((titulo, indice) => (COLUNAS_CENTRALIZADAS_PLANILHA.has(titulo) ? indice + 1 : null))
    .filter((indice) => indice !== null);

  candidatos.forEach((c) => {
    const linha = planilha.addRow(montarLinhaRelatorio(c));
    linha.eachCell((celula) => { celula.border = BORDA_FINA_PLANILHA; });
    indicesCentralizados.forEach((indice) => {
      linha.getCell(indice).alignment = { horizontal: 'center', vertical: 'middle' };
    });

    const estilo = ESTILO_STATUS_PLANILHA[String(linha.getCell(indiceColunaStatus).value || '')];
    if (estilo) {
      const celulaStatus = linha.getCell(indiceColunaStatus);
      celulaStatus.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: estilo.fundo } };
      celulaStatus.font = { color: { argb: estilo.texto }, bold: true };
      celulaStatus.alignment = { horizontal: 'center', vertical: 'middle' };
    }
  });

  planilha.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: CABECALHO_RELATORIO.length } };

  // Largura automática por coluna, baseada no maior conteúdo (cabeçalho incluso).
  CABECALHO_RELATORIO.forEach((titulo, indice) => {
    const coluna = planilha.getColumn(indice + 1);
    let maiorTamanho = titulo.length;
    coluna.eachCell({ includeEmpty: true }, (celula) => {
      const tamanho = String(celula.value == null ? '' : celula.value).length;
      if (tamanho > maiorTamanho) maiorTamanho = tamanho;
    });
    coluna.width = Math.min(maiorTamanho + 2, 60);
  });

  await workbook.xlsx.writeFile(ARQUIVO_PLANILHA_MESTRE);
}

// Fila serializada: garante que nunca haja duas gravações do mesmo arquivo
// .xlsx em paralelo (o que poderia corromper o arquivo) quando várias
// requisições disparam atualizações quase ao mesmo tempo.
let filaPlanilhaMestre = Promise.resolve();
function atualizarPlanilhaMestre() {
  filaPlanilhaMestre = filaPlanilhaMestre.then(gerarOuAtualizarPlanilhaMestre).catch((erro) => {
    console.error('Falha ao atualizar a planilha mestre:', erro.message);
  });
  return filaPlanilhaMestre;
}

// ---------------------------------------------------------------------------
// ROTA: download da planilha Mestre de admissões em Excel (.xlsx), sempre
// atualizada com os dados mais recentes do sistema antes do envio.
// ---------------------------------------------------------------------------
app.get('/api/rh/exportar-relatorio', exigirRh, async (req, res) => {
  try {
    await atualizarPlanilhaMestre();
    return res.download(ARQUIVO_PLANILHA_MESTRE, 'relatorio_geral_admissoes.xlsx');
  } catch (erro) {
    console.error('Falha ao exportar a planilha mestre:', erro.message);
    return res.status(500).json({ erro: 'Falha ao gerar o relatório em Excel.' });
  }
});

// ---------------------------------------------------------------------------
// DASHBOARD DE ADMISSÕES - filtros compartilhados entre o painel visual
// (public/rh.html) e o relatório em PDF gerado abaixo, para que o PDF
// exportado sempre reflita exatamente o que o RH está vendo na tela.
// ---------------------------------------------------------------------------

// Aplica os mesmos filtros do painel (período de submissão, status e busca
// por nome/CPF) sobre a lista de candidatos.
function filtrarCandidatosParaDashboard(candidatos, query = {}) {
  let resultado = candidatos;
  const { dataInicio, dataFim, status, busca } = query;

  if (status) {
    resultado = resultado.filter((c) => c.status === status);
  }

  if (dataInicio) {
    const inicio = new Date(`${dataInicio}T00:00:00`);
    resultado = resultado.filter((c) => new Date(c.criadoEm) >= inicio);
  }

  if (dataFim) {
    const fim = new Date(`${dataFim}T23:59:59`);
    resultado = resultado.filter((c) => new Date(c.criadoEm) <= fim);
  }

  if (busca) {
    const termo = String(busca).trim().toLowerCase();
    const termoDigitos = termo.replace(/\D/g, '');
    resultado = resultado.filter((c) => {
      const nome = (c.nomeCompleto || '').toLowerCase();
      const cpfDigitos = (c.cpf || '').replace(/\D/g, '');
      return nome.includes(termo) || (termoDigitos.length > 0 && cpfDigitos.includes(termoDigitos));
    });
  }

  return resultado;
}

// Calcula os KPIs consolidados (contagens, percentuais e taxa de adesão por
// etapa da jornada) sobre um conjunto de candidatos já filtrado. Os quatro
// buckets de status (em análise/pendente de assinatura/reprovadas/concluídas)
// são mutuamente exclusivos e somam o total.
function calcularKpisDashboard(candidatos) {
  const total = candidatos.length;
  const percentual = (valor) => (total === 0 ? 0 : Math.round((valor / total) * 1000) / 10);

  const contratacoesConcluidas = candidatos.filter((c) => c.status === 'CONTRATACAO_CONCLUIDA').length;
  const emAnalise = candidatos.filter((c) => c.status === 'EM_ANALISE').length;
  const pendenteAssinatura = candidatos.filter((c) => c.status === 'PENDENTE_ASSINATURA').length;
  const reprovadas = candidatos.filter((c) => c.status === 'REPROVADO').length;

  const comAceiteContrato = candidatos.filter((c) => c.contrato?.assinaturaConcluida).length;

  return {
    total,
    contratacoesConcluidas, percentualContratacoesConcluidas: percentual(contratacoesConcluidas),
    emAnalise, percentualEmAnalise: percentual(emAnalise),
    pendenteAssinatura, percentualPendenteAssinatura: percentual(pendenteAssinatura),
    reprovadas, percentualReprovadas: percentual(reprovadas),
    etapaAceiteContrato: percentual(comAceiteContrato)
  };
}

// Rótulos e valores de cada filtro aplicado na tela do Dashboard, para exibir
// de forma explícita no cabeçalho do PDF exportado - o RH precisa ver
// exatamente qual período/status/busca gerou aquele relatório.
function descreverFiltrosDashboard(query = {}) {
  const { dataInicio, dataFim, status, busca } = query;
  const partes = [];

  if (dataInicio || dataFim) {
    partes.push(`Período: ${dataInicio ? formatarDataBr(`${dataInicio}T00:00:00`).split(',')[0] : 'início'} até ${dataFim ? formatarDataBr(`${dataFim}T00:00:00`).split(',')[0] : 'hoje'}`);
  }
  if (status) {
    partes.push(`Status: ${ROTULO_STATUS_CSV[status] || status}`);
  }
  if (busca) {
    partes.push(`Busca: "${busca}"`);
  }

  return partes.length ? partes.join('   |   ') : 'Nenhum filtro aplicado - todos os registros do sistema';
}

// ---------------------------------------------------------------------------
// ROTA: relatório visual do Dashboard de Admissões em PDF (A4 paisagem),
// respeitando os mesmos filtros (período/status/busca) aplicados na tela.
// ---------------------------------------------------------------------------
app.get('/api/relatorio/dashboard-pdf', exigirRh, async (req, res) => {
  try {
    // Arquivados no Banco de Talentos ficam fora, como na tela do dashboard.
    const candidatosFiltrados = filtrarCandidatosParaDashboard((await lerCandidatos()).filter((c) => !c.bancoTalentos), req.query);
    const kpis = calcularKpisDashboard(candidatosFiltrados);

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="dashboard_admissoes.pdf"');

    const doc = new PDFDocument({ margin: 40, size: 'A4', layout: 'landscape' });
    doc.pipe(res);

    const larguraUtil = doc.page.width - doc.page.margins.left - doc.page.margins.right;

    // Cabeçalho corporativo
    doc.rect(doc.page.margins.left, doc.page.margins.top, larguraUtil, 55).fill('#005623');
    doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(18)
      .text('Dashboard de Admissões', doc.page.margins.left + 15, doc.page.margins.top + 10);
    doc.font('Helvetica').fontSize(9)
      .text(`Sistema ${MARCA.nome} & Conformidade Trabalhista`, doc.page.margins.left + 15, doc.page.margins.top + 34);
    doc.font('Helvetica-Bold').fontSize(9)
      .text(`Gerado em: ${formatarDataBr(new Date().toISOString())}`, doc.page.margins.left, doc.page.margins.top + 10, { width: larguraUtil - 15, align: 'right' });
    doc.font('Helvetica').fontSize(9)
      .text(`Registros no filtro: ${kpis.total}`, doc.page.margins.left, doc.page.margins.top + 34, { width: larguraUtil - 15, align: 'right' });

    // Filtros aplicados - mostrado sempre, mesmo sem filtro nenhum (deixa
    // explícito que o relatório traz TODOS os registros nesse caso), para que
    // o PDF nunca deixe dúvida sobre qual período/status/busca foi impresso.
    const yFiltros = doc.page.margins.top + 62;
    doc.rect(doc.page.margins.left, yFiltros, larguraUtil, 22).fill('#f4f6f9');
    doc.fillColor('#1a252f').font('Helvetica-Bold').fontSize(8)
      .text('FILTROS APLICADOS:  ', doc.page.margins.left + 10, yFiltros + 7, { continued: true })
      .font('Helvetica').fillColor('#333333')
      .text(descreverFiltrosDashboard(req.query));

    doc.y = yFiltros + 22 + 15;

    // Blocos de KPI
    const blocos = [
      { rotulo: 'Total de Admissões', valor: String(kpis.total), destaque: '#1a252f' },
      { rotulo: 'Contratações Concluídas', valor: `${kpis.contratacoesConcluidas} (${kpis.percentualContratacoesConcluidas}%)`, destaque: '#00A335' },
      { rotulo: 'Em Análise', valor: `${kpis.emAnalise} (${kpis.percentualEmAnalise}%)`, destaque: '#F5E40B' },
      { rotulo: 'Pendente de Assinatura', valor: `${kpis.pendenteAssinatura} (${kpis.percentualPendenteAssinatura}%)`, destaque: '#F97316' },
      { rotulo: 'Recusadas / Reprovadas', valor: `${kpis.reprovadas} (${kpis.percentualReprovadas}%)`, destaque: '#FF0303' }
    ];

    const espacamento = 10;
    const larguraBloco = (larguraUtil - espacamento * (blocos.length - 1)) / blocos.length;
    const yBlocos = doc.y;
    const alturaBloco = 55;

    blocos.forEach((bloco, indice) => {
      const x = doc.page.margins.left + indice * (larguraBloco + espacamento);
      doc.lineWidth(1).rect(x, yBlocos, larguraBloco, alturaBloco).stroke('#cccccc');
      doc.rect(x, yBlocos, 4, alturaBloco).fill(bloco.destaque);
      doc.fillColor('#6c757d').font('Helvetica-Bold').fontSize(8)
        .text(bloco.rotulo.toUpperCase(), x + 10, yBlocos + 8, { width: larguraBloco - 16 });
      doc.fillColor('#2c3e50').font('Helvetica-Bold').fontSize(14)
        .text(bloco.valor, x + 10, yBlocos + 26, { width: larguraBloco - 16 });
    });

    doc.y = yBlocos + alturaBloco + 22;

    // Dois painéis lado a lado, espelhando os mesmos 2 gráficos exibidos na
    // aba "Estatísticas & Relatórios" do painel (mesmas cores e categorias),
    // para que o PDF exportado seja fiel ao que o RH vê na tela.
    const yPaineis = doc.y;
    const alturaPaineis = 130;
    const larguraPainel = (larguraUtil - espacamento) / 2;
    const xPainelEsquerdo = doc.page.margins.left;
    const xPainelDireito = doc.page.margins.left + larguraPainel + espacamento;

    doc.lineWidth(1).rect(xPainelEsquerdo, yPaineis, larguraPainel, alturaPaineis).stroke('#e6e9ee');
    doc.lineWidth(1).rect(xPainelDireito, yPaineis, larguraPainel, alturaPaineis).stroke('#e6e9ee');

    // Painel 1: Distribuição por Status - barra segmentada proporcional
    // (equivalente ao gráfico de rosca da tela) com legenda e percentuais.
    doc.fillColor('#1a252f').font('Helvetica-Bold').fontSize(10)
      .text('Distribuição por Status', xPainelEsquerdo + 12, yPaineis + 10);

    const fatias = [
      { rotulo: 'Contratação Concluída', valor: kpis.contratacoesConcluidas, pct: kpis.percentualContratacoesConcluidas, cor: '#00A335' },
      { rotulo: 'Em Análise', valor: kpis.emAnalise, pct: kpis.percentualEmAnalise, cor: '#F5E40B' },
      { rotulo: 'Pendente de Assinatura', valor: kpis.pendenteAssinatura, pct: kpis.percentualPendenteAssinatura, cor: '#F97316' },
      { rotulo: 'Reprovado', valor: kpis.reprovadas, pct: kpis.percentualReprovadas, cor: '#FF0303' }
    ];

    const xBarraSegmentada = xPainelEsquerdo + 12;
    const larguraBarraSegmentada = larguraPainel - 24;
    const yBarraSegmentada = yPaineis + 32;
    const alturaBarraSegmentada = 16;

    if (kpis.total === 0) {
      doc.rect(xBarraSegmentada, yBarraSegmentada, larguraBarraSegmentada, alturaBarraSegmentada).fill('#e6e9ee');
    } else {
      let xSegmento = xBarraSegmentada;
      fatias.forEach((fatia) => {
        const largura = (fatia.valor / kpis.total) * larguraBarraSegmentada;
        if (largura > 0) doc.rect(xSegmento, yBarraSegmentada, largura, alturaBarraSegmentada).fill(fatia.cor);
        xSegmento += largura;
      });
    }

    let yLegenda = yBarraSegmentada + alturaBarraSegmentada + 14;
    fatias.forEach((fatia) => {
      doc.rect(xPainelEsquerdo + 12, yLegenda, 8, 8).fill(fatia.cor);
      doc.fillColor('#333333').font('Helvetica').fontSize(8)
        .text(`${fatia.rotulo}: ${fatia.valor} (${fatia.pct}%)`, xPainelEsquerdo + 26, yLegenda - 1, { width: larguraPainel - 40 });
      yLegenda += 14;
    });

    // Painel 2: Taxa de Adesão por Etapa - gráfico de barras verticais
    // (mesmas 4 categorias e cores do gráfico da tela).
    doc.fillColor('#1a252f').font('Helvetica-Bold').fontSize(10)
      .text('Taxa de Adesão por Etapa', xPainelDireito + 12, yPaineis + 10);

    const etapas = [
      { rotulo: 'Reprovado', pct: kpis.percentualReprovadas, cor: '#FF0303' },
      { rotulo: 'Em Análise', pct: kpis.percentualEmAnalise, cor: '#F5E40B' },
      { rotulo: 'Pend. Assinatura', pct: kpis.percentualPendenteAssinatura, cor: '#F97316' },
      { rotulo: 'Aceite Contrato', pct: kpis.etapaAceiteContrato, cor: '#00A335' }
    ];

    const alturaMaximaBarra = 60;
    const yBaseBarras = yPaineis + 32 + alturaMaximaBarra;
    const larguraBarraVertical = 26;
    const espacoEntreBarras = (larguraPainel - 24 - larguraBarraVertical * etapas.length) / (etapas.length + 1);

    etapas.forEach((etapa, indice) => {
      const x = xPainelDireito + 12 + espacoEntreBarras * (indice + 1) + larguraBarraVertical * indice;
      const alturaBarra = Math.max((etapa.pct / 100) * alturaMaximaBarra, etapa.pct > 0 ? 3 : 0);
      doc.fillColor('#333333').font('Helvetica-Bold').fontSize(7)
        .text(`${etapa.pct}%`, x - 5, yBaseBarras - alturaBarra - 11, { width: larguraBarraVertical + 10, align: 'center' });
      doc.rect(x, yBaseBarras - alturaBarra, larguraBarraVertical, alturaBarra).fill(etapa.cor);
      doc.fillColor('#333333').font('Helvetica').fontSize(6.5)
        .text(etapa.rotulo, x - 8, yBaseBarras + 4, { width: larguraBarraVertical + 16, align: 'center' });
    });
    doc.moveTo(xPainelDireito + 12, yBaseBarras).lineTo(xPainelDireito + larguraPainel - 12, yBaseBarras).lineWidth(0.5).stroke('#cccccc');

    doc.y = yPaineis + alturaPaineis + 22;

    // Tabela analítica dos candidatos filtrados
    doc.fillColor('#1a252f').font('Helvetica-Bold').fontSize(11).text('Candidatos no Filtro Selecionado', doc.page.margins.left);
    doc.moveDown(0.4);

    const colunas = [
      { titulo: 'Nome Completo', largura: 0.24 },
      { titulo: 'CPF', largura: 0.14 },
      { titulo: 'Status Atual', largura: 0.20 },
      { titulo: 'Data de Submissão', largura: 0.16 },
      { titulo: 'Aceite Contrato', largura: 0.13 },
      { titulo: 'Exportado Ponto', largura: 0.13 }
    ];
    const xColunas = [];
    let acumulado = doc.page.margins.left;
    colunas.forEach((coluna) => { xColunas.push(acumulado); acumulado += larguraUtil * coluna.largura; });

    function desenharCabecalhoTabela() {
      const yCabecalho = doc.y;
      doc.rect(doc.page.margins.left, yCabecalho, larguraUtil, 20).fill('#005623');
      doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(8);
      colunas.forEach((coluna, indice) => {
        doc.text(coluna.titulo, xColunas[indice] + 4, yCabecalho + 6, { width: larguraUtil * coluna.largura - 8 });
      });
      doc.y = yCabecalho + 20;
    }

    desenharCabecalhoTabela();
    doc.font('Helvetica').fontSize(8).fillColor('#000000');

    candidatosFiltrados.forEach((c, indice) => {
      if (doc.y > doc.page.height - doc.page.margins.bottom - 20) {
        doc.addPage();
        desenharCabecalhoTabela();
        doc.font('Helvetica').fontSize(8).fillColor('#000000');
      }

      const yLinha = doc.y;
      if (indice % 2 === 1) {
        doc.rect(doc.page.margins.left, yLinha, larguraUtil, 18).fill('#f4f6f9');
      }

      const statusTexto = ROTULO_STATUS_CSV[c.status] || c.status || '';
      const aceiteTexto = c.contrato?.assinaturaConcluida ? 'Sim' : 'Não';
      const pontoTexto = c.integracaoPonto?.exportado ? 'Sim' : 'Não';
      const valores = [c.nomeCompleto, c.cpf, statusTexto, formatarDataBr(c.criadoEm), aceiteTexto, pontoTexto];

      doc.fillColor('#000000').font('Helvetica').fontSize(8);
      valores.forEach((valor, indiceColuna) => {
        doc.text(String(valor || '-'), xColunas[indiceColuna] + 4, yLinha + 5, { width: larguraUtil * colunas[indiceColuna].largura - 8 });
      });
      doc.y = yLinha + 18;
    });

    if (candidatosFiltrados.length === 0) {
      doc.font('Helvetica-Oblique').fontSize(9).fillColor('#6c757d')
        .text('Nenhum candidato encontrado para os filtros selecionados.', doc.page.margins.left, doc.y + 6);
    }

    doc.end();
  } catch (erro) {
    console.error('Falha ao gerar o PDF do dashboard:', erro.message);
    return res.status(500).json({ erro: 'Falha ao gerar o relatório em PDF.' });
  }
});

// ---------------------------------------------------------------------------
// ROTA: geração de um PDF real da ficha individual (dados pessoais,
// documentos e declaração de consentimento LGPD), para o RH visualizar,
// baixar ou imprimir a partir do visualizador de PDF do navegador - em vez
// de acionar diretamente a caixa de diálogo de impressão do sistema.
// ---------------------------------------------------------------------------
const TITULOS_DOCUMENTO = {
  identidade: 'Identidade (RG)',
  cpf: 'CPF',
  comprovanteResidencia: 'Comprovante de Residência',
  comprovanteEscolaridade: 'Comprovante de Escolaridade',
  reservista: 'Certificado de Reservista',
  carteiraTrabalho: 'Carteira de Trabalho'
};

function formatarDataBr(iso) {
  if (!iso) return '-';
  return new Date(iso).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
}

// ---------------------------------------------------------------------------
// API REST v1 - integração com sistemas externos de admissão (protegida por
// API Key). API_KEY_ADMISSOES é obrigatória (mín. 16 caracteres): sem ela a
// API fica desativada - não existe chave padrão.
// ---------------------------------------------------------------------------
const CHAVE_API_ADMISSOES = process.env.API_KEY_ADMISSOES || '';
const TAMANHO_MINIMO_CHAVE_API = 16;

// Comparação em tempo constante (compara os SHA-256, que têm tamanho fixo).
function chavesIguais(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function exigirApiKeyAdmissoes(req, res, next) {
  if (CHAVE_API_ADMISSOES.length < TAMANHO_MINIMO_CHAVE_API) {
    // Em produção a resposta não revela como o servidor é configurado; o nome
    // da variável só aparece fora de produção, para quem está configurando.
    return res.status(503).json({
      erro: EXIBIR_LINK_ATIVACAO
        ? `API de integração desativada: defina API_KEY_ADMISSOES (mínimo de ${TAMANHO_MINIMO_CHAVE_API} caracteres) no ambiente do servidor.`
        : 'API de integração indisponível.'
    });
  }
  const chaveRecebida = req.headers['x-api-key'] || (req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
  if (!chaveRecebida || !chavesIguais(chaveRecebida, CHAVE_API_ADMISSOES)) {
    return res.status(401).json({ erro: 'API Key inválida ou ausente. Use o header "x-api-key" ou "Authorization: Bearer <TOKEN>".' });
  }
  next();
}

// Remove acentos e normaliza para minúsculas, para comparar rótulos em
// pt-BR vindos da query string sem depender de acento/caixa exatos.
function normalizarTextoComparacao(texto) {
  return String(texto || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim();
}

// Aceita tanto o código interno (EM_ANALISE) quanto o rótulo em português
// (com ou sem acentos/caixa, ex.: "Contratação Concluída") e devolve o
// código interno correspondente, ou null se não houver correspondência.
function resolverCodigoStatus(valorConsulta) {
  if (!valorConsulta) return null;
  if (Object.prototype.hasOwnProperty.call(ROTULO_STATUS_CSV, valorConsulta)) {
    return valorConsulta;
  }
  const alvo = normalizarTextoComparacao(valorConsulta);
  const codigo = Object.keys(ROTULO_STATUS_CSV).find(
    (chave) => normalizarTextoComparacao(ROTULO_STATUS_CSV[chave]) === alvo
  );
  return codigo || null;
}

// Monta o registro estruturado de uma ficha para consumo por sistemas
// externos de admissão: dados cadastrais, status, documentos, LGPD, aceite
// contratual e integração de ponto. Não inclui mensagens do chat nem
// caminhos de arquivo além dos indicadores booleanos.
function montarRegistroApiAdmissao(c) {
  const documentos = TIPOS_DOCUMENTO.map((tipo) => {
    const documento = c.documentos?.[tipo] || {};
    return {
      tipo,
      titulo: TITULOS_DOCUMENTO[tipo],
      status: documento.status || null,
      arquivo: !!documento.arquivo,
      validado: documento.status === 'VERDE'
    };
  });

  const assinatura = c.contrato?.assinaturaConcluida;
  const aceiteContratual = assinatura
    ? { concluido: true, timestamp: assinatura.timestamp, hash: assinatura.hash, cpf: assinatura.cpf }
    : { concluido: false };

  return {
    nomeCompleto: c.nomeCompleto,
    cpf: c.cpf,
    email: c.email,
    whatsapp: c.whatsapp,
    genero: c.genero,
    cep: c.cep,
    logradouro: c.logradouro,
    bairro: c.bairro,
    numero: c.numero,
    complemento: c.complemento,
    dataNascimento: c.dataNascimento,
    status: c.status,
    statusRotulo: ROTULO_STATUS_CSV[c.status] || c.status || '',
    criadoEm: c.criadoEm,
    atualizadoEm: c.atualizadoEm,
    bancoTalentos: !!c.bancoTalentos,
    documentos,
    auditoriaLgpd: {
      consentimentoFicha: c.consentimentoFichaLGPD,
      consentimentoContrato: c.consentimentoContratoLGPD
    },
    aceiteContratual,
    integracaoPonto: c.integracaoPonto
  };
}

// ---------------------------------------------------------------------------
// ROTA: API v1 - lista/filtra admissões para integração com sistemas externos
// ---------------------------------------------------------------------------
app.get('/api/v1/admissoes', exigirApiKeyAdmissoes, async (req, res) => {
  try {
  const statusQuery = req.query.status;
  let candidatos = await lerCandidatos();
  let filtroAplicado = null;

  if (statusQuery) {
    const codigo = resolverCodigoStatus(statusQuery);
    if (!codigo) {
      return res.status(400).json({
        erro: 'Status inválido. Use um dos: EM_ANALISE, PENDENTE_ASSINATURA, CONTRATACAO_CONCLUIDA, REPROVADO (ou seu rótulo em português).'
      });
    }
    filtroAplicado = codigo;
    candidatos = candidatos.filter((c) => c.status === codigo);
  }

  const admissoes = candidatos.map(montarRegistroApiAdmissao);

  return res.status(200).json({ total: admissoes.length, filtro: filtroAplicado, admissoes });
  } catch (erro) {
    console.error('Falha ao listar admissões (API v1):', erro.message);
    return res.status(500).json({ erro: 'Falha ao listar admissões.' });
  }
});

function situacaoDocumentoPdf(candidato, tipo, documento) {
  if (documento.arquivo) return 'Enviado';
  if (tipo === 'reservista' && candidato.genero !== 'Masculino') return 'Não exigido';
  if (tipo === 'cpf' && candidato.cpfInclusoNaIdentidade) return 'Não exigido (incluso na Identidade)';
  return 'Pendente';
}

// Trilha de auditoria (LGPD) de uma ficha: eventos do candidato e do RH sobre ela.
app.get('/api/rh/fichas/:id/auditoria', exigirRh, async (req, res) => {
  try {
    const candidatos = await lerCandidatos();
    const candidato = candidatos.find((c) => c.id === req.params.id);
    if (!candidato) return res.status(404).json({ erro: 'Candidato não encontrado.' });
    return res.status(200).json({ eventos: await lerAuditoriaDaFicha(candidato) });
  } catch (erro) {
    console.error('Falha ao consultar a auditoria:', erro.message);
    return res.status(500).json({ erro: 'Falha ao consultar a trilha de auditoria.' });
  }
});

app.get('/api/rh/fichas/:id/pdf', exigirRh, async (req, res) => {
  const { id } = req.params;
  let candidatos;
  try {
    candidatos = await lerCandidatos();
  } catch (erro) {
    console.error('Falha ao buscar candidato para PDF da ficha:', erro.message);
    return res.status(500).json({ erro: 'Falha ao buscar o candidato.' });
  }
  const candidato = candidatos.find((c) => c.id === id);

  if (!candidato) return res.status(404).json({ erro: 'Candidato não encontrado.' });
  // A ficha só pode ser impressa/gerada em PDF depois que todo o trâmite de
  // contratação estiver definitivamente vigente (status terminal).
  if (candidato.status !== 'CONTRATACAO_CONCLUIDA') {
    return res.status(400).json({ erro: 'A ficha só pode ser impressa depois que a contratação for concluída.' });
  }

  const nomeArquivo = `ficha-${candidato.id}.pdf`;

  const doc = new PDFDocument({ margin: 50, size: 'A4' });
  const pronto = pdfParaBuffer(doc);

  const endereco = [candidato.logradouro, candidato.numero, candidato.complemento, candidato.bairro, candidato.cep]
    .filter(Boolean).join(', ');
  const decisaoTexto = candidato.decisaoFinal
    ? `${candidato.decisaoFinal} em ${formatarDataBr(candidato.decisaoFinalEm)}`
    : 'Ainda não decidida';

  doc.fontSize(18).font('Helvetica-Bold').fillColor('#1a252f')
    .text(`Ficha de Admissão - ${candidato.nomeCompleto}`, { underline: false });
  doc.moveDown(1);

  doc.fontSize(13).font('Helvetica-Bold').fillColor('#00A335').text('Dados Pessoais');
  doc.moveDown(0.3);
  doc.fontSize(10).font('Helvetica').fillColor('#000000');

  const campo = (rotulo, valor) => doc.font('Helvetica-Bold').text(`${rotulo}: `, { continued: true }).font('Helvetica').text(valor || '-');
  campo('Nome Completo', candidato.nomeCompleto);
  campo('CPF', candidato.cpf);
  campo('Data de Nascimento', candidato.dataNascimento);
  campo('Gênero', candidato.genero);
  campo('E-mail', candidato.email);
  campo('WhatsApp/Telefone', candidato.whatsapp);
  campo('Endereço', endereco);
  campo('Decisão Final', decisaoTexto);
  campo('Data de Submissão', formatarDataBr(candidato.criadoEm));

  doc.moveDown(1);
  doc.fontSize(13).font('Helvetica-Bold').fillColor('#00A335').text('Documentos');
  doc.moveDown(0.3);
  doc.fontSize(10).font('Helvetica').fillColor('#000000');

  TIPOS_DOCUMENTO.forEach((tipo) => {
    const documento = candidato.documentos[tipo] || {};
    const situacao = situacaoDocumentoPdf(candidato, tipo, documento);
    doc.font('Helvetica-Bold').text(`${TITULOS_DOCUMENTO[tipo]}: `, { continued: true }).font('Helvetica').text(situacao);
  });

  doc.moveDown(1);
  doc.fontSize(11).font('Helvetica-Bold').fillColor('#1a252f').text('Declaração de Consentimento (LGPD)');
  doc.moveDown(0.2);
  doc.fontSize(9).font('Helvetica').fillColor('#333333').text(
    `Ao submeter esta ficha em ${formatarDataBr(candidato.criadoEm)}, o(a) candidato(a) ${candidato.nomeCompleto} ` +
    'declarou estar ciente e de acordo com a coleta, o armazenamento e o tratamento dos seus dados pessoais e ' +
    'documentos para fins exclusivos deste processo seletivo, nos termos da Lei Geral de Proteção de Dados ' +
    'Pessoais (Lei nº 13.709/2018 - LGPD).',
    { align: 'justify' }
  );

  doc.moveDown(1.5);
  doc.fontSize(8).font('Helvetica').fillColor('#666666')
    .text(`Documento gerado pelo Painel do RH em ${formatarDataBr(new Date().toISOString())}.`);

  doc.end();

  try {
    await armazenamento.salvar(nomeArquivo, await pronto);
    return res.status(200).json({ mensagem: 'PDF gerado com sucesso!', arquivo: 'uploads/' + nomeArquivo });
  } catch (erro) {
    console.error('Falha ao gerar PDF da ficha:', erro.message);
    return res.status(500).json({ erro: 'Falha ao gerar o PDF da ficha.' });
  }
});

// ---------------------------------------------------------------------------
// MÓDULO DE ACEITE VIRTUAL DE CONTRATOS POR CLIQUE (ASSINATURA ELETRÔNICA
// SIMPLES) - lista de documentos/contratos que o candidato aprovado precisa
// ler e aceitar individualmente (um clique = um aceite), antes de concluir a
// assinatura digital unificada.
// ---------------------------------------------------------------------------

const CONTRATOS_DOCUMENTOS = [
  { tipo: 'contratoTrabalho', titulo: 'Contrato de Trabalho (CLT)' },
  { tipo: 'termoConfidencialidade', titulo: 'Termo de Confidencialidade' },
  { tipo: 'politicaPrivacidade', titulo: 'Política de Privacidade e Tratamento de Dados (LGPD)' }
];
const TIPOS_CONTRATO = CONTRATOS_DOCUMENTOS.map((d) => d.tipo);

// Estrutura inicial do módulo de contratação: um estado de aceite por
// documento (null até o clique, com o PDF assinado gerado no aceite) + a
// assinatura digital unificada (só existe depois que TODOS os documentos
// acima estiverem aceitos) + a validação do RH.
function criarContratoInicial() {
  const documentos = {};
  TIPOS_CONTRATO.forEach((tipo) => { documentos[tipo] = { aceite: null, arquivoAssinado: null }; });
  return { documentos, assinaturaConcluida: null, validacaoRh: null };
}

function nomeArquivoMinuta(tipo) {
  return `minuta-${tipo}.pdf`;
}

function caminhoMinuta(tipo) {
  return path.join(PASTA_UPLOADS, nomeArquivoMinuta(tipo));
}

// Gera, uma única vez por tipo (se ainda não existir em disco), a minuta
// padrão de cada documento como PDF de exemplo - texto simples, suficiente
// para abrir corretamente no visualizador de PDF do navegador. Em um
// cenário real, estes arquivos seriam fornecidos pelo time Jurídico/RH.
function garantirMinutaContrato(tipo, titulo) {
  const caminho = caminhoMinuta(tipo);
  if (fs.existsSync(caminho)) return;
  const tituloEscapado = titulo.replace(/[()\\]/g, '');
  const conteudo = `%PDF-1.4
1 0 obj
<< /Type /Catalog /Pages 2 0 R >>
endobj
2 0 obj
<< /Type /Pages /Kids [3 0 R] /Count 1 >>
endobj
3 0 obj
<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>
endobj
4 0 obj
<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>
endobj
5 0 obj
<< /Length 220 >>
stream
BT /F1 14 Tf 50 780 Td (MINUTA - ${tituloEscapado}) Tj ET
BT /F1 10 Tf 50 750 Td (Documento de exemplo - ${marca.nomeParaPdf(MARCA.nome)}) Tj ET
BT /F1 10 Tf 50 730 Td (Substitua por um modelo real fornecido pelo Juridico/RH.) Tj ET
endstream
endobj
trailer
<< /Size 6 /Root 1 0 R >>
%%EOF`;
  fs.writeFileSync(caminho, conteudo);
}

function garantirMinutasContrato() {
  CONTRATOS_DOCUMENTOS.forEach((doc) => garantirMinutaContrato(doc.tipo, doc.titulo));
}

// Hash SHA-256 do conteúdo exato de todas as minutas, na ordem fixa de
// CONTRATOS_DOCUMENTOS - evidência de integridade de qual versão dos
// documentos foi efetivamente aceita no momento da assinatura digital.
function calcularHashDocumentosContrato() {
  const hash = crypto.createHash('sha256');
  CONTRATOS_DOCUMENTOS.forEach((doc) => {
    hash.update(fs.readFileSync(caminhoMinuta(doc.tipo)));
  });
  return hash.digest('hex');
}

// Nome/caminho do PDF assinado de UM documento de UM candidato (gerado no
// momento do aceite - distinto da minuta genérica, que é a mesma para todos).
function nomeArquivoContratoAssinado(candidatoId, tipo) {
  return `contrato-${tipo}-${candidatoId}-assinado.pdf`;
}

// Gera (ou regenera, se o aceite for refeito) o PDF assinado de um documento
// do contrato: reproduz o texto da minuta e acrescenta um carimbo visível de
// assinatura eletrônica (nome, CPF, data/hora, IP e quem confirmou), para que
// o documento aberto pelo candidato ou pelo RH mostre claramente que aquele
// exemplar específico foi assinado - não é só um registro no banco de dados.
function gerarDocumentoContratoAssinado(candidato, tipo, titulo, aceite) {
  const nomeArquivo = nomeArquivoContratoAssinado(candidato.id, tipo);

  const doc = new PDFDocument({ margin: 50, size: 'A4' });
  const conteudoPronto = pdfParaBuffer(doc);
  const prontoQuandoGravado = conteudoPronto
    .then((buffer) => armazenamento.salvar(nomeArquivo, buffer))
    .then(() => nomeArquivo);

  doc.fontSize(16).font('Helvetica-Bold').fillColor('#1a252f').text(titulo);
  doc.moveDown(1);
  doc.fontSize(10).font('Helvetica').fillColor('#333333').text(
    `Documento de exemplo - ${MARCA.nome}. Em um cenário real, este seria o ` +
    'texto integral do documento fornecido pelo time Jurídico/RH.'
  );
  doc.moveDown(2);

  const alturaCarimbo = 140;
  const yCarimbo = doc.y;
  doc.save();
  doc.rect(50, yCarimbo, doc.page.width - 100, alturaCarimbo).fillAndStroke('#eafaef', '#00A335');
  doc.restore();

  doc.fontSize(12).font('Helvetica-Bold').fillColor('#00812a')
    .text('✓ ASSINADO ELETRONICAMENTE', 60, yCarimbo + 10);
  doc.fontSize(9).font('Helvetica').fillColor('#1a252f');
  doc.text(`Assinado por: ${candidato.nomeCompleto} (CPF ${candidato.cpf})`, 60, yCarimbo + 32);
  doc.text(`Data/Hora: ${formatarDataBr(aceite.timestamp)}`, 60, yCarimbo + 47);
  doc.text(`IP de origem: ${aceite.ip || '-'}`, 60, yCarimbo + 62);
  doc.text(`Confirmado por: ${aceite.por === 'RH' ? 'RH (em nome do candidato)' : 'Candidato'}`, 60, yCarimbo + 77);
  if (aceite.hash) doc.text(`Hash (SHA-256): ${aceite.hash}`, 60, yCarimbo + 92, { width: doc.page.width - 120 });
  doc.text(
    'Assinatura eletrônica válida nos termos da MP nº 2.200-2/2001 e da Lei nº 14.063/2020.',
    60, yCarimbo + 118
  );

  doc.end();
  return prontoQuandoGravado;
}

// Download da minuta de um documento/contrato específico.
app.get('/api/contrato/minuta/:tipo', (req, res) => {
  const { tipo } = req.params;
  if (!TIPOS_CONTRATO.includes(tipo)) {
    return res.status(400).json({ erro: 'Documento de contrato inválido.' });
  }
  garantirMinutaContrato(tipo, CONTRATOS_DOCUMENTOS.find((d) => d.tipo === tipo).titulo);
  // Inline (não attachment): abre direto no visualizador de PDF da nova aba.
  res.setHeader('Content-Disposition', `inline; filename="${nomeArquivoMinuta(tipo)}"`);
  return res.type('application/pdf').send(fs.readFileSync(caminhoMinuta(tipo)));
});

// O candidato clica em "Li e Aceito os Termos" para UM documento (aceite por
// clique = assinatura eletrônica simples). Só é permitido para fichas já
// APROVADAS pelo RH. Grava timestamp (ISO) e IP no documento e na auditoria.
app.post('/api/candidato/:id/contrato/:tipo/aceite', autenticar, async (req, res) => {
  try {
  const { id, tipo } = req.params;
  if (!TIPOS_CONTRATO.includes(tipo)) {
    return res.status(400).json({ erro: 'Documento de contrato inválido.' });
  }

  const candidatos = await lerCandidatos();
  const candidato = candidatos.find((c) => c.id === id);

  if (!candidato) return res.status(404).json({ erro: 'Candidato não encontrado.' });
  // Assinatura é ato pessoal: só a conta dona da ficha aceita (nem o RH).
  if (!usuarioEhDonoDaFicha(req.usuario, candidato)) {
    return res.status(403).json({ erro: ERRO_FICHA_DE_OUTRA_CONTA });
  }
  if (candidato.status !== 'PENDENTE_ASSINATURA') {
    return res.status(400).json({ erro: 'O aceite dos documentos só está disponível para fichas aprovadas e ainda não contratadas.' });
  }

  const agora = new Date().toISOString();
  const titulo = CONTRATOS_DOCUMENTOS.find((d) => d.tipo === tipo).titulo;
  garantirMinutaContrato(tipo, titulo);
  // Hash SHA-256 da assinatura: amarra o conteúdo exato da minuta aceita ao
  // candidato (id + CPF), ao instante e ao IP do aceite.
  const hash = crypto.createHash('sha256')
    .update(fs.readFileSync(caminhoMinuta(tipo)))
    .update(`|${tipo}|${candidato.id}|${candidato.cpf}|${agora}|${req.ip}`)
    .digest('hex');
  const aceite = { timestamp: agora, ip: req.ip, por: 'CANDIDATO', hash };
  const arquivoAssinado = await gerarDocumentoContratoAssinado(candidato, tipo, titulo, aceite);

  candidato.contrato.documentos[tipo].aceite = aceite;
  candidato.contrato.documentos[tipo].arquivoAssinado = 'uploads/' + arquivoAssinado;
  candidato.atualizadoEm = agora;
  await salvarCandidatos(candidatos);

  await registrarEventoAuditoria({
    id: gerarId(),
    tipoEvento: 'aceite_documento_contrato',
    candidatoId: id,
    documentoTipo: tipo,
    por: 'CANDIDATO',
    timestamp: agora,
    ip: req.ip
  });

  return res.status(200).json({ mensagem: 'Documento aceito com sucesso!', candidato });
  } catch (erro) {
    console.error('Falha ao registrar aceite do documento:', erro.message);
    return res.status(500).json({ erro: 'Falha ao registrar o aceite do documento.' });
  }
});

// O aceite dos documentos do contrato é ato do próprio candidato: o RH não
// pode assinar em nome dele. A rota segue existindo só para recusar com clareza.
app.patch('/api/rh/fichas/:id/contrato/:tipo/aceitar', exigirRh, (req, res) => {
  return res.status(403).json({ erro: 'O aceite dos documentos do contrato só pode ser feito pelo próprio candidato.' });
});

// Conclusão unificada da assinatura digital: só é permitida quando TODOS os
// documentos da lista já foram aceitos individualmente. Grava o log de
// auditoria completo (IP, timestamp ISO, CPF do candidato e hash SHA-256 do
// conteúdo exato das minutas aceitas).
// Base legal citada no log de assinatura eletrônica simples (Momento 3 da
// jornada): validade da assinatura eletrônica (MP nº 2.200-2/2001 e Lei nº
// 14.063/2020) e a base legal do tratamento dos metadados (LGPD, Art. 7º).
const BASE_LEGAL_ASSINATURA_DIGITAL = 'MP nº 2.200-2/2001; Lei nº 14.063/2020; LGPD Art. 7º, II e V';

app.post('/api/candidato/:id/contrato/concluir', autenticar, async (req, res) => {
  try {
  const { id } = req.params;
  const { consentimentoContratoLGPD } = req.body;
  const candidatos = await lerCandidatos();
  const candidato = candidatos.find((c) => c.id === id);

  if (!candidato) return res.status(404).json({ erro: 'Candidato não encontrado.' });
  // Assinatura é ato pessoal: só a conta dona da ficha conclui (nem o RH).
  if (!usuarioEhDonoDaFicha(req.usuario, candidato)) {
    return res.status(403).json({ erro: ERRO_FICHA_DE_OUTRA_CONTA });
  }
  if (candidato.status !== 'PENDENTE_ASSINATURA') {
    return res.status(400).json({ erro: 'A assinatura digital só está disponível para fichas aprovadas e ainda não contratadas.' });
  }

  const pendentes = TIPOS_CONTRATO.filter((tipo) => !candidato.contrato.documentos[tipo].aceite);
  if (pendentes.length) {
    return res.status(400).json({ erro: 'Confirme o aceite de todos os documentos antes de concluir a assinatura digital.' });
  }
  if (consentimentoContratoLGPD !== true) {
    return res.status(400).json({ erro: 'É necessário declarar ciência sobre a assinatura eletrônica (IP, timestamp e hash) para concluir.' });
  }

  garantirMinutasContrato();
  const agora = new Date().toISOString();
  const hash = calcularHashDocumentosContrato();

  candidato.contrato.assinaturaConcluida = { timestamp: agora, ip: req.ip, cpf: candidato.cpf, hash };
  // Consentimento específico da assinatura eletrônica do contrato (Momento 3
  // da jornada) - registrado separadamente do consentimento da ficha (Momento
  // 2), com o hash e a base legal citada ao candidato no momento do aceite.
  candidato.consentimentoContratoLGPD = {
    aceito: true,
    dataHora: agora,
    ip: req.ip,
    hashDocumentos: hash,
    baseLegal: BASE_LEGAL_ASSINATURA_DIGITAL
  };
  candidato.atualizadoEm = agora;
  await salvarCandidatos(candidatos);

  await registrarEventoAuditoria({
    id: gerarId(),
    tipoEvento: 'assinatura_digital_concluida',
    candidatoId: id,
    cpf: candidato.cpf,
    hashDocumentos: hash,
    baseLegal: BASE_LEGAL_ASSINATURA_DIGITAL,
    timestamp: agora,
    ip: req.ip
  });

  return res.status(200).json({ mensagem: 'Assinatura digital concluída com sucesso!', candidato });
  } catch (erro) {
    console.error('Falha ao concluir assinatura digital:', erro.message);
    return res.status(500).json({ erro: 'Falha ao concluir a assinatura digital.' });
  }
});

// RH finaliza o processo: exige a assinatura digital unificada já concluída
// pelo candidato, e move o status geral da ficha para o estado terminal.
app.patch('/api/rh/fichas/:id/contrato/validar', exigirRh, async (req, res) => {
  try {
  const { id } = req.params;
  const candidatos = await lerCandidatos();
  const candidato = candidatos.find((c) => c.id === id);

  if (!candidato) return res.status(404).json({ erro: 'Candidato não encontrado.' });
  if (candidato.status !== 'PENDENTE_ASSINATURA') {
    return res.status(400).json({ erro: 'Só é possível validar a contratação de uma ficha aprovada.' });
  }
  if (!candidato.contrato.assinaturaConcluida) {
    return res.status(400).json({ erro: 'Aguardando a conclusão da assinatura digital pelo candidato.' });
  }
  if (TIPOS_CONTRATO.some((tipo) => !candidato.contrato.documentos[tipo]?.aceite)) {
    return res.status(400).json({ erro: 'Todos os documentos do contrato precisam ter sido aceitos pelo candidato.' });
  }

  const agora = new Date().toISOString();
  candidato.contrato.validacaoRh = { timestamp: agora, ip: req.ip, validadoPor: req.usuario.id };
  candidato.status = 'CONTRATACAO_CONCLUIDA';
  candidato.atualizadoEm = agora;
  await salvarCandidatos(candidatos);

  await registrarEventoAuditoria({
    id: gerarId(),
    tipoEvento: 'contratacao_concluida',
    candidatoId: id,
    timestamp: agora,
    ip: req.ip
  });

  return res.status(200).json({ mensagem: 'Contratação concluída com sucesso!', candidato });
  } catch (erro) {
    console.error('Falha ao validar contratação:', erro.message);
    return res.status(500).json({ erro: 'Falha ao validar a contratação.' });
  }
});

// ---------------------------------------------------------------------------
// RECUPERAÇÃO / DEFINIÇÃO DE SENHA (link por e-mail + senha temporária)
// O e-mail leva um link com token e uma senha temporária; para trocar a senha
// é preciso o token E a senha temporária. Só os hashes ficam no banco
// (tabela recuperacoes_senha). Contas novas criadas pelo master/admin usam o
// mesmo mecanismo para definir a primeira senha.
// ---------------------------------------------------------------------------
const VALIDADE_RECUPERACAO_MS = 30 * 60 * 1000;
const MAX_TENTATIVAS_SENHA_TEMPORARIA = 5;
const ALFABETO_SENHA_TEMPORARIA = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';

function gerarSenhaTemporaria() {
  let s = '';
  for (let i = 0; i < 10; i += 1) s += ALFABETO_SENHA_TEMPORARIA[crypto.randomInt(ALFABETO_SENHA_TEMPORARIA.length)];
  return s;
}

// Endereço base usado nos links dos e-mails. APP_URL é o recomendado; sem ele,
// usa o Host da requisição apenas se tiver formato de domínio válido.
function urlBase(req) {
  const configurada = String(process.env.APP_URL || '').trim().replace(/\/+$/, '');
  if (configurada) return configurada;
  const host = String(req.get('host') || '');
  return /^[a-z0-9.-]+(:\d{1,5})?$/i.test(host) ? `${req.protocol}://${host}` : `http://localhost:${PORTA}`;
}

// Cria um pedido de redefinição para o usuário e invalida os anteriores.
async function criarPedidoRecuperacao(usuario, finalidade) {
  await repo.invalidarRecuperacoesDoUsuario(usuario.id);
  const token = crypto.randomBytes(32).toString('hex');
  const senhaTemporaria = gerarSenhaTemporaria();
  const agora = Date.now();
  await repo.inserirRecuperacao({
    id: gerarId(),
    usuario_id: usuario.id,
    token_hash: hashToken(token),
    senha_temp_hash: bcrypt.hashSync(senhaTemporaria, 10),
    finalidade,
    tentativas: 0,
    usado: false,
    criado_em: agora,
    expira_em: agora + VALIDADE_RECUPERACAO_MS
  });
  return { token, senhaTemporaria };
}

// Envia o e-mail do pedido. Em desenvolvimento (fora de produção) devolve o
// link e a senha temporária para a tela de teste; em produção nunca.
async function enviarPedidoRecuperacao(req, usuario, pedido, finalidade) {
  const link = `${urlBase(req)}/recuperar-senha.html?token=${pedido.token}`;
  const minutos = Math.round(VALIDADE_RECUPERACAO_MS / 60000);
  const abertura = finalidade === 'definicao'
    ? `Olá, ${usuario.nome}. Foi criado um acesso para você ao ${MARCA.nome}. Para definir a sua senha:`
    : `Olá, ${usuario.nome}. Recebemos um pedido para redefinir a sua senha. Para continuar:`;
  const texto = [
    abertura, '',
    `1. Abra o link: ${link}`,
    `2. Informe a senha temporária: ${pedido.senhaTemporaria}`,
    '3. Escolha a nova senha e confirme.', '',
    `O link e a senha temporária valem por ${minutos} minutos. Se você não pediu isto, ignore este e-mail: nada será alterado.`
  ].join('\n');
  const resultado = await enviarEmail({
    para: usuario.email,
    assunto: finalidade === 'definicao' ? `Defina a sua senha - ${MARCA.nome}` : `Redefinição de senha - ${MARCA.nome}`,
    texto
  });
  const teste = EXIBIR_LINK_ATIVACAO
    ? { linkRecuperacao: `/recuperar-senha.html?token=${pedido.token}`, senhaTemporaria: pedido.senhaTemporaria }
    : {};
  return { emailEnviado: resultado.enviado, emailSimulado: resultado.simulado, ...teste };
}

const limiteRecuperacao = criarLimitador({ nome: 'limiteRecuperacao',
  janelaMs: HORA_MS, max: limiteDoAmbiente('LIMITE_RECUPERACOES_HORA', 5),
  chave: (req) => `rec|${req.ip}|${String((req.body || {}).email || '').trim().toLowerCase()}`,
  mensagem: 'Muitos pedidos de recuperação de senha. Tente novamente mais tarde.'
});
const limiteRecuperacaoIp = criarLimitador({ nome: 'limiteRecuperacaoIp',
  janelaMs: HORA_MS, max: limiteDoAmbiente('LIMITE_RECUPERACOES_IP_HORA', 20), chave: porIp,
  mensagem: 'Muitos pedidos de recuperação de senha. Tente novamente mais tarde.'
});
const limiteRedefinicao = criarLimitador({ nome: 'limiteRedefinicao',
  janelaMs: 15 * 60 * 1000, max: limiteDoAmbiente('LIMITE_REDEFINICOES_15MIN', 15), chave: porIp,
  mensagem: 'Muitas tentativas. Aguarde alguns minutos.'
});

const MENSAGEM_RECUPERACAO = 'Se o e-mail estiver cadastrado, enviamos um link de recuperação e uma senha temporária. Verifique a caixa de entrada.';

app.post('/api/auth/recuperar-senha', limiteRecuperacaoIp, limiteRecuperacao, async (req, res) => {
  try {
    const email = String((req.body || {}).email || '').trim().toLowerCase();
    if (!REGEX_EMAIL_AUTH.test(email) || email.length > 254) {
      return res.status(400).json({ erro: 'Informe um e-mail válido.' });
    }

    const linha = await repo.buscarUsuarioPorEmail(email);
    const usuario = linha ? usuarioParaCamelCase(linha) : null;

    // Resposta idêntica exista a conta ou não (não revela quais e-mails têm cadastro).
    // A conta master não usa este fluxo: a senha dela vem do ambiente do servidor.
    let extra = {};
    if (usuario && usuario.ativo !== false && usuario.tipo !== 'master') {
      const pedido = await criarPedidoRecuperacao(usuario, 'recuperacao');
      extra = await enviarPedidoRecuperacao(req, usuario, pedido, 'recuperacao');
      await registrarEventoAuditoria({
        id: gerarId(), tipoEvento: 'recuperacao_senha_solicitada', usuarioId: usuario.id,
        timestamp: new Date().toISOString(), ip: req.ip
      });
    } else {
      await new Promise((r) => setTimeout(r, 120)); // iguala o tempo aproximado de resposta
    }
    return res.status(200).json({ mensagem: MENSAGEM_RECUPERACAO, ...(EXIBIR_LINK_ATIVACAO ? extra : {}) });
  } catch (erro) {
    console.error('Falha ao solicitar recuperação de senha:', erro.message);
    return res.status(500).json({ erro: 'Não foi possível processar o pedido agora. Tente novamente em instantes.' });
  }
});

app.post('/api/auth/redefinir-senha', limiteRedefinicao, async (req, res) => {
  try {
    const { token, senhaTemporaria, novaSenha, confirmarSenha } = req.body || {};
    const invalido = () => res.status(400).json({ erro: 'Link inválido ou expirado, ou senha temporária incorreta.' });
    if (!token || !senhaTemporaria) return invalido();

    const pedido = await repo.buscarRecuperacaoPorHash(hashToken(token));
    if (!pedido || pedido.usado || Number(pedido.expira_em) <= Date.now() || pedido.tentativas >= MAX_TENTATIVAS_SENHA_TEMPORARIA) {
      return invalido();
    }

    if (!bcrypt.compareSync(String(senhaTemporaria), pedido.senha_temp_hash)) {
      await repo.atualizarRecuperacao(pedido.id, { tentativas: pedido.tentativas + 1 });
      return invalido();
    }

    const erroSenha = erroSenhaFraca(novaSenha);
    if (erroSenha) return res.status(400).json({ erro: erroSenha });
    if (novaSenha !== confirmarSenha) return res.status(400).json({ erro: 'A confirmação de senha não confere com a nova senha.' });

    const usuario = await buscarUsuarioPorId(pedido.usuario_id);
    if (!usuario || usuario.ativo === false || usuario.tipo === 'master') return invalido();

    const { salt, hash } = gerarHashSenha(String(novaSenha));
    await repo.atualizarUsuario(usuario.id, { senha_salt: salt, senha_hash: hash });
    await repo.atualizarRecuperacao(pedido.id, { usado: true });
    // Troca de senha encerra todas as sessões abertas dessa conta.
    await repo.removerSessoesDoUsuario(usuario.id);

    await registrarEventoAuditoria({
      id: gerarId(), tipoEvento: 'senha_redefinida', usuarioId: usuario.id, finalidade: pedido.finalidade,
      timestamp: new Date().toISOString(), ip: req.ip
    });
    return res.status(200).json({ mensagem: 'Senha alterada com sucesso. Entre com a nova senha.' });
  } catch (erro) {
    console.error('Falha ao redefinir senha:', erro.message);
    return res.status(500).json({ erro: 'Não foi possível alterar a senha agora. Tente novamente em instantes.' });
  }
});

// ---------------------------------------------------------------------------
// GESTÃO DE CONTAS: MASTER cria administradores (clientes); o ADMIN cria e
// gerencia os operadores do RH da própria empresa.
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// DIREITOS DO TITULAR (LGPD, art. 18): exportar os próprios dados, pedir
// exclusão (o RH/admin executa ou recusa com motivo) e política de retenção.
//
// "Excluir" aqui é ANONIMIZAR a ficha: os arquivos PDF e as mensagens são
// apagados, os dados pessoais da ficha são removidos e a conta de acesso é
// excluída; fica só o esqueleto sem identificação (id, status, datas) para
// estatística. Fichas de CONTRATADOS não são excluídas: a empresa tem
// obrigação legal de guarda (art. 16, I). A trilha de auditoria é mantida,
// porque é somente de acréscimo e cumpre obrigação legal.
// ---------------------------------------------------------------------------
// Envolve um handler: qualquer falha vira um 500 genérico (sem vazar detalhes).
const comTratamento = (fn) => async (req, res) => {
  try {
    return await fn(req, res);
  } catch (erro) {
    console.error('Falha na operação:', erro.message);
    return res.status(500).json({ erro: 'Não foi possível concluir a operação agora.' });
  }
};

const TEXTO_FICHA_ANONIMIZADA = 'Dados removidos a pedido do titular';
const RETENCAO_DIAS = limiteDoAmbiente('RETENCAO_DIAS', 365);

function motivoRetencaoLegal(candidato) {
  if (candidato.status === 'CONTRATACAO_CONCLUIDA') {
    return 'Candidato contratado: a empresa deve guardar os documentos admissionais por obrigação legal (LGPD, art. 16, I).';
  }
  return null;
}

// Apaga arquivos, mensagens e dados pessoais de uma ficha. Não exclui a conta.
async function anonimizarFicha(candidato, motivo, executorId) {
  const arquivos = new Set([`ficha-${candidato.id}.pdf`]);
  Object.values(candidato.documentos || {}).forEach((d) => { if (d && d.arquivo) arquivos.add(nomeDoArquivo(d.arquivo)); });
  Object.values((candidato.contrato && candidato.contrato.documentos) || {}).forEach((d) => { if (d && d.arquivoAssinado) arquivos.add(nomeDoArquivo(d.arquivoAssinado)); });
  for (const nome of arquivos) {
    try { await armazenamento.remover(nome); } catch (erro) { console.error('Falha ao remover arquivo na anonimização:', erro.message); }
  }

  await repo.excluirMensagensDaFicha(candidato.id);

  const documentosVazios = {};
  TIPOS_DOCUMENTO.forEach((tipo) => { documentosVazios[tipo] = { arquivo: null, status: 'VERMELHO', atualizadoEm: null, pendencia: null }; });
  const consentimento = candidato.consentimentoFichaLGPD
    ? { aceito: candidato.consentimentoFichaLGPD.aceito, dataHora: candidato.consentimentoFichaLGPD.dataHora, versaoTermo: candidato.consentimentoFichaLGPD.versaoTermo, finalidade: candidato.consentimentoFichaLGPD.finalidade }
    : null;
  const agora = new Date().toISOString();
  await repo.atualizarCandidato(candidato.id, {
    nome_completo: TEXTO_FICHA_ANONIMIZADA, cpf: null, email: null, whatsapp: null, genero: null, cep: null,
    logradouro: null, bairro: null, numero: null, complemento: null, data_nascimento: null,
    documentos: documentosVazios, contrato: criarContratoInicial(), integracao_ponto: criarIntegracaoPontoInicial(),
    ficha_pdf: null, usuario_id: null, tags: [], banco_talentos: false,
    consentimento_ficha_lgpd: consentimento, consentimento_contrato_lgpd: null,
    anonimizado_em: agora, atualizado_em: agora
  });

  await registrarEventoAuditoria({
    id: gerarId(), tipoEvento: 'ficha_anonimizada', candidatoId: candidato.id, motivo,
    executadoPor: executorId || null, timestamp: agora
  });
}

// Exclui a conta de acesso (sessões e pedidos de senha caem em cascata).
async function excluirConta(usuarioId, motivo, executorId) {
  await repo.excluirUsuario(usuarioId);
  await registrarEventoAuditoria({
    id: gerarId(), tipoEvento: 'conta_excluida', usuarioId, motivo,
    executadoPor: executorId || null, timestamp: new Date().toISOString()
  });
}

// Todos os dados que o sistema guarda sobre o titular (acesso e portabilidade).
async function montarExportacaoTitular(usuario) {
  const candidatos = (await lerCandidatos()).filter((c) => usuarioEhDonoDaFicha(usuario, c));
  const solic = await repo.listarSolicitacoesDoUsuario(usuario.id);
  const eventos = [];
  for (const c of candidatos) eventos.push(...await lerAuditoriaDaFicha(c, 500));
  return {
    geradoEm: new Date().toISOString(),
    titular: {
      nome: usuario.nome, email: usuario.email, cpf: usuario.cpf || null, dataNascimento: usuario.dataNascimento || null,
      papel: usuario.tipo, contaCriadaEm: usuario.criadoEm, consentimentoCadastro: usuario.consentimentoCadastro || null
    },
    fichas: candidatos.map((c) => ({
      id: c.id, status: c.status, criadoEm: c.criadoEm, atualizadoEm: c.atualizadoEm,
      dadosPessoais: {
        nomeCompleto: c.nomeCompleto, dataNascimento: c.dataNascimento, cpf: c.cpf, genero: c.genero, email: c.email,
        whatsapp: c.whatsapp, cep: c.cep, logradouro: c.logradouro, bairro: c.bairro, numero: c.numero, complemento: c.complemento
      },
      documentos: Object.entries(c.documentos || {}).map(([tipo, d]) => ({ tipo, enviado: !!(d && d.arquivo), status: d && d.status })),
      decisaoFinal: c.decisaoFinal || null,
      consentimentoFicha: c.consentimentoFichaLGPD || null,
      consentimentoContrato: c.consentimentoContratoLGPD || null,
      mensagens: (c.mensagens || []).map((m) => ({ autor: m.autor, texto: m.texto, enviadaEm: m.timestamp }))
    })),
    solicitacoes: solic.map((s) => ({ id: s.id, tipo: s.tipo, status: s.status, criadoEm: s.criado_em, resolvidoEm: s.resolvido_em, motivoRecusa: s.motivo_recusa })),
    registrosDeAcesso: eventos.map((e) => ({ evento: e.tipoEvento, ocorridoEm: e.ocorridoEm, ip: e.ip }))
  };
}

const limiteTitular = criarLimitador({ nome: 'limiteTitular',
  janelaMs: HORA_MS, max: limiteDoAmbiente('LIMITE_TITULAR_HORA', 10), chave: porUsuarioOuIp,
  mensagem: 'Muitos pedidos em pouco tempo. Tente novamente mais tarde.'
});

// --- Titular (conta logada) ---
app.get('/api/meus-dados/exportar', autenticar, limiteTitular, comTratamento(async (req, res) => {
  const dados = await montarExportacaoTitular(req.usuario);
  await registrarEventoAuditoria({ id: gerarId(), tipoEvento: 'dados_exportados', usuarioId: req.usuario.id, timestamp: new Date().toISOString(), ip: req.ip });
  res.set('Content-Disposition', 'attachment; filename="meus-dados.json"');
  return res.status(200).json(dados);
}));

app.get('/api/meus-dados/solicitacoes', autenticar, comTratamento(async (req, res) => {
  const data = await repo.listarSolicitacoesDoUsuario(req.usuario.id);
  return res.status(200).json(data.map((s) => ({ id: s.id, tipo: s.tipo, status: s.status, criadoEm: s.criado_em, resolvidoEm: s.resolvido_em, motivoRecusa: s.motivo_recusa })));
}));

app.post('/api/meus-dados/solicitar-exclusao', autenticar, limiteTitular, comTratamento(async (req, res) => {
  if (req.usuario.tipo !== 'candidato') return res.status(403).json({ erro: 'Este pedido é para contas de candidato.' });
  if ((req.body || {}).confirmar !== true) return res.status(400).json({ erro: 'Confirme o pedido de exclusão.' });

  const existentes = await repo.listarSolicitacoesDoUsuario(req.usuario.id, 'pendente');
  if (existentes.length) {
    return res.status(200).json({ mensagem: 'Você já tem um pedido de exclusão em análise.', solicitacaoId: existentes[0].id, jaExistia: true });
  }

  const fichas = (await lerCandidatos()).filter((c) => usuarioEhDonoDaFicha(req.usuario, c));
  const bloqueio = fichas.map(motivoRetencaoLegal).find(Boolean) || null;
  const nova = {
    id: gerarId(), usuario_id: req.usuario.id, candidato_id: fichas[0] ? fichas[0].id : null,
    tipo: 'exclusao', status: 'pendente', criado_em: new Date().toISOString()
  };
  await repo.inserirSolicitacao(nova);
  await registrarEventoAuditoria({ id: gerarId(), tipoEvento: 'exclusao_solicitada', usuarioId: req.usuario.id, candidatoId: nova.candidato_id, timestamp: nova.criado_em, ip: req.ip });
  return res.status(201).json({
    mensagem: 'Pedido de exclusão registrado. O RH da empresa vai analisá-lo.' + (bloqueio ? ' Atenção: ' + bloqueio : ''),
    solicitacaoId: nova.id, retencaoLegal: !!bloqueio
  });
}));

// --- RH / admin: analisar e executar pedidos ---
app.get('/api/rh/solicitacoes-titular', exigirRh, comTratamento(async (req, res) => {
  const data = await repo.listarSolicitacoes();
  const fichas = new Map((await lerCandidatos()).map((c) => [c.id, c]));
  const lista = data.sort((a, b) => String(b.criado_em).localeCompare(String(a.criado_em))).map((s) => {
    const ficha = s.candidato_id ? fichas.get(s.candidato_id) : null;
    return {
      id: s.id, status: s.status, criadoEm: s.criado_em, resolvidoEm: s.resolvido_em, motivoRecusa: s.motivo_recusa,
      candidatoId: s.candidato_id, nome: ficha ? ficha.nomeCompleto : null, statusFicha: ficha ? ficha.status : null,
      retencaoLegal: ficha ? motivoRetencaoLegal(ficha) : null
    };
  });
  return res.status(200).json(lista);
}));

async function carregarSolicitacaoPendente(id) {
  const data = await repo.buscarSolicitacao(id);
  return data && data.status === 'pendente' ? data : null;
}

app.post('/api/rh/solicitacoes-titular/:id/executar', exigirRh, comTratamento(async (req, res) => {
  const s = await carregarSolicitacaoPendente(req.params.id);
  if (!s) return res.status(404).json({ erro: 'Pedido não encontrado ou já resolvido.' });

  const todas = await lerCandidatos();
  const fichas = todas.filter((c) => c.usuarioId === s.usuario_id || c.id === s.candidato_id);
  const bloqueio = fichas.map(motivoRetencaoLegal).find(Boolean);
  if (bloqueio) return res.status(409).json({ erro: bloqueio + ' Recuse o pedido informando esse motivo.' });

  for (const ficha of fichas) await anonimizarFicha(ficha, 'solicitacao_do_titular', req.usuario.id);
  await excluirConta(s.usuario_id, 'solicitacao_do_titular', req.usuario.id);
  await repo.atualizarSolicitacao(s.id, {
    status: 'executada', resolvido_em: new Date().toISOString(), resolvido_por: req.usuario.id
  });
  return res.status(200).json({ mensagem: 'Dados do titular excluídos.', fichasAnonimizadas: fichas.length });
}));

app.post('/api/rh/solicitacoes-titular/:id/recusar', exigirRh, comTratamento(async (req, res) => {
  const motivo = String((req.body || {}).motivo || '').trim();
  if (motivo.length < 5 || motivo.length > 500) return res.status(400).json({ erro: 'Informe o motivo da recusa (5 a 500 caracteres).' });
  const s = await carregarSolicitacaoPendente(req.params.id);
  if (!s) return res.status(404).json({ erro: 'Pedido não encontrado ou já resolvido.' });
  await repo.atualizarSolicitacao(s.id, {
    status: 'recusada', motivo_recusa: motivo, resolvido_em: new Date().toISOString(), resolvido_por: req.usuario.id
  });
  await registrarEventoAuditoria({ id: gerarId(), tipoEvento: 'exclusao_recusada', usuarioId: s.usuario_id, candidatoId: s.candidato_id, motivo, executadoPor: req.usuario.id, timestamp: new Date().toISOString(), ip: req.ip });
  return res.status(200).json({ mensagem: 'Pedido recusado.' });
}));

// --- Retenção: fichas de NÃO contratados paradas há mais de RETENCAO_DIAS ---
function fichasForaDoPrazo(candidatos, diasMaximos) {
  const limite = Date.now() - diasMaximos * 24 * 60 * 60 * 1000;
  return candidatos.filter((c) =>
    !c.anonimizadoEm && !c.bancoTalentos &&
    ['REPROVADO', 'EM_ANALISE'].includes(c.status) &&
    new Date(c.atualizadoEm || c.criadoEm).getTime() < limite);
}

app.post('/api/admin/retencao', exigirAdmin, comTratamento(async (req, res) => {
  const simular = (req.body || {}).simular !== false;
  const dias = Number((req.body || {}).dias) > 0 ? Number(req.body.dias) : RETENCAO_DIAS;
  const todas = await lerCandidatos();
  const elegiveis = fichasForaDoPrazo(todas, dias);
  if (simular) {
    return res.status(200).json({ simulacao: true, dias, total: elegiveis.length, fichas: elegiveis.map((c) => ({ id: c.id, status: c.status, atualizadoEm: c.atualizadoEm })) });
  }
  const usuariosAfetados = new Set();
  for (const ficha of elegiveis) {
    await anonimizarFicha(ficha, 'retencao_vencida', req.usuario.id);
    if (ficha.usuarioId) usuariosAfetados.add(ficha.usuarioId);
  }
  // Exclui a conta quando todas as fichas dela foram anonimizadas.
  const idsAnonimizados = new Set(elegiveis.map((c) => c.id));
  let contasExcluidas = 0;
  for (const usuarioId of usuariosAfetados) {
    const restantes = todas.filter((c) => c.usuarioId === usuarioId && !idsAnonimizados.has(c.id) && !c.anonimizadoEm);
    if (!restantes.length) { await excluirConta(usuarioId, 'retencao_vencida', req.usuario.id); contasExcluidas += 1; }
  }
  return res.status(200).json({ simulacao: false, dias, fichasAnonimizadas: elegiveis.length, contasExcluidas });
}));

const limiteGestaoContas = criarLimitador({ nome: 'limiteGestaoContas',
  janelaMs: HORA_MS, max: limiteDoAmbiente('LIMITE_CONTAS_CRIADAS_HORA', 60), chave: porUsuarioOuIp,
  mensagem: 'Limite de contas criadas por hora atingido.'
});

function resumoConta(u) {
  return { id: u.id, nome: u.nome, email: u.email, tipo: u.tipo, ativo: u.ativo !== false, criadoEm: u.criadoEm };
}

// Cria uma conta (admin ou rh) sem senha utilizável: o titular define a senha
// pelo link enviado por e-mail.
async function criarContaEquipe(req, res, tipo) {
  const nome = String((req.body || {}).nome || '').trim();
  const email = String((req.body || {}).email || '').trim().toLowerCase();
  if (!nome || nome.length > 120) return res.status(400).json({ erro: 'Informe o nome (até 120 caracteres).' });
  if (!REGEX_EMAIL_AUTH.test(email) || email.length > 254) return res.status(400).json({ erro: 'E-mail inválido.' });

  const existente = await repo.buscarUsuarioPorEmail(email);
  if (existente) return res.status(409).json({ erro: 'Já existe uma conta com este e-mail.' });

  const { salt, hash } = gerarHashSenha(crypto.randomBytes(24).toString('hex'));
  const novo = {
    id: gerarId(), nome, email, senhaSalt: salt, senhaHash: hash, tipo, googleId: null,
    ativo: true, tokenAtivacao: null, criadoEm: new Date().toISOString()
  };
  await salvarUsuarios([novo]);

  const pedido = await criarPedidoRecuperacao(novo, 'definicao');
  const envio = await enviarPedidoRecuperacao(req, novo, pedido, 'definicao');
  await registrarEventoAuditoria({
    id: gerarId(), tipoEvento: 'conta_criada', usuarioId: novo.id, tipo, criadoPor: req.usuario.id,
    timestamp: new Date().toISOString(), ip: req.ip
  });
  return res.status(201).json({ conta: resumoConta(novo), ...envio });
}

async function listarContas(req, res, tipo) {
  const data = await repo.listarUsuariosPorTipo(tipo);
  return res.status(200).json(data.map(usuarioParaCamelCase).map(resumoConta));
}

async function alterarConta(req, res, tipo) {
  const conta = await buscarUsuarioPorId(req.params.id);
  if (!conta || conta.tipo !== tipo) return res.status(404).json({ erro: 'Conta não encontrada.' });
  if (conta.id === req.usuario.id) return res.status(400).json({ erro: 'Você não pode alterar a própria conta por aqui.' });

  const mudancas = {};
  const corpo = req.body || {};
  if (corpo.ativo !== undefined) {
    if (typeof corpo.ativo !== 'boolean') return res.status(400).json({ erro: 'O campo "ativo" deve ser verdadeiro ou falso.' });
    mudancas.ativo = corpo.ativo;
  }
  if (corpo.nome !== undefined) {
    const nome = String(corpo.nome).trim();
    if (!nome || nome.length > 120) return res.status(400).json({ erro: 'Nome inválido (até 120 caracteres).' });
    mudancas.nome = nome;
  }
  if (!Object.keys(mudancas).length) return res.status(400).json({ erro: 'Nada para alterar.' });

  await repo.atualizarUsuario(conta.id, mudancas);
  if (mudancas.ativo === false) await repo.removerSessoesDoUsuario(conta.id);

  await registrarEventoAuditoria({
    id: gerarId(), tipoEvento: 'conta_alterada', usuarioId: conta.id, alteracoes: Object.keys(mudancas),
    alteradoPor: req.usuario.id, timestamp: new Date().toISOString(), ip: req.ip
  });
  return res.status(200).json({ conta: resumoConta({ ...conta, ...mudancas }) });
}

async function reenviarAcesso(req, res, tipo) {
  const conta = await buscarUsuarioPorId(req.params.id);
  if (!conta || conta.tipo !== tipo) return res.status(404).json({ erro: 'Conta não encontrada.' });
  if (conta.ativo === false) return res.status(400).json({ erro: 'A conta está desativada.' });
  const pedido = await criarPedidoRecuperacao(conta, 'definicao');
  const envio = await enviarPedidoRecuperacao(req, conta, pedido, 'definicao');
  return res.status(200).json({ mensagem: 'Novo acesso enviado ao e-mail da conta.', ...envio });
}

// Master -> administradores (clientes)
app.get('/api/master/admins', exigirMaster, comTratamento((req, res) => listarContas(req, res, 'admin')));
app.post('/api/master/admins', exigirMaster, limiteGestaoContas, comTratamento((req, res) => criarContaEquipe(req, res, 'admin')));
app.patch('/api/master/admins/:id', exigirMaster, comTratamento((req, res) => alterarConta(req, res, 'admin')));
app.post('/api/master/admins/:id/reenviar-acesso', exigirMaster, limiteGestaoContas, comTratamento((req, res) => reenviarAcesso(req, res, 'admin')));

// Admin -> operadores do RH
app.get('/api/admin/operadores', exigirAdmin, comTratamento((req, res) => listarContas(req, res, 'rh')));
app.post('/api/admin/operadores', exigirAdmin, limiteGestaoContas, comTratamento((req, res) => criarContaEquipe(req, res, 'rh')));
app.patch('/api/admin/operadores/:id', exigirAdmin, comTratamento((req, res) => alterarConta(req, res, 'rh')));
app.post('/api/admin/operadores/:id/reenviar-acesso', exigirAdmin, limiteGestaoContas, comTratamento((req, res) => reenviarAcesso(req, res, 'rh')));

// ---------------------------------------------------------------------------
// VERIFICAÇÃO EM DUAS ETAPAS (MFA, TOTP) para rh, admin e master.
//   configurar -> mostra QR/segredo; ativar -> confirma com um código e libera
//   os códigos de recuperação (uma única vez); login -> desafio + verificar.
// O segredo TOTP fica cifrado (AES-256-GCM) e os códigos de recuperação só
// existem como hash. Quem perdeu o aplicativo e os códigos é resetado pelo
// admin (operadores) ou pelo master (administradores).
// ---------------------------------------------------------------------------
const limiteMfa = criarLimitador({ nome: 'limiteMfa',
  janelaMs: 15 * 60 * 1000, max: limiteDoAmbiente('LIMITE_MFA_15MIN', 30), chave: porUsuarioOuIp,
  mensagem: 'Muitas tentativas de verificação. Aguarde alguns minutos.'
});
const MAX_FALHAS_MFA = 5;

async function atualizarMfa(usuarioId, campos) {
  await repo.atualizarUsuario(usuarioId, campos);
}

const eventoMfa = (tipoEvento, usuario, req, extra) => registrarEventoAuditoria(Object.assign({
  id: gerarId(), tipoEvento, usuarioId: usuario.id, tipo: usuario.tipo, timestamp: new Date().toISOString(), ip: req.ip
}, extra || {}));

// Confere o código do aplicativo (6 dígitos) ou um código de recuperação
// (consumido na hora). { ok, via: 'totp' | 'recuperacao' }.
async function conferirSegundoFator(usuario, codigo) {
  const texto = String(codigo || '').trim();
  if (/^\d{3}\s?\d{3}$/.test(texto) && usuario.mfaSegredo) {
    const passo = mfa.verificarTotp(mfa.decifrar(usuario.mfaSegredo, materialMfa()), texto, usuario.mfaUltimoPasso);
    if (passo !== null) {
      await atualizarMfa(usuario.id, { mfa_ultimo_passo: passo });
      return { ok: true, via: 'totp' };
    }
    return { ok: false };
  }
  if (/^[0-9a-fA-F]{5}-?[0-9a-fA-F]{5}$/.test(texto)) {
    const hash = mfa.hashCodigo(texto);
    if (usuario.mfaCodigos.includes(hash)) {
      await atualizarMfa(usuario.id, { mfa_codigos: usuario.mfaCodigos.filter((x) => x !== hash) });
      return { ok: true, via: 'recuperacao', restantes: usuario.mfaCodigos.length - 1 };
    }
  }
  return { ok: false };
}

// Segunda etapa do login.
app.post('/api/auth/mfa/verificar', limiteMfa, comTratamento(async (req, res) => {
  const { desafio, codigo } = req.body || {};
  const usuarioId = mfa.lerDesafio(desafio, materialMfa());
  if (!usuarioId) return res.status(401).json({ erro: 'A verificação expirou. Entre novamente com e-mail e senha.' });

  const chave = `mfa|${usuarioId}`;
  if ((await falhasAtuais(chave)) >= MAX_FALHAS_MFA) {
    res.set('Retry-After', String(Math.ceil(JANELA_LOGIN_MS / 1000)));
    return res.status(429).json({ erro: 'Muitas tentativas. Aguarde alguns minutos e entre novamente.' });
  }
  const usuario = await buscarUsuarioPorId(usuarioId);
  if (!usuario || !usuario.mfaAtivo || usuario.ativo === false) {
    return res.status(401).json({ erro: 'A verificação expirou. Entre novamente com e-mail e senha.' });
  }

  const conferido = await conferirSegundoFator(usuario, codigo);
  if (!conferido.ok) {
    await registrarFalhaLogin(chave);
    await eventoMfa('mfa_falha', usuario, req);
    return res.status(401).json({ erro: 'Código inválido ou já utilizado.' });
  }
  await limparFalhas(chave);

  const token = await criarSessao(usuario.id);
  await eventoMfa('login', usuario, req, { email: usuario.email, mfa: conferido.via });
  if (conferido.via === 'recuperacao') await eventoMfa('mfa_codigo_recuperacao_usado', usuario, req, { restantes: conferido.restantes });
  const corpo = respostaLoginCompleto(usuario, token, 'Login realizado com sucesso!');
  if (conferido.via === 'recuperacao') corpo.codigosRestantes = conferido.restantes;
  return res.status(200).json(corpo);
}));

app.get('/api/auth/mfa/status', autenticar, (req, res) => {
  const u = req.usuario;
  return res.status(200).json({
    disponivel: u.tipo !== 'candidato', ativo: u.mfaAtivo, obrigatorio: MFA_OBRIGATORIO && u.tipo !== 'candidato',
    codigosRestantes: u.mfaAtivo ? u.mfaCodigos.length : 0
  });
});

app.post('/api/auth/mfa/configurar', autenticar, limiteMfa, comTratamento(async (req, res) => {
  const u = req.usuario;
  if (u.tipo === 'candidato') return res.status(403).json({ erro: 'A verificação em duas etapas é para a equipe de RH.' });
  if (u.mfaAtivo) return res.status(409).json({ erro: 'A verificação em duas etapas já está ativa. Desative antes de configurar de novo.' });
  const segredo = mfa.gerarSegredo();
  await atualizarMfa(u.id, { mfa_segredo: mfa.cifrar(segredo, materialMfa()), mfa_ativo: false, mfa_codigos: [], mfa_ultimo_passo: 0 });
  const uri = mfa.uriOtpauth(segredo, u.email, MARCA.nome);
  const qr = await QRCode.toDataURL(uri, { margin: 1, width: 220 });
  return res.status(200).json({ segredo, uri, qr });
}));

app.post('/api/auth/mfa/ativar', autenticar, limiteMfa, comTratamento(async (req, res) => {
  const u = req.usuario;
  if (u.tipo === 'candidato') return res.status(403).json({ erro: 'A verificação em duas etapas é para a equipe de RH.' });
  if (u.mfaAtivo) return res.status(409).json({ erro: 'A verificação em duas etapas já está ativa.' });
  if (!u.mfaSegredo) return res.status(400).json({ erro: 'Inicie a configuração antes de confirmar o código.' });

  const chave = `mfa-ativar|${u.id}`;
  if ((await falhasAtuais(chave)) >= MAX_FALHAS_MFA) return res.status(429).json({ erro: 'Muitas tentativas. Aguarde alguns minutos.' });
  const passo = mfa.verificarTotp(mfa.decifrar(u.mfaSegredo, materialMfa()), (req.body || {}).codigo, 0);
  if (passo === null) {
    await registrarFalhaLogin(chave);
    return res.status(400).json({ erro: 'Código inválido. Confira o horário do celular e tente com o código atual.' });
  }
  await limparFalhas(chave);

  const codigos = mfa.gerarCodigosRecuperacao(10);
  await atualizarMfa(u.id, { mfa_ativo: true, mfa_ultimo_passo: passo, mfa_codigos: codigos.map(mfa.hashCodigo) });
  await eventoMfa('mfa_ativado', u, req);
  return res.status(200).json({
    mensagem: 'Verificação em duas etapas ativada. Guarde os códigos de recuperação: eles não serão mostrados de novo.',
    codigosRecuperacao: codigos
  });
}));

app.post('/api/auth/mfa/desativar', autenticar, limiteMfa, comTratamento(async (req, res) => {
  const u = req.usuario;
  if (!u.mfaAtivo) return res.status(400).json({ erro: 'A verificação em duas etapas não está ativa.' });
  if (MFA_OBRIGATORIO) return res.status(403).json({ erro: 'Neste ambiente a verificação em duas etapas é obrigatória e não pode ser desativada.' });

  const chave = `mfa-desativar|${u.id}`;
  if ((await falhasAtuais(chave)) >= MAX_FALHAS_MFA) return res.status(429).json({ erro: 'Muitas tentativas. Aguarde alguns minutos.' });
  const corpo = req.body || {};
  const senhaOk = u.senhaHash ? senhaConfere(String(corpo.senha || ''), u.senhaSalt, u.senhaHash) : true;
  const conferido = senhaOk ? await conferirSegundoFator(u, corpo.codigo) : { ok: false };
  if (!senhaOk || !conferido.ok) {
    await registrarFalhaLogin(chave);
    return res.status(401).json({ erro: 'Senha ou código incorretos.' });
  }
  await limparFalhas(chave);

  await atualizarMfa(u.id, { mfa_ativo: false, mfa_segredo: null, mfa_codigos: [], mfa_ultimo_passo: 0 });
  await eventoMfa('mfa_desativado', u, req);
  return res.status(200).json({ mensagem: 'Verificação em duas etapas desativada.' });
}));

// Quem perdeu o aplicativo e os códigos: o admin reseta operadores; o master, administradores.
async function resetarMfaDaConta(req, res, tipo) {
  const conta = await buscarUsuarioPorId(req.params.id);
  if (!conta || conta.tipo !== tipo) return res.status(404).json({ erro: 'Conta não encontrada.' });
  if (conta.id === req.usuario.id) return res.status(400).json({ erro: 'Use a página de segurança para alterar a sua própria verificação.' });
  await atualizarMfa(conta.id, { mfa_ativo: false, mfa_segredo: null, mfa_codigos: [], mfa_ultimo_passo: 0 });
  await repo.removerSessoesDoUsuario(conta.id);
  await eventoMfa('mfa_resetado', conta, req, { executadoPor: req.usuario.id });
  return res.status(200).json({ mensagem: 'Verificação em duas etapas redefinida. A pessoa deve configurá-la de novo no próximo acesso.' });
}
app.post('/api/admin/operadores/:id/mfa/resetar', exigirAdmin, limiteGestaoContas, comTratamento((req, res) => resetarMfaDaConta(req, res, 'rh')));
app.post('/api/master/admins/:id/mfa/resetar', exigirMaster, limiteGestaoContas, comTratamento((req, res) => resetarMfaDaConta(req, res, 'admin')));

// Conta MASTER: semeada no boot a partir do ambiente do servidor (nunca do
// código nem do banco de testes). Sem MASTER_EMAIL e MASTER_SENHA, não existe.
async function garantirUsuarioMaster() {
  const email = String(process.env.MASTER_EMAIL || '').trim().toLowerCase();
  const senha = String(process.env.MASTER_SENHA || '');
  if (!email || !senha) return;
  if (!REGEX_EMAIL_AUTH.test(email) || senha.length < 12 || erroSenhaFraca(senha)) {
    console.error('MASTER_EMAIL/MASTER_SENHA inválidos (senha com 12+ caracteres, letras e números): conta master não criada.');
    return;
  }
  const usuarios = await lerUsuarios();
  const existente = usuarios.find((u) => u.email === email);
  if (existente && existente.tipo !== 'master') {
    console.error('MASTER_EMAIL já pertence a uma conta que não é master: conta master não criada.');
    return;
  }
  const { salt, hash } = gerarHashSenha(senha);
  if (existente) {
    // A senha do master é a do ambiente (fonte da verdade).
    if (!existente.senhaHash || !senhaConfere(senha, existente.senhaSalt, existente.senhaHash) || existente.ativo === false) {
      existente.senhaSalt = salt; existente.senhaHash = hash; existente.ativo = true;
      await salvarUsuarios(usuarios);
      console.log('--- Conta master atualizada a partir do ambiente ---');
    }
    return;
  }
  await salvarUsuarios([{
    id: gerarId(), nome: 'Administrador da Plataforma', email, senhaSalt: salt, senhaHash: hash,
    tipo: 'master', googleId: null, ativo: true, tokenAtivacao: null, criadoEm: new Date().toISOString()
  }]);
  console.log('--- Conta master criada a partir do ambiente ---');
}

// ---------------------------------------------------------------------------
// CONTA DE RH DE TESTES (MVP/Dev) - semeada de forma idempotente no boot,
// já que o formulário público de registro só cria contas 'candidato'.
// A senha padrão é pública de propósito (documentada no README.md), para que
// qualquer pessoa consiga testar a aplicação. Para usar outra senha, defina
// SENHA_RH_TESTE no ambiente (ver .env.example): nesse caso ela vale também
// para uma conta de RH já existente.
// ---------------------------------------------------------------------------
const EMAIL_RH_TESTE = 'rh@onboarding.local';
const SENHA_RH_PADRAO = 'onboarding123';
const SENHA_RH_AMBIENTE = process.env.SENHA_RH_TESTE || '';
const SENHA_RH_TESTE = SENHA_RH_AMBIENTE || SENHA_RH_PADRAO;

async function garantirUsuarioRhTeste() {
  const usuarios = await lerUsuarios();
  const existente = usuarios.find((u) => u.email === EMAIL_RH_TESTE);

  if (existente) {
    // Só mexe na conta existente quando a senha foi definida explicitamente no
    // ambiente; sem a variável, a conta já criada é mantida como está.
    if (SENHA_RH_AMBIENTE && (!existente.senhaHash || !senhaConfere(SENHA_RH_AMBIENTE, existente.senhaSalt, existente.senhaHash))) {
      const { salt, hash } = gerarHashSenha(SENHA_RH_AMBIENTE);
      existente.senhaSalt = salt;
      existente.senhaHash = hash;
      existente.ativo = true;
      await salvarUsuarios(usuarios);
      console.log('--- Senha da conta de RH atualizada a partir de SENHA_RH_TESTE:', EMAIL_RH_TESTE, '---');
    }
    return;
  }

  const { salt, hash } = gerarHashSenha(SENHA_RH_TESTE);
  usuarios.push({
    id: gerarId(),
    nome: `RH ${MARCA.nome}`,
    email: EMAIL_RH_TESTE,
    senhaSalt: salt,
    senhaHash: hash,
    tipo: 'rh',
    googleId: null,
    criadoEm: new Date().toISOString()
  });
  await salvarUsuarios(usuarios);
  console.log('--- Conta de RH de testes criada (MVP/Dev):', EMAIL_RH_TESTE, '---');
}

// Em serverless (Vercel), este arquivo é reavaliado a cada cold start - uma
// falha de disco/rede aqui (ex.: /tmp indisponível, ou o Supabase ainda sem
// as tabelas criadas pelo humano via supabase/schema.sql) não pode derrubar
// o carregamento do módulo inteiro, ou toda requisição àquela instância
// passaria a falhar. Localmente, uma falha aqui é genuinamente grave (impede
// o boot de dados de teste), então o erro ainda é logado bem visível.
// A sequência de boot agora depende de chamadas assíncronas ao Supabase, mas
// "module.exports = app" (mais abaixo) precisa continuar síncrono - por isso
// o boot roda numa IIFE assíncrona "solta" (fire-and-forget), sem bloquear a
// importação do módulo pela Vercel nem pelo "node index.js" local.
(async () => {
  try {
    // RH_TESTE_ATIVO=0: não recria a conta pública de RH de demonstração (rh@onboarding.local).
    if (process.env.RH_TESTE_ATIVO !== '0') await garantirUsuarioRhTeste();
    await garantirUsuarioMaster();
    // Remove sessões expiradas e as do formato antigo (token em texto puro).
    await limparSessoesAntigas();
    garantirMinutasContrato();
    await migrarTagsLegadasParaEtiquetas();
    // Gera a planilha Mestre já no boot, refletindo a carga inicial existente
    // no banco (ex.: a ficha de testes "Maria Gadu"), sem esperar a próxima
    // gravação para o arquivo existir.
    await atualizarPlanilhaMestre();
  } catch (erro) {
    console.error('Falha na inicialização de dados (não impede o boot do servidor):', erro.message);
  }
})();

// Exporta o app Express: hospedagens serverless (ex.: Vercel) o importam e o
// invocam como função, sem abrir porta TCP própria.
module.exports = app;

// Porta configurável via variável de ambiente PORT (padrão do Node/Express e
// das plataformas de deploy em nuvem, como Render e Railway, que injetam essa
// variável automaticamente). Padrão local: 3001, evitando conflito com outros
// servidores locais, como o do projeto Pré-Vendas na 3000.
// Na Vercel a própria plataforma importa o app exportado acima e o invoca como
// função serverless - chamar app.listen() lá seria redundante. Por isso o
// servidor só abre a porta quando o arquivo é executado diretamente
// ("node index.js"), em qualquer NODE_ENV: um contêiner em produção
// (NODE_ENV=production) também escuta, sem depender da Vercel.
const PORTA = process.env.PORT || 3001;
if (require.main === module) {
  app.listen(PORTA, () => {
    console.log(`Servidor ${MARCA.nome} rodando em http://localhost:${PORTA}`);
  });
}
