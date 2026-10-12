// Marca configurável (white-label): nome, logo e cores de cada instalação, por
// variáveis de ambiente. O código e o layout são os mesmos para todo cliente.
//
//   MARCA_NOME          nome exibido (padrão: Admitte)
//   MARCA_LOGO_URL      logo: caminho dentro de public/ (ex.: /marca/logo.svg) ou https://...
//   MARCA_COR           cor de ação (botões, destaques), #RRGGBB
//   MARCA_COR_ESCURA    cor escura da marca (títulos, painel), #RRGGBB
//
// Nada aqui é confiado às cegas: nome é escapado, logo só aceita caminho local
// de imagem ou https, e cores só aceitam #RRGGBB.
const NOME_PADRAO = 'Admitte';
const NOME_ANTIGO = 'Onboarding Digital';
const LOGO_PADRAO = '/marca/logo.png';

const REGEX_LOGO_LOCAL = /^\/(?!\/)[\w./-]*\.(svg|png|jpe?g|webp)$/i;
const REGEX_LOGO_HTTPS = /^https:\/\/[\w.-]+(:\d{1,5})?\/[\w%./~+-]*\.(svg|png|jpe?g|webp)(\?[\w%=&.-]*)?$/i;
const REGEX_COR = /^#[0-9a-fA-F]{6}$/;

const escaparHtml = (texto) => String(texto)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

// Escurece uma cor #RRGGBB (fator 0..1) para os estados de hover e texto.
function escurecer(hex, fator) {
  const n = parseInt(hex.slice(1), 16);
  const canal = (v) => Math.max(0, Math.round(v * (1 - fator))).toString(16).padStart(2, '0');
  return '#' + canal((n >> 16) & 255) + canal((n >> 8) & 255) + canal(n & 255);
}

function carregar(env = process.env) {
  const nomeBruto = String(env.MARCA_NOME || '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 60);
  const nome = nomeBruto || NOME_PADRAO;

  const logoBruto = String(env.MARCA_LOGO_URL || '').trim();
  const logoValido = logoBruto && !logoBruto.includes('..') && (REGEX_LOGO_LOCAL.test(logoBruto) || REGEX_LOGO_HTTPS.test(logoBruto))
    ? logoBruto
    : null;
  // O símbolo da Admitte só é o padrão quando a instalação usa o nome padrão:
  // um cliente com nome próprio e sem logo mantém o ícone neutro do tema.
  const logoUrl = logoValido || (nomeBruto ? null : LOGO_PADRAO);

  const cor = REGEX_COR.test(String(env.MARCA_COR || '').trim()) ? String(env.MARCA_COR).trim() : null;
  const corEscura = REGEX_COR.test(String(env.MARCA_COR_ESCURA || '').trim()) ? String(env.MARCA_COR_ESCURA).trim() : null;

  const variaveis = [];
  if (cor) {
    variaveis.push(`--verde: ${cor}`, `--verde-hover: ${escurecer(cor, 0.2)}`, `--verde-texto: ${escurecer(cor, 0.2)}`, `--status-concluida: ${cor}`);
  }
  if (corEscura) variaveis.push(`--floresta: ${corEscura}`, `--floresta-2: ${corEscura}`);
  const css = variaveis.length ? `:root { ${variaveis.join('; ')}; }` : '';

  const nomeHtml = escaparHtml(nome);

  // Aplica a marca a um HTML/JS servido: troca o nome, o ícone e injeta as cores.
  function aplicar(conteudo, { html = true } = {}) {
    let saida = String(conteudo).split(NOME_ANTIGO).join(html ? nomeHtml : nome.replace(/\\/g, '\\\\').replace(/'/g, "\\'"));
    if (!html) return saida;
    if (logoUrl) {
      saida = saida.replace(/<svg class="ic ic-logo"([^>]*)><use href="#i-logo"\s*\/><\/svg>/g,
        () => `<img class="ic ic-logo" src="${escaparHtml(logoUrl)}" alt="" style="object-fit:contain">`);
    }
    if (css) saida = saida.replace('</head>', `<style id="marca-cores">${css}</style>\n</head>`);
    return saida;
  }

  return { nome, logoUrl, cor, corEscura, css, aplicar, publico: () => ({ nome, logoUrl, cor, corEscura }) };
}

// Nome seguro para strings de PDF cru (sem parênteses nem barra invertida).
const nomeParaPdf = (nome) => String(nome).replace(/[()\\]/g, '').replace(/[^\x20-\x7e]/g, '');

module.exports = { carregar, escaparHtml, nomeParaPdf, NOME_PADRAO, NOME_ANTIGO, LOGO_PADRAO };
