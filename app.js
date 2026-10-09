// Interface do PWA: questionário -> receita -> ajuste fino -> salvar/abrir/melhorar, e o mapa da máquina; tudo no aparelho (motor.js).
(() => {
  'use strict';
  const $ = s => document.querySelector(s);
  const NEUTRAS = ['tanto_faz', 'nenhum', 'nenhuma'];
  const CHAVE_RECEITAS = 'perfume.receitas.v1', CHAVE_MAQUINA = 'perfume.maquina', CHAVE_PROPRIA = 'perfume.minha_maquina.v1';
  const CHAVE_ESP = 'perfume.especialista.v1';                 // a última recomendação do nariz digital
  const PESADAS = new Set(['/api/compor', '/api/refinar']);       // dão um respiro para a tela pintar "Montando…" antes da conta
  const AJ = { mais_fresco: 'Mais fresco', menos_fresco: 'Menos fresco', mais_doce: 'Mais doce', menos_doce: 'Menos doce', mais_floral: 'Mais floral',
    mais_amadeirado: 'Mais amadeirado', mais_apimentado: 'Mais apimentado' };
  const POR = { ifra: 'limite da IFRA', frasco: 'o que cabe no frasco', estoque: 'estoque do vidro' };
  const CONFIANCA = { alta: 'alta', media: 'média' };
  const NIVEL = { erro: 'erro', aviso: 'aviso' };
  const ML_DO_FRASCO = new Map([[4.4, 5], [8.8, 10], [26.5, 30], [44, 50]]);      // massa final (g) -> ml, como na pergunta de volume
  const DILUICOES = [100, 50, 25, 10, 5, 2, 1, 0.5, 0.1];
  const fmt = n => Number(n).toLocaleString('pt-BR', { maximumFractionDigits: 1 });
  const plural = (n, um, varios) => n + ' ' + (n === 1 ? um : varios);
  const g3 = n => Number(n).toLocaleString('pt-BR', { minimumFractionDigits: 3, maximumFractionDigits: 3 });
  const data = iso => new Date(iso).toLocaleDateString('pt-BR');
  const estrelas = n => '★'.repeat(n) + '☆'.repeat(5 - n);
  let app, db, maquina = null, respostas = {}, candidatos = [], ajustes = [], pai = null, aberta = null, abaAtual = 'novo', rascunho = null;
  let tituloResultado = '';
  let cru = null;                                           // o dados.json como veio (o Banco não guarda o que o motor não usa; o nariz digital precisa da chave "especialista")
  let espDados = null, espRespostas = {};                   // especialista.json baixado na 1ª recomendação e as respostas das 11 perguntas
  let usandoBiblio = false, biblioPronta = false;           // a composição está usando os acordes da biblioteca (§2.18), e o biblioteca.json já baixado
  let vez = 0;                                              // cada tela nova ganha a vez; quem terminou depois de perdê-la não desenha por cima

  function el(t, a = {}, ...f) {
    const e = document.createElement(t);
    for (const [k, v] of Object.entries(a)) {
      if (k === 'class') e.className = v;
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
      else if (k.startsWith('aria-')) e.setAttribute(k, v);          // aria-* não é propriedade do elemento: sem isso o leitor de tela não vê o rótulo
      else e[k] = v;
    }
    f.flat().forEach(x => e.append(x));
    return e;
  }

  const lembrar = {
    ler(chave) { try { return localStorage.getItem(chave); } catch { return null; } },
    gravar(chave, valor) { try { localStorage.setItem(chave, valor); } catch { /* sem armazenamento: segue sem lembrar */ } },
  };
  const guardar = {
    ler() { try { return JSON.parse(localStorage.getItem(CHAVE_RECEITAS) || '[]'); } catch { return []; } },
    gravar(lista) { localStorage.setItem(CHAVE_RECEITAS, JSON.stringify(lista)); },
  };
  const propria = {
    ler() { try { return JSON.parse(localStorage.getItem(CHAVE_PROPRIA) || 'null'); } catch { return null; } },
    gravar(mapa) { if (mapa === null) localStorage.removeItem(CHAVE_PROPRIA); else localStorage.setItem(CHAVE_PROPRIA, JSON.stringify(mapa)); },
  };
  const calibracao = Calibracao.criar(lembrar);               // fatores mg/passo e densidades medidas por canal (docs/11 §2)

  async function api(rota, corpo) {
    if (PESADAS.has(rota)) await new Promise(r => setTimeout(r, 30));
    return app.chamar(rota, corpo);
  }
  const base = () => ({ maquina, respostas, tecnico: $('#tec').checked });
  const erro = e => $('#tela').replaceChildren(el('div', { class: 'card erro' }, e.message));

  function aviso(texto, ms, ...extra) {
    const a = $('#aviso');
    a.replaceChildren(texto, ...extra);
    a.hidden = false;
    if (ms) setTimeout(() => { a.hidden = true; }, ms);
  }

  function marcarAba(qual) {
    abaAtual = qual;
    for (const [nome, id] of [['novo', '#aba-novo'], ['receitas', '#aba-receitas'], ['mapa', '#aba-mapa'], ['imprimir', '#aba-imprimir']]) $(id).className = qual === nome ? '' : 'sec';
  }

  async function popularMaquinas(preferida) {
    const lista = (await api('/api/maquinas', {})).maquinas, s = $('#maq');
    s.replaceChildren(...lista.map(m => el('option', { value: m.id, textContent: m.nome })));
    s.value = [preferida, lembrar.ler(CHAVE_MAQUINA), 'minha', 'mvp-64'].find(id => id && lista.some(m => m.id === id)) || lista[0].id;
    maquina = s.value;
  }

  // ---------------------------------------------------------------------------------------------- questionário
  async function passo() {
    const minha = ++vez;
    candidatos = [];
    usandoBiblio = false;                       // questionário novo: começa nas sugestões do kit (a biblioteca é convite à parte)
    marcarAba('novo');
    const j = await api('/api/proxima', base());
    if (minha !== vez) return;
    $('#hist').replaceChildren(...j.caminho.map((c, i) => el('div', {}, c.pergunta + ' ', el('b', {}, c.respostas.join(', ')),
      el('button', { class: 'sec', onclick: () => { const novo = {}; j.caminho.slice(0, i).forEach(x => { novo[x.no] = respostas[x.no]; }); respostas = novo; passo(); } }, 'alterar'))));
    if (!j.pergunta) return compor();
    desenhar(j.pergunta, j.caminho.length === 0);        // na 1ª pergunta, o cartão do nariz digital dá o atalho das 11 perguntas
  }

  function desenhar(p, comNariz = false) {
    const sel = new Set(), inputs = [], msg = el('div', { class: 'erro' }), bt = el('button', { disabled: true }, 'Continuar');
    function mudou(i, o) {
      msg.textContent = '';
      if (p.tipo === 'unica') { sel.clear(); sel.add(o.id); }
      else if (i.checked) {
        if (NEUTRAS.includes(o.id)) { inputs.forEach(x => { if (x !== i) x.checked = false; }); sel.clear(); }
        else { inputs.forEach(x => { if (NEUTRAS.includes(x.value)) x.checked = false; }); NEUTRAS.forEach(n => sel.delete(n)); }
        sel.add(o.id);
        if (sel.size > p.max) { i.checked = false; sel.delete(o.id); msg.textContent = 'Escolha no máximo ' + p.max + '.'; }
      } else sel.delete(o.id);
      bt.disabled = sel.size === 0;
    }
    const linhas = p.opcoes.map(o => {
      const i = el('input', { type: p.tipo === 'unica' ? 'radio' : 'checkbox', name: 'op', value: o.id });
      i.onchange = () => mudou(i, o);
      inputs.push(i);
      return el('label', { class: 'op' }, i, o.rotulo);
    });
    bt.onclick = async () => {
      try { respostas = (await api('/api/responder', { maquina, respostas, no: p.id, escolhidas: [...sel] })).respostas; passo(); } catch (e) { msg.textContent = e.message; }
    };
    $('#tela').replaceChildren(...(comNariz ? [cartaoNariz()] : []),
      el('div', { class: 'card' }, el('h2', {}, p.titulo), p.tipo === 'multipla' ? el('div', { class: 'dica' }, 'Pode marcar até ' + p.max + '.') : '',
      ...linhas, msg, el('div', { class: 'linha' }, bt)));
  }

  // ---------------------------------------------------------------------------------------------- receitas sugeridas
  /* A outra fonte do compositor (docs/08 §2.18): os 9.180 acordes gerados do catálogo. Vêm do biblioteca.json,
   * baixado UMA vez quando a pessoa pede (o service worker guarda, como o especialista.json); nenhum deles foi
   * cheirado, então a tela avisa que são hipóteses — as sugestões do kit seguem sendo as primeiras. */
  async function carregarBiblioteca() {
    if (biblioPronta) return;
    const r = await fetch('biblioteca.json');
    if (!r.ok) throw new Error('HTTP ' + r.status);
    db.definir_biblioteca(await r.json());
    biblioPronta = true;
  }

  async function compor(bib = false) {
    const minha = ++vez;
    usandoBiblio = bib;
    $('#tela').replaceChildren(el('div', { class: 'card' }, bib ? (biblioPronta ? 'Consultando a biblioteca de acordes…'
      : 'Baixando a biblioteca de acordes — é uma vez só, depois fica guardada no aparelho…') : 'Montando seus perfumes…'));
    try {
      if (bib) await carregarBiblioteca();
      const j = await api('/api/compor', { ...base(), biblioteca: bib });
      if (minha !== vez) return;
      candidatos = j.candidatos;
      ajustes = j.ajustes;
      tituloResultado = candidatos.length ? ['Uma sugestão', 'Duas sugestões', 'Três sugestões'][candidatos.length - 1]
        + (bib ? ' da biblioteca' : ' para você') : '';
      resultado();
    } catch (e) {
      if (minha !== vez) return;
      if (bib) {
        $('#tela').replaceChildren(el('div', { class: 'card erro' }, 'Não consegui consultar a biblioteca de acordes (' + e.message
          + '). Conecte-se à internet uma vez para baixá-la.'),
          el('div', { class: 'linha' }, el('button', { onclick: () => compor(true) }, 'Tentar de novo'),
            el('button', { class: 'sec', onclick: () => compor(false) }, 'Voltar às sugestões do kit')));
      } else erro(e);
    }
  }

  function cartao(c, i, rotulo, acao) {
    const ing = el('table'), box = el('div', { class: 'card' });
    c.ingredientes.forEach(g => ing.append(el('tr', {}, el('td', {}, g.nome), el('td', {}, fmt(g.pct) + '%  ' + g3(g.gramas) + ' g'))));
    box.append(el('div', { class: 'linha' }, el('h2', { style: 'margin:0;flex:1' }, (i === null ? '' : (i + 1) + '. ') + c.titulo),
      c.valido ? el('span', { class: 'badge' }, 'pronto para fazer') : el('span', { class: 'badge ruim' }, 'não validado')),
    ...(c.alergias.length ? [el('p', { class: 'alerta', role: 'alert' },
      'Você disse ter alergia ou sensibilidade a ' + c.alergias.join(', ') + ' e ' + (c.alergias.length === 1 ? 'ele está' : 'eles estão') + ' nesta receita.')] : []),
    ...(!c.valido && c.motivos.length ? [el('p', { class: 'falta' }, 'Por que ainda não dá para fazer: ' + c.motivos.join('; ') + '.')] : []),
    el('p', { class: 'dica' }, c.descricao.replace(/(\d)\.(\d)/g, '$1,$2') + ' Concentração ' + fmt(c.concentracao_pct) + '%.'),
    ...c.perfil.map(f => el('div', {}, el('div', { class: 'fam' }, el('span', {}, f.familia), el('span', {}, fmt(f.pct) + '%')),
      el('div', { class: 'barra' }, el('i', { style: 'width:' + f.pct + '%' })))),
    el('details', {}, el('summary', {}, 'Ingredientes'), ing));
    if (c.cuidados.length) box.append(blocoCuidados(c.cuidados, !!c.tecnico));
    (c.faltando || []).forEach(f => box.append(el('p', { class: 'falta' },
      'Esta máquina não tem ' + f.nome + (f.equivalentes.length ? ' (parecidos que ela tem: ' + f.equivalentes.join(', ') + ')' : '') + '.')));
    c.escolhas.forEach(e => box.append(el('p', { class: 'dica' }, 'Você pode trocar em "' + e.item + '": ' + e.opcoes.join(', ') + '.')));
    if (c.acorde_biblioteca) box.append(el('p', { class: 'dica' },
      el('span', { class: 'chip atencao' }, 'acorde da biblioteca'),
      ' Ninguém cheirou este acorde ainda: é uma hipótese para cheirar — ',
      el('a', { href: 'catalogo.html?acorde=' + encodeURIComponent(c.acorde_biblioteca.id) }, 'ver no catálogo')));
    if (c.tecnico) box.append(blocoTecnico(c.tecnico));
    if (acao) box.append(el('div', { class: 'linha', style: 'margin-top:8px' }, el('button', { onclick: acao }, rotulo)));
    return box;
  }

  /* O que reage ou escurece na mistura (regras com fonte, motor/quimica.py). Só avisa; abre sozinho quando algo pede atenção e,
   * no modo técnico, mostra a fonte de cada regra com a citação literal. */
  function blocoCuidados(lista, tecnico) {
    const fonte = f => el('li', {}, el('a', { href: f.url, target: '_blank', rel: 'noopener' }, new URL(f.url).hostname.replace(/^www\./, '')),
      ' (visto em ' + f.visto_em.split('-').reverse().join('/') + '): “' + f.trecho + '”' + (f.nota ? ' — ' + f.nota : ''));
    return el('details', { class: 'cuidados', open: lista.some(x => x.gravidade === 'atencao') },
      el('summary', {}, 'Cuidados com a mistura (' + lista.length + ')'),
      ...lista.map(x => el('div', { class: 'cuidado ' + x.gravidade },
        el('b', {}, x.titulo), el('div', {}, x.texto), el('div', { class: 'dica' }, 'Na sua receita: ' + x.materiais.join(', ') + '. O que fazer: ' + x.dica),
        tecnico ? el('details', {}, el('summary', {}, 'Fontes (confiança ' + CONFIANCA[x.confianca] + ')'), el('ul', {}, ...x.fontes.map(fonte))) : '')));
  }

  /* Modo técnico: o que o motor decidiu, em blocos que se leem; o JSON que a máquina recebe fica atrás de um botão, nunca na tela. */
  function blocoTecnico(t) {
    const itens = (lista, vazio) => lista.length ? el('ul', {}, ...lista.map(x => el('li', {}, x))) : el('p', { class: 'dica' }, vazio);
    const copiado = el('span', { class: 'dica', role: 'status' });
    const copiar = el('button', { class: 'sec', onclick: async () => {
      try { await navigator.clipboard.writeText(JSON.stringify(t.job)); copiado.textContent = 'Copiado.'; } catch { copiado.textContent = 'Este navegador não deixou copiar.'; }
    } }, 'Copiar para a máquina');
    return el('details', { class: 'tecnico' }, el('summary', {}, 'Técnico'),
      el('h3', {}, 'Como o motor montou'), itens(t.explicacao, 'Sem detalhes.'),
      el('h3', {}, 'Limites que agiram'), itens(t.avisos, 'Nenhum limite precisou agir.'),
      el('h3', {}, 'Trocas de ingrediente'), itens(t.trocas, 'Nenhuma: todos os materiais vieram como o acorde pede.'),
      el('h3', {}, 'Conferência da máquina'),
      t.violacoes.length ? el('ul', {}, ...agruparConferencias(t.violacoes).map(g => el('li', { class: 'nivel-' + g.nivel }, el('b', {}, NIVEL[g.nivel] || g.nivel),
        ': ' + (g.nomes.length > 1 ? g.resto + ' — ' + g.nomes.join(', ') : (g.nomes[0] ? g.nomes[0] + ': ' : '') + g.resto))))
        : el('p', { class: 'ok' }, '✔ Passou em todas as conferências da máquina (vidros, dose mínima, estoque, lote e IFRA).'),
      el('h3', {}, 'Dosagem, vidro por vidro'), tabelaDeDosagem(t.job.itens),
      el('div', { class: 'linha', style: 'margin-top:8px' }, copiar, copiado));
  }

  /* A mesma frase para vários ingredientes ("estoque não conferido" repetido 12 vezes) vira uma linha só, com os nomes depois dela. */
  function agruparConferencias(violacoes) {
    const grupos = new Map();
    for (const v of violacoes) {
      const i = v.mensagem.indexOf(': '), nome = i > 0 ? v.mensagem.slice(0, i) : '', resto = i > 0 ? v.mensagem.slice(i + 2) : v.mensagem;
      const chave = v.nivel + '|' + v.codigo + '|' + resto;
      if (!grupos.has(chave)) grupos.set(chave, { nivel: v.nivel, resto, nomes: [] });
      if (nome) grupos.get(chave).nomes.push(nome);
    }
    return [...grupos.values()];
  }

  function tabelaDeDosagem(itens) {
    const total = itens.reduce((s, i) => s + i.gramas, 0);
    return el('table', { class: 'dosagem' }, el('thead', {}, el('tr', {}, el('th', { scope: 'col' }, 'Vidro nº'), el('th', { scope: 'col' }, 'Material'), el('th', { scope: 'col' }, 'Gramas'))),
      el('tbody', {}, ...itens.map(i => el('tr', {}, el('td', {}, String(i.canal)), el('td', {}, i.material), el('td', {}, g3(i.gramas))))),
      el('tfoot', {}, el('tr', {}, el('td', { colSpan: 2 }, 'Total dosado'), el('td', {}, g3(total)))));
  }

  /* Imprimir: a receita COMO ESTÁ AGORA (com as quantidades que a pessoa mexeu no ajuste fino). A conta é refeita pelo motor com `novos` vazio,
   * para a folha trazer a dosagem por vidro mesmo com o modo técnico desligado; o que se imprime é o que o motor valida neste instante. */
  async function imprimir(c, respostasDaReceita, frascoRotulo) {
    const j = await api('/api/ajustar', { maquina, respostas: respostasDaReceita, itens: c.formula, novos: {}, massa_final_g: c.massa_final_g, nome: c.titulo, tecnico: true });
    const x = j.candidato, frasco = frascoRotulo || (ML_DO_FRASCO.has(x.massa_final_g) ? ML_DO_FRASCO.get(x.massa_final_g) + ' ml (' + fmt(x.massa_final_g) + ' g)' : fmt(x.massa_final_g) + ' g');
    const soAromas = x.ingredientes.reduce((s, i) => s + i.gramas, 0);
    $('#folha').replaceChildren(
      el('h1', {}, x.titulo),
      el('p', { class: 'selo ' + (x.valido ? 'pronta' : 'nao') }, x.valido ? 'PRONTA PARA FAZER' : 'NÃO VALIDADA: ' + x.motivos.join('; ')),
      el('p', {}, 'Máquina: ' + db.maquinas.get(maquina).nome + ' · Frasco: ' + frasco + ' · Concentração: ' + fmt(x.concentracao_pct) + '% · ' + new Date().toLocaleDateString('pt-BR')),
      ...(x.alergias.length ? [el('p', { class: 'selo nao' }, 'ALERGIA DECLARADA nesta receita: ' + x.alergias.join(', '))] : []),
      el('h2', {}, 'Ingredientes'),
      el('table', {}, el('thead', {}, el('tr', {}, el('th', {}, 'Ingrediente'), el('th', {}, '% do concentrado'), el('th', {}, 'Gramas'))),
        el('tbody', {}, ...x.ingredientes.map(i => el('tr', {}, el('td', {}, i.nome), el('td', {}, fmt(i.pct) + '%'), el('td', {}, g3(i.gramas))))),
        el('tfoot', {}, el('tr', {}, el('td', {}, 'Total do concentrado'), el('td', {}, '100%'), el('td', {}, g3(soAromas))))),
      el('h2', {}, 'Dosagem na máquina, vidro por vidro'), tabelaDeDosagem(x.tecnico.job.itens),
      ...(x.cuidados.length ? [el('h2', {}, 'Cuidados com a mistura (' + x.cuidados.length + ')'),
        el('ul', {}, ...x.cuidados.map(k => el('li', {}, el('b', {}, k.titulo + '. '), k.dica)))] : []),
      el('h2', {}, 'Depois de fazer'), el('p', {}, 'Cheirou? Nota de 1 a 5: ______    Anotações: ______________________________________________'),
      el('p', { class: 'rodape-folha' }, 'Calculado no aparelho, sem internet. As proporções são hipóteses de partida: cheire antes de usar.'));
    window.print();
  }

  function botaoImprimir(obter, respostasDaReceita, antes = async () => {}) {
    const msg = el('span', { class: 'dica', role: 'status' });
    return [el('button', { class: 'sec', onclick: async () => {
      msg.textContent = '';
      try { await antes(); await imprimir(obter(), respostasDaReceita()); } catch (e) { msg.textContent = 'Não consegui preparar a impressão: ' + e.message; }
    } }, 'Imprimir'), msg];
  }

  function resultado() {
    const t = $('#tela');
    if (!candidatos.length) { t.replaceChildren(el('div', { class: 'card' }, 'Nenhum perfume possível com esse pedido nesta máquina. Tente alterar alguma resposta acima.')); return; }
    const avisoBiblio = usandoBiblio ? [el('div', { class: 'card nariz' }, el('h2', {}, 'Sugestões da biblioteca'),
      el('p', { class: 'dica' }, 'Estas receitas montam com os ' + (biblioPronta ? db.biblioteca.acordes.length.toLocaleString('pt-BR') : '9.180')
        + ' acordes da biblioteca — combinações criadas por regra sobre os mesmos vidros da máquina. Ninguém as cheirou ainda: são hipóteses para experimentar, como as previsões do nariz digital.'))] : [];
    t.replaceChildren(el('h2', {}, tituloResultado), ...avisoBiblio, ...candidatos.map((c, i) => cartao(c, i, 'Quero este', () => feito(c))),
      el('div', { class: 'linha' },
        el('button', { class: 'sec', onclick: () => compor(!usandoBiblio) }, usandoBiblio ? 'Voltar às sugestões do kit' : 'Ver opções da biblioteca'),
        el('button', { class: 'sec', onclick: () => { respostas = {}; pai = null; passo(); } }, 'Começar de novo')));
  }

  // ---------------------------------------------------------------------------------------------- ajuste fino por ingrediente
  /* Uma barra por ingrediente, de zero até o limite da IFRA, o estoque do vidro ou o que cabe no frasco (o que vier primeiro).
   * O etanol completa o resto. Tudo é calculado pelo motor (/api/ajustar); aqui só se desenha e se pede de novo a cada mudança. */
  function painelAjuste(c, aoMudar) {
    let atual = c.formula, lim = null, serie = 0, espera = null, pendente = null, emVoo = Promise.resolve(), evitados = new Set();      // evitados: ids dos materiais a que a pessoa declarou alergia
    const linhas = new Map(), lista = el('div'), resumo = el('p', { class: 'dica ajuste-resumo' }), problemas = el('div', { class: 'erro' }), avisos = el('div', { class: 'dica' });
    const seletor = el('select', { 'aria-label': 'Ingrediente para acrescentar', onchange: () => { acrescentar(); seletor.value = ''; } });
    const encaixar = (v, x) => (v < x.min_dose_g / 2 ? 0 : v < x.min_dose_g ? x.min_dose_g : v);      // abaixo da dose mínima a máquina não dosa: zero ou o mínimo

    function criarLinha(x) {
      const barra = el('input', { type: 'range', min: 0, max: x.max_g, step: 0.001, value: x.gramas, 'aria-label': x.nome });
      const valor = el('output', {}, g3(x.gramas) + ' g'), dica = el('div', { class: 'dica' });
      const row = el('div', { class: 'ajuste-linha' }, el('div', { class: 'linha' }, el('b', { style: 'flex:1' }, x.nome), valor), barra, dica);
      barra.oninput = () => {
        valor.textContent = g3(barra.valueAsNumber) + ' g';
        pendente = { [x.material_id]: encaixar(barra.valueAsNumber, linhas.get(x.material_id).x) };
        clearTimeout(espera);
        espera = setTimeout(enviar, 40);
      };
      linhas.set(x.material_id, { row, barra, valor, dica, x });
      lista.append(row);
    }

    function atualizar() {
      for (const x of lim.ingredientes) {
        if (!linhas.has(x.material_id) && x.gramas > 0) criarLinha(x);
        const l = linhas.get(x.material_id);
        if (!l) continue;
        l.x = x;
        l.barra.max = x.max_g;
        if (document.activeElement !== l.barra) l.barra.value = x.gramas;
        l.valor.textContent = g3(x.gramas) + ' g';
        const acima = x.gramas > x.max_g + 1e-9;
        l.row.classList.toggle('acima', acima);
        const alergico = evitados.has(x.material_id) && x.gramas > 0;
        l.row.classList.toggle('alergia', alergico);
        l.dica.textContent = (acima ? 'acima do limite: ' + g3(x.max_g) + ' g (' + POR[x.limitado_por] + ')' : 'até ' + g3(x.max_g) + ' g (' + POR[x.limitado_por] + ')')
          + (alergico ? ' · você disse ter alergia a este ingrediente' : '');
        l.barra.disabled = x.max_g <= 0 && x.gramas <= 0;
      }
      const fora = lim.ingredientes.filter(x => !linhas.has(x.material_id)), porFamilia = new Map();
      fora.forEach(x => porFamilia.set(x.familia || 'outros', (porFamilia.get(x.familia || 'outros') || []).concat([x])));
      seletor.replaceChildren(el('option', { value: '' }, 'Acrescentar ingrediente…'),
        ...[...porFamilia].map(([f, xs]) => el('optgroup', { label: f }, ...xs.map(x => el('option', { value: x.material_id }, x.nome + (evitados.has(x.material_id) ? ' (você tem alergia)' : ''))))));
      seletor.disabled = !fora.length;
      resumo.textContent = 'Etanol: ' + g3(lim.folga_g) + ' g (completa o frasco de ' + fmt(lim.massa_final_g) + ' g)';
    }

    /* Manda ao motor o último pedido de barra que ainda não foi e espera a resposta. Salvar e Imprimir passam por aqui: nunca levam a receita de antes do ajuste. */
    function enviar() {
      clearTimeout(espera);
      espera = null;
      if (pendente) { const novos = pendente; pendente = null; emVoo = pedir(novos); }
      return emVoo;
    }

    async function pedir(novos) {
      const minha = ++serie;
      try {
        const j = await api('/api/ajustar', { maquina, respostas, itens: atual, novos, massa_final_g: c.massa_final_g, nome: c.titulo, tecnico: $('#tec').checked });
        if (minha !== serie) return;
        atual = j.candidato.formula;
        lim = j.limites;
        evitados = new Set(j.evitados);
        atualizar();
        problemas.replaceChildren(...j.problemas.map(p => el('div', {}, p)), ...j.candidato.faltando.map(f => el('div', {}, 'Esta máquina não tem ' + f.nome + '.')));
        avisos.replaceChildren(...j.avisos.map(a => el('div', {}, a)));
        aoMudar(j.candidato);
      } catch (e) { if (minha === serie) problemas.replaceChildren(e.message); }
    }

    function acrescentar() {
      const x = lim && lim.ingredientes.find(i => String(i.material_id) === seletor.value);
      if (!x) return;
      criarLinha(x);
      atualizar();
      linhas.get(x.material_id).barra.focus();
    }

    emVoo = pedir({});
    const raiz = el('div', {}, el('p', { class: 'dica' }, 'Cada barra vai de zero até o limite da IFRA ou o que cabe no frasco, o que vier primeiro. O etanol completa o resto.'),
      resumo, lista, el('div', { class: 'linha', style: 'margin-top:8px' }, seletor), problemas, avisos);
    raiz.aguardar = enviar;
    return raiz;
  }

  function feito(c) {
    let nota = 0, atualC = c;
    const t = $('#tela'), com = el('textarea', { rows: 2, placeholder: 'O que achou? (opcional)' }), msg = el('div', { class: 'dica' });
    const topo = el('div', {}, cartao(c, null)), titulo = el('h2', {}, c.titulo);
    const bs = [1, 2, 3, 4, 5].map(n => el('button', { class: 'sec', onclick: () => { nota = n; bs.forEach((b, k) => b.classList.toggle('sel', k < n)); } }, String(n)));
    const ref = el('div', { class: 'linha' }, ...ajustes.map(a => el('button', { class: 'sec', onclick: async () => {
      const minha = ++vez;
      try {
        const j = await api('/api/refinar', { ...base(), protagonista_id: c.protagonista_id, ajuste: a });
        if (minha !== vez) return;
        candidatos = [j.candidato];
        tituloResultado = 'Receita refeita';
        resultado();
      } catch (e) { msg.textContent = e.message; }
    } }, AJ[a] || a)));
    const fino = el('details', { class: 'card' }, el('summary', {}, 'Ajuste fino das quantidades (opcional)'));
    let painel = null;
    fino.addEventListener('toggle', () => {                                // só monta o painel quando a pessoa abre
      if (fino.open && !fino.dataset.pronto) {
        fino.dataset.pronto = '1';
        painel = painelAjuste(c, nc => { atualC = nc; titulo.textContent = nc.titulo; topo.replaceChildren(cartao(nc, null)); });
        fino.append(painel);
      }
    });
    const aguardarAjuste = async () => { if (painel) await painel.aguardar(); };
    async function salvar() {
      await aguardarAjuste();
      if (!nota) { msg.textContent = 'Escolha uma nota de 1 a 5.'; return; }
      try {
        const j = await api('/api/salvar', { maquina, respostas, nome: atualC.titulo, itens: atualC.formula, massa_final_g: atualC.massa_final_g,
          protagonista_id: c.protagonista_id, pai_id: pai, nota, comentario: com.value });
        pai = j.id;
        msg.textContent = 'Receita salva. Ela está em "Minhas receitas".';
        if (navigator.storage && navigator.storage.persist) navigator.storage.persist();     // pede ao navegador para não apagar as receitas sozinho
      } catch (e) { msg.textContent = e instanceof Motor.ErroDeUso ? e.message : 'Não consegui salvar neste navegador: ' + e.message; }
    }
    t.replaceChildren(titulo, topo, fino, el('div', { class: 'card' }, el('h2', {}, 'Faça, cheire e conte como ficou'),
      el('div', { class: 'dica' }, 'Sua nota ajuda a melhorar a receita.'), el('div', { class: 'linha notas' }, ...bs), com,
      el('div', { class: 'linha', style: 'margin-top:8px' }, el('button', { onclick: salvar }, 'Salvar receita'), ...botaoImprimir(() => atualC, () => respostas, aguardarAjuste)), msg),
    el('div', { class: 'card' }, el('h2', {}, 'Quer mudar o estilo?'), ref),
    el('div', { class: 'linha' }, el('button', { class: 'sec', onclick: resultado }, 'Voltar às sugestões')));
  }

  // ---------------------------------------------------------------------------------------------- minhas receitas
  async function listar() {
    const minha = ++vez;
    aberta = null;
    marcarAba('receitas');
    $('#hist').replaceChildren();
    const t = $('#tela'), j = await api('/api/receitas', {});
    if (minha !== vez) return;
    const arquivo = el('input', { type: 'file', accept: 'application/json,.json', hidden: true });
    arquivo.onchange = () => importar(arquivo.files[0]);
    const rodape = el('div', { class: 'linha', style: 'margin-top:12px' }, el('button', { class: 'sec', onclick: exportar }, 'Exportar receitas'),
      el('button', { class: 'sec', onclick: () => arquivo.click() }, 'Importar receitas'), arquivo);
    if (!j.receitas.length) {
      t.replaceChildren(el('div', { class: 'card' }, 'Você ainda não salvou nenhuma receita. Monte um perfume em "Novo perfume", faça, cheire e salve com uma nota.'), rodape);
      return;
    }
    t.replaceChildren(el('h2', {}, 'Minhas receitas'), ...j.receitas.map(r => el('div', { class: 'card' },
      el('div', { class: 'linha' }, el('h2', { style: 'margin:0;flex:1' }, r.nome), el('span', { class: 'estrelas' }, estrelas(r.nota))),
      el('p', { class: 'dica' }, data(r.criada_em) + (r.comentario ? ' — ' + r.comentario : '')),
      el('div', { class: 'linha' }, el('button', { onclick: () => abrir(r.id) }, 'Abrir')))), rodape);
  }

  async function abrir(id) {
    const minha = ++vez;
    aberta = id;
    marcarAba('receitas');
    $('#hist').replaceChildren();
    try {
      const j = await api('/api/receita', { id, maquina, tecnico: $('#tec').checked }), r = j.receita;
      if (minha !== vez) return;
      let certeza = false;
      const bExcluir = el('button', { class: 'sec', onclick: async () => {
        if (!certeza) { certeza = true; bExcluir.textContent = 'Toque de novo para excluir'; bExcluir.classList.add('ruim'); return; }
        await api('/api/excluir', { id }); listar();
      } }, 'Excluir');
      const ajustarQuantidades = () => { respostas = r.respostas; pai = r.id; ajustes = j.ajustes; aberta = null; $('#hist').replaceChildren(); marcarAba('novo'); feito(j.candidato); };
      $('#tela').replaceChildren(el('div', { class: 'linha' }, el('button', { class: 'sec', onclick: listar }, '← Minhas receitas')), cartao(j.candidato, null),
        el('div', { class: 'card' }, el('div', { class: 'estrelas' }, estrelas(r.nota)), el('p', { class: 'dica' }, 'Salva em ' + data(r.criada_em) + (r.comentario ? ': ' + r.comentario : '')),
          el('div', { class: 'linha' }, el('button', { onclick: ajustarQuantidades }, 'Ajustar quantidades e salvar como nova versão'), ...botaoImprimir(() => j.candidato, () => r.respostas))),
        el('div', { class: 'card' }, el('h2', {}, 'Quer melhorar?'), el('div', { class: 'dica' }, 'Cada botão refaz a receita mantendo o perfume e mexendo só nisso.'),
          el('div', { class: 'linha' }, ...j.ajustes.map(a => el('button', { class: 'sec', onclick: () => melhorar(j, a) }, AJ[a] || a)))),
        el('div', { class: 'linha' }, bExcluir));
    } catch (e) { erro(e); }
  }

  async function melhorar(j, ajuste) {
    respostas = j.receita.respostas;
    pai = j.receita.id;
    ajustes = j.ajustes;
    const minha = ++vez;
    try {
      const novo = (await api('/api/refinar', { ...base(), protagonista_id: j.receita.protagonista_id, ajuste })).candidato;
      if (minha !== vez) return;
      candidatos = [novo];
      tituloResultado = 'Receita refeita';
      $('#hist').replaceChildren();
      marcarAba('novo');
      resultado();
    } catch (e) { if (minha === vez) erro(e); }
  }

  function baixar(nome, texto) {
    const link = el('a', { href: URL.createObjectURL(new Blob([texto], { type: 'application/json' })), download: nome });
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  }

  async function exportar() {
    baixar('receitas-perfume.json', JSON.stringify(await api('/api/exportar', {}), null, 1));
  }

  async function importar(arquivo) {
    if (!arquivo) return;
    try {
      const j = await api('/api/importar', { conteudo: JSON.parse(await arquivo.text()) });
      aviso(j.importadas + ' receita(s) importada(s)' + (j.ignoradas ? ', ' + j.ignoradas + ' já existiam ou eram inválidas' : '') + '.', 6000);
      listar();
    } catch (e) { aviso(e instanceof SyntaxError ? 'Esse arquivo não é de receitas.' : e.message, 6000); }
  }

  // ---------------------------------------------------------------------------------------------- minha máquina (o que há em cada vidro)
  async function telaMapa() {
    const minha = ++vez;
    aberta = null;
    marcarAba('mapa');
    $('#hist').replaceChildren();
    const j = await api('/api/mapa', {});
    if (minha !== vez) return;
    if (!rascunho) rascunho = j.mapa ? structuredClone(j.mapa) : { nome: 'Minha máquina', canais: [] };
    desenharMapa(j);
  }

  function desenharMapa(j) {
    const nomeDe = id => (db.materiais.get(id) ? db.materiais.get(id).nome : '');
    const painel = el('div', { class: 'card' }), grade = el('div'), msg = el('div', { class: 'erro' });
    let espera = null, serie = 0;
    const proximoNumero = () => rascunho.canais.reduce((m, c) => Math.max(m, c.canal), -1) + 1;

    async function conferir() {
      const minha = ++serie;
      const v = await api('/api/mapa/validar', { mapa: rascunho });
      if (minha !== serie) return;
      salvarBt.disabled = v.erros.length > 0;
      painel.replaceChildren(
        ...v.erros.map(e => el('div', { class: 'erro' }, e)), ...v.avisos.map(a => el('div', { class: 'dica' }, '⚠ ' + a)),
        v.resumo ? el('div', { class: 'ok' }, 'Com este mapa: ' + plural(v.resumo.acordes, 'acorde', 'acordes') + ' (de ' + v.resumo.acordes_do_motor + '), '
          + plural(v.resumo.notas, 'nota', 'notas') + ', ' + plural(v.resumo.materiais, 'material', 'materiais') + ' em ' + plural(v.resumo.canais, 'vidro', 'vidros') + '.') : '');
    }
    const agendar = () => { clearTimeout(espera); espera = setTimeout(conferir, 150); };

    function linha(c) {
      const nome = el('div', { class: 'dica' }, c.material_id ? nomeDe(c.material_id) : 'escolha o material'), achados = el('div', { class: 'achados' });
      const calib = el('div');                                    // o bloco de calibração acompanha o que muda no vidro
      const mudaCalib = () => calib.replaceChildren(blocoCalibracao(c));
      mudaCalib();
      const busca = el('input', { type: 'search', placeholder: 'Buscar material (nome ou CAS)', 'aria-label': 'Buscar material do vidro ' + c.canal });
      busca.oninput = async () => {
        const r = (await api('/api/materiais', { q: busca.value })).materiais;
        achados.replaceChildren(...r.map(m => el('button', { onclick: () => {
          c.material_id = m.id; nome.textContent = m.nome; busca.value = ''; achados.replaceChildren(); mudaCalib(); agendar();
        } }, m.nome, ' ', el('small', {}, [m.cas, m.familia].filter(Boolean).join(' · ')))));
      };
      const numero = (valor, passo, cb, rotulo, vazio) => el('input', { type: 'number', min: 0, step: passo, value: valor === null ? '' : valor, 'aria-label': rotulo, placeholder: vazio || '',
        onchange: ev => { cb(ev.target.value === '' ? null : Number(ev.target.value)); mudaCalib(); agendar(); } });
      const dil = el('select', { 'aria-label': 'Diluição do vidro ' + c.canal, onchange: ev => { c.diluicao_pct = Number(ev.target.value); mudaCalib(); agendar(); } },
        ...[...new Set([...DILUICOES, c.diluicao_pct])].sort((a, b) => b - a).map(d => el('option', { value: d, selected: d === c.diluicao_pct }, fmt(d) + '%')));
      return el('div', { class: 'vidro' },
        el('div', { class: 'linha' }, el('b', {}, 'Vidro nº'), numero(c.canal, 1, v => { c.canal = v; }, 'Número do vidro'),
          el('button', { class: 'sec', style: 'margin-left:auto', onclick: () => { rascunho.canais = rascunho.canais.filter(x => x !== c); desenharMapa(j); } }, 'Remover')),
        nome, busca, achados,
        el('div', { class: 'linha' }, el('label', { class: 'dica' }, 'Diluição ', dil), el('label', { class: 'dica' }, 'Volume (ml) ',
          numero(c.volume_atual_ml, 'any', v => { c.volume_atual_ml = v; }, 'Volume do vidro em ml')),
        el('label', { class: 'dica' }, 'Densidade (g/ml, opcional) ', numero(c.densidade_g_ml, 'any', v => { c.densidade_g_ml = v; }, 'Densidade em g/ml', 'não sei'))),
        calib,
        el('div', { class: 'linha' }, el('button', { class: 'sec', onclick: () => telaCalibracao(j, c) }, 'Calibrar este vidro')));
    }

    const modelo = el('select', { 'aria-label': 'Máquina para copiar' }, ...[...db.maquinas.keys()].filter(id => id !== 'minha').map(id => el('option', { value: id }, db.maquinas.get(id).nome)));
    const salvarBt = el('button', { disabled: true, onclick: async () => {
      try {
        const r = await api('/api/mapa/salvar', { mapa: rascunho });
        await popularMaquinas(r.maquina);
        lembrar.gravar(CHAVE_MAQUINA, r.maquina);
        respostas = {};
        rascunho = null;
        aviso('Máquina salva: agora o app só propõe o que ela consegue fazer.', 6000);
        passo();
      } catch (e) { msg.textContent = e.message; }
    } }, 'Usar esta máquina');
    let certeza = false;
    const apagar = el('button', { class: 'sec', onclick: async () => {
      if (!certeza) { certeza = true; apagar.textContent = 'Toque de novo para apagar'; apagar.classList.add('ruim'); return; }
      await api('/api/mapa/excluir', {});
      rascunho = null;
      await popularMaquinas();
      aviso('Minha máquina apagada.', 4000);
      telaMapa();
    } }, 'Apagar minha máquina');
    grade.replaceChildren(...rascunho.canais.map(linha));
    $('#tela').replaceChildren(el('div', { class: 'card' }, el('h2', {}, 'Minha máquina'),
      el('p', { class: 'dica' }, 'Diga o que há em cada vidro da sua máquina. O app só propõe receitas que ela consegue fazer, e as barras de ajuste respeitam o volume de cada vidro.'),
      j.perdidos.length ? el('p', { class: 'falta' }, 'Estes materiais saíram do catálogo e foram retirados: ' + j.perdidos.join(', ') + '.') : '',
      el('div', { class: 'linha' }, el('label', { class: 'dica' }, 'Copiar de ', modelo), el('button', { class: 'sec', onclick: async () => {
        rascunho = structuredClone((await api('/api/mapa/modelo', { de: modelo.value })).mapa);
        desenharMapa(j);
      } }, 'Copiar'), el('button', { class: 'sec', onclick: () => { rascunho = { nome: 'Minha máquina', canais: [] }; desenharMapa(j); } }, 'Começar vazia'))),
    grade,
    el('div', { class: 'linha' }, el('button', { class: 'sec', onclick: () => {
      rascunho.canais.push({ canal: proximoNumero(), material_id: null, diluicao_pct: 100, volume_atual_ml: 30, densidade_g_ml: null });
      desenharMapa(j);
    } }, 'Adicionar vidro')),
    painel, msg,
    el('div', { class: 'linha', style: 'margin-top:8px' }, salvarBt, j.registrada ? apagar : ''));
    conferir();
  }

  // ---------------------------------------------------------------------------------------------- calibrar o vidro (docs/11 §2)
  /* O fluxo manual: pesar o vidro cheio na balança de 0,01 g, rodar N passos da bomba pelo painel da máquina e pesar de
   * novo — 2–3 rodadas dão o fator mg/passo com desvio; a proveta (opcional) dá a densidade real. Grava em
   * perfume.calibracao.v1 por canal, FORA do mapa; a densidade medida preenche o campo do canal pelo mesmo caminho do
   * preenchimento manual, para o estoque virar conferível. Trocado o material do vidro: a calibração fica desatualizada. */
  const pctPt = n => String(n).replace('.', ',');
  const doseMinimaMg = () => Math.round((db.maquinas.get(Motor.ID_PROPRIA) || db.maquinas.get('mvp-64')).dose_minima_g * 1000);

  function blocoCalibracao(c) {
    const box = el('div', { class: 'dica' });
    const ent = calibracao.do(Motor.ID_PROPRIA, c.canal);
    if (!ent) { box.textContent = 'Sem calibração: o fator mg/passo deste vidro ainda não foi medido.'; return box; }
    const mat = c.material_id ? db.materiais.get(c.material_id) : null;
    if (!mat) { box.textContent = 'Calibração gravada para ' + ent.material.nome + ' — escolha o material deste vidro para conferir.'; return box; }
    let conf;
    try { conf = Calibracao.conferencias(ent, c, mat, doseMinimaMg()); }
    catch { box.textContent = 'Calibração ilegível neste navegador — recalibre este vidro.'; return box; }
    if (conf.desatualizada) { box.className = 'falta'; box.textContent = '⚠ ' + conf.avisos[0] + '.'; return box; }
    const linhas = [el('div', { class: 'ok' }, '✔ Calibrado em ' + data(ent.data) + ': ' + g3(ent.fator_mg_passo) + ' mg/passo'
      + (ent.desvio_mg_passo === null ? '' : ' ± ' + g3(ent.desvio_mg_passo)))];
    const p = conf.passosDose;
    linhas.push(el('div', {}, doseMinimaMg() + ' mg = ' + p.passos + ' passos' + (p.margem === null ? '' : ' ± ' + p.margem)));
    if (conf.usoTipico) linhas.push(el('div', {}, 'No menor uso típico do catálogo (' + pctPt(conf.usoTipico.faixa.min) + '–'
      + pctPt(conf.usoTipico.faixa.max) + '%): ~' + Math.round(conf.usoTipico.dispensado_mg) + ' mg dispensados por lote de '
      + Calibracao.CONCENTRADO_G + ' g'));
    if (typeof conf.estoque_g === 'number') linhas.push(el('div', {}, 'Estoque conferível: restam ~' + fmt(conf.estoque_g) + ' g no vidro'));
    conf.avisos.forEach(a => linhas.push(el('div', { class: 'falta' }, '⚠ ' + a + '.')));
    box.replaceChildren(...linhas);
    return box;
  }

  function telaCalibracao(j, c) {
    const mat = c.material_id ? db.materiais.get(c.material_id) : null;
    const voltar = el('button', { class: 'sec', onclick: () => desenharMapa(j) }, '← Voltar ao mapa');
    if (!mat) {
      $('#tela').replaceChildren(voltar, el('div', { class: 'card' }, el('h2', {}, 'Calibrar vidro'),
        el('p', { class: 'falta' }, 'Escolha o material deste vidro no mapa antes de calibrar.')));
      return;
    }
    const ja = calibracao.do(Motor.ID_PROPRIA, c.canal);
    const rodadas = [], msg = el('div', { class: 'erro' }), lista = el('div');
    const balanca = el('select', { 'aria-label': 'Resolução da balança', onchange: ajustaBalanca },
      ...[0.01, 0.05, 0.1].map(v => el('option', { value: v, selected: v === 0.01 }, v.toLocaleString('pt-BR') + ' g')));
    const mAntes = el('input', { type: 'number', min: 0, step: 0.01, 'aria-label': 'Massa do vidro cheio, em gramas', placeholder: 'ex. 85,20' });
    const nPassos = el('input', { type: 'number', min: 1, step: 1, value: 1000, 'aria-label': 'Quantos passos da bomba vão rodar' });
    const mDepois = el('input', { type: 'number', min: 0, step: 0.01, 'aria-label': 'Massa depois de rodar, em gramas', placeholder: 'ex. 84,20' });
    const proveta = el('input', { type: 'number', min: 0, step: 'any', 'aria-label': 'Volume dispensado na proveta, em ml (opcional)', placeholder: 'opcional' });
    function ajustaBalanca() { mAntes.step = balanca.value; mDepois.step = balanca.value; }
    function registrar() {
      msg.textContent = '';
      try {
        const volume = proveta.value === '' ? null : Number(proveta.value);
        if (volume !== null && !(volume > 0)) throw new Calibracao.ErroDeUso('o volume na proveta tem de ser maior que zero');
        const f = Calibracao.fatorDaRodada(Number(mAntes.value), Number(mDepois.value), Number(nPassos.value));
        rodadas.push({ antes_g: Number(mAntes.value), depois_g: Number(mDepois.value), passos: Number(nPassos.value), volume_ml: volume,
          mg: f.mg, mg_por_passo: f.mg_por_passo });
        desenharRodadas();
      } catch (e) { msg.textContent = e.message; }
    }
    const salvarBt = el('button', { disabled: true, onclick: salvar }, 'Salvar calibração');
    function desenharRodadas() {
      const linhas = rodadas.map((r, i) => el('div', {}, 'Rodada ' + (i + 1) + ': ' + g3(r.mg / 1000) + ' g em ' + r.passos + ' passos = '
        + g3(r.mg_por_passo) + ' mg/passo' + (r.volume_ml ? ' · proveta ' + r.volume_ml + ' ml → ' + g3(r.mg / 1000 / r.volume_ml) + ' g/ml' : '')));
      if (rodadas.length) {
        const { media, desvio } = Calibracao.mediaDesvio(rodadas.map(r => r.mg_por_passo));
        const p = Calibracao.passosDaDose(doseMinimaMg(), media, desvio);
        linhas.push(el('div', { class: 'ok' }, 'Média ' + g3(media) + ' mg/passo' + (desvio === null ? ' (uma rodada: ainda sem desvio)' : ' ± ' + g3(desvio))));
        linhas.push(el('div', {}, doseMinimaMg() + ' mg = ' + p.passos + ' passos' + (p.margem === null ? '' : ' ± ' + p.margem)));
        linhas.push(el('div', { class: 'dica' }, 'SUGESTÃO de passos para a próxima rodada (~1 g): ' + Math.round(1000 / media)
          + ' — chute de partida, ajuste como preferir.'));
      }
      lista.replaceChildren(...linhas);
      salvarBt.disabled = !rodadas.length;
    }
    function salvar() {
      msg.textContent = '';
      try {
        const { media, desvio } = Calibracao.mediaDesvio(rodadas.map(r => r.mg_por_passo));
        const dens = Calibracao.densidadeDasRodadas(rodadas);
        calibracao.salvar({ maquina: Motor.ID_PROPRIA, canal: c.canal, diluicao_pct: c.diluicao_pct,
          material: { id: mat.id, nome: mat.nome, cas: mat.cas }, rodadas,
          fator_mg_passo: media, desvio_mg_passo: desvio, densidade_g_ml: dens, data: new Date().toISOString() });
        if (dens !== null) c.densidade_g_ml = dens;          // mesmo caminho do preenchimento manual: o validador do mapa passa a conferir o estoque
        aviso('Calibração salva para o vidro nº' + c.canal + (dens === null ? '' : ' (densidade ' + g3(dens) + ' g/ml anotada no canal)'), 6000);
        desenharMapa(j);
      } catch (e) { msg.textContent = e.message; }
    }
    let certeza = false;
    const apagarBt = el('button', { class: 'sec', onclick: () => {
      if (!certeza) { certeza = true; apagarBt.textContent = 'Toque de novo para apagar'; apagarBt.classList.add('ruim'); return; }
      calibracao.limpar(Motor.ID_PROPRIA, c.canal);
      aviso('Calibração do vidro nº' + c.canal + ' apagada.', 4000);
      desenharMapa(j);
    } }, 'Apagar calibração');
    $('#tela').replaceChildren(voltar,
      el('div', { class: 'card' }, el('h2', {}, 'Calibrar vidro nº' + c.canal + ' — ' + mat.nome + ' (' + fmt(c.diluicao_pct) + '%)'),
        el('p', { class: 'dica' }, 'Padrões assumidos (docs/11 §2): balança de resolução ', balanca,
          ' · dose por massa (a proveta é opcional) · calibração por canal, feita na montagem e conferida na troca de vidro.'),
        ja ? el('p', { class: 'dica' }, 'Já existe calibração: ' + g3(ja.fator_mg_passo) + ' mg/passo'
          + (ja.desvio_mg_passo === null ? '' : ' ± ' + g3(ja.desvio_mg_passo)) + ' (' + data(ja.data) + '). Salvar por cima substitui.') : '',
        el('div', { class: 'vidro' },
          el('div', { class: 'linha' }, el('label', { class: 'dica' }, '1. Vidro cheio ', mAntes, ' g')),
          el('div', { class: 'linha' }, el('label', { class: 'dica' }, '2. Rodar ', nPassos, ' passos da bomba pelo painel da máquina')),
          el('div', { class: 'linha' }, el('label', { class: 'dica' }, '3. Pesar de novo ', mDepois, ' g')),
          el('div', { class: 'linha' }, el('label', { class: 'dica' }, '(opcional) Proveta ', proveta, ' ml')),
          el('div', { class: 'linha' }, el('button', { onclick: registrar }, 'Registrar rodada'))),
        msg, lista,
        el('p', { class: 'dica' }, 'Faça 2–3 rodadas: o desvio entre elas é o que aparece depois do ±. Os 1000 passos do campo são um chute de partida (algo entre 0,5 e 2 g na maioria dos vidros).'),
        el('div', { class: 'linha' }, salvarBt, ja ? apagarBt : '')));
  }

  // ---------------------------------------------------------------------------------------------- imprimir (docs/11 §1 — SITE-1, fluxo F1 local)
  /* A primeira leva do site de compartilhamento, dentro do app: escolher uma fórmula que já existe (minhas receitas,
   * acordes do banco, biblioteca), o volume do frasco e mandar imprimir — com o LOTE MÍNIMO (decisão 14) e a
   * PRÉ-CHECAGEM de estoque (decisão 8) ANTES de habilitar o botão, e o arquivo .json da fórmula no fim (decisão 9).
   * As contas novas estão no módulo Imprimir; aqui só se desenha e se pede ao motor. Este conteúdo acompanha a
   * máquina: é grátis (decisão 10). Tudo local — a biblioteca baixa uma vez, como sempre. */
  let imp = null, impFonte = 'acordes';        // a escolha da aba ({ fonte, id, ml }) e qual lista está aberta na escolha
  const semAcento = s => s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');

  function telaImprimir() {
    if (imp) return telaImprimirFormula();
    telaImprimirFontes();
  }

  async function telaImprimirFontes() {
    const minha = ++vez;
    imp = null;
    marcarAba('imprimir');
    $('#hist').replaceChildren();
    const t = $('#tela'), lista = el('div', { class: 'achados', style: 'margin-top:8px' });
    const buscar = el('input', { type: 'search', placeholder: 'Buscar por nome…', 'aria-label': 'Buscar na lista de fórmulas', oninput: () => desenhar() });
    const chips = [['receitas', 'Minhas receitas'], ['acordes', 'Acordes do banco'], ['biblioteca', 'Biblioteca']]
      .map(([f, rotulo], i) => el('button', { class: impFonte === f ? '' : 'sec', onclick: () => { impFonte = f; chips.forEach((b, k) => b.className = k === i ? '' : 'sec'); desenhar(); } }, rotulo));
    async function desenhar() {
      const q = semAcento(buscar.value || '');
      lista.replaceChildren(el('p', { class: 'dica' }, 'Carregando…'));
      let itens = [];
      try {
        if (impFonte === 'receitas') {
          itens = (await api('/api/receitas', {})).receitas
            .filter(r => !q || semAcento(r.nome).includes(q))
            .map(r => ({ id: r.id, nome: r.nome, sub: data(r.criada_em) + ' · ' + estrelas(r.nota) }));
        } else if (impFonte === 'acordes') {
          itens = db.acordes_motor.filter(a => !q || semAcento(a.nome).includes(q))
            .map(a => ({ id: a.id, nome: a.nome, sub: a.itens.filter(i => i.partes).length + ' ingredientes' }));
        } else {
          await carregarBiblioteca();
          itens = (q.length < 2 ? [] : db.biblioteca.acordes.map((a, i) => ({ i, nome: a[1], tier: a[2] }))
            .filter(a => semAcento(a.nome).includes(q)).slice(0, 30))
            .map(a => ({ id: a.i, nome: a.nome, sub: 'biblioteca · tier ' + a.tier }));
        }
      } catch (e) {
        if (minha !== vez) return;
        lista.replaceChildren(el('p', { class: 'falta' }, 'Não consegui carregar esta lista: ' + e.message
          + (impFonte === 'biblioteca' ? '. Conecte-se à internet uma vez para baixar a biblioteca.' : '.')));
        return;
      }
      if (minha !== vez) return;
      if (!itens.length) {
        lista.replaceChildren(el('p', { class: 'dica' },
          impFonte === 'receitas' ? 'Você ainda não salvou nenhuma receita. Monte um perfume em "Novo perfume" e salve com uma nota.'
          : impFonte === 'biblioteca' && q.length < 2 ? 'Digite ao menos 2 letras para buscar nos '
            + (db.biblioteca ? db.biblioteca.acordes.length.toLocaleString('pt-BR') : '9.180') + ' acordes da biblioteca.'
          : 'Nada encontrado com essa busca.'));
        return;
      }
      lista.replaceChildren(...itens.map(r => el('button', { onclick: () => { imp = { fonte: impFonte, id: r.id, ml: null }; telaImprimirFormula(); } },
        r.nome, ' ', el('small', {}, r.sub))));
    }
    t.replaceChildren(el('div', { class: 'card' }, el('h2', {}, 'Imprimir'),
      el('p', { class: 'dica' }, 'Escolha um perfume ou acorde, o volume do frasco e mande a máquina dosar. O app confere os vidros antes de imprimir.'),
      el('p', {}, el('span', { class: 'badge' }, Imprimir.GRATIS))),
      el('div', { class: 'card' }, el('h2', {}, 'O que imprimir'),
        el('div', { class: 'linha' }, ...chips), buscar, lista));
    desenhar();
  }

  async function formulaImp() {
    if (imp.fonte === 'receitas') {
      const j = await api('/api/receita', { id: imp.id, maquina, tecnico: false }), r = j.receita;
      const f = Imprimir.daReceita(Object.fromEntries(r.itens.map(i => [i.id, i.gramas])), r.massa_final_g, r.nome, r.nota, r.respostas);
      f.faltando = j.candidato.faltando.map(x => x.nome);      // o que a máquina ativa não tem, como no "Abrir" da receita
      return f;
    }
    if (imp.fonte === 'acordes') return Imprimir.comoProduto(Imprimir.doAcorde(db, imp.id, maquina));
    await carregarBiblioteca();
    return Imprimir.comoProduto(Imprimir.daBiblioteca(db, maquina, imp.id));
  }

  async function telaImprimirFormula() {
    const minha = ++vez;
    marcarAba('imprimir');
    $('#hist').replaceChildren();
    const t = $('#tela');
    t.replaceChildren(el('div', { class: 'card' }, 'Preparando a fórmula…'));
    let f;
    try { f = await formulaImp(); } catch (e) {
      if (minha !== vez) return;
      t.replaceChildren(el('div', { class: 'linha' }, el('button', { class: 'sec', onclick: telaImprimirFontes }, '← Escolher outra fórmula')),
        el('div', { class: 'card erro' }, e.message));
      return;
    }
    if (minha !== vez) return;
    if (f.impossivel) {
      t.replaceChildren(el('div', { class: 'linha' }, el('button', { class: 'sec', onclick: telaImprimirFontes }, '← Escolher outra fórmula')),
        el('div', { class: 'card' }, el('h2', {}, f.titulo), el('p', { class: 'falta' }, f.aviso)));
      return;
    }
    const sel = Imprimir.seletor(db, maquina, f.itens);
    const ml = sel.padrao && (!imp.ml || !sel.opcoes.some(o => o.ml === imp.ml && !o.desabilitada)) ? sel.padrao.ml : imp.ml;
    imp.ml = ml;
    const g = ml === null ? 0 : ml * Imprimir.DENSIDADE_DECLARADA;
    const pch = ml === null ? null : Imprimir.prechecagem(db, app, maquina, f, g, f.titulo);
    const msgs = el('span', { class: 'dica', role: 'status' });
    const btFolha = el('button', { disabled: !pch || !pch.ok, title: pch && pch.bloqueios.length ? pch.bloqueios[0] : '',
      onclick: async () => {
        msgs.textContent = '';
        try {
          await imprimir({ titulo: f.titulo, massa_final_g: g, formula: Object.fromEntries(f.itens.map(i => [String(i.material_id), i.fracao * g])) },
            () => f.respostas || {}, ml + ' ml (' + fmt(g) + ' g)');
        } catch (e) { msgs.textContent = 'Não consegui preparar a impressão: ' + e.message; }
      } }, 'Imprimir folha');
    const btExportar = el('button', { class: 'sec', onclick: () => {
      baixar('formula-' + semAcento(f.titulo).replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') + '.json',
        JSON.stringify(Imprimir.arquivoDaFormula(db, f, g, new Date().toISOString()), null, 1));
      msgs.textContent = 'Fórmula exportada — quem imprime recebe a fórmula.';
    } }, 'Exportar fórmula (.json)');
    const rotFonte = { receitas: 'minha receita', acordes: 'acorde do banco', biblioteca: 'acorde da biblioteca' }[f.fonte];
    const porLote = sel.opcoes.find(o => o.desabilitada === 'lote'), porMaquina = sel.opcoes.find(o => o.desabilitada === 'maquina');
    t.replaceChildren(el('div', { class: 'linha' }, el('button', { class: 'sec', onclick: telaImprimirFontes }, '← Escolher outra fórmula')),
      el('div', { class: 'card' },
        el('div', { class: 'linha' }, el('h2', { style: 'margin:0;flex:1' }, f.titulo), el('span', { class: 'badge' }, rotFonte), el('span', { class: 'badge' }, 'grátis')),
        el('table', {}, el('tbody', {}, ...f.itens.map(i => el('tr', {},
          el('td', {}, Motor.nome_curto(db.materiais.get(i.material_id).nome, 46)), el('td', {}, fmt(i.fracao * 100) + '%'))))),
        ...(f.concentracao_pct ? [el('p', { class: 'dica' }, 'Acorde dosado a ' + fmt(f.concentracao_pct)
          + '% — a concentração padrão do motor; o etanol completa o frasco.')] : []),
        ...(f.cobertura !== 1 ? [el('p', { class: 'dica' }, 'Cobertura: ' + fmt(f.cobertura * 100) + '% das partes do acorde nesta máquina.')] : []),
        ...f.trocas.map(tr => el('p', { class: 'dica' }, 'Troca: ' + tr + '.')),
        ...f.escolhas.map(e => el('p', { class: 'dica' }, 'Escolha feita: ' + e.item + ' → ' + e.opcoes[0] + (e.opcoes.length > 1 ? ' (outras opções: ' + e.opcoes.slice(1).join(', ') + ')' : '') + '.')),
        ...(f.faltando.length ? [el('p', { class: 'falta' }, 'Fora desta máquina: ' + f.faltando.join(', ') + ' — com troca/ajuste o lote muda.')] : [])),
      el('div', { class: 'card' }, el('h2', {}, 'Volume do frasco'),
        ...(sel.lote.limitante ? [el('p', { class: 'dica' }, 'Lote mínimo desta fórmula nesta máquina: ' + fmt(sel.lote.ml) + ' ml.')] : []),
        ...(maquina === Motor.ID_PROPRIA ? [] : [el('p', { class: 'dica' }, '⚠ ' + Imprimir.avisoReferencia(db, maquina))]),
        el('div', { class: 'linha notas', style: 'margin-top:6px' },
          ...sel.opcoes.map(o => el('button', { class: o.ml === ml ? 'sel' : 'sec', disabled: !!o.desabilitada, title: o.motivo || '',
            onclick: () => { imp.ml = o.ml; telaImprimirFormula(); } }, o.ml + ' ml'))),
        ...(porLote ? [el('p', { class: 'dica' }, porLote.motivo + '.')] : []),
        ...(porMaquina ? [el('p', { class: 'dica' }, porMaquina.motivo + '.')] : [])),
      el('div', { class: 'card' }, el('h2', {}, 'Conferência antes de imprimir'),
        ml === null ? el('p', { class: 'falta' }, 'Nenhum volume da grade dosa nesta máquina.')
        : [el('p', { class: 'dica' }, 'O que esta impressão usa de cada vidro da ' + db.maquinas.get(maquina).nome + ' para '
            + ml + ' ml (' + fmt(g) + ' g — densidade declarada ' + fmt(Imprimir.DENSIDADE_DECLARADA) + ' g/ml):'),
          el('table', {}, el('thead', {}, el('tr', {}, el('th', { scope: 'col' }, 'Vidro'), el('th', { scope: 'col' }, 'Material'),
            el('th', { scope: 'col' }, 'No vidro'), el('th', { scope: 'col' }, 'Vai usar'))),
            el('tbody', {}, ...pch.linhas.map(l => el('tr', {}, el('td', {}, String(l.canal)), el('td', {}, l.material),
              el('td', {}, l.estoque_texto), el('td', {}, g3(l.usar_g) + ' g'))))),
          ...(pch.ok ? [el('p', { class: 'ok' }, '✔ Os vidros cobrem esta impressão.')] : pch.bloqueios.map(b => el('p', { class: 'falta' }, '✕ ' + b))),
          ...pch.avisos.map(a => el('p', { class: 'dica' }, '⚠ ' + a))]),
      el('div', { class: 'card' }, el('h2', {}, 'Imprimir'),
        el('p', { class: 'dica' }, pch && pch.ok ? 'Tudo conferido: a folha traz a fórmula e a dosagem vidro por vidro.'
          : 'O botão liga quando a conferência acima passar.'),
        el('div', { class: 'linha' }, btFolha, btExportar), msgs));
  }

  // ---------------------------------------------------------------------------------------------- nariz digital (o especialista)
  // Onze perguntas sobre o cheiro ideal (docs/09) viram 3 acordes da biblioteca recomendados aqui no aparelho. As previsões
  // vêm prontas no especialista.json (~3 MB), buscado UMA vez quando a pessoa termina de responder — o service worker guarda.
  const BLOCOS_ESP = { uso: 'Como você vai usar', gosto: 'Do que você gosta', quem: 'Pra quem é' };
  const DURACAO = l => l < 1.75 ? 'poucas horas' : l < 2.75 ? 'umas 2–3 h' : l < 4 ? 'até o meio-dia' : 'o dia inteiro';
  const ALCANCE = p => p < 1.75 ? 'só quem te abraça' : p < 3 ? 'um braço de distância' : 'enche o ambiente';
  function estrelasMeia(r) {
    const cheias = Math.floor(r), resto = r - cheias, meio = resto >= 0.25 && resto < 0.75;
    const n = cheias + (resto >= 0.75 ? 1 : 0);                   // 3,6 vira ★★★½☆ e 3,9 vira ★★★★☆
    return '★'.repeat(n) + (meio ? '½' : '') + '☆'.repeat(Math.max(0, 5 - n - (meio ? 1 : 0)));
  }
  function lerEsp() { try { const t = lembrar.ler(CHAVE_ESP); return t ? JSON.parse(t) : null; } catch { return null; } }

  function cartaoNariz() {
    const salvo = lerEsp();
    return el('div', { class: 'card nariz' },
      el('h2', {}, 'Não sabe por onde começar?'),
      el('p', { class: 'dica' }, 'O nariz digital faz 11 perguntas sobre o perfume que você quer e recomenda acordes prontos para cheirar — tudo calculado aqui no aparelho.'),
      el('div', { class: 'linha' },
        el('button', { onclick: () => { espRespostas = {}; telaNariz(0); } }, 'Perguntar ao nariz digital'),
        salvo ? el('button', { class: 'sec', onclick: () => telaNarizResultado(salvo.resultado, 'A sua última recomendação') }, 'Ver minha última recomendação') : ''));
  }

  function telaNariz(no) {
    ++vez;                                                          // trocar de tela cancela um "consultando…" que ainda esteja por aí
    const p = cru.especialista.perguntas[no], ultima = no === cru.especialista.perguntas.length - 1;
    const voltar = el('button', { class: 'sec', onclick: () => (no === 0 ? passo() : telaNariz(no - 1)) }, no === 0 ? 'Voltar ao questionário' : 'Voltar');
    if (p.tipo === 'slider') {                                     // doçura e frescor: uma barra de 0 a 10, valor aparecendo ao vivo
      const valor = espRespostas[p.id] ?? 5;
      const saida = el('output', {}, valor);
      const barra = el('input', { type: 'range', id: 'esp-' + p.id, min: p.min, max: p.max, step: 1, value: valor, 'aria-label': p.texto + ' (0 a 10)' });
      barra.oninput = () => { saida.textContent = barra.value; espRespostas[p.id] = Number(barra.value); };
      $('#tela').replaceChildren(el('div', { class: 'card' },
        passosEsp(no),
        el('p', { class: 'dica' }, BLOCOS_ESP[p.bloco]), el('h2', {}, p.texto),
        el('div', { class: 'nariz-slider' }, el('div', { class: 'linha' }, el('label', { for: 'esp-' + p.id, class: 'dica', style: 'flex:1' }, '0 é nada · 10 é muito'), saida), barra),
        el('div', { class: 'linha' }, voltar, el('button', { onclick: () => (ultima ? narizFinal() : telaNariz(no + 1)) }, ultima ? 'Ver recomendações' : 'Avançar'))));
      return;
    }
    let escolha = espRespostas[p.id] ?? null;                      // voltar reencontra a resposta de antes marcada
    const avancar = el('button', { disabled: escolha === null, onclick: () => (ultima ? narizFinal() : telaNariz(no + 1)) }, ultima ? 'Ver recomendações' : 'Avançar');
    const linhas = p.opcoes.map(o => {
      const i = el('input', { type: 'radio', name: 'op', value: o.id, checked: escolha === o.id });
      i.onchange = () => { escolha = o.id; espRespostas[p.id] = o.id; avancar.disabled = false; };
      return el('label', { class: 'op' }, i, o.rotulo);
    });
    $('#tela').replaceChildren(el('div', { class: 'card' },
      passosEsp(no),
      el('p', { class: 'dica' }, BLOCOS_ESP[p.bloco]), el('h2', {}, p.texto),
      ...linhas,
      el('div', { class: 'linha' }, voltar, avancar)));
  }

  function passosEsp(no) {
    const total = cru.especialista.perguntas.length;
    return el('div', { class: 'nariz-passos' }, el('span', {}, 'Nariz digital'),
      el('span', { role: 'progressbar', 'aria-valuemin': 1, 'aria-valuemax': total, 'aria-valuenow': no + 1 }, (no + 1) + ' de ' + total),
      el('div', { class: 'barra' }, el('i', { style: 'width:' + Math.round((no + 1) / total * 100) + '%' })));
  }

  async function narizFinal() {
    const minha = ++vez;
    $('#tela').replaceChildren(el('div', { class: 'card' }, el('h2', {}, 'Consultando o nariz digital…'),
      el('p', { class: 'dica' }, espDados ? 'Comparando o seu gosto com os 9.180 acordes da biblioteca…'
        : 'Baixando a biblioteca de acordes — é uma vez só, depois fica guardada no aparelho…')));
    try {
      if (!espDados) {
        const r = await fetch('especialista.json');
        if (!r.ok) throw new Error('HTTP ' + r.status);
        espDados = await r.json();
      }
      const resultado = Especialista.recomendar(cru.especialista, espDados, espRespostas);
      if (minha !== vez) return;
      lembrar.gravar(CHAVE_ESP, JSON.stringify({ quando: new Date().toISOString(), respostas: espRespostas, resultado }));
      telaNarizResultado(resultado, 'O nariz digital recomenda');
    } catch (e) {
      if (minha !== vez) return;
      $('#tela').replaceChildren(el('div', { class: 'card erro' }, 'Não consegui consultar a biblioteca de acordes (' + e.message + '). Conecte-se à internet uma vez para baixá-la.'),
        el('div', { class: 'linha' }, el('button', { onclick: () => narizFinal() }, 'Tentar de novo'),
          el('button', { class: 'sec', onclick: () => telaNariz(cru.especialista.perguntas.length - 1) }, 'Voltar às perguntas')));
    }
  }

  function cartaoDoAcorde(c, i, alvo) {
    const comparado = (previsto, pedido, texto) => pedido == null ? '' : ' — você pediu ' + texto + (Math.abs(previsto - pedido) <= 1 ? ' ✓' : ' ⚠');
    const chips = [];
    if (c.selos.fiel) chips.push(el('span', { class: 'chip ok' }, 'fiel ao pedido'));
    if (c.selos.distancia) chips.push(el('span', { class: 'chip ok' }, 'distância OK'));
    if (c.selos.aprovado) chips.push(el('span', { class: 'chip ok' }, 'aprovado pela multidão'));
    if (c.selos.comportamento) chips.push(el('span', { class: 'chip ok' }, 'dura e alcança como você pediu'));
    if (!chips.length) chips.push(el('span', { class: 'chip atencao' }, 'o mais perto que a biblioteca tem'));
    const nota = el('p', {}, el('b', {}, 'Vai cheirar como: '), c.top.map(t => t.nome + ' ' + Math.round(t.peso)).join(', '));
    const estrelinhas = el('span', { class: 'estrelas', 'aria-label': 'nota prevista ' + fmt(c.rating) + ' de 5' }, estrelasMeia(c.rating));
    return el('div', { class: 'card' },
      el('h2', {}, (i + 1) + '. ' + c.nome),
      el('p', { class: 'dica' }, c.faceta + ' · família ' + c.familia),
      nota,
      el('p', {}, estrelinhas, ' ', fmt(c.rating), ' de 5 — previsão da comunidade'),
      el('p', { class: 'dica' }, 'Dura ' + DURACAO(c.longevidade) + comparado(c.longevidade, alvo.longevidade_alvo, DURACAO(alvo.longevidade_alvo))
        + ' · Alcance: ' + ALCANCE(c.projecao) + comparado(c.projecao, alvo.projecao_alvo, ALCANCE(alvo.projecao_alvo))),
      el('div', {}, ...chips),
      ...c.avisos.map(a => el('p', { class: 'alerta' }, '⚠ ' + a + '.')),
      el('div', { class: 'linha' }, el('button', { onclick: () => { location.href = 'catalogo.html?acorde=' + encodeURIComponent(c.id); } }, 'Ver no catálogo')));
  }

  function telaNarizResultado(r, titulo) {
    ++vez;
    $('#tela').replaceChildren(
      el('div', { class: 'card' }, el('h2', {}, titulo),
        r.aviso_geral ? el('p', { class: 'falta' }, r.aviso_geral) : '',
        el('p', { class: 'dica' }, 'Os acordes da biblioteca mais perto do que você descreveu. O cheiro e a nota da multidão são previsões — nada substitui cheirar.')),
      ...r.resultados.map((c, i) => cartaoDoAcorde(c, i, r.alvo)),
      r.alternativas.length ? el('div', { class: 'card' }, el('h2', {}, 'Outras ideias'),
        el('ul', { class: 'hist' }, ...r.alternativas.map(a => el('li', { style: 'margin:4px 0' }, a.nome, ' — ', a.faceta)))) : '',
      el('div', { class: 'card' }, el('div', { class: 'linha' },
        el('button', { onclick: () => { espRespostas = {}; telaNariz(0); } }, 'Refazer respostas'),
        el('button', { class: 'sec', onclick: () => passo() }, 'Voltar ao questionário'))));
  }

  // ---------------------------------------------------------------------------------------------- partida
  function servico() {
    if (!('serviceWorker' in navigator)) return;
    const tinhaControle = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.register('sw.js').catch(() => { /* sem service worker (http fora de localhost): o app funciona, só não abre offline */ });
    navigator.serviceWorker.ready.then(() => { if (!tinhaControle) aviso('Pronto: o app já funciona sem internet.', 6000); });
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (tinhaControle) aviso('Versão nova instalada. ', 0, el('button', { class: 'sec', onclick: () => location.reload() }, 'Recarregar'));
    });
  }

  async function iniciar() {
    try {
      const resposta = await fetch('dados.json');
      if (!resposta.ok) throw new Error('HTTP ' + resposta.status);
      cru = await resposta.json();
      db = new Motor.Banco(cru);
      app = Motor.criar_app(db, guardar, undefined, propria);
      Imprimir.usar(Motor);                      // o módulo da aba Imprimir lê o motor (nada dele é escrito)
    } catch {
      $('#tela').replaceChildren(el('div', { class: 'card erro' }, 'Não consegui carregar os dados do app. Conecte-se à internet uma vez para instalar.'));
      return;
    }
    await popularMaquinas();
    $('#maq').onchange = () => {
      maquina = $('#maq').value;
      lembrar.gravar(CHAVE_MAQUINA, maquina);
      if (aberta !== null) abrir(aberta); else if (abaAtual === 'receitas') listar(); else if (abaAtual === 'mapa') telaMapa(); else if (abaAtual === 'imprimir') telaImprimir(); else { respostas = {}; passo(); }
    };
    $('#tec').onchange = () => { if (aberta !== null) abrir(aberta); else if (candidatos.length) compor(usandoBiblio); };
    $('#aba-novo').onclick = () => { aberta = null; pai = null; passo(); };
    $('#aba-receitas').onclick = listar;
    $('#aba-mapa').onclick = telaMapa;
    $('#aba-imprimir').onclick = telaImprimir;
    $('#aba-acordes').onclick = () => { location.href = 'catalogo.html'; };   // o catálogo completo é uma página própria, ao lado do app
    $('#aba-escadas').onclick = () => { location.href = 'escadas.html'; };    // a escada de gotas também (mesma navegação do catálogo)
    $('#rodape').textContent = 'Para instalar no celular: menu do navegador → Adicionar à tela inicial. Dados ' + db.versao + '.';
    servico();
    const alvo = new URLSearchParams(location.search).get('aba');            // o catálogo/escadas voltam pelo link (index.html?aba=receitas|mapa|imprimir)
    if (alvo === 'receitas') listar(); else if (alvo === 'mapa') telaMapa(); else if (alvo === 'imprimir') telaImprimir(); else passo();
  }

  iniciar();
})();
