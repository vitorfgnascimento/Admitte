// Verificação em duas etapas (MFA) por TOTP (RFC 6238), compatível com Google
// Authenticator, Microsoft Authenticator, Authy, 1Password etc. Sem serviço
// externo: tudo é calculado aqui, só com o módulo crypto do Node.
const crypto = require('crypto');

const ALFABETO = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const PERIODO_S = 30;
const DIGITOS = 6;

function base32Codificar(buffer) {
  let bits = 0;
  let valor = 0;
  let saida = '';
  for (const byte of buffer) {
    valor = (valor << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      saida += ALFABETO[(valor >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) saida += ALFABETO[(valor << (5 - bits)) & 31];
  return saida;
}

function base32Decodificar(texto) {
  const limpo = String(texto).toUpperCase().replace(/=+$/, '').replace(/\s/g, '');
  let bits = 0;
  let valor = 0;
  const bytes = [];
  for (const c of limpo) {
    const i = ALFABETO.indexOf(c);
    if (i < 0) throw new Error('Segredo base32 inválido');
    valor = (valor << 5) | i;
    bits += 5;
    if (bits >= 8) {
      bytes.push((valor >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

function gerarSegredo() {
  return base32Codificar(crypto.randomBytes(20));
}

function codigoTotp(segredo, passo) {
  const contador = Buffer.alloc(8);
  contador.writeBigUInt64BE(BigInt(passo));
  const h = crypto.createHmac('sha1', base32Decodificar(segredo)).update(contador).digest();
  const o = h[h.length - 1] & 0x0f;
  const n = ((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(n % 10 ** DIGITOS).padStart(DIGITOS, '0');
}

function passoAtual(agora = Date.now()) {
  return Math.floor(agora / 1000 / PERIODO_S);
}

// Devolve o passo (janela de 30 s) em que o código confere, ou null. Aceita o
// passo anterior e o seguinte (relógio defasado) e NUNCA um passo já usado:
// `ultimoPasso` impede reaproveitar um código visto por terceiros.
function verificarTotp(segredo, codigo, ultimoPasso = 0, agora = Date.now()) {
  const informado = String(codigo || '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(informado)) return null;
  const atual = passoAtual(agora);
  let achado = null;
  for (const delta of [0, -1, 1]) {
    const passo = atual + delta;
    const esperado = codigoTotp(segredo, passo);
    const confere = crypto.timingSafeEqual(Buffer.from(esperado), Buffer.from(informado));
    if (confere && passo > ultimoPasso && achado === null) achado = passo;
  }
  return achado;
}

function uriOtpauth(segredo, conta, emissor) {
  const rotulo = encodeURIComponent(`${emissor}:${conta}`);
  return `otpauth://totp/${rotulo}?secret=${segredo}&issuer=${encodeURIComponent(emissor)}&algorithm=SHA1&digits=${DIGITOS}&period=${PERIODO_S}`;
}

// ---- segredo do usuário em repouso: AES-256-GCM ----
function chaveDe(material) {
  return crypto.createHash('sha256').update('mfa-segredo-v1|' + material).digest();
}

function cifrar(texto, material) {
  const iv = crypto.randomBytes(12);
  const cifra = crypto.createCipheriv('aes-256-gcm', chaveDe(material), iv);
  const dados = Buffer.concat([cifra.update(String(texto), 'utf8'), cifra.final()]);
  return ['v1', iv.toString('base64'), cifra.getAuthTag().toString('base64'), dados.toString('base64')].join(':');
}

function decifrar(valor, material) {
  const [versao, iv, tag, dados] = String(valor || '').split(':');
  if (versao !== 'v1' || !iv || !tag || !dados) throw new Error('Segredo MFA em formato desconhecido');
  const decifra = crypto.createDecipheriv('aes-256-gcm', chaveDe(material), Buffer.from(iv, 'base64'));
  decifra.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decifra.update(Buffer.from(dados, 'base64')), decifra.final()]).toString('utf8');
}

// ---- códigos de recuperação (uso único; o banco guarda só o hash) ----
const hashCodigo = (codigo) => crypto.createHash('sha256').update(String(codigo).toLowerCase().replace(/[^0-9a-f]/g, '')).digest('hex');

function gerarCodigosRecuperacao(quantidade = 10) {
  const codigos = [];
  for (let i = 0; i < quantidade; i += 1) {
    const hex = crypto.randomBytes(5).toString('hex');
    codigos.push(`${hex.slice(0, 5)}-${hex.slice(5)}`);
  }
  return codigos;
}

// ---- desafio do login: prova (assinada, curta) de que a senha já foi aceita ----
function emitirDesafio(usuarioId, segredoServidor, validadeMs = 5 * 60 * 1000) {
  const corpo = Buffer.from(JSON.stringify({ u: usuarioId, e: Date.now() + validadeMs })).toString('base64url');
  const assinatura = crypto.createHmac('sha256', segredoServidor).update(corpo).digest('base64url');
  return `${corpo}.${assinatura}`;
}

function lerDesafio(desafio, segredoServidor) {
  const [corpo, assinatura] = String(desafio || '').split('.');
  if (!corpo || !assinatura) return null;
  const esperada = crypto.createHmac('sha256', segredoServidor).update(corpo).digest('base64url');
  const a = Buffer.from(assinatura);
  const b = Buffer.from(esperada);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const dados = JSON.parse(Buffer.from(corpo, 'base64url').toString('utf8'));
    return dados && typeof dados.u === 'string' && dados.e > Date.now() ? dados.u : null;
  } catch (e) {
    return null;
  }
}

module.exports = {
  gerarSegredo, codigoTotp, passoAtual, verificarTotp, uriOtpauth, cifrar, decifrar,
  hashCodigo, gerarCodigosRecuperacao, emitirDesafio, lerDesafio
};
