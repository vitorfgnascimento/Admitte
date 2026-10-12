// Repositório de dados - DRIVER POSTGRES (banco próprio do cliente, sem Supabase).
// Mesma interface de db/repositorio-supabase.js; escolhido com BANCO_DRIVER=postgres.
//
//   DATABASE_URL   postgres://usuario:senha@host:5432/banco   (obrigatória)
//   PGSSL=1        liga TLS na conexão (use em bancos gerenciados/remotos)
//   PGSSL_REJEITAR_NAO_AUTORIZADO=0   aceita certificado autoassinado (evite)
//   PGPOOL_MAX     tamanho do pool (padrão 10)
//
// O esquema vem de db/postgres/*.sql (executados em ordem na criação do banco).
// Todo SQL usa parâmetros ($1...) e identificadores validados: nenhum valor
// vindo do usuário é concatenado na consulta.

// Pool padrão (a partir do ambiente), criado só no primeiro uso.
let poolPadrao = null;
function obterPool() {
  if (poolPadrao) return poolPadrao;
  const { Pool, types } = require('pg');
  // Mesmo formato que o PostgREST entrega: datas em ISO e inteiros grandes como número.
  types.setTypeParser(1184, (v) => new Date(v).toISOString()); // timestamptz
  types.setTypeParser(1114, (v) => new Date(v + 'Z').toISOString()); // timestamp
  types.setTypeParser(20, (v) => Number(v)); // bigint
  if (!process.env.DATABASE_URL) throw new Error('BANCO_DRIVER=postgres exige DATABASE_URL.');
  poolPadrao = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: Number(process.env.PGPOOL_MAX) || 10,
    ssl: process.env.PGSSL === '1' ? { rejectUnauthorized: process.env.PGSSL_REJEITAR_NAO_AUTORIZADO !== '0' } : undefined
  });
  return poolPadrao;
}
let poolInjetado = null;
const pool = { query: (...argumentos) => (poolInjetado || obterPool()).query(...argumentos) };

const REGEX_IDENT = /^[a-z_][a-z0-9_]*$/;
function ident(nome) {
  if (!REGEX_IDENT.test(nome)) throw new Error(`Identificador SQL inválido: ${nome}`);
  return `"${nome}"`;
}

// Valores jsonb (objetos e arrays) precisam ir como texto JSON; o driver pg
// converteria arrays em arrays do Postgres.
function valorSql(valor) {
  if (valor === undefined) return null;
  if (valor !== null && typeof valor === 'object' && !(valor instanceof Date) && !Buffer.isBuffer(valor)) return JSON.stringify(valor);
  return valor;
}

// Datas e bigint que algum driver entregue "cru" viram o formato do PostgREST.
function normalizar(linha) {
  if (!linha) return linha;
  const saida = {};
  Object.keys(linha).forEach((k) => {
    const v = linha[k];
    if (v instanceof Date) saida[k] = v.toISOString();
    else if (typeof v === 'bigint') saida[k] = Number(v);
    else saida[k] = v;
  });
  return saida;
}

async function consultar(sql, parametros = []) {
  const resultado = await pool.query(sql, parametros.map(valorSql));
  return (resultado.rows || []).map(normalizar);
}
async function um(sql, parametros) {
  return (await consultar(sql, parametros))[0] || null;
}

// INSERT ... ON CONFLICT (chave) DO UPDATE, agrupando linhas de mesmo formato.
async function gravar(tabela, linhas, chave = 'id') {
  if (!linhas.length) return;
  const grupos = new Map();
  linhas.forEach((linha) => {
    const colunas = Object.keys(linha).sort();
    const id = colunas.join('|');
    if (!grupos.has(id)) grupos.set(id, { colunas, linhas: [] });
    grupos.get(id).linhas.push(linha);
  });
  for (const { colunas, linhas: grupo } of grupos.values()) {
    const lista = colunas.map(ident).join(', ');
    const atualizar = colunas.filter((c) => c !== chave).map((c) => `${ident(c)} = EXCLUDED.${ident(c)}`);
    const conflito = atualizar.length ? `DO UPDATE SET ${atualizar.join(', ')}` : 'DO NOTHING';
    for (let i = 0; i < grupo.length; i += 50) {
      const lote = grupo.slice(i, i + 50);
      const parametros = [];
      const valores = lote.map((linha) => `(${colunas.map((c) => { parametros.push(linha[c]); return `$${parametros.length}`; }).join(', ')})`);
      await consultar(`INSERT INTO ${ident(tabela)} (${lista}) VALUES ${valores.join(', ')} ON CONFLICT (${ident(chave)}) ${conflito}`, parametros);
    }
  }
}

async function inserir(tabela, linha) {
  const colunas = Object.keys(linha);
  await consultar(
    `INSERT INTO ${ident(tabela)} (${colunas.map(ident).join(', ')}) VALUES (${colunas.map((_, i) => `$${i + 1}`).join(', ')})`,
    colunas.map((c) => linha[c])
  );
}

async function atualizar(tabela, campos, filtros) {
  const colunas = Object.keys(campos);
  if (!colunas.length) return;
  const parametros = colunas.map((c) => campos[c]);
  const sets = colunas.map((c, i) => `${ident(c)} = $${i + 1}`);
  const onde = Object.keys(filtros).map((c) => { parametros.push(filtros[c]); return `${ident(c)} = $${parametros.length}`; });
  await consultar(`UPDATE ${ident(tabela)} SET ${sets.join(', ')} WHERE ${onde.join(' AND ')}`, parametros);
}

