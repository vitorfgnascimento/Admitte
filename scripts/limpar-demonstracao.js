// Limpa os dados de DEMONSTRAÇÃO do banco configurado no .env (ou no ambiente):
//   - todas as fichas de candidatos (e as mensagens do chat e os PDFs delas);
//   - todos os pedidos de titulares;
//   - todas as contas de candidato, de operador de RH e de administrador.
// PRESERVA: a(s) conta(s) master, a trilha de auditoria (que é somente de acréscimo),
// as configurações e o catálogo de etiquetas.
//
//   npm run limpar:demonstracao                 só mostra o que seria apagado (não apaga nada)
//   npm run limpar:demonstracao -- --confirmar  APAGA, de forma definitiva
//
// Atenção: ele age no banco que o .env aponta; se for o mesmo da produção, vale para a
// produção. Não há como desfazer; exporte o que quiser guardar antes. Para a conta de RH
// de demonstração não voltar a cada reinício do servidor, defina RH_TESTE_ATIVO=0.
require('dotenv').config();
const path = require('path');
const crypto = require('crypto');

const repo = require('../db/repositorio');
const plataforma = require('../lib/plataforma');
const armazenamento = require('../storage/armazenamento').criarArmazenamento({ pastaLocal: path.join(plataforma.diretorioDados, 'uploads') });

const CONFIRMAR = process.argv.includes('--confirmar');
const mascarar = (email) => String(email || '').replace(/^(.{2}).*(@.*)$/, '$1***$2');
const nomeDoArquivo = (ref) => String(ref || '').replace(/^\/?uploads\//, '');

function destinoDoBanco() {
  try {
    const bruto = process.env.BANCO_DRIVER === 'postgres' ? process.env.DATABASE_URL : process.env.SUPABASE_URL;
    return `${process.env.BANCO_DRIVER === 'postgres' ? 'postgres' : 'supabase'} @ ${new URL(bruto).host}`;
  } catch (e) { return '(destino não identificado)'; }
}

// Todos os arquivos que uma ficha referencia (documentos, contratos assinados, PDF da ficha).
function arquivosDaFicha(f) {
  const nomes = new Set([`ficha-${f.id}.pdf`]);
  Object.values(f.documentos || {}).forEach((d) => { if (d && d.arquivo) nomes.add(nomeDoArquivo(d.arquivo)); });
  Object.values((f.contrato && f.contrato.documentos) || {}).forEach((d) => { if (d && d.arquivoAssinado) nomes.add(nomeDoArquivo(d.arquivoAssinado)); });
  if (f.ficha_pdf) nomes.add(nomeDoArquivo(f.ficha_pdf));
  return [...nomes].filter(Boolean);
}

(async () => {
  const fichas = await repo.listarCandidatos();
  const usuarios = await repo.listarUsuarios();
  const solicitacoes = await repo.listarSolicitacoes();
  const masters = usuarios.filter((u) => u.tipo === 'master');
  const aRemover = usuarios.filter((u) => u.tipo !== 'master');
  const porTipo = (t) => aRemover.filter((u) => u.tipo === t).length;
  const arquivos = [...new Set(fichas.flatMap(arquivosDaFicha))];

  console.log(`Banco: ${destinoDoBanco()}`);
  console.log(`Armazenamento de PDFs: ${armazenamento.driver}`);
  console.log('');
  console.log(CONFIRMAR ? 'VAI APAGAR (definitivo):' : 'Seria apagado (simulação, nada foi alterado):');
  console.log(`  fichas de candidatos .......... ${fichas.length}`);
  console.log(`  arquivos PDF referenciados .... ${arquivos.length}`);
  console.log(`  pedidos de titulares .......... ${solicitacoes.length}`);
  console.log(`  contas de candidato ........... ${porTipo('candidato')}`);
  console.log(`  contas de operador de RH ...... ${porTipo('rh')}`);
  console.log(`  contas de administrador ....... ${porTipo('admin')}`);
  console.log(`Preservadas: ${masters.length} conta(s) master (${masters.map((m) => mascarar(m.email)).join(', ') || 'nenhuma'}), trilha de auditoria, configurações e etiquetas.`);
  if (!masters.length) console.log('AVISO: não há conta master neste banco; defina MASTER_EMAIL e MASTER_SENHA e reinicie o servidor para criá-la.');

  if (armazenamento.driver === 'local' && process.env.BANCO_DRIVER !== 'postgres') {
    console.log('AVISO: os PDFs são apagados da pasta local. Se a produção guarda os PDFs no Supabase Storage, rode com ARMAZENAMENTO_DRIVER=supabase para removê-los de lá também.');
  }

  if (!CONFIRMAR) {
    console.log('\nNada foi apagado. Para apagar de verdade, rode de novo com --confirmar.');
    return;
  }

  let arquivosRemovidos = 0;
  let falhasArquivo = 0;
  // Fichas primeiro: elas referenciam as contas (chave estrangeira).
  for (const f of fichas) {
    for (const nome of arquivosDaFicha(f)) {
      try { await armazenamento.remover(nome); arquivosRemovidos += 1; } catch (e) { falhasArquivo += 1; }
    }
    await repo.excluirMensagensDaFicha(f.id);
    await repo.excluirCandidato(f.id);
  }
  for (const s of solicitacoes) await repo.excluirSolicitacao(s.id);
  for (const u of aRemover) {
    await repo.removerSessoesDoUsuario(u.id);
    await repo.excluirUsuario(u.id);
  }

  const restantes = { fichas: (await repo.listarCandidatos()).length, contas: (await repo.listarUsuarios()).map((u) => u.tipo) };
  try {
    await repo.inserirAuditoria({
      id: crypto.randomUUID(), tipo_evento: 'limpeza_demonstracao', usuario_id: null, candidato_id: null, ip: null,
      ocorrido_em: new Date().toISOString(),
      dados: { fichas: fichas.length, arquivos: arquivosRemovidos, solicitacoes: solicitacoes.length, contas: aRemover.length, executadoPor: 'script limpar-demonstracao' }
    });
  } catch (e) { /* a limpeza já foi feita; só não ficou registrada */ }

  console.log(`\nConcluído: ${fichas.length} ficha(s), ${arquivosRemovidos} arquivo(s)${falhasArquivo ? ` (${falhasArquivo} sem sucesso)` : ''}, ${solicitacoes.length} pedido(s) e ${aRemover.length} conta(s) apagados.`);
  console.log(`Restam: ${restantes.fichas} ficha(s) e ${restantes.contas.length} conta(s) (${restantes.contas.join(', ') || 'nenhuma'}).`);
})().catch((erro) => { console.error('ERRO:', erro.message); process.exit(1); });
