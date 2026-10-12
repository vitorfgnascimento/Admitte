// Sobe o servidor com o driver POSTGRES sobre um Postgres em memória (pg-mem),
// só para a bateria de testes:  TESTE_DRIVER=postgres npm run teste:seguranca
//
// Usa o MESMO esquema que vai para o banco do cliente (db/postgres/01-esquema.sql).
// O pg-mem não implementa gatilhos plpgsql, então o 02-auditoria-imutavel.sql
// não é aplicado aqui (ele é testado em um Postgres real, ver README).
const fs = require('fs');
const path = require('path');
const { newDb } = require('pg-mem');

const banco = newDb();
banco.public.none(fs.readFileSync(path.join(__dirname, '..', 'db', 'postgres', '01-esquema.sql'), 'utf8'));
const { Pool } = banco.adapters.createPg();
require('../db/repositorio-pg').criar(new Pool());

require('../index.js').listen(Number(process.env.PORTA_TESTE));
