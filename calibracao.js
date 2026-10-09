/* Calibração do vidro em JavaScript (docs/11 §2): o fator mg/passo e a densidade real de cada canal, medidos
 * por quem monta a máquina com uma balança de 0,01 g. Não é porte de nenhum Python — é ferramenta nova do app,
 * UI + conta própria; o motor de composição e o validador NÃO leem daqui (a densidade medida entra pelo mesmo
 * campo `densidade_g_ml` que o preenchimento manual do mapa usa, e o resto fica só na tela do canal).
 *
 * Onde grava: localStorage `perfume.calibracao.v1`, por máquina+canal (nunca no mapa): religa pelo canal e, se o
 * vidro trocar de material, a calibração aparece como DESATUALIZADA e pede recalibrar (a checagem rápida da
 * troca de vidro é o terceiro padrão do docs/11 §2). Testes: pwa/teste/calibracao.test.mjs.
 */
(function (raiz, fabrica) {
  if (typeof module === 'object' && module.exports) module.exports = fabrica();
  else raiz.Calibracao = fabrica();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const CHAVE = 'perfume.calibracao.v1';
  const CASAS = 3;                                  // casas dos fatores mg/passo e da densidade (µg/passo já é além da balança)
  const CONCENTRADO_G = 4;                          // docs/08 §4: lote de referência (30 ml EDP 15% ≈ 4 g de concentrado)
  const PISO_MG = 100;                              // docs/08 §4: ≥100 mg dispensados para erro ≤ ~20% (hipótese, dono decide a tolerância)
  const AVISO_PISO = 'este vidro dosa abaixo do piso de precisão p/ o uso típico — considere diluir mais';

  class ErroDeUso extends Error {}

  const r3 = x => Math.round((x + Number.EPSILON) * 1e3) / 1e3;

  /* Uma rodada: pesou o vidro cheio, rodou N passos da bomba, pesou de novo.
   * mg/passo = Δmassa × 1000 / passos (docs/11 §2). A balança de 0,01 g dá mg inteiros; o fator sai com 3 casas. */
  function fatorDaRodada(antes_g, depois_g, passos) {
    const num = v => typeof v === 'number' && Number.isFinite(v);
    if (!num(antes_g) || antes_g <= 0) throw new ErroDeUso('informe a massa do vidro cheio em gramas');
    if (!num(depois_g) || depois_g < 0) throw new ErroDeUso('informe a massa depois de rodar a bomba, em gramas');
    if (!num(passos) || !Number.isInteger(passos) || passos < 1) throw new ErroDeUso('os passos têm de ser um inteiro maior que zero');
    const mg = r3((antes_g - depois_g) * 1000);
    if (mg <= 0) throw new ErroDeUso('o vidro pesou mais depois de dispensar — confira as duas pesagens');
    return { mg, mg_por_passo: r3(mg / passos) };
  }

  /* Média e desvio-padrão (amostral, n−1) dos fatores das rodadas — 2–3 rodadas dão o desvio; com uma, null. */
  function mediaDesvio(fatores) {
    if (!Array.isArray(fatores) || !fatores.length) throw new ErroDeUso('calibração sem rodada nenhuma');
    const media = fatores.reduce((s, x) => s + x, 0) / fatores.length;
    const desvio = fatores.length >= 2
      ? r3(Math.sqrt(fatores.reduce((s, x) => s + (x - media) ** 2, 0) / (fatores.length - 1))) : null;
    return { media: r3(media), desvio };
  }

  /* Densidade real (proveta, opcional): média das massas/volumes das rodadas em que se mediu volume.
   * Faixa 0,5–2 g/ml — a mesma que o validador do mapa aceita; fora dela a leitura merece desconfiança. */
  function densidadeDasRodadas(rodadas) {
    const comVolume = (rodadas || []).filter(r => typeof r.volume_ml === 'number' && r.volume_ml > 0);
    if (!comVolume.length) return null;
    const d = comVolume.reduce((s, r) => s + (r.antes_g - r.depois_g) / r.volume_ml, 0) / comVolume.length;
    if (!(d >= 0.5 && d <= 2)) throw new ErroDeUso(`densidade medida de ${r3(d).toLocaleString('pt-BR')} g/ml está fora da faixa 0,5–2 — confira a proveta`);
    return r3(d);
  }

  /* "20 mg = X passos ±Y": a dose mínima da máquina em passos do fator medido (X arredondado; Y propaga o desvio). */
  function passosDaDose(dose_mg, fator, desvio) {
    if (!(fator > 0)) throw new ErroDeUso('fator de calibração inválido');
    const passos = Math.round(dose_mg / fator);
    return { passos, margem: desvio === null || desvio === undefined ? null : Math.round(passos * desvio / fator) };
  }

  /* A faixa de uso típico do catálogo ("2-35", "0.01-0.5"): números > 100 são outra coisa (é a régua do motor em _uso_maximo). */
  function usoTipicoPct(texto) {
    const nums = (String(texto || '').match(/\d+(?:\.\d+)?/g) || []).map(Number).filter(n => n <= 100);
    return nums.length ? { min: Math.min(...nums), max: Math.max(...nums) } : null;
  }

  /* A calibração continua valendo para este vidro? Religa como o mapa: pelo id, senão pelo CAS, senão pelo nome. */
  function materialBate(ref, atual) {
    if (!ref || !atual) return false;
    return ref.id === atual.id || (!!ref.cas && ref.cas === atual.cas) || (!!ref.nome && ref.nome === atual.nome);
  }

  /* O que passa a aparecer na tela do canal: passos da dose mínima, massa dispensada no uso típico (com o aviso do
   * piso de 100 mg) e o estoque quando há densidade medida. `material` é o material do dados.json do canal HOJE. */
  function conferencias(entrada, canal, material, dose_minima_mg) {
    const out = { desatualizada: false, fator: entrada.fator_mg_passo, desvio: entrada.desvio_mg_passo, avisos: [] };
    if (material && !materialBate(entrada.material, { id: material.id, nome: material.nome, cas: material.cas })) {
      out.desatualizada = true;
      out.avisos.push(`calibração desatualizada (gravada para ${entrada.material.nome}; recalibre este vidro)`);
      return out;
    }
    out.passosDose = passosDaDose(dose_minima_mg, entrada.fator_mg_passo, entrada.desvio_mg_passo);
    const uso = material ? usoTipicoPct(material.uso_tipico_pct) : null;
    if (uso) {
      out.usoTipico = { pct: uso.min, faixa: uso, dispensado_mg: r3(CONCENTRADO_G * 1000 * uso.min / 100 / (canal.diluicao_pct / 100)) };
      if (out.usoTipico.dispensado_mg < PISO_MG) out.avisos.push(AVISO_PISO);
    } else {
      out.usoTipico = null;
      out.avisos.push('sem uso típico no catálogo: o piso de 100 mg não é conferível para este material');
    }
    if (entrada.densidade_g_ml && typeof canal.volume_atual_ml === 'number' && canal.volume_atual_ml >= 0) {
      out.estoque_g = Math.round((entrada.densidade_g_ml * canal.volume_atual_ml) * 10) / 10;
    }
    return out;
  }

  /* As entradas ficam em localStorage (chave única, por máquina+canal), como "Minha máquina" e as receitas. */
  function criar(lembrar) {
    const chave = (maquina, canal) => `${maquina}:${canal}`;
    const ler = () => {
      try {
        const j = JSON.parse(lembrar.ler(CHAVE));
        return j && typeof j === 'object' && j.canais ? j : { versao: 1, canais: {} };
      } catch { return { versao: 1, canais: {} }; }
    };
    return {
      do(maquina, canal) { return ler().canais[chave(maquina, canal)] || null; },
      salvar(entrada) { const j = ler(); j.canais[chave(entrada.maquina, entrada.canal)] = entrada; lembrar.gravar(CHAVE, JSON.stringify(j)); },
      limpar(maquina, canal) { const j = ler(); delete j.canais[chave(maquina, canal)]; lembrar.gravar(CHAVE, JSON.stringify(j)); },
    };
  }

  return {
    CHAVE, ErroDeUso, CONCENTRADO_G, PISO_MG, AVISO_PISO, criar,
    fatorDaRodada, mediaDesvio, densidadeDasRodadas, passosDaDose, usoTipicoPct, materialBate, conferencias,
  };
});
