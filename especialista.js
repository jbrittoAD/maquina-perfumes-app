/* Sistema especialista em JavaScript: PORTE de dados/motor/perfil.py para o navegador — as 11 perguntas
 * (docs/09) viram vetor-alvo sobre os 92 acordes do dump, e a busca acha os 3 acordes da biblioteca mais
 * perto do pedido, com os selos de validação (G1 fidelidade, G2 aceitação, G3 sinergia, G4 comportamento).
 *
 * Os nomes (funções, campos) são os do Python de propósito: confira um contra o outro. Quem garante a
 * paridade é pwa/teste/especialista.test.mjs, que compara o vetorAlvo daqui com o que o Python respondeu
 * (especialista.golden.json, gerado por exportar_pwa.py — tolerância 1e-9, campo a campo).
 *
 * O ranking roda no aparelho, sem internet e sem rede neural: as previsões da rede (perfil, rating,
 * longevidade, projeção, afinidades) vêm PRONTAS no especialista.json (~3 MB, buscado só quando a pessoa
 * termina as perguntas) junto com os pares de notas do dump (gate G3).
 */
(function (raiz, fabrica) {
  if (typeof module === 'object' && module.exports) module.exports = fabrica();
  else raiz.Especialista = fabrica();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const LIMITE = 100.0;
  const LINEAR = /^(\d+(?:\.\d+)?)\*N(?:\+(\d+(?:\.\d+)?))?$/;             // "10*N", "8*N+20"
  const MINIMO = /^min\((\d+(?:\.\d+)?),\s*(.+)\)$/;                       // "min(100, 8*N+20)"
  const CONDICIONAL = /^(.+) se N>=(\d+)$/;                                // "6*N se N>=8"

  class ErroDeUso extends Error {}

  // ------------------------------------------------------------------------------------------------ vetor-alvo (motor/perfil.py)
  function valorDaFormula(formula, n) {
    const texto = formula.trim();
    let m = CONDICIONAL.exec(texto);
    if (m) return n >= Number(m[2]) ? valorDaFormula(m[1], n) : 0.0;
    m = MINIMO.exec(texto);
    if (m) return Math.min(Number(m[1]), valorDaFormula(m[2], n));
    m = LINEAR.exec(texto);
    if (m) return Number(m[1]) * n + (m[2] === undefined ? 0.0 : Number(m[2]));
    throw new ErroDeUso(`não entendi a fórmula do slider: '${formula}'`);
  }

  function vetorAlvo(seed, respostas) {
    /* As respostas viram o alvo: pesos 0–100 para cada acorde do vocabulário, mais a projeção e a
     * longevidade desejadas e os avisos que a busca usa. Pergunta ausente = neutra. O peso do bloco
     * (docs/09: a hierarquia da pirâmide é a hierarquia das perguntas) multiplica o que ela soma. */
    const pesos = seed.pesos_blocos || {};
    const porId = new Map(seed.perguntas.map(p => [p.id, p]));
    for (const chave of Object.keys(respostas)) {
      if (!porId.has(chave)) throw new ErroDeUso(`pergunta desconhecida: ${chave}`);
    }
    const alvo = {};
    let projecao = null, longevidade = null, priorGender = null;
    const flags = [];
    for (const [pid, pergunta] of porId) {
      if (!Object.hasOwn(respostas, pid)) continue;
      const escolha = respostas[pid];
      const pesoDoBloco = pesos[pid] == null ? 1.0 : pesos[pid];
      if (pergunta.tipo === 'slider') {
        if (typeof escolha !== 'number') throw new ErroDeUso(`a resposta de '${pergunta.texto}' tem de ser um número de ${pergunta.min} a ${pergunta.max}`);
        for (const nome in pergunta.formula) alvo[nome] = (alvo[nome] || 0) + valorDaFormula(pergunta.formula[nome], escolha);
        continue;
      }
      const opcao = pergunta.opcoes.find(o => o.id === escolha);
      if (!opcao) throw new ErroDeUso(`não conheço essa resposta para '${pergunta.texto}': '${escolha}'`);
      for (const [nome, valor] of Object.entries(opcao.soma || {})) alvo[nome] = (alvo[nome] || 0) + valor * pesoDoBloco;
      if ('projecao_alvo' in opcao) projecao = opcao.projecao_alvo;
      if ('longevidade_alvo' in opcao) longevidade = opcao.longevidade_alvo;
      for (const flag of opcao.flags || []) if (!flags.includes(flag)) flags.push(flag);
      if ('prior_gender' in opcao) priorGender = opcao.prior_gender;
    }
    const acordes = {};
    for (const [nome, valor] of Object.entries(alvo)) if (valor > 0.0) acordes[nome] = Math.max(0.0, Math.min(LIMITE, valor));
    return { acordes, projecao_alvo: projecao, longevidade_alvo: longevidade, flags, prior_gender: priorGender };
  }

  function pesosDe(perfil) { return perfil && typeof perfil === 'object' && 'acordes' in perfil ? perfil.acordes : perfil; }

  function top3DoPerfil(perfilPrevisto, vocabulario = []) {
    /* Os 3 nomes de maior peso de um perfil (gate G1). Empate decide pela ordem da lista de nomes. */
    const pesos = pesosDe(perfilPrevisto) || {};
    const ordem = new Map(vocabulario.map((n, i) => [n, i]));
    return Object.entries(pesos).filter(([, peso]) => peso > 0)
      .map(([nome]) => nome)
      .sort((a, b) => pesos[b] - pesos[a] || (ordem.get(a) ?? ordem.size) - (ordem.get(b) ?? ordem.size) || (a < b ? -1 : 1))
      .slice(0, 3);
  }

  function l1(alvoA, alvoB) {
    /* Distância de Manhattan entre dois perfis {chave: peso}: o que um não fala conta como zero. */
    const a = pesosDe(alvoA) || {}, b = pesosDe(alvoB) || {};
    let soma = 0;
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) soma += Math.abs((a[k] || 0) - (b[k] || 0));
    return soma;
  }

  // ------------------------------------------------------------------------------------------------ a busca (os gates do docs/09)
  function recomendar(seed, dados9180, respostas, { maquina = null } = {}) {
    /* `seed` é a chave "especialista" do dados.json (perguntas + pesos + vocabulário); `dados9180` é o
     * especialista.json (previsões prontas da rede + pares do dump + facetas). `maquina` é aceito para o
     * futuro filtro por máquina — hoje a busca é na biblioteca inteira; o que cada máquina consegue fazer
     * aparece no catálogo, para onde o botão do resultado leva. */
    const vocab = seed.vocabulario;
    const idx = new Map(vocab.map((n, i) => [n, i]));
    const nomesPt = seed.nomes_pt || [];
    const pt = i => nomesPt[i] || vocab[i];
    const alvo = vetorAlvo(seed, respostas);

    const denso = new Array(vocab.length).fill(0);
    let somaAlvo = 0;
    for (const [nome, peso] of Object.entries(alvo.acordes)) {
      const i = idx.get(nome);
      if (i === undefined) throw new ErroDeUso(`o pedido fala de "${nome}", que não está no vocabulário do especialista`);
      denso[i] = peso;
      somaAlvo += peso;
    }

    // o acorde principal do pedido (gate G1): o maior peso do sub-vetor que só p5 (topo) e p7 (base) somam
    const daPiramide = {};
    if (Object.hasOwn(respostas, 'p5')) daPiramide.p5 = respostas.p5;
    if (Object.hasOwn(respostas, 'p7')) daPiramide.p7 = respostas.p7;
    const sub = vetorAlvo(seed, daPiramide);
    let principal = null;
    for (const [nome, peso] of Object.entries(sub.acordes)) {
      const i = idx.get(nome);
      if (principal === null || peso > principal.peso || (peso === principal.peso && i < principal.i)) principal = { i, peso };
    }

    const pares = new Set(dados9180.pares.map(p => p.toLowerCase()));     // o dump escreve "Bergamot|Musk": conferimos em minúsculas, nas duas ordens
    const juntos = (a, b) => pares.has(`${a}|${b}`) || pares.has(`${b}|${a}`);
    const g1 = seed.g1_l1_max != null ? seed.g1_l1_max : dados9180.g1_l1_max;
    const afin = a => alvo.prior_gender === 'female' ? a.afin_f : alvo.prior_gender === 'male' ? a.afin_m : 0;

    // ranking: menor L1 contra o perfil previsto de cada acorde (entrada ausente do esparso conta o peso
    // do alvo; dimensão do alvo ausente do previsto entra inteira). Empate decide pelo id, na ordem do texto.
    const ordenados = [];
    for (const a of dados9180.acordes) {
      let distancia = somaAlvo;
      for (const [i, p] of a.perfil) distancia += Math.abs(denso[i] - p) - denso[i];
      ordenados.push({ a, l1: distancia, chave: distancia - 5 * afin(a) });    // p11: +5 de afinidade do gênero escolhido — só desempata, o L1 não muda
    }
    ordenados.sort((x, y) => x.chave - y.chave || (x.a.id < y.a.id ? -1 : x.a.id > y.a.id ? 1 : 0));

    const faceta = a => dados9180.facetas[a.f] || { nome: '', familia: '' };
    const perto = (previsto, pedido) => pedido == null || Math.abs(previsto - pedido) <= 1;   // pedido ausente não penaliza

    function cartao(c) {
      const a = c.a;
      const top = a.perfil.slice().sort((x, y) => y[1] - x[1] || x[0] - y[0]);
      const top3 = top.slice(0, 3).map(([i]) => i);
      const raros = [];
      const top4 = top.slice(0, 4).map(([i]) => [i, vocab[i].toLowerCase()]);
      for (let x = 0; x < top4.length; x++) for (let y = x + 1; y < top4.length; y++) if (!juntos(top4[x][1], top4[y][1])) raros.push([top4[x][0], top4[y][0]]);
      const fiel = principal !== null && top3.includes(principal.i);
      const avisos = [];
      if (raros.length) {
        const mais = raros.length > 1 ? ` (e mais ${raros.length - 1} ${raros.length - 1 === 1 ? 'par' : 'pares'})` : '';
        avisos.push(`combinação rara: ${pt(raros[0][0])} + ${pt(raros[0][1])} nunca foram votadas juntas${mais}`);
      }
      return {
        id: a.id, nome: a.nome, faceta: faceta(a).nome, familia: faceta(a).familia,
        l1: c.l1, rating: a.rating, longevidade: a.longevidade, projecao: a.projecao, afin_f: a.afin_f, afin_m: a.afin_m,
        top: top.slice(0, 3).map(([i, p]) => ({ nome: pt(i), peso: p })),
        selos: {
          fiel,                                                                 // G1: o principal pedido está no top 3 do previsto
          distancia: fiel && c.l1 < g1,                                         // G1, segunda parte: perto do que foi pedido
          aprovado: a.rating >= 3.98,                                           // G2: previsão de nota da comunidade
          sinergia: raros.length === 0,                                         // G3: todo par do top 4 já andou junto (alerta, não veto)
          comportamento: perto(a.longevidade, alvo.longevidade_alvo) && perto(a.projecao, alvo.projecao_alvo),   // G4
        },
        avisos,
      };
    }

    const resultados = ordenados.slice(0, 3).map(cartao);
    const alternativas = ordenados.slice(3, 8).map(c => ({ id: c.a.id, nome: c.a.nome, faceta: faceta(c.a).nome, familia: faceta(c.a).familia, l1: c.l1 }));
    return {
      alvo,
      principal: principal === null ? null : { nome: vocab[principal.i], nome_pt: pt(principal.i), peso: principal.peso },
      resultados,
      alternativas,
      aviso_geral: resultados.some(r => r.selos.aprovado) ? null : 'a multidão não ama nada exatamente assim — o mais próximo é…',
    };
  }

  return { vetorAlvo, top3DoPerfil, l1, recomendar, ErroDeUso };
});
