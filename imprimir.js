/* A aba "Imprimir" (docs/11 §1, leva SITE-1 — fluxo F1 local) em JavaScript: o LOTE MÍNIMO da decisão 14, o seletor
 * de volume com as opções desabilitadas ANTES de imprimir, a PRÉ-CHECAGEM de estoque da decisão 8 e o arquivo .json
 * da fórmula (decisão 9 — quem imprime recebe a fórmula). Não é porte de nenhum Python — é ferramenta nova do app;
 * o motor de composição e o validador são REUSADOS por leitura (/api/ajustar compõe a dosagem e conferes os limites),
 * e o motor.js não é tocado: a redução de um acorde do dicionário lê a Instancia que o Motor exporta.
 *
 * As contas (docs/11 §1.1 decisão 14): para cada ingrediente i com fração mássica f_i e canal de diluição c_i, a
 * massa de SOLUÇÃO dispensada é s_i = f_i × M_lote ÷ c_i; a máquina dosa no mínimo `dose_minima_g` (20 mg, docs/08
 * §4), logo M_min = max_i (dose × c_i ÷ f_i) — no canal MAIS diluído do material, que é o que favonece o mínimo.
 * Miligramas em ml pela densidade declarada 0,83 g/ml (a aproximação do projeto, rotulada onde aparece).
 *
 * Nada aqui faz rede: a biblioteca 9.180 entra pelo fetch que já existia (biblioteca.json, guardado pelo SW).
 * Testes: pwa/teste/imprimir.test.mjs.
 */
