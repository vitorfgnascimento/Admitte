// Roda a bateria completa de testes contra o driver POSTGRES (pg-mem, em memória).
//   npm run teste:postgres
process.env.TESTE_DRIVER = 'postgres';
require('./teste-seguranca.js');
