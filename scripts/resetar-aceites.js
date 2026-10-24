// Volta todos os documentos enviados para "ainda não aceitos", para o botão "Aceitar" do painel
// do RH ficar clicável de novo (útil para gravar a demonstração). Não apaga nada: só tira o aceite
// e qualquer pendência aberta dos documentos que já foram enviados.
//
//   node scripts/resetar-aceites.js              todas as fichas
//   node scripts/resetar-aceites.js <id-da-ficha>  só uma ficha
//
// Age no banco do .env (se for o mesmo da produção, vale para a produção).
require('dotenv').config();
const repo = require('../db/repositorio');

(async () => {
  const alvo = process.argv[2];
  const fichas = (await repo.listarCandidatos()).filter((f) => !alvo || f.id === alvo);
  if (!fichas.length) { console.log('Nenhuma ficha encontrada.'); return; }
  const agora = new Date().toISOString();
  for (const f of fichas) {
    const docs = JSON.parse(JSON.stringify(f.documentos || {}));
    let alterados = 0;
    Object.values(docs).forEach((d) => {
      if (d && d.arquivo && (d.status === 'VERDE' || d.pendencia)) {
        d.status = 'AMARELO';
        d.pendencia = null;
        d.atualizadoEm = agora;
        alterados += 1;
      }
    });
    if (alterados) await repo.atualizarCandidato(f.id, { documentos: docs });
    console.log(`${f.id}: ${alterados} documento(s) voltaram para "não aceito".`);
  }
})().catch((erro) => { console.error('ERRO:', erro.message || JSON.stringify(erro)); process.exit(1); });
