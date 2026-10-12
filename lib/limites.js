// Contadores de limite de taxa (anti força bruta e anti abuso), COMPARTILHADOS
// entre instâncias: ficam na tabela limites_taxa do banco, então várias cópias
// da aplicação (réplicas, serverless) somam as mesmas tentativas.
//
//   - As chaves (IP, e-mail, id) são gravadas só como SHA-256: o banco não
//     guarda dado pessoal por causa dos limites.
//   - Se o banco falhar (ou a migração ainda não existir), o contador cai para a
//     memória DO PROCESSO e o erro é registrado uma vez por minuto: o sistema
//     nunca fica indisponível por causa do limitador.
//   - LIMITES_COMPARTILHADOS=0 desliga o banco e usa só a memória.
const crypto = require('crypto');

function criar({ repo = null, compartilhado = true, agora = () => Date.now(), log = console } = {}) {
  const memoria = new Map(); // chave -> { contagem, fim }
  const usarBanco = !!repo && compartilhado;
  let ultimoAviso = 0;

  const hash = (chave) => crypto.createHash('sha256').update(String(chave)).digest('hex');

  function avisar(erro) {
    const t = agora();
    if (t - ultimoAviso > 60 * 1000) {
      ultimoAviso = t;
      log.error('Limites compartilhados indisponíveis (usando a memória deste processo):', erro.message);
    }
  }

  function limparMemoria() {
    if (memoria.size <= 5000) return;
    const t = agora();
    for (const [k, v] of memoria) if (v.fim <= t) memoria.delete(k);
  }

  function incrementarMemoria(chave, janelaMs) {
    const t = agora();
    let r = memoria.get(chave);
    if (!r || r.fim <= t) {
      r = { contagem: 0, fim: t + janelaMs };
      memoria.set(chave, r);
    }
    r.contagem += 1;
    limparMemoria();
    return { contagem: r.contagem, fim: r.fim };
  }

  // Soma 1 à chave dentro da janela e devolve { contagem, fim }. Nunca lança.
  async function incrementar(chave, janelaMs) {
    if (usarBanco) {
      try {
        const r = await repo.incrementarLimite(hash(chave), agora(), janelaMs);
        // Limpeza oportunista das chaves vencidas (1 em cada ~200 chamadas).
        if (Math.random() < 0.005) repo.limparLimites(agora()).catch(() => {});
        return { contagem: Number(r.contagem), fim: Number(r.expiraEm) };
      } catch (erro) {
        avisar(erro);
      }
    }
    return incrementarMemoria(chave, janelaMs);
  }

  // Contagem atual (0 se a janela venceu). Nunca lança.
  async function contagem(chave) {
    if (usarBanco) {
      try {
        return Number(await repo.lerLimite(hash(chave), agora())) || 0;
      } catch (erro) {
        avisar(erro);
      }
    }
    const r = memoria.get(chave);
    return r && r.fim > agora() ? r.contagem : 0;
  }

  async function zerar(chave) {
    memoria.delete(chave);
    if (usarBanco) {
      try { await repo.zerarLimite(hash(chave)); } catch (erro) { avisar(erro); }
    }
  }

  return { incrementar, contagem, zerar, compartilhado: usarBanco };
}

module.exports = { criar };
