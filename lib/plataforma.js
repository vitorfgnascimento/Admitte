// Onde o sistema está rodando. É o ÚNICO lugar que conhece particularidades de
// plataforma (Vercel e outras hospedagens serverless); o restante do código só
// consulta o resultado e funciona igual em um servidor, em Docker ou na nuvem.
//
// Variáveis (todas opcionais):
//   SERVERLESS=1        força o modo serverless em outra hospedagem (Netlify, AWS Lambda...)
//   TRUST_PROXY=1       confia no cabeçalho X-Forwarded-For (atrás de proxy reverso)
//   DIRETORIO_DADOS     pasta gravável dos dados locais (substitui o padrão)
const os = require('os');
const path = require('path');

function detectar(env = process.env, raizDoProjeto = path.join(__dirname, '..')) {
  const naVercel = !!env.VERCEL;
  // Em serverless o disco do projeto é somente leitura e só o diretório
  // temporário aceita gravação (e ele é efêmero).
  const serverless = naVercel || env.SERVERLESS === '1';
  return {
    nome: naVercel ? 'vercel' : (serverless ? 'serverless' : 'servidor'),
    serverless,
    // O IP real do cliente vem de X-Forwarded-For quando há proxy na frente;
    // plataformas serverless sempre têm um.
    confiarNoProxy: serverless || env.TRUST_PROXY === '1',
    diretorioDados: env.DIRETORIO_DADOS || (serverless ? os.tmpdir() : raizDoProjeto)
  };
}

module.exports = Object.assign(detectar(), { detectar });
