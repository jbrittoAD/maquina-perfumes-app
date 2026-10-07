// Interface do PWA: questionário -> receita -> ajuste fino -> salvar/abrir/melhorar, e o mapa da máquina; tudo no aparelho (motor.js).
(() => {
  'use strict';
  const $ = s => document.querySelector(s);
  const NEUTRAS = ['tanto_faz', 'nenhum', 'nenhuma'];
  const CHAVE_RECEITAS = 'perfume.receitas.v1', CHAVE_MAQUINA = 'perfume.maquina', CHAVE_PROPRIA = 'perfume.minha_maquina.v1';
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
    for (const [nome, id] of [['novo', '#aba-novo'], ['receitas', '#aba-receitas'], ['mapa', '#aba-mapa']]) $(id).className = qual === nome ? '' : 'sec';
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
    marcarAba('novo');
    const j = await api('/api/proxima', base());
    if (minha !== vez) return;
    $('#hist').replaceChildren(...j.caminho.map((c, i) => el('div', {}, c.pergunta + ' ', el('b', {}, c.respostas.join(', ')),
      el('button', { class: 'sec', onclick: () => { const novo = {}; j.caminho.slice(0, i).forEach(x => { novo[x.no] = respostas[x.no]; }); respostas = novo; passo(); } }, 'alterar'))));
    if (!j.pergunta) return compor();
    desenhar(j.pergunta);
  }

  function desenhar(p) {
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
    $('#tela').replaceChildren(el('div', { class: 'card' }, el('h2', {}, p.titulo), p.tipo === 'multipla' ? el('div', { class: 'dica' }, 'Pode marcar até ' + p.max + '.') : '',
      ...linhas, msg, el('div', { class: 'linha' }, bt)));
  }

  // ---------------------------------------------------------------------------------------------- receitas sugeridas
  async function compor() {
    const minha = ++vez;
    $('#tela').replaceChildren(el('div', { class: 'card' }, 'Montando seus perfumes…'));
    try {
      const j = await api('/api/compor', base());
      if (minha !== vez) return;
      candidatos = j.candidatos;
      ajustes = j.ajustes;
      tituloResultado = candidatos.length ? ['Uma sugestão', 'Duas sugestões', 'Três sugestões'][candidatos.length - 1] + ' para você' : '';
      resultado();
    } catch (e) { if (minha === vez) erro(e); }
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
  async function imprimir(c, respostasDaReceita) {
    const j = await api('/api/ajustar', { maquina, respostas: respostasDaReceita, itens: c.formula, novos: {}, massa_final_g: c.massa_final_g, nome: c.titulo, tecnico: true });
    const x = j.candidato, frasco = ML_DO_FRASCO.has(x.massa_final_g) ? ML_DO_FRASCO.get(x.massa_final_g) + ' ml (' + fmt(x.massa_final_g) + ' g)' : fmt(x.massa_final_g) + ' g';
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
    t.replaceChildren(el('h2', {}, tituloResultado), ...candidatos.map((c, i) => cartao(c, i, 'Quero este', () => feito(c))),
      el('div', { class: 'linha' }, el('button', { class: 'sec', onclick: () => { respostas = {}; pai = null; passo(); } }, 'Começar de novo')));
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

  async function exportar() {
    const j = await api('/api/exportar', {});
    const link = el('a', { href: URL.createObjectURL(new Blob([JSON.stringify(j, null, 1)], { type: 'application/json' })), download: 'receitas-perfume.json' });
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
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
      const busca = el('input', { type: 'search', placeholder: 'Buscar material (nome ou CAS)', 'aria-label': 'Buscar material do vidro ' + c.canal });
      busca.oninput = async () => {
        const r = (await api('/api/materiais', { q: busca.value })).materiais;
        achados.replaceChildren(...r.map(m => el('button', { onclick: () => {
          c.material_id = m.id; nome.textContent = m.nome; busca.value = ''; achados.replaceChildren(); agendar();
        } }, m.nome, ' ', el('small', {}, [m.cas, m.familia].filter(Boolean).join(' · ')))));
      };
      const numero = (valor, passo, cb, rotulo, vazio) => el('input', { type: 'number', min: 0, step: passo, value: valor === null ? '' : valor, 'aria-label': rotulo, placeholder: vazio || '',
        onchange: ev => { cb(ev.target.value === '' ? null : Number(ev.target.value)); agendar(); } });
      const dil = el('select', { 'aria-label': 'Diluição do vidro ' + c.canal, onchange: ev => { c.diluicao_pct = Number(ev.target.value); agendar(); } },
        ...[...new Set([...DILUICOES, c.diluicao_pct])].sort((a, b) => b - a).map(d => el('option', { value: d, selected: d === c.diluicao_pct }, fmt(d) + '%')));
      return el('div', { class: 'vidro' },
        el('div', { class: 'linha' }, el('b', {}, 'Vidro nº'), numero(c.canal, 1, v => { c.canal = v; }, 'Número do vidro'),
          el('button', { class: 'sec', style: 'margin-left:auto', onclick: () => { rascunho.canais = rascunho.canais.filter(x => x !== c); desenharMapa(j); } }, 'Remover')),
        nome, busca, achados,
        el('div', { class: 'linha' }, el('label', { class: 'dica' }, 'Diluição ', dil), el('label', { class: 'dica' }, 'Volume (ml) ',
          numero(c.volume_atual_ml, 'any', v => { c.volume_atual_ml = v; }, 'Volume do vidro em ml')),
        el('label', { class: 'dica' }, 'Densidade (g/ml, opcional) ', numero(c.densidade_g_ml, 'any', v => { c.densidade_g_ml = v; }, 'Densidade em g/ml', 'não sei'))));
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
      db = new Motor.Banco(await resposta.json());
      app = Motor.criar_app(db, guardar, undefined, propria);
    } catch {
      $('#tela').replaceChildren(el('div', { class: 'card erro' }, 'Não consegui carregar os dados do app. Conecte-se à internet uma vez para instalar.'));
      return;
    }
    await popularMaquinas();
    $('#maq').onchange = () => {
      maquina = $('#maq').value;
      lembrar.gravar(CHAVE_MAQUINA, maquina);
      if (aberta !== null) abrir(aberta); else if (abaAtual === 'receitas') listar(); else if (abaAtual === 'mapa') telaMapa(); else { respostas = {}; passo(); }
    };
    $('#tec').onchange = () => { if (aberta !== null) abrir(aberta); else if (candidatos.length) compor(); };
    $('#aba-novo').onclick = () => { aberta = null; pai = null; passo(); };
    $('#aba-receitas').onclick = listar;
    $('#aba-mapa').onclick = telaMapa;
    $('#aba-acordes').onclick = () => { location.href = 'catalogo.html'; };   // o catálogo completo é uma página própria, ao lado do app
    $('#rodape').textContent = 'Para instalar no celular: menu do navegador → Adicionar à tela inicial. Dados ' + db.versao + '.';
    servico();
    passo();
  }

  iniciar();
})();
