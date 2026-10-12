// Repositório de dados: ÚNICO ponto do sistema que fala com o banco.
//
// O resto do código (index.js) só chama as funções deste módulo. A implementação
// é escolhida pelo ambiente:
//
//   BANCO_DRIVER=supabase   (padrão) Supabase/PostgREST  -> db/repositorio-supabase.js
//   BANCO_DRIVER=postgres   Postgres próprio (DATABASE_URL) -> db/repositorio-pg.js
//
// Os dois drivers expõem exatamente as mesmas funções e formatos (linhas em
// snake_case; falha = erro lançado). Para um novo banco, crie outro driver com
// essa interface. Só o driver escolhido é carregado.
const driver = String(process.env.BANCO_DRIVER || 'supabase').trim().toLowerCase();

if (driver === 'postgres') module.exports = require('./repositorio-pg');
else if (driver === 'supabase') module.exports = require('./repositorio-supabase');
else throw new Error(`BANCO_DRIVER inválido: "${driver}". Use "supabase" ou "postgres".`);
