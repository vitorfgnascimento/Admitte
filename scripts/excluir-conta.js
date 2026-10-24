// Exclui UMA conta de equipe (administrador ou operador de RH) pelo e-mail, para ela poder
// ser criada de novo. Nunca exclui a master nem contas de candidato.
//
//   npm run excluir:conta -- email@empresa.com.br              só mostra a conta (não apaga nada)
//   npm run excluir:conta -- email@empresa.com.br --confirmar  APAGA a conta, de forma definitiva
//
// Age no banco do .env (se for o mesmo da produção, vale para a produção).
require('dotenv').config();
const crypto = require('crypto');
const repo = require('../db/repositorio');

const args = process.argv.slice(2);
const CONFIRMAR = args.includes('--confirmar');
const email = String(args.find((a) => !a.startsWith('--')) || '').trim().toLowerCase();
const mascarar = (e) => String(e || '').replace(/^(.{2}).*(@.*)$/, '$1***$2');

(async () => {
  if (!email) {
    console.log('Informe o e-mail da conta: npm run excluir:conta -- email@empresa.com.br');
    process.exit(2);
  }
  const usuarios = await repo.listarUsuarios();
  const conta = usuarios.find((u) => String(u.email || '').toLowerCase() === email);
  if (!conta) { console.log(`Nenhuma conta com o e-mail ${mascarar(email)}.`); process.exit(1); }
  if (conta.tipo !== 'admin' && conta.tipo !== 'rh') {
    console.log(`Recusado: esta conta é do tipo "${conta.tipo}". Só administradores e operadores de RH podem ser excluídos por aqui.`);
    process.exit(1);
  }
  console.log(`Conta: ${conta.nome} <${mascarar(conta.email)}> | tipo ${conta.tipo} | ${conta.ativo ? 'ativa' : 'desativada'}`);
  if (!CONFIRMAR) {
    console.log('\nNada foi apagado. Para apagar de verdade, rode de novo com --confirmar.');
    return;
  }
  await repo.removerSessoesDoUsuario(conta.id);
  await repo.excluirUsuario(conta.id);
  try {
    await repo.inserirAuditoria({
      id: crypto.randomUUID(), tipo_evento: 'conta_excluida_script', usuario_id: null, candidato_id: null, ip: null,
      ocorrido_em: new Date().toISOString(),
      dados: { tipo: conta.tipo, executadoPor: 'script excluir-conta' }
    });
  } catch (e) { /* a exclusão já foi feita; só não ficou registrada */ }
  console.log('\nConta excluída. O e-mail já pode ser usado em um novo cadastro.');
})().catch((erro) => { console.error('ERRO:', erro.message); process.exit(1); });
