// Driver de armazenamento S3-COMPATÍVEL: AWS S3, MinIO, Cloudflare R2, Backblaze
// B2, Wasabi, Ceph... Sem SDK: assinatura AWS Signature V4 própria (só `crypto` e
// `fetch` do Node), para não carregar dezenas de pacotes na aplicação.
//
//   ARMAZENAMENTO_DRIVER=s3
//   S3_BUCKET             nome do bucket (ou ARMAZENAMENTO_BUCKET)
//   S3_ACCESS_KEY_ID      credencial de acesso
//   S3_SECRET_ACCESS_KEY  segredo da credencial (só no servidor)
//   S3_REGION             região (padrão us-east-1; MinIO aceita qualquer uma)
//   S3_ENDPOINT           ex.: http://minio:9000 ou https://<conta>.r2.cloudflarestorage.com.
//                         Vazio = AWS S3 (https://<bucket>.s3.<regiao>.amazonaws.com)
//   S3_PREFIXO            pasta dentro do bucket (ex.: admitte/), opcional
//   S3_SSE=AES256         pede criptografia em repouso do S3 (AWS); opcional
//
// Com S3_ENDPOINT o endereço é "path-style" (<endpoint>/<bucket>/<chave>), que é
// o aceito por MinIO e pela maioria dos compatíveis.
const crypto = require('crypto');
const path = require('path');

const sha256 = (dados) => crypto.createHash('sha256').update(dados).digest('hex');
const hmac = (chave, dados) => crypto.createHmac('sha256', chave).update(dados).digest();

// Codificação de URI da SigV4: tudo exceto A-Z a-z 0-9 - _ . ~ (e "/" no caminho).
const codificar = (texto) => encodeURIComponent(texto).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
const codificarCaminho = (caminho) => caminho.split('/').map(codificar).join('/');

// Assinatura SigV4 (função pura, testada com o vetor oficial da AWS).
//   headers: cabeçalhos a assinar (host, x-amz-*, content-type, range...)
// Devolve o valor do cabeçalho Authorization e a lista de cabeçalhos assinados.
function assinar({ metodo, caminho, consulta = '', headers, payloadHash, regiao, accessKeyId, secretAccessKey, amzDate }) {
  const dataCurta = amzDate.slice(0, 8);
  const nomes = Object.keys(headers).map((n) => n.toLowerCase()).sort();
  const valores = {};
  Object.keys(headers).forEach((n) => { valores[n.toLowerCase()] = String(headers[n]).trim().replace(/\s+/g, ' '); });
  const canonicalHeaders = nomes.map((n) => `${n}:${valores[n]}\n`).join('');
  const signedHeaders = nomes.join(';');
  const canonicalRequest = [metodo, caminho, consulta, canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const escopo = `${dataCurta}/${regiao}/s3/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, escopo, sha256(canonicalRequest)].join('\n');
  const chave = hmac(hmac(hmac(hmac('AWS4' + secretAccessKey, dataCurta), regiao), 's3'), 'aws4_request');
  const assinatura = crypto.createHmac('sha256', chave).update(stringToSign).digest('hex');
  return {
    authorization: `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${escopo}, SignedHeaders=${signedHeaders}, Signature=${assinatura}`,
    signedHeaders
  };
}

const dataAmz = (agora = new Date()) => agora.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

function driverS3(env = process.env) {
  const bucket = env.S3_BUCKET || env.ARMAZENAMENTO_BUCKET;
  const accessKeyId = env.S3_ACCESS_KEY_ID;
  const secretAccessKey = env.S3_SECRET_ACCESS_KEY;
  if (!bucket || !accessKeyId || !secretAccessKey) {
    throw new Error('ARMAZENAMENTO_DRIVER=s3 exige S3_BUCKET, S3_ACCESS_KEY_ID e S3_SECRET_ACCESS_KEY.');
  }
  const regiao = env.S3_REGION || 'us-east-1';
  const prefixo = String(env.S3_PREFIXO || '').replace(/^\/+/, '').replace(/\/*$/, '');
  const sse = String(env.S3_SSE || '').trim();
  const endpoint = String(env.S3_ENDPOINT || '').trim().replace(/\/+$/, '');

  let base; // origem (esquema + host)
  let prefixoCaminho; // "/bucket" no path-style, "" no virtual-host
  if (endpoint) {
    if (!/^https?:\/\//i.test(endpoint)) throw new Error('S3_ENDPOINT deve começar com http:// ou https://');
    base = new URL(endpoint);
    prefixoCaminho = `/${bucket}`;
  } else {
    base = new URL(`https://${bucket}.s3.${regiao}.amazonaws.com`);
    prefixoCaminho = '';
  }

  const chaveDoObjeto = (nome) => (prefixo ? `${prefixo}/` : '') + path.basename(nome);

  async function pedir(metodo, nome, corpo) {
    const caminho = `${prefixoCaminho}/${codificarCaminho(chaveDoObjeto(nome))}`;
    const payloadHash = sha256(corpo || '');
    const amzDate = dataAmz();
    const headers = { host: base.host, 'x-amz-content-sha256': payloadHash, 'x-amz-date': amzDate };
    if (corpo) headers['content-type'] = 'application/pdf';
    if (metodo === 'PUT' && sse) headers['x-amz-server-side-encryption'] = sse;
    const { authorization } = assinar({ metodo, caminho, headers, payloadHash, regiao, accessKeyId, secretAccessKey, amzDate });

    const enviar = { ...headers, authorization };
    delete enviar.host; // o fetch define o Host sozinho
    try {
      return await fetch(`${base.origin}${caminho}`, {
        method: metodo, headers: enviar, body: corpo || undefined, signal: AbortSignal.timeout(20000)
      });
    } catch (erro) {
      // "fetch failed" não diz nada: mostra o motivo de rede (DNS, recusa, timeout...).
      const causa = erro.cause && (erro.cause.code || erro.cause.message);
      throw new Error(`S3 inacessível em ${base.origin} (${causa || erro.message})`);
    }
  }

  async function falha(resposta, acao) {
    let detalhe = '';
    try { detalhe = (await resposta.text()).replace(/\s+/g, ' ').slice(0, 200); } catch (e) { /* sem corpo */ }
    const erro = new Error(`S3 ${acao} falhou (HTTP ${resposta.status}) ${detalhe}`.trim());
    erro.status = resposta.status;
    return erro;
  }

  return {
    driver: 's3',
    async salvar(nome, buffer) {
      const r = await pedir('PUT', nome, buffer);
      if (!r.ok) throw await falha(r, 'ao gravar');
      await r.arrayBuffer().catch(() => {});
    },
    async ler(nome) {
      const r = await pedir('GET', nome);
      if (r.status === 404) { await r.arrayBuffer().catch(() => {}); return null; }
      if (!r.ok) throw await falha(r, 'ao ler');
      return Buffer.from(await r.arrayBuffer());
    },
    async existe(nome) {
      const r = await pedir('HEAD', nome);
      if (r.status === 404) return false;
      if (!r.ok) throw await falha(r, 'ao consultar');
      return true;
    },
    async remover(nome) {
      const r = await pedir('DELETE', nome);
      if (r.status === 404) { await r.arrayBuffer().catch(() => {}); return; }
      if (!r.ok) throw await falha(r, 'ao remover');
      await r.arrayBuffer().catch(() => {});
    }
  };
}

module.exports = { driverS3, assinar, dataAmz };