async function excluir(tabela, coluna, valor) {
  await consultar(`DELETE FROM ${ident(tabela)} WHERE ${ident(coluna)} = $1`, [valor]);
}

function criar(poolDoCliente) {
  // Permite injetar outro pool (testes com pg-mem); sem isso usa DATABASE_URL.
  if (poolDoCliente) poolInjetado = poolDoCliente;

  return {
    driver: 'postgres',

    // candidatos
    listarCandidatos: () => consultar('SELECT * FROM candidatos'),
    buscarCandidato: (id) => um('SELECT * FROM candidatos WHERE id = $1', [id]),
    gravarCandidatos: (linhas) => gravar('candidatos', linhas),
    atualizarCandidato: (id, campos) => atualizar('candidatos', campos, { id }),
    listarTagsDasFichas: () => consultar('SELECT id, tags FROM candidatos'),

    // mensagens
    listarMensagens: () => consultar('SELECT * FROM mensagens_chat ORDER BY "timestamp" ASC'),
    listarMensagensDaFicha: (candidatoId, aposIso) => (aposIso
      ? consultar('SELECT * FROM mensagens_chat WHERE candidato_id = $1 AND "timestamp" > $2 ORDER BY "timestamp" ASC', [candidatoId, aposIso])
      : consultar('SELECT * FROM mensagens_chat WHERE candidato_id = $1 ORDER BY "timestamp" ASC', [candidatoId])),
    inserirMensagem: (linha) => inserir('mensagens_chat', linha),
    excluirMensagensDaFicha: (candidatoId) => excluir('mensagens_chat', 'candidato_id', candidatoId),

    // auditoria
    inserirAuditoria: (linha) => inserir('auditoria', linha),
    listarAuditoria: ({ candidatoId, usuarioId, limite = 200 }) => {
      const coluna = candidatoId ? 'candidato_id' : 'usuario_id';
      return consultar(`SELECT * FROM auditoria WHERE ${coluna} = $1 ORDER BY ocorrido_em DESC LIMIT $2`, [candidatoId || usuarioId, limite]);
    },

    // usuários
    listarUsuarios: () => consultar('SELECT * FROM usuarios'),
    listarUsuariosPorTipo: (tipo) => consultar('SELECT * FROM usuarios WHERE tipo = $1 ORDER BY criado_em ASC', [tipo]),
    buscarUsuario: (id) => um('SELECT * FROM usuarios WHERE id = $1', [id]),
    buscarUsuarioPorEmail: (email) => um('SELECT * FROM usuarios WHERE email = $1', [email]),
    gravarUsuarios: (linhas) => gravar('usuarios', linhas),
    atualizarUsuario: (id, campos) => atualizar('usuarios', campos, { id }),
    excluirUsuario: (id) => excluir('usuarios', 'id', id),

    // sessões (chave = hash do token)
    inserirSessao: (linha) => inserir('sessoes', linha),
    buscarSessao: (tokenHash) => um('SELECT usuario_id, expira_em FROM sessoes WHERE token = $1', [tokenHash]),
    listarSessoes: () => consultar('SELECT token, expira_em FROM sessoes'),
    removerSessao: (tokenHash) => excluir('sessoes', 'token', tokenHash),
    removerSessoesDoUsuario: (usuarioId) => excluir('sessoes', 'usuario_id', usuarioId),

    // etiquetas
    listarEtiquetas: () => consultar('SELECT * FROM etiquetas ORDER BY criado_em ASC'),
    gravarEtiquetas: (linhas) => gravar('etiquetas', linhas),
    excluirEtiqueta: (id) => excluir('etiquetas', 'id', id),

    // configurações
    buscarConfiguracoes: (id = 'geral') => um('SELECT * FROM configuracoes WHERE id = $1', [id]),
    gravarConfiguracoes: (linha) => gravar('configuracoes', [linha]),

    // recuperação de senha
    invalidarRecuperacoesDoUsuario: (usuarioId) => consultar('UPDATE recuperacoes_senha SET usado = true WHERE usuario_id = $1 AND usado = false', [usuarioId]),
    inserirRecuperacao: (linha) => inserir('recuperacoes_senha', linha),
    buscarRecuperacaoPorHash: (tokenHash) => um('SELECT * FROM recuperacoes_senha WHERE token_hash = $1', [tokenHash]),
    atualizarRecuperacao: (id, campos) => atualizar('recuperacoes_senha', campos, { id }),

    // pedidos do titular (LGPD)
    listarSolicitacoes: () => consultar('SELECT * FROM solicitacoes_titular'),
    listarSolicitacoesDoUsuario: (usuarioId, status) => (status
      ? consultar('SELECT * FROM solicitacoes_titular WHERE usuario_id = $1 AND status = $2', [usuarioId, status])
      : consultar('SELECT * FROM solicitacoes_titular WHERE usuario_id = $1', [usuarioId])),
    buscarSolicitacao: (id) => um('SELECT * FROM solicitacoes_titular WHERE id = $1', [id]),
    inserirSolicitacao: (linha) => inserir('solicitacoes_titular', linha),
    atualizarSolicitacao: (id, campos) => atualizar('solicitacoes_titular', campos, { id })
  };
}

module.exports = Object.assign(criar(), { criar });
