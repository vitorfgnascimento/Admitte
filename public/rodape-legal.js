/* Rodapé legal e pop-up dos documentos da LGPD (comum a todas as páginas).
 *
 *  - Coloca, no fim da página, o rodapé "© ano Marca · Política de Privacidade · Termos de Uso"
 *    (a menos que a página já tenha o seu, marcado com data-rodape-legal).
 *  - Ao clicar em qualquer link para /termos-de-uso.html ou /politica-privacidade.html, abre o
 *    documento num pop-up sobre a página atual, sem tirar a pessoa de onde estava. Ctrl/Cmd+clique
 *    e "abrir em nova aba" continuam funcionando.
 *  - Dentro do pop-up (?embed=1) as páginas legais escondem o cabeçalho de navegação.
 */
(function () {
  'use strict';

  var ehEmbutida = window.self !== window.top || /[?&]embed=1\b/.test(window.location.search);
  var REGEX_LEGAL = /\/(termos-de-uso|politica-privacidade)\.html(?:[?#].*)?$/;
  var TITULOS = { 'termos-de-uso': 'Termos de Uso', 'politica-privacidade': 'Política de Privacidade' };

  if (ehEmbutida) {
    document.documentElement.classList.add('modo-embutido');
  }

  var estilo = document.createElement('style');
  estilo.textContent =
    '.modo-embutido .topo, .modo-embutido .rodape-legal { display: none !important; }' +
    '.modo-embutido .pagina { padding-top: 1.25rem; }' +
    '.rodape-legal { display: flex; flex-wrap: wrap; justify-content: center; gap: 0.25rem 1rem; padding: 1.25rem 1rem 1.5rem; font-size: 0.8125rem; color: #6B665E; }' +
    '.rodape-legal a, .rodape-pagina a { color: #6B665E; text-decoration: none; font-weight: 500; }' +
    '.rodape-legal a:hover, .rodape-pagina a:hover { color: #0F3D2A; text-decoration: underline; }' +
    '.rodape-legal a:focus-visible, .rodape-pagina a:focus-visible { outline: 3px solid #00A335; outline-offset: 2px; border-radius: 4px; }' +
    '.legal-fundo { position: fixed; inset: 0; z-index: 2147483000; display: flex; align-items: center; justify-content: center; padding: 1rem; background: rgba(15, 31, 21, 0.55); backdrop-filter: blur(2px); animation: legal-entra 0.18s ease-out; }' +
    '.legal-fundo[hidden] { display: none; }' +
    '.legal-caixa { display: flex; flex-direction: column; width: min(52rem, 100%); height: min(46rem, 100%); background: #FBF8F3; border-radius: 1.125rem; box-shadow: 0 30px 70px -20px rgba(15, 31, 21, 0.6); overflow: hidden; }' +
    '.legal-topo { display: flex; align-items: center; justify-content: space-between; gap: 1rem; padding: 0.75rem 0.75rem 0.75rem 1.25rem; background: #fff; border-bottom: 1px solid #E8E2D8; }' +
    '.legal-topo h2 { margin: 0; font-family: Fraunces, Georgia, serif; font-size: 1.125rem; font-weight: 600; color: #0F3D2A; }' +
    '.legal-fechar { min-height: 2.5rem; padding: 0.375rem 1rem; border: 1px solid #E8E2D8; border-radius: 0.75rem; background: #fff; color: #2B2A27; font: inherit; font-size: 0.9375rem; font-weight: 600; cursor: pointer; }' +
    '.legal-fechar:hover { background: #E7F3EA; border-color: #D2E9D9; color: #0F3D2A; }' +
    '.legal-fechar:focus-visible { outline: 3px solid #00A335; outline-offset: 2px; }' +
    '.legal-quadro { flex: 1; width: 100%; border: 0; background: #FBF8F3; }' +
    '@keyframes legal-entra { from { opacity: 0; } to { opacity: 1; } }' +
    '@media (prefers-reduced-motion: reduce) { .legal-fundo { animation: none; } }' +
    '@media (max-width: 40rem) { .legal-fundo { padding: 0; } .legal-caixa { height: 100%; border-radius: 0; } }';
  document.head.appendChild(estilo);

  // ---------- Pop-up ----------
  var fundo = null;
  var quadro = null;
  var titulo = null;
  var anterior = null;

  function fechar() {
    if (!fundo) return;
    fundo.hidden = true;
    quadro.removeAttribute('src');
    document.body.style.overflow = fundo.getAttribute('data-overflow') || '';
    document.removeEventListener('keydown', aoTeclar, true);
    if (anterior && anterior.focus) anterior.focus();
  }

  function aoTeclar(e) {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); fechar(); return; }
    if (e.key === 'Tab') {
      // Mantém o foco dentro do pop-up (o botão Fechar é o único controle fora do documento).
      var botao = fundo.querySelector('.legal-fechar');
      if (document.activeElement !== botao) { e.preventDefault(); botao.focus(); }
      else if (!e.shiftKey) { e.preventDefault(); try { quadro.contentWindow.focus(); } catch (x) { botao.focus(); } }
      else { e.preventDefault(); botao.focus(); }
    }
  }

  function montar() {
    fundo = document.createElement('div');
    fundo.className = 'legal-fundo';
    fundo.hidden = true;
    var caixa = document.createElement('div');
    caixa.className = 'legal-caixa';
    caixa.setAttribute('role', 'dialog');
    caixa.setAttribute('aria-modal', 'true');
    caixa.setAttribute('aria-labelledby', 'legalTitulo');
    var topo = document.createElement('div');
    topo.className = 'legal-topo';
    titulo = document.createElement('h2');
    titulo.id = 'legalTitulo';
    var botao = document.createElement('button');
    botao.type = 'button';
    botao.className = 'legal-fechar';
    botao.textContent = 'Fechar';
    botao.addEventListener('click', fechar);
    topo.appendChild(titulo);
    topo.appendChild(botao);
    quadro = document.createElement('iframe');
    quadro.className = 'legal-quadro';
    quadro.setAttribute('title', 'Documento legal');
    caixa.appendChild(topo);
    caixa.appendChild(quadro);
    fundo.appendChild(caixa);
    fundo.addEventListener('mousedown', function (e) { if (e.target === fundo) fechar(); });
    document.body.appendChild(fundo);
    // Esc também funciona com o foco dentro do documento.
    quadro.addEventListener('load', function () {
      try {
        quadro.contentWindow.document.addEventListener('keydown', function (e) { if (e.key === 'Escape') fechar(); });
        var h1 = quadro.contentWindow.document.querySelector('h1');
        if (h1 && h1.textContent) titulo.textContent = h1.textContent.trim();
      } catch (x) { /* mesma origem: não deve falhar */ }
    });
  }

  function abrir(caminho, rotuloInicial) {
    if (!fundo) montar();
    anterior = document.activeElement;
    titulo.textContent = rotuloInicial;
    var url = new URL(caminho, window.location.origin);
    url.searchParams.set('embed', '1');
    quadro.src = url.pathname + url.search + url.hash;
    fundo.setAttribute('data-overflow', document.body.style.overflow || '');
    document.body.style.overflow = 'hidden';
    fundo.hidden = false;
    document.addEventListener('keydown', aoTeclar, true);
    fundo.querySelector('.legal-fechar').focus();
  }

  document.addEventListener('click', function (e) {
    if (e.defaultPrevented || e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
    var a = e.target.closest && e.target.closest('a[href]');
    if (!a || a.classList.contains('link-termos') || a.hasAttribute('download')) return;
    if (ehEmbutida) {
      // Dentro do pop-up: o documento mostra os links para o outro documento no próprio quadro.
      return;
    }
    var m = REGEX_LEGAL.exec(a.getAttribute('href') || '');
    if (!m) return;
    e.preventDefault();
    abrir(a.getAttribute('href'), TITULOS[m[1]]);
  });

  // ---------- Rodapé ----------
  function criarRodape(nome) {
    if (ehEmbutida || document.querySelector('[data-rodape-legal]')) return;
    var rodape = document.createElement('footer');
    rodape.className = 'rodape-legal';
    rodape.setAttribute('data-rodape-legal', '');
    var copia = document.createElement('span');
    copia.textContent = '© ' + new Date().getFullYear() + ' ' + nome;
    var politica = document.createElement('a');
    politica.href = '/politica-privacidade.html';
    politica.textContent = 'Política de Privacidade';
    var termos = document.createElement('a');
    termos.href = '/termos-de-uso.html';
    termos.textContent = 'Termos de Uso';
    rodape.appendChild(copia);
    rodape.appendChild(politica);
    rodape.appendChild(termos);
    document.body.appendChild(rodape);
  }

  function iniciar() {
    var ano = document.getElementById('anoAtual');
    if (ano) ano.textContent = new Date().getFullYear();
    // Sem rodapé próprio na página: pega o nome da marca configurada e cria o padrão.
    if (document.querySelector('[data-rodape-legal]') || ehEmbutida) return;
    fetch('/api/marca').then(function (r) { return r.ok ? r.json() : null; })
      .then(function (m) { criarRodape(m && m.nome ? m.nome : 'Admitte'); })
      .catch(function () { criarRodape('Admitte'); });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', iniciar);
  else iniciar();
})();
