// Repositório de dados - DRIVER SUPABASE (PostgREST). Veja db/repositorio.js.
//
// O resto do código (index.js) só chama as funções abaixo e recebe linhas no
// formato das colunas (snake_case) ou lança erro. Para trocar de banco (Postgres
// próprio do cliente, MySQL...), reescreva este arquivo mantendo os mesmos
// nomes e formatos: nada mais precisa mudar. A implementação atual usa o
// Supabase (PostgREST) via db/supabase.js.
//
// Convenções:
//   - listar*  -> array de linhas (nunca null)
//   - buscar*  -> uma linha ou null
//   - gravar*  -> upsert por id (recebe array de linhas)
//   - qualquer falha lança o erro do driver; quem chama decide o que fazer.
const supabase = require('./supabase');

function resultado({ data, error }) {
  if (error) throw error;
  return data;
}
const lista = (r) => resultado(r) || [];

// ---------------------------------------------------------------- candidatos
async function listarCandidatos() {
  return lista(await supabase.from('candidatos').select('*'));
}
async function buscarCandidato(id) {
  return resultado(await supabase.from('candidatos').select('*').eq('id', id).maybeSingle()) || null;
}
async function gravarCandidatos(linhas) {
  resultado(await supabase.from('candidatos').upsert(linhas, { onConflict: 'id' }));
}
async function atualizarCandidato(id, campos) {
  resultado(await supabase.from('candidatos').update(campos).eq('id', id));
}
// Só id e tags de todas as fichas (migração e exclusão de etiquetas).
async function listarTagsDasFichas() {
  return lista(await supabase.from('candidatos').select('id, tags'));
}

// ----------------------------------------------------------------- mensagens
async function listarMensagens() {
  return lista(await supabase.from('mensagens_chat').select('*').order('timestamp', { ascending: true }));
}
// `aposIso`: devolve só as mensagens posteriores a esse instante (ISO).
async function listarMensagensDaFicha(candidatoId, aposIso) {
  let consulta = supabase.from('mensagens_chat').select('*').eq('candidato_id', candidatoId).order('timestamp', { ascending: true });
  if (aposIso) consulta = consulta.gt('timestamp', aposIso);
  return lista(await consulta);
}
async function inserirMensagem(linha) {
  resultado(await supabase.from('mensagens_chat').insert(linha));
}
async function excluirMensagensDaFicha(candidatoId) {
  resultado(await supabase.from('mensagens_chat').delete().eq('candidato_id', candidatoId));
}

// ----------------------------------------------------------------- auditoria
async function inserirAuditoria(linha) {
  resultado(await supabase.from('auditoria').insert(linha));
}
// Eventos de uma ficha (candidatoId) ou de uma conta (usuarioId), mais novos primeiro.
async function listarAuditoria({ candidatoId, usuarioId, limite = 200 }) {
  let consulta = supabase.from('auditoria').select('*');
  if (candidatoId) consulta = consulta.eq('candidato_id', candidatoId);
  if (usuarioId) consulta = consulta.eq('usuario_id', usuarioId);
  return lista(await consulta.order('ocorrido_em', { ascending: false }).limit(limite));
}

// ------------------------------------------------------------------ usuários
async function listarUsuarios() {
  return lista(await supabase.from('usuarios').select('*'));
}
async function listarUsuariosPorTipo(tipo) {
  return lista(await supabase.from('usuarios').select('*').eq('tipo', tipo).order('criado_em', { ascending: true }));
}
async function buscarUsuario(id) {
  return resultado(await supabase.from('usuarios').select('*').eq('id', id).maybeSingle()) || null;
}
async function buscarUsuarioPorEmail(email) {
  return resultado(await supabase.from('usuarios').select('*').eq('email', email).maybeSingle()) || null;
}
async function gravarUsuarios(linhas) {
  resultado(await supabase.from('usuarios').upsert(linhas, { onConflict: 'id' }));
}
async function atualizarUsuario(id, campos) {
  resultado(await supabase.from('usuarios').update(campos).eq('id', id));
}
async function excluirUsuario(id) {
  resultado(await supabase.from('usuarios').delete().eq('id', id));
}

// ------------------------------------------------------------------- sessões
// A chave das sessões é o HASH do token (o token em si nunca é guardado).
async function inserirSessao(linha) {
  resultado(await supabase.from('sessoes').insert(linha));
}
async function buscarSessao(tokenHash) {
  return resultado(await supabase.from('sessoes').select('usuario_id, expira_em').eq('token', tokenHash).maybeSingle()) || null;
}
async function listarSessoes() {
  return lista(await supabase.from('sessoes').select('token, expira_em'));
}
async function removerSessao(tokenHash) {
  resultado(await supabase.from('sessoes').delete().eq('token', tokenHash));
}
async function removerSessoesDoUsuario(usuarioId) {
  resultado(await supabase.from('sessoes').delete().eq('usuario_id', usuarioId));
}

