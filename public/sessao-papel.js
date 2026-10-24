/* Sessões separadas por área: Candidato, RH (operador e administrador) e Master.
 *
 * Cada área tem o seu próprio login e a sua própria sessão guardada no navegador. Entrar como RH
 * numa aba não derruba nem troca o login do candidato aberto em outra aba, e vice-versa.
 *
 * As páginas continuam lendo e gravando "onboarding_token" e "onboarding_usuario"; este arquivo
 * (carregado primeiro, no <head>) troca, por baixo, a chave pela da área da própria página.
 *   /master.html ................ master
 *   /rh-login, /rh, /admin, /titulares ... rh
 *   /seguranca.html ............. rh (ou master, quando aberta com ?conta=master)
 *   /login, /ficha, /leitor ..... candidato
 *   /visualizador.html .......... lê a sessão do RH e, se não houver, a do candidato
 */
(function () {
  'use strict';
  var BASES = ['onboarding_token', 'onboarding_usuario'];
  var caminho = (window.location.pathname || '').toLowerCase();
  var parametros = new URLSearchParams(window.location.search);

  function areaDaPagina() {
    if (/\/master\.html$/.test(caminho)) return 'master';
    if (/\/seguranca\.html$/.test(caminho)) return parametros.get('conta') === 'master' ? 'master' : 'rh';
    if (/\/(rh-login|rh|admin|titulares)\.html$/.test(caminho)) return 'rh';
    return 'candidato';
  }
  var area = areaDaPagina();
  var leituraAlternativa = /\/visualizador\.html$/.test(caminho) ? ['rh', 'candidato'] : [area];

  function chave(base, para) { return base + '_' + para; }

  var original = {
    getItem: Storage.prototype.getItem,
    setItem: Storage.prototype.setItem,
    removeItem: Storage.prototype.removeItem
  };
  function ehSessao(armazenamento, nome) {
    return armazenamento === window.localStorage && BASES.indexOf(nome) !== -1;
  }

  Storage.prototype.getItem = function (nome) {
    if (ehSessao(this, nome)) {
      for (var i = 0; i < leituraAlternativa.length; i += 1) {
        var valor = original.getItem.call(this, chave(nome, leituraAlternativa[i]));
        if (valor !== null) return valor;
      }
      return null;
    }
    return original.getItem.call(this, nome);
  };
  Storage.prototype.setItem = function (nome, valor) {
    if (ehSessao(this, nome)) return original.setItem.call(this, chave(nome, area), valor);
    return original.setItem.call(this, nome, valor);
  };
  Storage.prototype.removeItem = function (nome) {
    if (ehSessao(this, nome)) return original.removeItem.call(this, chave(nome, area));
    return original.removeItem.call(this, nome);
  };

  // Sessão antiga (uma chave só, compartilhada): descarta, para ninguém ficar com login cruzado.
  try {
    BASES.forEach(function (base) { original.removeItem.call(window.localStorage, base); });
  } catch (e) { /* sem armazenamento */ }
})();
