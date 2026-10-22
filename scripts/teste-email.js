// Valida a configuração de e-mail (SMTP) sem expor segredos.
//
//   npm run teste:email                    só confere a conexão e o login no servidor SMTP
//   npm run teste:email -- voce@email.com  também envia um e-mail de prova para esse endereço
//
// Lê as mesmas variáveis do sistema (SMTP_URL ou SMTP_HOST/PORT/USER/PASS e
// EMAIL_REMETENTE) do .env ou do ambiente. Nunca imprime a senha.
require('dotenv').config();
const { criarTransporte, enviarEmail, smtpConfigurado } = require('../lib/email');

const mascarar = (email) => String(email || '').replace(/^(.).*(@.*)$/, '$1***$2');

(async () => {
  if (!smtpConfigurado()) {
    console.log('SMTP NÃO configurado: defina SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS e EMAIL_REMETENTE (ou SMTP_URL).');
    console.log('Sem isso os e-mails são apenas simulados no log do servidor.');
    process.exit(2);
  }
  const resumo = process.env.SMTP_URL
    ? 'SMTP_URL definido'
    : `${process.env.SMTP_HOST}:${process.env.SMTP_PORT || 587} (usuário ${mascarar(process.env.SMTP_USER)})`;
  console.log('Servidor:', resumo);
  console.log('Remetente:', process.env.EMAIL_REMETENTE || '(padrão: nome da marca <nao-responda@localhost>)');
  if (!process.env.EMAIL_REMETENTE) {
    console.log('AVISO: defina EMAIL_REMETENTE com um endereço que o provedor autorize (muitos recusam remetentes diferentes do usuário).');
  }

  try {
    await criarTransporte().verify();
    console.log('[ OK  ] conexão e login no servidor SMTP');
  } catch (erro) {
    console.log('[FALHA] conexão/login:', erro.code || '', String(erro.message).replace(/pass(word)?[^\s]*/gi, '***').slice(0, 200));
    process.exit(1);
  }

  const destino = process.argv[2];
  if (!destino) {
    console.log('Dica: passe um e-mail para receber uma mensagem de prova: npm run teste:email -- voce@email.com');
    return;
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(destino)) { console.log('E-mail de destino inválido.'); process.exit(2); }
  const r = await enviarEmail({
    para: destino,
    assunto: 'Teste de e-mail - sistema de admissão',
    texto: 'Se você recebeu esta mensagem, o envio de e-mails do sistema está funcionando.\n\nNenhuma ação é necessária.'
  });
  if (r.enviado) console.log(`[ OK  ] e-mail de prova enviado para ${mascarar(destino)} (confira a caixa de entrada e o spam)`);
  else { console.log('[FALHA] envio:', r.erro || 'não enviado'); process.exit(1); }
})().catch((e) => { console.error('ERRO:', e.message); process.exit(1); });