(function (raiz, fabrica) {
  if (typeof module === 'object' && module.exports) module.exports = fabrica();
  else raiz.Imprimir = fabrica();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const VOLUMES_ML = [5, 10, 15, 20, 25, 30, 40, 50, 60, 70, 80, 90, 100];   // a grade da decisão 3 (5 a 100 ml)
  const DENSIDADE_DECLARADA = 0.83;        // g/ml — a aproximação declarada do projeto (guia de montagem dos vidros)
  const RESERVA_ESTOQUE = 0.05;            // a mesma do validador: a linha "não cobre" acompanha o bloqueio do motor
  const CONCENTRACAO_PADRAO = 15.0;        // o PADRAO do Brief do motor: acorde é CONCENTRADO — o motor dosaria 15% e completaria com etanol
  const COBERTURA_MIN = 0.8;               // a mesma do motor ao reduzir um acorde aos vidros da máquina
  const GRATIS = 'Grátis — conteúdo que acompanha a máquina';                // decisão 10: catálogo/acordes/biblioteca/receitas acompanham a máquina
  const ESTOQUE_TEORICO = 'estoque teórico — vidro não calibrado';           // sem densidade no canal, nenhum número é inventado

  class ErroDeUso extends Error {}

  let M = null;                            // o Motor, injetado por usar() (o app carrega motor.js antes e chama ao iniciar)
  const motor = () => {
    if (!M) throw new ErroDeUso('chame Imprimir.usar(Motor) antes de usar o módulo');
    return M;
  };

  const fmt1 = n => Number(n).toLocaleString('pt-BR', { maximumFractionDigits: 1 });
  const pctTxt = p => (p < 1 ? Number(p).toLocaleString('pt-BR', { maximumFractionDigits: 3 }) : fmt1(p));   // traço menor que 1% não pode aparecer como "0%"
  const soma = xs => xs.reduce((s, x) => s + x, 0);
  const r4 = x => motor().numeros.pyround(x, 4);            // as gramas do arquivo têm 4 casas, como as receitas do app

  /* O canal ativo mais diluído do material (menos ativo por massa dispensada: é o que deixa o lote mínimo menor). */
  function canalMaisDiluido(maquina, material_id) {
    let melhor = null;
    for (const c of maquina.canais) if (c.ativo && c.material_id === material_id && (!melhor || c.diluicao_pct < melhor.diluicao_pct)) melhor = c;
    return melhor;
  }

  /* LOTE MÍNIMO (decisão 14): M_min = max_i (dose_mg × c_i ÷ f_i) sobre os aromáticos que têm canal nesta máquina.
   * `itens` = [{material_id, fracao}] com fração mássica sobre o lote (0–1); o limitante vem nomeado para a tela explicar. */
  function loteMinimo(db, maquina_id, itens) {
    const maq = db.maquinas.get(maquina_id);
    const dose_mg = Math.round(maq.dose_minima_g * 1000);
    let pico = null;
    for (const it of itens) {
      if (!(it.fracao > 0)) continue;
      const m = db.materiais.get(it.material_id);
      if (!m || m.tipo_material === 'solvent') continue;    // o solvente nunca limita (canal puro, fração grande)
      const canal = canalMaisDiluido(maq, it.material_id);
      if (!canal) continue;                                 // sem canal: quem avisa é o faltando, não o lote
      const mg = dose_mg * (canal.diluicao_pct / 100) / it.fracao;
      if (pico === null || mg > pico.mg) pico = { mg, material_id: it.material_id, nome: m.nome, fracao: it.fracao,
        canal: canal.canal, diluicao_pct: canal.diluicao_pct };
    }
    return { mg: pico === null ? 0 : pico.mg, ml: pico === null ? 0 : pico.mg / 1000 / DENSIDADE_DECLARADA, dose_mg, limitante: pico };
  }

  /* A explicação da decisão 14, no estilo do exemplo do dono: nomeia o ingrediente limitante e o menor lote que dosa. */
  function explicacaoLote(lote, ml) {
    const l = lote.limitante;
    if (l === null) return '';
    const mgAqui = l.fracao * ml * DENSIDADE_DECLARADA / (l.diluicao_pct / 100);
    return `o ${l.nome} é ${pctTxt(l.fracao * 100)}% da fórmula — em ${ml} ml seriam ${fmt1(mgAqui)} mg, abaixo dos ${lote.dose_mg} mg`
      + ` que a máquina consegue dosar; o menor lote que dosa é ${fmt1(lote.ml)} ml`;
  }

  /* O seletor: as 13 opções da grade, desabilitadas ABAIXO do lote mínimo (com o motivo físico) e ACIMA do lote da
   * máquina (a mvp-64 dosa até 44 g ≈ 53 ml — dado do mapa, não inventado). `padrao` é a menor opção que dosa. */
  function seletor(db, maquina_id, itens) {
    const maq = db.maquinas.get(maquina_id);
    const lote = loteMinimo(db, maquina_id, itens);
    const mlMax = maq.lote_max_g / DENSIDADE_DECLARADA;
    const opcoes = VOLUMES_ML.map(ml => {
      const g = ml * DENSIDADE_DECLARADA;
      if (g + 1e-9 < lote.mg / 1000) return { ml, g, desabilitada: 'lote', motivo: explicacaoLote(lote, ml) };
      if (g > maq.lote_max_g + 1e-9) return { ml, g, desabilitada: 'maquina',
        motivo: `a máquina dosa até ${fmt1(mlMax)} ml por lote (${fmt1(maq.lote_max_g)} g)` };
      return { ml, g, desabilitada: null, motivo: null };
    });
    return { lote, opcoes, ml_max: mlMax, padrao: opcoes.find(o => !o.desabilitada) || null,
      aviso_referencia: null, explicacao: opcoes.some(o => o.desabilitada === 'lote') ? explicacaoLote(lote, opcoes.find(o => o.desabilitada === 'lote').ml) : '' };
  }

  /* O aviso da decisão 14 quando não há máquina própria vinculada: o cálculo é contra a de referência, e as
   * diluições dos vidros de quem imprime mudam o resultado. */
  function avisoReferencia(db, maquina_id) {
    return `calculado contra a ${db.maquinas.get(maquina_id).nome} de referência (as diluições dos seus vidros mudam o lote)`;
  }

  // ---------------------------------------------------------------------------------------------- as fórmulas das três fontes
  /* Receita salva: as gramas de ativo religadas pelo motor viram frações sobre a massa final — é o que escala para o lote. */
  function daReceita(formula, massa_final_g, titulo, nota = null, respostas = {}) {
    const itens = Object.entries(formula).map(([id, g]) => ({ material_id: Number(id), fracao: g / massa_final_g }));
    return { titulo, itens, fonte: 'receitas', nota, respostas, trocas: [], escolhas: [], faltando: [], cobertura: 1, impossivel: false };
  }

  /* Acorde do dicionário resolvido contra os vidros desta máquina — o caminho do motor (instanciar → reduzir →
   * materializar), feito aqui LENDO a Instancia exportada: cobertura ≥ 80% das partes, fração = partes ÷ total mantido,
   * estados ok/nota/parecido materializam o escolhido, e o item de nota vira acorde de nota uma vez (fundo 1), igual `_materializar`. */
  function _materializar(db, item, inv, fundo, trocas, escolhas) {
    const est = item.estado, esc = item.escolhido;
    if ((est === 'ok' || est === 'nota_unica' || est === 'parecido') && esc) {
      if (est === 'parecido') trocas.push(`${item.nome_raw} → ${esc.nome} (parecido)`);
      return [[esc.material_id, 1.0]];
    }
    if (est === 'nota_opcoes' && item.opcoes.length) {
      escolhas.push({ item: item.nome_raw, opcoes: item.opcoes.map(o => o.nome) });
      return [[item.opcoes[0].material_id, 1.0]];
    }
    if (est === 'nota_acorde' && item.opcoes.length && fundo === 0) {
      const ins = motor().instanciar(db, item.opcoes[0].acorde_id, inv, 1);
      const pares = [];
      for (const r of _reduzir(ins) || []) {
        const sub = _materializar(db, r, inv, 1, trocas, escolhas);
        for (const [m, f] of sub) pares.push([m, r.fracao * f]);
      }
      return pares;
    }
    return [];
  }

  function _reduzir(inst) {
    const uteis = inst.itens.filter(i => i.estado !== 'solvente');
    const tot = soma(uteis.map(i => i.partes || 0));
    const mantidos = uteis.filter(i => i.estado !== 'faltando' && i.partes);
    const totalMantido = soma(mantidos.map(i => i.partes));
    if (!tot || totalMantido / tot < COBERTURA_MIN - 1e-9) return null;      // o motor descarta abaixo de 80% das partes
    return mantidos.map(i => ({ ...i, fracao: i.partes / totalMantido }));
  }

  function doAcorde(db, acorde_id, maquina_id) {
    const inv = motor().inventario(db, maquina_id);
    const inst = motor().instanciar(db, acorde_id, inv);
    const red = _reduzir(inst);
    const faltando = inst.itens.filter(i => i.estado === 'faltando').map(i => i.nome_raw);
    if (red === null) {
      return { titulo: inst.nome, itens: [], fonte: 'acordes', impossivel: true, faltando,
        aviso: `esta máquina cobre pouco deste acorde (${fmt1(inst.cobertura_partes * 100)}% das partes) — escolha outro ou troque os vidros` };
    }
    const trocas = [], escolhas = [], mats = new Map();
    for (const r of red) {
      for (const [m, f] of _materializar(db, r, inv, 0, trocas, escolhas)) mats.set(m, (mats.get(m) || 0) + r.fracao * f);
    }
    return { titulo: inst.nome, itens: [...mats].map(([material_id, fracao]) => ({ material_id, fracao })), fonte: 'acordes',
      trocas, escolhas, faltando, cobertura: inst.cobertura_partes, impossivel: false };
  }

  /* Acorde da biblioteca 9.180 (biblioteca.json, o fetch que já existia): itens por ÍNDICE de CAS resolvidos contra os
   * vidros — o material presente, senão o parecido (o mesmo caminho de `_resolver_da_biblioteca`, sem os proibidos do brief). */
  function daBiblioteca(db, maquina_id, indice) {
    if (!db.biblioteca) throw new ErroDeUso('a biblioteca de acordes ainda não foi baixada');
    const b = db.biblioteca, [id, nome, tier, ni, seusItens] = b.acordes[indice];
    const inv = motor().inventario(db, maquina_id);
    const universo = new Set(inv.keys());
    const total = soma(seusItens.map(([, p]) => p));
    const mantidos = new Map(), trocas = [];
    let mantido = 0.0;
    for (const [ci, partes] of seusItens) {
      const ids = db.por_cas.get(b.cas[ci]) || [];
      let mid = ids.find(m => universo.has(m));
      if (mid === undefined) {
        const alvo = ids[0];
        const par = alvo === undefined ? null : motor().parecidos_em(db, alvo, universo)[0];
        if (!par) continue;                                   // item fora: a cobertura dá conta dele
        mid = par[0];
        trocas.push(`${db.nome(alvo)} → ${db.nome(mid)} (parecido)`);
      }
      mantido += partes;
      mantidos.set(mid, (mantidos.get(mid) || 0) + partes);
    }
    if (!total || mantido / total < COBERTURA_MIN - 1e-9) {
      return { titulo: nome, itens: [], fonte: 'biblioteca', impossivel: true, faltando: [],
        aviso: `esta máquina cobre pouco deste acorde (${fmt1(100 * mantido / total)}% das partes) — escolha outro` };
    }
    return { titulo: nome, itens: [...mantidos].map(([material_id, p]) => ({ material_id, fracao: p / mantido })), fonte: 'biblioteca',
      trocas, escolhas: [], faltando: [], cobertura: mantido / total, impossivel: false,
      no_catalogo: id, nota_faceta: ni === null ? null : b.notas[ni], tier };
  }

  /* Um acorde do banco/biblioteca é um CONCENTRADO (o compositor nunca o usa puro: cumarina a 5% viola a IFRA no
   * produto). A impressão dosa como o motor dosaria — a 15%, o PADRAO do Brief — e o etanol completa o frasco; as
   * frações passam a ser sobre o PRODUTO (como nas receitas salvas), e a tela declara a concentração usada. */
  function comoProduto(f, concentracao_pct = CONCENTRACAO_PADRAO) {
    return { ...f, concentracao_pct, itens: f.itens.map(i => ({ ...i, fracao: i.fracao * concentracao_pct / 100 })) };
  }

  // ---------------------------------------------------------------------------------------------- pré-checagem (decisão 8)
  /* A fórmula escalada para o lote escolhido passa pelo motor (/api/ajustar): a dosagem vidro a vidro é o que a
   * impressão vai consumir, e o estoque de cada vidro sai do mapa (volume × densidade — a calibração v1 preenche a
   * densidade pelo mesmo campo do preenchimento manual). Sem densidade o estoque é teórico: nenhum número inventado.
   * Os bloqueios são os erros do próprio motor (estoque, dose mínima, IFRA, lote) — mais as linhas "não cobre". */
  function prechecagem(db, app, maquina_id, formula, massa_g, nome) {
    const itens = {};
    for (const it of formula.itens) itens[it.material_id] = it.fracao * massa_g;
    let j;
    try {
      j = app.chamar('/api/ajustar', { maquina: maquina_id, respostas: {}, itens, novos: {}, massa_final_g: massa_g, nome, tecnico: true });
    } catch (e) { return { ok: false, linhas: [], bloqueios: [e.message], semEstoque: [], outros: [e.message], avisos: [], candidato: null, faltando: [] }; }
    const maq = db.maquinas.get(maquina_id);
    const linhas = j.candidato.tecnico.job.itens.map(i => {
      const c = maq.por_canal.get(i.canal);
      const restam = c && c.densidade_g_ml && c.volume_atual_ml !== null
        ? Math.round(c.densidade_g_ml * c.volume_atual_ml * 10) / 10 : null;    // a mesma conta do bloco de calibração
      const cobre = restam === null ? null : i.gramas <= restam * (1 - RESERVA_ESTOQUE) + 1e-9;
      return { canal: i.canal, material: i.material, usar_g: i.gramas, restam_g: restam,
        estoque_texto: restam === null ? ESTOQUE_TEORICO : `restam ~${fmt1(restam)} g`, cobre };
    }).sort((a, b) => a.canal - b.canal);
    const semEstoque = linhas.filter(l => l.cobre === false)
      .map(l => `não vai dar com o que tem: ${l.material} — a impressão pede ${fmt1(l.usar_g)} g e ${l.estoque_texto} no vidro ${l.canal}`);
    const outros = j.problemas.filter(p => !/ restam ~.+ g no frasco$/.test(p));
    return { ok: j.problemas.length === 0, linhas, bloqueios: semEstoque.concat(outros), semEstoque, outros,
      avisos: j.avisos, candidato: j.candidato, faltando: j.candidato.faltando };
  }

  // ---------------------------------------------------------------------------------------------- o "XML" da decisão 9
  /* O arquivo que o app já troca (perfume.receitas.v1), com o VOLUME do lote escolhido: quem imprime recebe a
   * fórmula. A nota só vai quando existe (receita avaliada) — nota de acorde nunca foi dada, e não se inventa. */
  function arquivoDaFormula(db, formula, massa_g, criada_em) {
    return {
      formato: 'perfume.receitas.v1', dados: db.versao,
      receitas: [{
        nome: formula.titulo, maquina: '', massa_final_g: r4(massa_g), nota: formula.nota === undefined ? null : formula.nota,
        comentario: null, criada_em, pai_id: null, respostas: {}, protagonista_id: 0,
        itens: formula.itens.map(i => {
          const m = db.materiais.get(i.material_id);
          return { id: i.material_id, cas: m.cas, nome: m.nome, gramas: r4(i.fracao * massa_g) };
        }),
      }],
    };
  }

  return {
    ErroDeUso, VOLUMES_ML, DENSIDADE_DECLARADA, GRATIS, ESTOQUE_TEORICO, CONCENTRACAO_PADRAO,
    usar(m) { M = m; },
    canalMaisDiluido, loteMinimo, explicacaoLote, seletor, avisoReferencia,
    daReceita, doAcorde, daBiblioteca, comoProduto, prechecagem, arquivoDaFormula,
  };
});
