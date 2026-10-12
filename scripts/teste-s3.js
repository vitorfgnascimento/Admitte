// Teste do driver S3 contra um servidor S3-compatível REAL (MinIO, AWS, R2...).
//
//   S3_ENDPOINT=http://localhost:9100 S3_BUCKET=admitte-teste \
//   S3_ACCESS_KEY_ID=... S3_SECRET_ACCESS_KEY=... npm run teste:s3
//
// Cria o bucket se ele não existir (MinIO). Não faz parte da bateria padrão
// porque precisa de um servidor S3 acessível.
const crypto = require('crypto');
const { driverS3, assinar, dataAmz } = require('../storage/s3');

const resultados = [];
const t = (nome, ok, det = '') => { resultados.push(ok); console.log(`${ok ? '[ OK  ]' : '[FALHA]'} ${nome}${!ok && det ? ' -> ' + det : ''}`); };

async function garantirBucket(env) {
  const base = new URL(env.S3_ENDPOINT);
  const caminho = `/${env.S3_BUCKET}`;
  const payloadHash = crypto.createHash('sha256').update('').digest('hex');
  const amzDate = dataAmz();
  const headers = { host: base.host, 'x-amz-content-sha256': payloadHash, 'x-amz-date': amzDate };
  const { authorization } = assinar({ metodo: 'PUT', caminho, headers, payloadHash, regiao: env.S3_REGION || 'us-east-1', accessKeyId: env.S3_ACCESS_KEY_ID, secretAccessKey: env.S3_SECRET_ACCESS_KEY, amzDate });
  const r = await fetch(base.origin + caminho, { method: 'PUT', headers: { 'x-amz-content-sha256': payloadHash, 'x-amz-date': amzDate, authorization } });
  if (![200, 409].includes(r.status)) throw new Error(`Não foi possível criar/validar o bucket (HTTP ${r.status}).`);
}

(async () => {
  const env = { ...process.env };
  if (!env.S3_ENDPOINT) throw new Error('Defina S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY_ID e S3_SECRET_ACCESS_KEY.');
  await garantirBucket(env);
  const s3 = driverS3(env);
  const sufixo = crypto.randomBytes(4).toString('hex');
  const nome = `ficha-${sufixo}.pdf`;
  const binario = Buffer.concat([Buffer.from('%PDF-1.4\n'), crypto.randomBytes(2048), Buffer.from('\n%%EOF')]);

  t('driver identifica-se como s3', s3.driver === 's3');
  t('arquivo inexistente: existe() = false', (await s3.existe(nome)) === false);
  t('arquivo inexistente: ler() = null', (await s3.ler(nome)) === null);
  await s3.salvar(nome, binario);
  t('salvar + existe() = true', (await s3.existe(nome)) === true);
  const lido = await s3.ler(nome);
  t('ler() devolve exatamente os mesmos bytes', !!lido && Buffer.compare(lido, binario) === 0);
  await s3.salvar(nome, Buffer.from('%PDF-1.4\nNOVO\n%%EOF'));
  t('salvar de novo sobrescreve', (await s3.ler(nome)).toString().includes('NOVO'));

  const especial = `ficha ção+${sufixo} (1).pdf`;
  await s3.salvar(especial, binario);
  t('nome com espaço, acento, + e parênteses', Buffer.compare(await s3.ler(especial), binario) === 0);
  await s3.remover(especial);

  await s3.salvar(`../../fora-${sufixo}.pdf`, binario);
  t('nome com ../ é reduzido ao nome do arquivo (sem sair do prefixo)', (await s3.existe(`fora-${sufixo}.pdf`)) === true);
  await s3.remover(`fora-${sufixo}.pdf`);

  const grande = crypto.randomBytes(5 * 1024 * 1024);
  await s3.salvar(`grande-${sufixo}.pdf`, grande);
  t('arquivo de 5 MB', Buffer.compare(await s3.ler(`grande-${sufixo}.pdf`), grande) === 0);
  await s3.remover(`grande-${sufixo}.pdf`);

  await s3.remover(nome);
  t('remover() apaga', (await s3.existe(nome)) === false && (await s3.ler(nome)) === null);
  let falhou = false;
  try { await s3.remover(nome); } catch (e) { falhou = true; }
  t('remover() de arquivo inexistente não falha', !falhou);

  // Prefixo: outra instância com prefixo diferente não enxerga o arquivo
  const comPrefixo = driverS3({ ...env, S3_PREFIXO: `cliente-${sufixo}/` });
  await comPrefixo.salvar('doc.pdf', binario);
  t('S3_PREFIXO isola os objetos', (await comPrefixo.existe('doc.pdf')) === true && (await s3.existe('doc.pdf')) === false);
  await comPrefixo.remover('doc.pdf');

  // Credencial errada deve falhar com erro claro (e sem vazar o segredo)
  const ruim = driverS3({ ...env, S3_SECRET_ACCESS_KEY: 'segredo-errado-0123456789' });
  let erro = null;
  try { await ruim.salvar(nome, binario); } catch (e) { erro = e; }
  t('credencial errada: erro 403 sem expor o segredo', !!erro && erro.status === 403 && !String(erro.message).includes('segredo-errado'), erro ? erro.message : 'sem erro');

  const falhas = resultados.filter((r) => !r).length;
  console.log(`\nTotal: ${resultados.length} verificações | ${resultados.length - falhas} ok | ${falhas} falhas`);
  process.exit(falhas ? 1 : 0);
})().catch((e) => { console.error('ERRO:', e.message); process.exit(2); });
