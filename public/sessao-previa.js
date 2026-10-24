/* Evita a "tela fantasma" ao abrir uma página que depende da sessão.
 *
 * Carregue este arquivo no <head>, sem defer, com data-modo:
 *   data-modo="entrada"    telas de login (master, RH): só ficam ocultas quando já há uma sessão
 *                          guardada, até a página confirmar se ela vale. Se valer, a página
 *                          redireciona e o login nunca chega a aparecer.
 *   data-modo="protegida"  painéis (RH, administração...): ficam ocultos até a sessão ser
 *                          confirmada, para o painel não piscar antes de mandar ao login.
 *
 * A página chama window.revelarPagina() quando souber o que mostrar. Se nada chamar, um
 * limite de tempo revela a página para ela nunca ficar em branco.
 */
(function () {
  'use strict';
  var script = document.currentScript;
  var modo = (script && script.getAttribute('data-modo')) || 'entrada';
  var temSessao = false;
  try { temSessao = !!window.localStorage.getItem('onboarding_token'); } catch (e) { /* sem armazenamento */ }

  var classe = 'verificando-sessao';
  var raiz = document.documentElement;
  var temporizador = null;

  window.revelarPagina = function () {
    if (temporizador) { clearTimeout(temporizador); temporizador = null; }
    raiz.classList.remove(classe);
  };

  if (modo === 'entrada' && !temSessao) return;

  var estilo = document.createElement('style');
  estilo.textContent = 'html.' + classe + ' { background: #FBF8F3; } html.' + classe + ' body { visibility: hidden; }';
  document.head.appendChild(estilo);
  raiz.classList.add(classe);
  temporizador = setTimeout(window.revelarPagina, 8000);

  // Voltar pelo histórico do navegador pode restaurar a página já oculta: revela de novo.
  window.addEventListener('pageshow', function (e) { if (e.persisted && modo === 'entrada') window.revelarPagina(); });
})();
