// Armazenamento dos PDFs dos candidatos (documentos enviados, contratos
// assinados e PDF da ficha). O restante do sistema só conhece esta interface:
//
//   salvar(nome, buffer) -> Promise<void>
//   ler(nome)            -> Promise<Buffer | null>   (null = não existe)
//   existe(nome)         -> Promise<boolean>
//   remover(nome)        -> Promise<void>            (não falha se não existir)
//
// Drivers, escolhidos por ARMAZENAMENTO_DRIVER:
//   local    (padrão) disco do servidor (pasta uploads/). Bom para servidor
//                     próprio com disco persistente; NÃO persiste em hospedagem serverless.
//   supabase          bucket privado do Supabase Storage (ver README).
//   s3                S3-compatível (AWS S3, MinIO, Cloudflare R2...), ver storage/s3.js.
//
// Trocar de plataforma = escrever outro driver com a mesma interface.
const fs = require('fs');
const path = require('path');

function driverLocal(pasta) {
  fs.mkdirSync(pasta, { recursive: true });
  const caminho = (nome) => path.join(pasta, path.basename(nome));
  return {
    driver: 'local',
    async salvar(nome, buffer) {
      await fs.promises.writeFile(caminho(nome), buffer);
    },
    async ler(nome) {
      try {
        return await fs.promises.readFile(caminho(nome));
      } catch (erro) {
        if (erro.code === 'ENOENT') return null;
        throw erro;
      }
    },
    async existe(nome) {
      try {
        await fs.promises.access(caminho(nome));
        return true;
      } catch (erro) {
        return false;
      }
    },
    async remover(nome) {
      try {
        await fs.promises.unlink(caminho(nome));
      } catch (erro) {
        if (erro.code !== 'ENOENT') throw erro;
      }
    }
  };
}

function naoEncontrado(erro) {
  const texto = String((erro && (erro.message || erro.error)) || '').toLowerCase();
  const status = String((erro && (erro.statusCode || erro.status)) || '');
  return status === '404' || texto.includes('not found');
}

function driverSupabase() {
  const { createClient } = require('@supabase/supabase-js');
  const url = process.env.SUPABASE_URL;
  // Chave de serviço (secret) é a indicada: ela ignora o RLS do Storage e fica
  // só no servidor. Sem ela, cai na SUPABASE_KEY (exige políticas no bucket).
  const chave = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY;
  const bucket = process.env.ARMAZENAMENTO_BUCKET || 'documentos';
  if (!url || !chave) throw new Error('ARMAZENAMENTO_DRIVER=supabase exige SUPABASE_URL e SUPABASE_SERVICE_KEY (ou SUPABASE_KEY).');
  const cliente = createClient(url, chave, { auth: { persistSession: false } });
  const pasta = () => cliente.storage.from(bucket);

  return {
    driver: 'supabase',
    async salvar(nome, buffer) {
      const { error } = await pasta().upload(path.basename(nome), buffer, { contentType: 'application/pdf', upsert: true });
      if (error) throw error;
    },
    async ler(nome) {
      const { data, error } = await pasta().download(path.basename(nome));
      if (error) {
        if (naoEncontrado(error)) return null;
        throw error;
      }
      return Buffer.from(await data.arrayBuffer());
    },
    async existe(nome) {
      return (await this.ler(nome)) !== null;
    },
    async remover(nome) {
      const { error } = await pasta().remove([path.basename(nome)]);
      if (error && !naoEncontrado(error)) throw error;
    }
  };
}

function criarArmazenamento({ pastaLocal }) {
  const escolhido = String(process.env.ARMAZENAMENTO_DRIVER || 'local').trim().toLowerCase();
  if (escolhido === 'supabase') return driverSupabase();
  if (escolhido === 's3') return require('./s3').driverS3();
  if (escolhido !== 'local') throw new Error(`ARMAZENAMENTO_DRIVER inválido: "${escolhido}" (use "local", "supabase" ou "s3").`);
  return driverLocal(pastaLocal);
}

module.exports = { criarArmazenamento };
