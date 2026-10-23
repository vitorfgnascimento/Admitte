/* Termos de privacidade (LGPD) em pop-up, compartilhado por login.html e ficha.html.
 *
 * Uso: coloque <p data-termos-privacidade="cadastro|ficha|contrato"></p> perto do
 * botão de continuar. O script escreve a frase "Ao continuar você concorda com as
 * políticas de privacidade e os termos de uso" e, ao lado, o link "Termos de
 * privacidade", que abre o pop-up com: finalidade da coleta, dados coletados,
 * base legal e consentimento, compartilhamento, retenção, direitos do titular
 * (LGPD, art. 18), segurança e contato. O conteúdo muda conforme o momento.
 *
 * O consentimento é dado ao continuar (botão do formulário). O servidor registra
 * data/hora, IP e a versão destes termos como evidência.
 */
(function () {
  'use strict';

  var VERSAO = 'v1.0';

  // Conteúdo específico de cada momento em que o consentimento é coletado.
  var MOMENTOS = {
    cadastro: {
      titulo: 'Termos de privacidade: criação da conta',
      finalidade: 'Criar e manter o seu acesso à plataforma de admissão digital, identificar você com segurança e permitir que o RH da empresa contratante acompanhe o seu processo admissional.',
      dados: [
        'Nome completo, e-mail, data de nascimento e CPF informados no cadastro.',
        'Senha (guardada somente em forma criptografada, nunca em texto legível).',
        'Se você entrar com o Google: nome, e-mail e foto da conta Google.',
        'Registros de acesso: endereço IP, data e hora do cadastro e do aceite destes termos.'
      ],
      base: 'Consentimento (LGPD, art. 7º, I) e procedimentos preliminares relacionados a contrato do qual você é parte (art. 7º, V).',
      consentimento: 'Ao criar a conta, você consente com o tratamento dos dados do cadastro para a finalidade acima. Você pode não fornecer o consentimento; nesse caso a conta não é criada e não será possível participar do processo pela plataforma.'
    },
    ficha: {
      titulo: 'Termos de privacidade: envio da ficha e dos documentos',
      finalidade: 'Análise do processo admissional: validação cadastral e documental, comunicação com você durante o processo, decisão do RH e cumprimento de obrigações legais e trabalhistas da empresa contratante.',
      dados: [
        'Dados pessoais da ficha: nome, data de nascimento, CPF, gênero, e-mail, telefone/WhatsApp e endereço (CEP, logradouro, bairro, número e complemento).',
        'Documentos em PDF que você anexar: identidade, CPF, comprovante de residência, comprovante de escolaridade, certificado de reservista (quando exigido) e carteira de trabalho.',
        'Mensagens trocadas com o RH no chat da ficha.',
        'Registros de segurança: endereço IP, data e hora do envio e do aceite destes termos.'
      ],
      base: 'Consentimento (LGPD, art. 7º, I e art. 11, I, para dados pessoais sensíveis eventualmente contidos nos documentos), procedimentos preliminares relacionados a contrato (art. 7º, V) e cumprimento de obrigação legal ou regulatória (art. 7º, II).',
      consentimento: 'Ao enviar esta ficha e os documentos anexados, você autoriza expressamente a coleta, o armazenamento e o tratamento das suas informações pessoais e dos documentos de identificação para fins exclusivos de análise do processo admissional, validação cadastral e cumprimento de obrigações legais e trabalhistas, nos termos dos arts. 7º e 11 da LGPD (Lei nº 13.709/2018). Você pode não fornecer o consentimento, mas então não será possível concluir a admissão por este meio.'
    },
    contrato: {
      titulo: 'Termos de privacidade: assinatura eletrônica dos contratos',
      finalidade: 'Registrar a assinatura eletrônica simples dos documentos de contratação (contrato de trabalho, termo de confidencialidade e política de privacidade) e comprovar, com segurança, quem assinou, quando e com qual versão do documento.',
      dados: [
        'Nome e CPF constantes da sua ficha.',
        'Data e hora de cada aceite e da conclusão da assinatura.',
        'Endereço IP de origem.',
        'Código (hash SHA-256) do conteúdo exato dos documentos aceitos.'
      ],
      base: 'Cumprimento de obrigação legal ou regulatória e execução de contrato (LGPD, art. 7º, II e V). A validade da assinatura eletrônica decorre da MP nº 2.200-2/2001 e da Lei nº 14.063/2020.',
      consentimento: 'Ao concluir a admissão, você declara estar ciente de que o registro do seu IP, da data/hora e do hash dos documentos constitui assinatura eletrônica válida, e que esses metadados são mantidos sob guarda para cumprimento de obrigação legal e contratual (LGPD, art. 7º, II e V).'
    }
  };

  var DIREITOS = [
    'confirmação de que realizamos tratamento dos seus dados (art. 18, I);',
    'acesso aos dados (art. 18, II);',
    'correção de dados incompletos, inexatos ou desatualizados (art. 18, III);',
    'anonimização, bloqueio ou eliminação de dados desnecessários, excessivos ou tratados em desconformidade com a lei (art. 18, IV);',
    'portabilidade dos dados (art. 18, V);',
    'eliminação dos dados tratados com o seu consentimento (art. 18, VI);',
    'informação sobre com quais entidades públicas e privadas os dados foram compartilhados (art. 18, VII);',
    'informação sobre a possibilidade de não fornecer consentimento e sobre as consequências da negativa (art. 18, VIII);',
    'revogação do consentimento, a qualquer momento (art. 18, IX e art. 8º, § 5º).'
  ];

  var fundo = null;
  var caixa = null;
  var ultimoFoco = null;
  var emailContato = null;

  function el(tag, props, filhos) {
    var n = document.createElement(tag);
    Object.keys(props || {}).forEach(function (k) {
      if (k === 'texto') n.textContent = props[k]; else n.setAttribute(k, props[k]);
    });
    (filhos || []).forEach(function (f) { if (f) n.appendChild(f); });
    return n;
  }

  function secao(titulo, conteudo) {
    return el('section', { class: 'termos-secao' }, [el('h3', { texto: titulo })].concat(conteudo));
  }

  function lista(itens) {
    return el('ul', {}, itens.map(function (i) { return el('li', { texto: i }); }));
  }

  function paragrafo(texto) {
    return el('p', { texto: texto });
  }

  function montarConteudo(momento) {
    var m = MOMENTOS[momento] || MOMENTOS.cadastro;
    var contato = el('p', {}, [
      document.createTextNode('Para exercer seus direitos ou tirar dúvidas, procure o RH da empresa contratante'),
      emailContato ? document.createTextNode(' pelo e-mail ') : document.createTextNode('.'),
      emailContato ? el('a', { href: 'mailto:' + emailContato, texto: emailContato }) : null,
      emailContato ? document.createTextNode('.') : null
    ]);

    return [
      secao('Quem trata os seus dados', [paragrafo('O tratamento é realizado pela empresa contratante, por meio do seu RH, que decide a finalidade e os meios do tratamento (controlador). A plataforma Onboarding Digital atua em nome dela, como ferramenta de apoio (operador).')]),
      secao('Por que coletamos os seus dados', [paragrafo(m.finalidade)]),
      secao('Quais dados são coletados', [lista(m.dados)]),
      secao('Base legal', [paragrafo(m.base)]),
      secao('Consentimento', [el('p', { class: 'termos-consentimento', texto: m.consentimento })]),
      secao('Dados pessoais sensíveis', [paragrafo('Os documentos enviados podem conter dados pessoais sensíveis (por exemplo, informações da carteira de trabalho ou do certificado de reservista). Eles são tratados somente para a finalidade acima, com acesso restrito à equipe de RH autorizada (LGPD, art. 11).')]),
      secao('Com quem os dados são compartilhados', [
        lista([
          'Equipe de RH da empresa contratante, para conduzir o processo.',
          'Prestadores de serviço de tecnologia que hospedam e operam a plataforma (banco de dados, armazenamento de arquivos, envio de e-mails).',
          'Google, apenas se você escolher entrar com a conta Google; e serviço de consulta de CEP, que recebe somente o CEP digitado.'
        ]),
        paragrafo('Não vendemos os seus dados nem os usamos para publicidade.')
      ]),
      secao('Transferência internacional', [paragrafo('Alguns prestadores podem armazenar dados em servidores fora do Brasil. Nesses casos, a transferência observa o art. 33 da LGPD e as salvaguardas contratuais do prestador.')]),
      secao('Por quanto tempo guardamos', [paragrafo('Pelo tempo necessário para conduzir o processo admissional e cumprir obrigações legais, trabalhistas e de comprovação. Depois disso, os dados são eliminados ou anonimizados, salvo quando a lei exigir a guarda por mais tempo.')]),
      secao('Segurança', [paragrafo('Senhas criptografadas, acesso restrito por perfil, links temporários para abrir documentos, limite de tentativas de acesso e registro de ações relevantes (data, hora e IP).')]),
      secao('Seus direitos como titular (LGPD, art. 18)', [
        paragrafo('Você pode solicitar, a qualquer momento e mediante requisição:'),
        lista(DIREITOS),
        paragrafo('Você também pode peticionar à Autoridade Nacional de Proteção de Dados (ANPD) e se opor a tratamento realizado em desconformidade com a lei. Este sistema não toma decisões exclusivamente automatizadas sobre você.'),
        contato
      ]),
      secao('Termos de uso (resumo)', [
        lista([
          'Use a plataforma apenas para o seu processo admissional e informe dados verdadeiros e atualizados.',
          'Mantenha a sua senha em sigilo; ações feitas com o seu acesso são de sua responsabilidade.',
          'Não tente acessar dados de outras pessoas nem comprometer a segurança do sistema.',
          'O RH pode recusar documentos e solicitar correções; a decisão final do processo é da empresa contratante.',
          'Estes termos podem ser atualizados; a versão aceita por você fica registrada junto ao seu cadastro.'
        ])
      ]),
      el('p', { class: 'termos-versao' }, [
        document.createTextNode('Versão ' + VERSAO + ' · '),
        el('a', { href: '/politica-privacidade.html', target: '_blank', rel: 'noopener', texto: 'Ler a política de privacidade completa' }),
        document.createTextNode(' · '),
        el('a', { href: '/termos-de-uso.html', target: '_blank', rel: 'noopener', texto: 'Ler os termos de uso completos' })
      ])
    ];
  }

  function fechar() {
    if (!fundo) return;
    fundo.classList.remove('aberto');
    document.removeEventListener('keydown', aoTeclar, true);
    if (ultimoFoco && ultimoFoco.focus) ultimoFoco.focus();
  }

  function aoTeclar(e) {
    if (e.key === 'Escape') { e.stopPropagation(); fechar(); }
  }

  function abrir(momento) {
    ultimoFoco = document.activeElement;
    if (!fundo) {
      fundo = el('div', { class: 'termos-fundo' });
      fundo.addEventListener('click', function (e) { if (e.target === fundo) fechar(); });
      document.body.appendChild(fundo);
    }
    var m = MOMENTOS[momento] || MOMENTOS.cadastro;
    fundo.innerHTML = '';
    var botaoFechar = el('button', { type: 'button', class: 'termos-fechar', 'aria-label': 'Fechar', texto: 'Fechar' });
    botaoFechar.addEventListener('click', fechar);
    caixa = el('div', { class: 'termos-caixa', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'termosTitulo', tabindex: '-1' }, [
      el('div', { class: 'termos-topo' }, [el('h2', { id: 'termosTitulo', texto: m.titulo }), botaoFechar]),
      el('div', { class: 'termos-corpo' }, montarConteudo(momento)),
      el('div', { class: 'termos-rodape' }, [botaoFechar.cloneNode(true)])
    ]);
    caixa.querySelector('.termos-rodape .termos-fechar').addEventListener('click', fechar);
    caixa.querySelector('.termos-rodape .termos-fechar').textContent = 'Entendi';
    fundo.appendChild(caixa);
    fundo.classList.add('aberto');
    document.addEventListener('keydown', aoTeclar, true);
    caixa.focus();
  }

  function montarAviso(destino) {
    var momento = destino.getAttribute('data-termos-privacidade') || 'cadastro';
    destino.textContent = '';
    destino.appendChild(document.createTextNode('Ao continuar você concorda com as políticas de privacidade e os termos de uso. '));
    var link = el('a', { href: '/politica-privacidade.html', class: 'link-termos', role: 'button', texto: 'Termos de privacidade' });
    link.addEventListener('click', function (e) { e.preventDefault(); abrir(momento); });
    destino.appendChild(link);
  }

  function iniciar() {
    // E-mail de contato do RH (configurado no painel), quando existir.
    fetch('/api/configuracoes/publicas').then(function (r) { return r.ok ? r.json() : null; }).then(function (c) {
      var e = c && String(c.emailContatoRh || '').trim();
      if (e && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) emailContato = e;
    }).catch(function () { /* mantém o texto sem e-mail */ });
    Array.prototype.forEach.call(document.querySelectorAll('[data-termos-privacidade]'), montarAviso);
  }

  window.TermosPrivacidade = { abrir: abrir, versao: VERSAO };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', iniciar); else iniciar();
})();
