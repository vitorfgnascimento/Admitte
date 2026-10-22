// Envio de e-mails transacionais (recuperação de senha, acesso inicial, ativação).
//
// Configuração por variáveis de ambiente (ver .env.example):
//   SMTP_URL        ex.: smtps://usuario:senha@smtp.exemplo.com:465
//   ou SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS
//   EMAIL_REMETENTE ex.: "Admitte <nao-responda@suaempresa.com.br>"
//
// Sem SMTP configurado o envio é SIMULADO: o conteúdo vai para o log do
// servidor (com o endereço mascarado) e a função devolve { simulado: true }.
let transporte = null;
let transporteInicializado = false;

function criarTransporte() {
  if (transporteInicializado) return transporte;
  transporteInicializado = true;
  const nodemailer = require('nodemailer');
  if (process.env.SMTP_URL) {
    transporte = nodemailer.createTransport(process.env.SMTP_URL);
  } else if (process.env.SMTP_HOST) {
    const porta = Number(process.env.SMTP_PORT || 587);
    transporte = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: porta,
      secure: porta === 465,
      auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS || '' } : undefined
    });
  }
  return transporte;
}

const mascarar = (email) => String(email || '').replace(/^(.).*(@.*)$/, '$1***$2');

function smtpConfigurado() {
  return !!(process.env.SMTP_URL || process.env.SMTP_HOST);
}

// Envia (ou simula) um e-mail. Nunca lança por falha de entrega: devolve
// { enviado, simulado, erro? } para o chamador decidir o que mostrar.
async function enviarEmail({ para, assunto, texto }) {
  const t = criarTransporte();
  if (!t) {
    console.log(`\n=== [E-MAIL SIMULADO] ${assunto} ===`);
    console.log(`Para: ${mascarar(para)}`);
    console.log(texto);
    console.log('==========================================\n');
    return { enviado: false, simulado: true };
  }
  try {
    await t.sendMail({
      from: process.env.EMAIL_REMETENTE || `${String(process.env.MARCA_NOME || 'Admitte').replace(/[<>\r\n]/g, '')} <nao-responda@localhost>`,
      to: para,
      subject: assunto,
      text: texto
    });
    return { enviado: true, simulado: false };
  } catch (erro) {
    console.error('Falha ao enviar e-mail:', erro.message);
    return { enviado: false, simulado: false, erro: erro.message };
  }
}

module.exports = { enviarEmail, smtpConfigurado, criarTransporte };