// ----------------------------------------------------------------- etiquetas
async function listarEtiquetas() {
  return lista(await supabase.from('etiquetas').select('*').order('criado_em', { ascending: true }));
}
async function gravarEtiquetas(linhas) {
  resultado(await supabase.from('etiquetas').upsert(linhas, { onConflict: 'id' }));
}
async function excluirEtiqueta(id) {
  resultado(await supabase.from('etiquetas').delete().eq('id', id));
}

// ------------------------------------------------------------ configurações
async function buscarConfiguracoes(id = 'geral') {
  return resultado(await supabase.from('configuracoes').select('*').eq('id', id).maybeSingle()) || null;
}
async function gravarConfiguracoes(linha) {
  resultado(await supabase.from('configuracoes').upsert(linha, { onConflict: 'id' }));
}

// --------------------------------------------------- recuperação de senha
async function invalidarRecuperacoesDoUsuario(usuarioId) {
  resultado(await supabase.from('recuperacoes_senha').update({ usado: true }).eq('usuario_id', usuarioId).eq('usado', false));
}
async function inserirRecuperacao(linha) {
  resultado(await supabase.from('recuperacoes_senha').insert(linha));
}
async function buscarRecuperacaoPorHash(tokenHash) {
  return resultado(await supabase.from('recuperacoes_senha').select('*').eq('token_hash', tokenHash).maybeSingle()) || null;
}
async function atualizarRecuperacao(id, campos) {
  resultado(await supabase.from('recuperacoes_senha').update(campos).eq('id', id));
}

// --------------------------------- limites de taxa (compartilhados entre instancias)
// A chave e o SHA-256 do identificador (o banco nao guarda IP nem e-mail). O
// incremento e atomico no banco, pela funcao incrementar_limite
// (supabase/migracao_limites.sql).
async function incrementarLimite(chave, agora, janelaMs) {
  const linhas = resultado(await supabase.rpc('incrementar_limite', { p_chave: chave, p_agora: agora, p_fim: agora + janelaMs }));
  const r = Array.isArray(linhas) ? linhas[0] : linhas;
  if (!r) throw new Error('incrementar_limite nao retornou linha');
  return { contagem: Number(r.contagem), expiraEm: Number(r.expira_em) };
}
async function lerLimite(chave, agora) {
  const r = resultado(await supabase.from('limites_taxa').select('contagem, expira_em').eq('chave', chave).maybeSingle());
  return r && Number(r.expira_em) > agora ? Number(r.contagem) : 0;
}
async function zerarLimite(chave) {
  resultado(await supabase.from('limites_taxa').delete().eq('chave', chave));
}
async function limparLimites(agora) {
  resultado(await supabase.from('limites_taxa').delete().lte('expira_em', agora));
}

// ------------------------------------------------- pedidos do titular (LGPD)
async function listarSolicitacoes() {
  return lista(await supabase.from('solicitacoes_titular').select('*'));
}
async function listarSolicitacoesDoUsuario(usuarioId, status) {
  let consulta = supabase.from('solicitacoes_titular').select('*').eq('usuario_id', usuarioId);
  if (status) consulta = consulta.eq('status', status);
  return lista(await consulta);
}
async function buscarSolicitacao(id) {
  return resultado(await supabase.from('solicitacoes_titular').select('*').eq('id', id).maybeSingle()) || null;
}
async function inserirSolicitacao(linha) {
  resultado(await supabase.from('solicitacoes_titular').insert(linha));
}
async function atualizarSolicitacao(id, campos) {
  resultado(await supabase.from('solicitacoes_titular').update(campos).eq('id', id));
}

module.exports = {
  driver: 'supabase',
  listarCandidatos, buscarCandidato, gravarCandidatos, atualizarCandidato, listarTagsDasFichas,
  listarMensagens, listarMensagensDaFicha, inserirMensagem, excluirMensagensDaFicha,
  inserirAuditoria, listarAuditoria,
  listarUsuarios, listarUsuariosPorTipo, buscarUsuario, buscarUsuarioPorEmail, gravarUsuarios, atualizarUsuario, excluirUsuario,
  inserirSessao, buscarSessao, listarSessoes, removerSessao, removerSessoesDoUsuario,
  listarEtiquetas, gravarEtiquetas, excluirEtiqueta,
  buscarConfiguracoes, gravarConfiguracoes,
  invalidarRecuperacoesDoUsuario, inserirRecuperacao, buscarRecuperacaoPorHash, atualizarRecuperacao,
  incrementarLimite, lerLimite, zerarLimite, limparLimites,
  listarSolicitacoes, listarSolicitacoesDoUsuario, buscarSolicitacao, inserirSolicitacao, atualizarSolicitacao
};
