// Verifica se a chave PÚBLICA do projeto ainda consegue acessar as tabelas pela
// API REST do Supabase (o que não deve ocorrer com o RLS ligado).
//
//   node scripts/verificar-rls.js
//
// Usa SUPABASE_URL e SUPABASE_KEY (a chave pública) do ambiente/.env. Só faz
// leituras de contagem (HEAD), sem baixar nem alterar nenhuma linha.
require('dotenv').config();

const TABELAS = {
  usuarios: 'id', sessoes: 'token', candidatos: 'id',
  mensagens_chat: 'id', etiquetas: 'id', configuracoes: 'id',
  recuperacoes_senha: 'id', auditoria: 'id', solicitacoes_titular: 'id'
};

async function main() {
  const url = process.env.SUPABASE_URL;
  const chave = process.env.SUPABASE_KEY;
  if (!url || !chave) {
    console.error('Defina SUPABASE_URL e SUPABASE_KEY (a chave PUBLICA) para verificar.');
    process.exit(2);
  }

  let expostas = 0;
  for (const [tabela, coluna] of Object.entries(TABELAS)) {
    const r = await fetch(`${url}/rest/v1/${tabela}?select=${coluna}`, {
      method: 'HEAD',
      headers: { apikey: chave, Authorization: `Bearer ${chave}`, Prefer: 'count=exact' }
    });
    const total = (r.headers.get('content-range') || '').split('/')[1];
    const aberta = r.status === 200 && total && total !== '0';
    // 401/403, ou 200 com 0 linhas visíveis, significa que a chave pública não enxerga dados.
    const situacao = aberta ? `EXPOSTA (${total} linhas legíveis com a chave pública)` : `protegida (HTTP ${r.status})`;
    if (aberta) expostas += 1;
    console.log(`${aberta ? '[FALHA]' : '[ OK  ]'} ${tabela.padEnd(15)} ${situacao}`);
  }

  console.log(expostas ? `\n${expostas} tabela(s) expostas: ligue o RLS (supabase/ativar_rls.sql).` : '\nNenhuma tabela legível com a chave pública.');
  process.exit(expostas ? 1 : 0);
}

main().catch((erro) => { console.error('Erro na verificação:', erro.message); process.exit(2); });
