// Supabase FALSO em memória (PostgREST e Storage mínimos) - só para testes e
// demonstrações offline. Nada é gravado em disco e nada toca o Supabase real.
//
//   FALSO_PORTA=54330 node scripts/supabase-falso.js
const http = require('http');

const tabelas = { usuarios: [], sessoes: [], candidatos: [], mensagens_chat: [], etiquetas: [], configuracoes: [], recuperacoes_senha: [], auditoria: [], solicitacoes_titular: [] };
const chavePrimaria = { usuarios: 'id', sessoes: 'token', candidatos: 'id', mensagens_chat: 'id', etiquetas: 'id', configuracoes: 'id', recuperacoes_senha: 'id', auditoria: 'id', solicitacoes_titular: 'id' };
const objetos = new Map(); // "bucket/caminho" -> Buffer

function filtrar(linhas, params) {
  let r = linhas;
  for (const [campo, valor] of params) {
    const m = /^(eq|neq|gt)\.(.*)$/.exec(valor);
    if (!m) continue;
    if (m[1] === 'gt') r = r.filter((x) => String(x[campo]) > m[2]);
    else r = r.filter((x) => (m[1] === 'eq' ? String(x[campo]) === m[2] : String(x[campo]) !== m[2]));
  }
  return r;
}

const servidor = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const partes = [];
  req.on('data', (c) => partes.push(c));
  req.on('end', () => {
    const bruto = Buffer.concat(partes);
    const json = (status, obj) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(obj === undefined ? '' : JSON.stringify(obj));
    };

    // ---- Storage ----
    let m = /^\/storage\/v1\/object\/([^/]+)\/(.+)$/.exec(url.pathname);
    if (m) {
      const chave = `${m[1]}/${decodeURIComponent(m[2])}`;
      if (req.method === 'POST' || req.method === 'PUT') {
        let conteudo = bruto;
        if (String(req.headers['content-type'] || '').startsWith('multipart/form-data')) {
          conteudo = bruto.subarray(bruto.indexOf('\r\n\r\n') + 4, bruto.lastIndexOf('\r\n--'));
        }
        objetos.set(chave, conteudo);
        return json(200, { Key: chave, Id: chave });
      }
      if (req.method === 'GET') {
        if (!objetos.has(chave)) return json(404, { statusCode: '404', error: 'not_found', message: 'Object not found' });
        res.writeHead(200, { 'Content-Type': 'application/pdf' });
        return res.end(objetos.get(chave));
      }
    }
    m = /^\/storage\/v1\/object\/([^/]+)$/.exec(url.pathname);
    if (m && req.method === 'DELETE') {
      const { prefixes } = JSON.parse(bruto.toString() || '{}');
      (prefixes || []).forEach((p) => objetos.delete(`${m[1]}/${p}`));
      return json(200, []);
    }
    if (url.pathname === '/__objetos') return json(200, [...objetos.keys()]);

    // ---- PostgREST ----
    m = /^\/rest\/v1\/([a-z_]+)$/.exec(url.pathname);
    if (!m || !tabelas[m[1]]) return json(404, { message: 'recurso desconhecido' });
    const t = m[1];
    const filtros = [...url.searchParams.entries()].filter(([k]) => !['select', 'order', 'on_conflict', 'limit'].includes(k));
    const querObjeto = String(req.headers.accept || '').includes('vnd.pgrst.object');

    if (req.method === 'GET') {
      const linhas = filtrar(tabelas[t], filtros);
      if (querObjeto) return linhas.length ? json(200, linhas[0]) : json(406, { message: 'sem linhas' });
      return json(200, linhas);
    }
    if (req.method === 'POST') {
      const dados = bruto.length ? JSON.parse(bruto.toString()) : [];
      const lista = Array.isArray(dados) ? dados : [dados];
      const upsert = String(req.headers.prefer || '').includes('merge-duplicates');
      for (const novo of lista) {
        const i = tabelas[t].findIndex((x) => x[chavePrimaria[t]] === novo[chavePrimaria[t]]);
        if (i >= 0 && upsert) tabelas[t][i] = { ...tabelas[t][i], ...novo };
        else if (i < 0) tabelas[t].push(novo);
      }
      return json(201);
    }
    if (req.method === 'PATCH') {
      const dados = JSON.parse(bruto.toString() || '{}');
      filtrar(tabelas[t], filtros).forEach((x) => Object.assign(x, dados));
      return json(204);
    }
    if (req.method === 'DELETE') {
      const alvo = new Set(filtrar(tabelas[t], filtros));
      tabelas[t] = tabelas[t].filter((x) => !alvo.has(x));
      return json(204);
    }
    return json(405, { message: 'metodo nao suportado' });
  });
});

const porta = Number(process.env.FALSO_PORTA || 54321);
servidor.listen(porta, '127.0.0.1', () => console.log(`Supabase falso em http://127.0.0.1:${porta}`));
