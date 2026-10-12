/* Gestão de contas da equipe, compartilhado por master.html (administradores
 * dos clientes) e admin.html (operadores do RH).
 *
 *   GestaoContas.montar(container, { base: '/api/admin/operadores', rotulo: 'operador', token })
 *
 * Lista as contas, cria uma nova (o titular recebe por e-mail o link para definir
 * a senha), ativa/desativa e reenvia o acesso. Tudo é escrito com textContent.
 */
(function () {
  'use strict';

  function el(tag, props, filhos) {
    var n = document.createElement(tag);
    Object.keys(props || {}).forEach(function (k) {
      if (k === 'texto') n.textContent = props[k]; else n.setAttribute(k, props[k]);
    });
    (filhos || []).forEach(function (f) { if (f) n.appendChild(f); });
    return n;
  }

  function montar(container, opcoes) {
    var base = opcoes.base;
    var rotulo = opcoes.rotulo;
    var token = opcoes.token;
    var idLogado = opcoes.idLogado || null;

    function chamar(metodo, caminho, corpo) {
      return fetch(base + caminho, {
        method: metodo,
        headers: Object.assign({ Authorization: 'Bearer ' + token }, corpo ? { 'Content-Type': 'application/json' } : {}),
        body: corpo ? JSON.stringify(corpo) : undefined
      }).then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (j) { return { ok: r.ok, status: r.status, corpo: j }; });
      });
    }

    container.textContent = '';
    var aviso = el('div', { class: 'gc-aviso', role: 'status' });
    var campoNome = el('input', { type: 'text', id: 'gcNome', required: '', maxlength: '120', autocomplete: 'off' });
    var campoEmail = el('input', { type: 'email', id: 'gcEmail', required: '', maxlength: '254', autocomplete: 'off' });
    var botaoCriar = el('button', { type: 'submit', class: 'gc-btn gc-btn-primario', texto: 'Criar ' + rotulo });
    var formulario = el('form', { class: 'gc-form' }, [
      el('div', { class: 'gc-campo' }, [el('label', { for: 'gcNome', texto: 'Nome completo' }), campoNome]),
      el('div', { class: 'gc-campo' }, [el('label', { for: 'gcEmail', texto: 'E-mail' }), campoEmail]),
      botaoCriar
    ]);
    var corpoTabela = el('tbody');
    var tabela = el('table', { class: 'gc-tabela' }, [
      el('thead', {}, [el('tr', {}, ['Nome', 'E-mail', 'Situação', 'Ações'].map(function (t) { return el('th', { texto: t }); }))]),
      corpoTabela
    ]);
    container.appendChild(formulario);
    container.appendChild(aviso);
    container.appendChild(el('div', { class: 'gc-tabela-caixa' }, [tabela]));

    function mostrar(texto, erro, extra) {
      aviso.textContent = texto;
      aviso.className = 'gc-aviso ' + (erro ? 'gc-erro' : 'gc-ok');
      if (extra && extra.linkRecuperacao) {
        // Só aparece em ambiente de teste (sem e-mail real configurado).
        aviso.appendChild(document.createTextNode(' [Teste] '));
        aviso.appendChild(el('a', { href: extra.linkRecuperacao, target: '_blank', rel: 'noopener', texto: 'abrir link de definição de senha' }));
        aviso.appendChild(document.createTextNode(' (senha temporária: ' + extra.senhaTemporaria + ')'));
      }
    }

    function linha(c) {
      var situacao = el('span', { class: 'gc-situacao ' + (c.ativo ? 'gc-ativa' : 'gc-inativa'), texto: c.ativo ? 'Ativa' : 'Desativada' });
      var ehVoce = c.id === idLogado;
      var botoes = [];
      if (!ehVoce) {
        var alternar = el('button', { type: 'button', class: 'gc-btn', texto: c.ativo ? 'Desativar' : 'Reativar' });
        alternar.addEventListener('click', function () {
          if (c.ativo && !window.confirm('Desativar o acesso de ' + c.nome + '? As sessões abertas serão encerradas.')) return;
          chamar('PATCH', '/' + encodeURIComponent(c.id), { ativo: !c.ativo }).then(function (r) {
            if (!r.ok) return mostrar(r.corpo.erro || 'Não foi possível alterar a conta.', true);
            mostrar('Conta de ' + c.nome + (c.ativo ? ' desativada.' : ' reativada.'), false);
            carregar();
          });
        });
        botoes.push(alternar);
        var resetarMfa = el('button', { type: 'button', class: 'gc-btn', texto: 'Redefinir 2 etapas' });
        resetarMfa.addEventListener('click', function () {
          if (!window.confirm('Redefinir a verificação em duas etapas de ' + c.nome + '? As sessões abertas serão encerradas e a pessoa terá de configurá-la de novo.')) return;
          chamar('POST', '/' + encodeURIComponent(c.id) + '/mfa/resetar').then(function (r) {
            mostrar(r.ok ? r.corpo.mensagem : (r.corpo.erro || 'Não foi possível redefinir.'), !r.ok);
          });
        });
        botoes.push(resetarMfa);
        if (c.ativo) {
          var reenviar = el('button', { type: 'button', class: 'gc-btn', texto: 'Reenviar acesso' });
          reenviar.addEventListener('click', function () {
            chamar('POST', '/' + encodeURIComponent(c.id) + '/reenviar-acesso').then(function (r) {
              mostrar(r.ok ? 'Novo acesso enviado para ' + c.email + '.' : (r.corpo.erro || 'Não foi possível reenviar.'), !r.ok, r.ok ? r.corpo : null);
            });
          });
          botoes.push(reenviar);
        }
      } else {
        botoes.push(el('span', { class: 'gc-voce', texto: 'Você' }));
      }
      return el('tr', {}, [
        el('td', { texto: c.nome }),
        el('td', { texto: c.email }),
        el('td', {}, [situacao]),
        el('td', { class: 'gc-acoes' }, botoes)
      ]);
    }

    function carregar() {
      chamar('GET', '').then(function (r) {
        corpoTabela.textContent = '';
        if (!r.ok) { mostrar(r.corpo.erro || 'Não foi possível carregar a lista.', true); return; }
        if (!r.corpo.length) {
          corpoTabela.appendChild(el('tr', {}, [el('td', { colspan: '4', class: 'gc-vazio', texto: 'Nenhum ' + rotulo + ' cadastrado ainda.' })]));
          return;
        }
        r.corpo.forEach(function (c) { corpoTabela.appendChild(linha(c)); });
      });
    }

    formulario.addEventListener('submit', function (e) {
      e.preventDefault();
      botaoCriar.disabled = true;
      chamar('POST', '', { nome: campoNome.value.trim(), email: campoEmail.value.trim() }).then(function (r) {
        botaoCriar.disabled = false;
        if (!r.ok) return mostrar(r.corpo.erro || 'Não foi possível criar a conta.', true);
        formulario.reset();
        mostrar('Conta criada. Enviamos para ' + r.corpo.conta.email + ' o link para definir a senha.', false, r.corpo);
        carregar();
      }).catch(function () {
        botaoCriar.disabled = false;
        mostrar('Não conseguimos falar com o servidor. Tente novamente.', true);
      });
    });

    carregar();
  }

  window.GestaoContas = { montar: montar };
})();
