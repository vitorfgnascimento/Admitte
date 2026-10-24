// Só para a bateria de testes: troca a validação do token do Google por uma leitura direta.
// A "credencial" enviada é o próprio e-mail da conta Google de teste.
// Carregado pelo servidor de teste com NODE_OPTIONS=--require.
const { OAuth2Client } = require('google-auth-library');
OAuth2Client.prototype.verifyIdToken = async function verifyIdToken({ idToken }) {
  return { getPayload: () => ({ email: String(idToken), email_verified: true, name: 'Pessoa Google', sub: `sub-${idToken}` }) };
};
