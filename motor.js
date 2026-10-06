/* Motor de composição de perfumes em JavaScript: PORTE de dados/motor/*.py para rodar offline no celular, sem servidor e sem IA.
 *
 * Os nomes (funções, campos) são os do Python de propósito: confira um contra o outro. Contas, ordem de iteração e textos
 * são os mesmos; quem garante é pwa/teste/paridade.test.mjs, que compara a saída deste arquivo com o que o Python respondeu
 * (golden gerado por exportar_pwa.py). O banco chega pronto em dados.json: ordens e empates que o Python deixava ao
 * SQLite foram decididos na exportação.
 *
 * Onde o Python recebia `maquina_id` só para reabrir o inventário (notas, parecidos, instanciar...), aqui o inventário `inv` já vem
 * pronto e o parâmetro some (o mesmo vale para `db` e a máquina em `proxima`, `responder` e `caminho`, que só olham as respostas e as
 * `capacidades`); `inventario`, `compor`, `validar`, `traduzir_itens` e `capacidades` continuam recebendo a máquina.
 *
 * Armadilhas do porte, todas tratadas aqui:
 *  - material_id é inteiro e objeto JS reordena chave inteira: tudo que é {material_id: valor} é Map.
 *  - sum() do Python (3.12+) soma floats com compensação de Neumaier, o JS não: `soma`.
 *  - round() e format() do Python arredondam o valor binário exato e o empate vai para o par: `pyround`, `fixo`, `porcento`, `fmt_g`.
 */
(function (raiz, fabrica) {
  if (typeof module === 'object' && module.exports) module.exports = fabrica();
  else raiz.Motor = fabrica();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ------------------------------------------------------------------------------------------------ números como o Python
  function soma(xs) {
    let f = 0, c = 0;
    for (const x of xs) {
      const t = f + x;
      c += Math.abs(f) >= Math.abs(x) ? (f - t) + x : (x - t) + f;
      f = t;
    }
    return c && Number.isFinite(c) ? f + c : f;
  }

  function fixo(x, nd) {                                    // format(x, f'.{nd}f')
    const neg = x < 0 || Object.is(x, -0);
    const [inteira, frac] = Math.abs(x).toFixed(100).split('.');   // 100 casas: a expansão decimal exata dos valores que usamos
    let n = BigInt(inteira + frac.slice(0, nd));
    const d = frac.charCodeAt(nd) - 48;
    if (d > 5 || (d === 5 && (/[1-9]/.test(frac.slice(nd + 1)) || n % 2n === 1n))) n += 1n;
    let s = n.toString().padStart(nd + 1, '0');
    if (nd) s = s.slice(0, -nd) + '.' + s.slice(-nd);
    return (neg ? '-' : '') + s;
  }

  const pyround = (x, nd) => Number(fixo(x, nd));           // round(x, nd)
  const porcento = (x, nd) => fixo(x * 100, nd) + '%';      // format(x, f'.{nd}%')

  function fmt_g(x, p = 6) {                                // format(x, f'.{p}g')
    if (x === 0) return Object.is(x, -0) ? '-0' : '0';
    const [mant, ex] = Math.abs(x).toExponential(100).split('e');
    const dig = mant.replace('.', '');
    let cabeca = BigInt(dig.slice(0, p)), e = Number(ex);
    const d = dig.charCodeAt(p) - 48;
    if (d > 5 || (d === 5 && (/[1-9]/.test(dig.slice(p + 1)) || cabeca % 2n === 1n))) cabeca += 1n;
    let s = cabeca.toString();
    if (s.length > p) { s = s.slice(0, p); e += 1; }
    s = s.replace(/0+$/, '');
    let r;
    if (e < -4 || e >= p) r = s[0] + (s.length > 1 ? '.' + s.slice(1) : '') + 'e' + (e < 0 ? '-' : '+') + String(Math.abs(e)).padStart(2, '0');
    else if (e >= 0) { const t = s.padEnd(e + 1, '0'); r = t.slice(0, e + 1) + (t.length > e + 1 ? '.' + t.slice(e + 1) : ''); }
    else r = '0.' + '0'.repeat(-e - 1) + s;
    return (x < 0 ? '-' : '') + r;
  }

  // repr() de um valor que chega ao validador: as doses são sempre float no Python, então 0 é '0.0' (arredondar uma dose minúscula dá 0.0)
  const repr_py = v => v === null || v === undefined ? 'None' : typeof v === 'string' ? `'${v}'` : typeof v === 'boolean' ? (v ? 'True' : 'False')
    : Number.isInteger(v) ? v.toFixed(1) : String(v);

  // ------------------------------------------------------------------------------------------------ banco em memória
  class ErroDeUso extends Error {}

  class Banco {
    constructor(d) {
      this.versao = d.versao;
      this.materiais = new Map(d.materiais.map(m => [m.id, m]));
      this.notas = new Map(d.notas.map(n => [n.id, n]));
      this.nota_por_slug = new Map(d.notas.map(n => [n.slug, n]));
      this.materiais_da_nota = new Map();         // nota_id -> [[material_id, confirmado]] (confirmados primeiro, depois por id)
      for (const [nid, mid, conf] of d.nota_material) this._empilhar(this.materiais_da_nota, nid, [mid, conf]);
      this.acordes = new Map(d.acordes.map(a => [a.id, a]));
      this.acordes_motor = d.acordes.filter(a => a.motor);
      this.acordes_da_nota = new Map();           // nota_id -> [acorde_id]
      for (const a of d.acordes) if (a.nota_id !== null) this._empilhar(this.acordes_da_nota, a.nota_id, a.id);
      this.equivalentes = new Map();              // material_id -> [[outro_id, similaridade]]
      for (const [a, b, sim] of d.equivalencias) { this._empilhar(this.equivalentes, a, [b, sim]); this._empilhar(this.equivalentes, b, [a, sim]); }
      this.exclusoes = new Map();                 // material_id -> [[nivel, nota]]
      this.excluidos = new Set();                 // 'proibido' ou 'evitar'
      for (const [mid, nivel, nota] of d.exclusoes) {
        this._empilhar(this.exclusoes, mid, [nivel, nota]);
        if (nivel === 'proibido' || nivel === 'evitar') this.excluidos.add(mid);
      }
      this.populares = new Map();                 // material_id -> em quantos itens de acorde ele aparece
      for (const a of d.acordes) for (const it of a.itens) if (it.material_id !== null) this.populares.set(it.material_id, (this.populares.get(it.material_id) || 0) + 1);
      this.por_papel = new Map();                 // 'familia|nota' -> materiais com descritores
      this.por_cas = new Map();
      for (const m of d.materiais) {
        if (m.descritores !== null && m.familia_canonica !== null && m.nota_piramide !== null) this._empilhar(this.por_papel, m.familia_canonica + '|' + m.nota_piramide, m);
        if (m.cas) this._empilhar(this.por_cas, m.cas, m.id);
      }
      this.maquinas = new Map(d.maquinas.map(m => [m.id, this._maquina(m)]));
      this.questionario = d.questionario;
      this.glossario = new Map(Object.entries(d.glossario));
      this.familias_pt = d.familias_pt;
      this.regras_quimicas = d.regras_quimicas;
    }

    _empilhar(mapa, chave, valor) {
      if (!mapa.has(chave)) mapa.set(chave, []);
      mapa.get(chave).push(valor);
    }

    _maquina(m) {
      const por_canal = new Map(m.canais.map(c => [c.canal, c]));
      const ativos_do_material = new Map();       // material_id -> canais ativos, do mais diluído ao menos (empate: menor canal)
      for (const c of m.canais) if (c.ativo) this._empilhar(ativos_do_material, c.material_id, c);
      for (const lista of ativos_do_material.values()) lista.sort((a, b) => a.diluicao_pct - b.diluicao_pct || a.canal - b.canal);
      return { ...m, por_canal, ativos_do_material };
    }

    nome(mid) { return this.materiais.get(mid).nome; }
    adicionar_maquina(m) { this.maquinas.set(m.id, this._maquina(m)); }
    remover_maquina(id) { this.maquinas.delete(id); }
  }

  // ------------------------------------------------------------------------------------------------ notas.py
  const JACCARD_MIN_PAPEL = 0.25;

  function inventario(db, maquina_id) {
    const inv = new Map();
    for (const c of db.maquinas.get(maquina_id).canais) {
      if (!c.ativo) continue;
      if (!inv.has(c.material_id)) inv.set(c.material_id, []);
      inv.get(c.material_id).push([c.canal, c.diluicao_pct]);
    }
    return inv;
  }

  function _ref(db, mid, inv) {
    const canal = inv.has(mid) ? Math.min(...inv.get(mid).map(x => x[0])) : null;
    return { material_id: mid, nome: db.nome(mid), canal };
  }

  function parecidos_em(db, material_id, universo) {
    const achados = new Map();
    for (const [outro, sim] of db.equivalentes.get(material_id) || []) if (universo.has(outro)) achados.set(outro, ['equivalencia', sim]);
    const base = db.materiais.get(material_id);
    if (base.familia_canonica && base.nota_piramide && base.descritores) {
      const d0 = new Set(base.descritores);
      for (const m of db.por_papel.get(base.familia_canonica + '|' + base.nota_piramide) || []) {
        if (m.id === material_id || achados.has(m.id) || !universo.has(m.id)) continue;
        let comuns = 0;
        for (const x of m.descritores) if (d0.has(x)) comuns++;
        const uniao = d0.size + m.descritores.length - comuns;
        const j = uniao ? comuns / uniao : 0.0;
        if (j >= JACCARD_MIN_PAPEL) achados.set(m.id, ['papel', pyround(j, 3)]);
      }
    }
    return [...achados].sort((a, b) => ((a[1][0] !== 'equivalencia') - (b[1][0] !== 'equivalencia')) || (b[1][1] - a[1][1]) || (a[0] - b[0]))
      .map(([m, [nv, sim]]) => [m, nv, sim]);
  }

  function parecidos(db, material_id, inv) {
    return parecidos_em(db, material_id, inv).map(([m, nv, sim]) => ({ ..._ref(db, m, inv), nivel: nv, similaridade: sim }));
  }

  class ItemResolvido {
    constructor(ordem, nome_raw, partes, estado) {
      Object.assign(this, { ordem, nome_raw, partes, estado, escolhido: null, opcoes: [], nota: null });
    }
  }

  class Instancia {
    constructor(acorde_id, nome) { this.acorde_id = acorde_id; this.nome = nome; this.itens = []; }
    get _uteis() { return this.itens.filter(i => i.estado !== 'solvente'); }
    get faltando() { return this._uteis.filter(i => i.estado === 'faltando'); }
    get completo() { return this._uteis.length > 0 && this.faltando.length === 0; }
    get exato() { return this.completo && this._uteis.every(i => i.estado === 'ok' || i.estado === 'nota_unica'); }
    get com_variacao() { return this._uteis.some(i => i.estado === 'parecido'); }
    get cobertura_partes() {
      const tot = soma(this._uteis.map(i => i.partes || 0));
      return tot ? soma(this._uteis.filter(i => i.estado !== 'faltando').map(i => i.partes || 0)) / tot : 0.0;
    }
  }

  function reduzir(inst, minimo = 0.8) {
    if (inst.cobertura_partes < minimo - 1e-9) return null;
    const mantidos = inst._uteis.filter(i => i.estado !== 'faltando' && i.partes);
    const tot = soma(mantidos.map(i => i.partes));
    return mantidos.map(i => ({ nome: i.nome_raw, fracao: i.partes / tot, estado: i.estado, escolhido: i.escolhido, opcoes: i.opcoes }));
  }

  function opcoes_nota(db, nota_id, inv, fundo = 0) {
    const { slug, nome } = db.notas.get(nota_id);
    const diretos = [];
    for (const [mid, confirmado] of db.materiais_da_nota.get(nota_id) || []) if (inv.has(mid)) diretos.push({ ..._ref(db, mid, inv), confirmado: !!confirmado });
    const acordes = [];
    if (fundo < 1) {                                        // acorde de nota não pode pedir outra nota (evita ciclo)
      for (const aid of db.acordes_da_nota.get(nota_id) || []) {
        const ins = instanciar(db, aid, inv, fundo + 1);
        acordes.push({ acorde_id: aid, nome: ins.nome, completo: ins.completo, exato: ins.exato, com_variacao: ins.com_variacao,
          cobertura_partes: pyround(ins.cobertura_partes, 3), faltando: ins.faltando.map(i => i.nome_raw) });
      }
    }
    const decisao = diretos.length === 1 ? 'unico' : diretos.length > 1 ? 'opcoes' : acordes.some(a => a.completo) ? 'acorde' : 'indisponivel';
    return { nota: slug, nome, decisao, diretos, acordes };
  }

  function _resolver_item(db, item, candidatos, inv, fundo) {
    const presentes = candidatos.map(c => c[0]).filter(m => m !== null && inv.has(m));
    if (presentes.length) {                                 // 1) material que a máquina tem
      item.estado = 'ok';
      item.escolhido = _ref(db, presentes[0], inv);
      if (presentes.length > 1) item.opcoes = presentes.map(m => _ref(db, m, inv));
      return;
    }
    for (const [, nid] of candidatos) {                     // 2) nota: um químico, opções ou acorde que a reconstrói
      if (nid === null) continue;
      const o = opcoes_nota(db, nid, inv, fundo);
      item.nota = o.nota;
      if (o.decisao === 'unico') { item.estado = 'nota_unica'; item.escolhido = o.diretos[0]; return; }
      if (o.decisao === 'opcoes') { item.estado = 'nota_opcoes'; item.opcoes = o.diretos; return; }
      if (o.decisao === 'acorde') { item.estado = 'nota_acorde'; item.opcoes = o.acordes.filter(a => a.completo); return; }
    }
    for (const [m] of candidatos) {                         // 3) parecido (variação)
      if (m === null) continue;
      const par = parecidos(db, m, inv);
      if (par.length) { item.estado = 'parecido'; item.escolhido = par[0]; item.opcoes = par; return; }
    }
  }

  function instanciar(db, acorde_id, inv, fundo = 0) {
    const ac = db.acordes.get(acorde_id);
    const res = new Instancia(acorde_id, ac.nome);
    for (const it of ac.itens) {
      const item = new ItemResolvido(it.ordem, it.nome, it.partes, 'faltando');
      if (it.solvente) item.estado = 'solvente';
      else _resolver_item(db, item, [[it.material_id, it.nota_id], ...it.alts], inv, fundo);
      res.itens.push(item);
    }
    return res;
  }

  // ------------------------------------------------------------------------------------------------ validar_formula.py
  const RESERVA_ESTOQUE = 0.05;
  const ERRO_MAX_AVISO = 0.20;

  class Resultado {
    constructor() { this.violacoes = []; this.resumo = {}; }
    get ok() { return !this.violacoes.some(v => v.nivel === 'erro'); }
  }

  const _viol = (codigo, nivel, mensagem, canal = null) => ({ codigo, nivel, mensagem, canal });

  function validar(db, maquina_id, formula, erro_max = ERRO_MAX_AVISO) {
    const r = new Resultado();
    const maq = db.maquinas.get(maquina_id);
    if (!maq) { r.violacoes.push(_viol('MAQUINA_INEXISTENTE', 'erro', `máquina '${maquina_id}' não existe`)); return r; }
    const itens = formula.itens || [];
    if (!itens.length) { r.violacoes.push(_viol('FORMULA_VAZIA', 'erro', 'fórmula sem itens')); return r; }

    const vistos = new Set(), ativo_por_material = new Map();
    let total = 0.0;
    for (const it of itens) {
      const canal = it.canal === undefined ? null : it.canal, g = it.gramas;
      if (typeof g !== 'number' || !Number.isFinite(g) || g <= 0) { r.violacoes.push(_viol('GRAMAS_INVALIDO', 'erro', `gramas inválido (${repr_py(g)})`, canal)); continue; }
      if (vistos.has(canal)) { r.violacoes.push(_viol('CANAL_DUPLICADO', 'erro', 'canal repetido na fórmula', canal)); continue; }
      vistos.add(canal);
      total += g;
      const c = maq.por_canal.get(canal);
      if (!c || !c.ativo) { r.violacoes.push(_viol('CANAL_INEXISTENTE', 'erro', 'esta máquina não tem esse canal (ou está desativado)', canal)); continue; }
      const mid = c.material_id, dil = c.diluicao_pct, vol = c.volume_atual_ml, dens = c.densidade_g_ml;
      const { nome, restricao_maquina: restr } = db.materiais.get(mid);
      if (g < maq.dose_minima_g) {
        r.violacoes.push(_viol('DOSE_ABAIXO_MINIMA', 'erro',
          `${nome}: ${fixo(Math.floor(g * 10000) / 10, 1)} mg < mínimo da máquina (${fixo(maq.dose_minima_g * 1000, 0)} mg); use canal mais diluído`, canal));
      } else {
        const erro_rel = Math.max(maq.tolerancia_g / g, maq.tolerancia_pct / 100.0);
        if (erro_rel > erro_max) r.violacoes.push(_viol('DOSE_IMPRECISA', 'aviso', `${nome}: erro possível de ±${porcento(erro_rel, 0)} nesta dose`, canal));
      }
      if (dens && vol !== null) {
        if (g > vol * dens * (1 - RESERVA_ESTOQUE)) {
          r.violacoes.push(_viol('ESTOQUE_INSUFICIENTE', 'erro', `${nome}: pede ${fixo(g, 2)} g, restam ~${fixo(vol * dens, 2)} g no frasco`, canal));
        }
      } else {
        r.violacoes.push(_viol('ESTOQUE_NAO_VERIFICAVEL', 'aviso', `${nome}: sem densidade/volume cadastrados, estoque não conferido`, canal));
      }
      if (restr === 'proibido' || restr === 'evitar') r.violacoes.push(_viol('MATERIAL_RESTRITO_NA_MAQUINA', 'erro', `${nome}: marcado '${restr}'`, canal));
      if (restr === 'so_diluido' && dil >= 100) r.violacoes.push(_viol('SO_DILUIDO', 'erro', `${nome}: só pode ir diluído`, canal));
      for (const [niv, nota] of db.exclusoes.get(mid) || []) {
        if (niv === 'proibido' || niv === 'evitar') r.violacoes.push(_viol('MATERIAL_EXCLUIDO', 'erro', `${nome}: ${nota.slice(0, 140)}`, canal));
        else if (niv === 'so_diluido' && dil >= 100) r.violacoes.push(_viol('SO_DILUIDO', 'erro', `${nome}: só pode ir diluído (${nota.slice(0, 100)})`, canal));
      }
      if (!ativo_por_material.has(mid)) ativo_por_material.set(mid, [nome, 0.0]);
      ativo_por_material.get(mid)[1] += g * dil / 100.0;
    }

    if (total > maq.lote_max_g + 1e-9) r.violacoes.push(_viol('LOTE_EXCEDIDO', 'erro', `total ${fixo(total, 2)} g > lote máximo ${fmt_g(maq.lote_max_g)} g`));

    const massa_final = formula.massa_final_g || total;
    const tem_solvente = itens.some(i => { const c = maq.por_canal.get(i.canal); return c && db.materiais.get(c.material_id).tipo_material === 'solvent'; });
    if (!formula.massa_final_g && !tem_solvente) {
      r.violacoes.push(_viol('SEM_SOLVENTE', 'aviso', 'sem solvente nem massa_final_g: % IFRA calculado sobre o concentrado (conservador)'));
    }
    const pct_final = {};
    for (const [mid, [nome, ativo]] of ativo_por_material) {
      const pct = massa_final ? ativo / massa_final * 100.0 : 0.0;
      pct_final[nome] = pyround(pct, 4);
      const [status, lim] = db.materiais.get(mid).ifra;
      if (status === 'limite' && pct > lim + 1e-12) r.violacoes.push(_viol('IFRA_EXCEDIDO', 'erro', `${nome}: ${fmt_g(pct, 3)}% no produto final > limite IFRA Cat.4 de ${fmt_g(lim)}%`));
      else if (status === 'desconhecido') r.violacoes.push(_viol('IFRA_DESCONHECIDO', 'aviso', `${nome}: sem CAS no catálogo, IFRA não pôde ser conferido`));
      else if (status === 'restricao_sem_limite') r.violacoes.push(_viol('IFRA_RESTRICAO_SEM_LIMITE', 'aviso', `${nome}: há restrição IFRA sem limite extraído; ler o padrão`));
      else if (status === 'proibido') r.violacoes.push(_viol('IFRA_PROIBIDO', 'erro', `${nome}: padrão IFRA de proibição`));
    }
    r.resumo = { total_g: pyround(total, 4), massa_final_g: pyround(massa_final, 4), pct_final_por_material: pct_final };
    return r;
  }

  // ------------------------------------------------------------------------------------------------ formula_salva.py
  class Traducao {
    constructor(massa_final_g) { this.itens = []; this.massa_final_g = massa_final_g; this.faltando = []; this.inviaveis = []; this.excede = false; }
    get completa() { return !this.faltando.length && !this.inviaveis.length; }
  }

  // O que o vidro pode dar de uma vez (com a reserva do validador); null se o estoque não é verificável.
  const estoque_g = (volume_ml, densidade_g_ml) => densidade_g_ml && volume_ml !== null ? volume_ml * densidade_g_ml * (1 - RESERVA_ESTOQUE) : null;

  function traduzir_itens(db, itens, massa_final_g, maquina_id, cabendo = false) {
    const maq = db.maquinas.get(maquina_id);
    const t = new Traducao(massa_final_g);
    const escolhas = [];
    for (const [mid, ativo] of itens) {
      const nome = db.nome(mid);
      const canais = maq.ativos_do_material.get(mid) || [];
      if (!canais.length) {
        const equiv = [];
        for (const [outro] of db.equivalentes.get(mid) || []) for (const c of maq.ativos_do_material.get(outro) || []) equiv.push([outro, db.nome(outro), c.canal]);
        equiv.sort((a, b) => a[0] - b[0] || a[2] - b[2]);
        t.faltando.push({ material_id: mid, nome, gramas_ativos: ativo, equivalentes: equiv.map(([i, n, c]) => ({ material_id: i, nome: n, canal: c })) });
        continue;
      }
      const cabe = k => {
        const c = canais[k];
        if (!cabendo) return ativo / (c.diluicao_pct / 100.0) <= maq.lote_max_g;
        const estoque = estoque_g(c.volume_atual_ml, c.densidade_g_ml);    // com `cabendo`, a conta é nas gramas que a máquina de fato dosa (4 casas)
        return pyround(ativo / (c.diluicao_pct / 100.0), 4) <= (estoque === null ? maq.lote_max_g : Math.min(maq.lote_max_g, estoque));
      };
      let pos = -1;
      for (let k = 0; k < canais.length; k++) if (cabe(k)) { pos = k; break; }
      if (pos < 0) t.inviaveis.push({ material_id: mid, nome, gramas_ativos: ativo });
      else escolhas.push({ mid, ativo, canais, pos, cabe });
    }
    if (cabendo) {
      const ocupa = e => pyround(e.ativo / (e.canais[e.pos].diluicao_pct / 100.0), 4);
      const proximo = e => { for (let k = e.pos + 1; k < e.canais.length; k++) if (e.cabe(k)) return k; return -1; };
      while (soma(escolhas.map(ocupa)) > massa_final_g + 1e-9) {
        let maior = null;
        for (const e of escolhas) {
          if (proximo(e) < 0) continue;
          if (maior === null || ocupa(e) > ocupa(maior) || (ocupa(e) === ocupa(maior) && e.mid < maior.mid)) maior = e;
        }
        if (maior === null) { t.excede = true; break; }
        maior.pos = proximo(maior);
      }
    }
    t.itens = escolhas.map(e => ({ canal: e.canais[e.pos].canal, gramas: pyround(e.ativo / (e.canais[e.pos].diluicao_pct / 100.0), 4) }));
    return t;
  }

  // ------------------------------------------------------------------------------------------------ composicao.py
  const PESO_PROTAGONISTA = 0.50, PESO_APOIO = 0.30, PESO_BASE = 0.20;
  const PESO_SEM_APOIO = 0.80;
  const PESO_PREENCHIMENTO = 0.25;
  const DEFICIT_MIN = 0.15;
  const PESO_SO_FAMILIAS = 0.80;
  const PESO_NOTA = 0.10;
  const MAX_NOTAS_DIRETAS = 3;
  const PONTUACAO_MIN = 0.35;
  const MAX_FRACAO_MATERIAL = 0.50;
  const BASE_FAMILIAS = [['musk', 0.50], ['amber', 0.30], ['woody', 0.20]];
  const FOLGA_IFRA = 0.90;
  const VOLTAS_DA_CORRECAO = 6;                                    // trava: em 1.240 composições medidas bastaram 2 voltas (tetos, tirar dose mínima, tetos de novo)
  const COBERTURA_MIN = 0.80;
  const AJUSTES = {
    mais_fresco: { citrus: 0.25, aquatic: 0.10, green: 0.10 },
    menos_fresco: { citrus: -0.25, aquatic: -0.10, green: -0.10 },
    mais_doce: { gourmand: 0.30, balsamic: 0.10 },
    menos_doce: { gourmand: -0.30, balsamic: -0.10 },
    mais_floral: { floral: 0.30 },
    mais_amadeirado: { woody: 0.30, amber: 0.10 },
    mais_apimentado: { spicy: 0.25 },
  };
  const ETANOL_CAS = '64-17-5';

  class Brief {
    constructor({ familias = {}, notas = [], evitar_notas = [], evitar_materiais = [], concentracao_pct = 15.0, massa_final_g = 26.5, preferir_acordes = [] } = {}) {
      Object.assign(this, { familias, notas, evitar_notas, evitar_materiais, concentracao_pct, massa_final_g, preferir_acordes });
    }
    pesos() {
      const positivos = Object.entries(this.familias).filter(([, v]) => v > 0);
      const tot = soma(positivos.map(([, v]) => v));
      return tot ? Object.fromEntries(positivos.map(([f, v]) => [f, v / tot])) : {};
    }
  }

  class Candidato {
    constructor({ nome, protagonista_id, itens, massa_final_g, avisos = [], pontuacao = 0.0 }) {
      Object.assign(this, { nome, protagonista_id, itens, massa_final_g, avisos, pontuacao,
        explicacao: [], trocas: [], escolhas_pendentes: [], traducao: null, resultado: null });
    }
    get valido() { return this.resultado !== null && this.resultado.ok && this.traducao !== null && this.traducao.completa; }
  }

  function _materializar(db, item, inv, fundo = 0) {
    const est = item.estado, esc = item.escolhido;
    if ((est === 'ok' || est === 'nota_unica' || est === 'parecido') && esc) return [[[esc.material_id, 1.0]], null];
    if (est === 'nota_opcoes' && item.opcoes.length) return [[[item.opcoes[0].material_id, 1.0]], item];
    if (est === 'nota_acorde' && item.opcoes.length && fundo === 0) {
      const ins = instanciar(db, item.opcoes[0].acorde_id, inv, 1);
      const pares = [];
      for (const r of reduzir(ins, COBERTURA_MIN) || []) {
        const [sub] = _materializar(db, r, inv, 1);
        for (const [m, f] of sub) pares.push([m, r.fracao * f]);
      }
      return [pares, item];
    }
    return [[], null];
  }

  function _acordes_da_maquina(db, inv) {
    const out = [];
    for (const ac of db.acordes_motor) {
      const ins = instanciar(db, ac.id, inv);
      const red = reduzir(ins, COBERTURA_MIN);
      if (!red || !red.length) continue;
      let mats = new Map();
      const trocas = [], pend = [];
      for (const r of red) {
        const [pares, pendente] = _materializar(db, r, inv);
        for (const [m, f] of pares) mats.set(m, (mats.has(m) ? mats.get(m) : 0.0) + r.fracao * f);
        if (r.estado === 'parecido') trocas.push(`${r.nome} → ${r.escolhido.nome} (parecido)`);
        else if (r.estado === 'nota_unica' || r.estado === 'nota_acorde' || r.estado === 'nota_opcoes') {
          trocas.push(`${r.nome} → ` + (r.escolhido ? r.escolhido.nome : r.estado === 'nota_acorde' ? 'acorde da nota' : 'opção da nota'));
        }
        if (pendente) pend.push({ item: r.nome, opcoes: pendente.opcoes.map(o => o.nome) });
      }
      const tot = soma(mats.values());
      if (!tot) continue;
      mats = new Map([...mats].map(([m, f]) => [m, f / tot]));
      const fam = {};
      for (const [m, f] of mats) {
        const fc = db.materiais.get(m).familia_canonica;
        if (fc) fam[fc] = (fam[fc] === undefined ? 0.0 : fam[fc]) + f;
      }
      out.push({ id: ac.id, nome: ac.nome, nota: ac.nota_id === null ? null : db.notas.get(ac.nota_id).slug, materiais: mats,
        pontuacao: 0.0, familias: fam, trocas, pendentes: pend, cobertura: ins.cobertura_partes, validado: ac.validado });
    }
    return out;
  }

  function _proibidos(db, brief) {
    const p = new Set(brief.evitar_materiais);
    for (const slug of brief.evitar_notas) {
      const n = db.nota_por_slug.get(slug);
      for (const [mid] of n ? db.materiais_da_nota.get(n.id) || [] : []) p.add(mid);
    }
    for (const mid of db.excluidos) p.add(mid);
    return p;
  }

  function _pontuar(a, brief, pesos) {
    let s = soma(Object.entries(a.familias).map(([f, sh]) => (pesos[f] === undefined ? 0.0 : pesos[f]) * sh));
    if (a.nota && brief.notas.includes(a.nota)) s += 1.0;
    if (brief.preferir_acordes.includes(a.id)) s += 0.5;
    if (a.validado) s += 0.3;
    s -= 0.10 * a.trocas.filter(t => t.endsWith('(parecido)')).length;
    return s + 0.01 * a.cobertura;
  }

  function _jaccard(a, b) {
    let comuns = 0;
    for (const m of a.materiais.keys()) if (b.materiais.has(m)) comuns++;
    const uniao = a.materiais.size + b.materiais.size - comuns;
    return uniao ? comuns / uniao : 0.0;
  }

  const COM_RESTRICAO_IFRA = new Set(['limite', 'restricao_sem_limite', 'proibido', 'desconhecido']);

  function _melhores_da_familia(db, inv, proibidos, familia, pop, notas = null) {
    const cands = [];
    for (const mid of inv.keys()) {
      const m = db.materiais.get(mid);
      if (m.familia_canonica === familia && m.tipo_material !== 'solvent' && !proibidos.has(mid) && (notas === null || notas.has(m.nota_piramide))) {
        cands.push([COM_RESTRICAO_IFRA.has(m.ifra[0]), -(pop.get(mid) || 0), mid]);
      }
    }
    return cands.sort((a, b) => (a[0] - b[0]) || (a[1] - b[1]) || (a[2] - b[2])).map(c => c[2]);
  }

  function _camada_base(db, inv, proibidos, rotacao = 0) {
    const out = [];
    for (const [fam, peso] of BASE_FAMILIAS) {
      const lista = _melhores_da_familia(db, inv, proibidos, fam, db.populares, new Set(['base']));
      if (lista.length) out.push([lista[rotacao % lista.length], peso]);
    }
    const tot = soma(out.map(([, p]) => p));
    return tot ? out.map(([m, p]) => [m, p / tot]) : [];
  }

  function _preenchimento(db, inv, proibidos, deficit, rotacao = 0) {
    const ordem = Object.entries(deficit).sort((a, b) => b[1] - a[1]).slice(0, 3);
    const tot = soma(ordem.map(([, d]) => d));
    const out = [];
    for (const [fam, d] of ordem) {
      const todos = _melhores_da_familia(db, inv, proibidos, fam, db.populares);
      const lista = todos.slice(rotacao).concat(todos.slice(0, rotacao)).slice(0, 2);
      for (const m of lista) out.push([m, d / tot / lista.length]);
    }
    return out;
  }

  function _notas_diretas(db, inv, proibidos, slugs, cobertas) {
    const out = [], sem = [];
    for (const slug of slugs) {
      if (cobertas.has(slug)) continue;
      const n = db.nota_por_slug.get(slug);
      const mids = (n ? db.materiais_da_nota.get(n.id) || [] : []).map(x => x[0]).filter(m => inv.has(m) && !proibidos.has(m));
      if (mids.length && out.length < MAX_NOTAS_DIRETAS) out.push([mids[0], 1.0]);
      else sem.push(slug);
    }
    return [out, sem];
  }

  function _solvente(db, maquina_id) {
    const prioridade = c => { const cas = db.materiais.get(c.material_id).cas; return cas === ETANOL_CAS ? 2 : cas !== null ? 1 : 0; };   // ORDER BY (cas='64-17-5') DESC, com NULL por último
    const cs = db.maquinas.get(maquina_id).canais.filter(c => c.ativo && db.materiais.get(c.material_id).tipo_material === 'solvent');
    cs.sort((a, b) => prioridade(b) - prioridade(a) || a.canal - b.canal);
    return cs.length ? cs[0].material_id : null;
  }

  function _renormalizar(itens, travados, alvo_g, solvente_id) {
    const livres = [...itens.keys()].filter(m => m !== solvente_id && !travados.has(m));
    const soma_livre = soma(livres.map(m => itens.get(m)));
    const fixo_g = soma([...itens].filter(([m]) => m !== solvente_id && travados.has(m)).map(([, g]) => g));
    if (!livres.length || soma_livre <= 0) return false;
    const k = Math.max(alvo_g - fixo_g, 0.0) / soma_livre;
    for (const m of livres) itens.set(m, itens.get(m) * k);
    return true;
  }

  function _uso_maximo(db, mid) {
    const nums = (db.materiais.get(mid).uso_tipico_pct || '').match(/\d+(?:\.\d+)?/g) || [];
    const maior = Math.max(...nums.map(Number));
    return nums.length && maior <= 100 ? maior : null;
  }

  function _aplicar_tetos(db, itens, brief, alvo_g, solvente_id, travados, avisos) {
    for (let volta = 0; volta < 8; volta++) {
      let novos = false;
      for (const [m, g] of [...itens]) {
        if (m === solvente_id || travados.has(m)) continue;
        const [st, lim] = db.materiais.get(m).ifra;
        if (st === 'limite') {
          const teto = FOLGA_IFRA * lim / 100.0 * brief.massa_final_g;
          if (g > teto + 1e-12) {
            avisos.push(`IFRA: ${db.nome(m)} limitado a ${porcento(FOLGA_IFRA, 0)} do limite de ${fmt_g(lim)}%`);
            itens.set(m, teto); novos = true; travados.add(m);
            continue;
          }
        }
        const uso = _uso_maximo(db, m);
        if (uso !== null && g > uso / 100.0 * alvo_g + 1e-12) {
          avisos.push(`${db.nome(m)} limitado ao uso típico máximo de ${fmt_g(uso)}% do concentrado`);
          itens.set(m, uso / 100.0 * alvo_g); novos = true; travados.add(m);
          continue;
        }
        if (g > MAX_FRACAO_MATERIAL * alvo_g + 1e-12) {
          avisos.push(`${db.nome(m)} limitado a ${porcento(MAX_FRACAO_MATERIAL, 0)} do concentrado`);
          itens.set(m, MAX_FRACAO_MATERIAL * alvo_g); novos = true; travados.add(m);
        }
      }
      if (!novos || !_renormalizar(itens, travados, alvo_g, solvente_id)) break;
    }
  }

  function _corrigir(db, maquina_id, itens, brief, alvo_g, solvente_id, avisos) {
    const travados = new Set();
    const maq = db.maquinas.get(maquina_id);
    const canal_mat = new Map(maq.canais.map(c => [c.canal, c.material_id]));
    for (let volta = 0; volta < VOLTAS_DA_CORRECAO; volta++) {
      _aplicar_tetos(db, itens, brief, alvo_g, solvente_id, travados, avisos);
      const t = traduzir_itens(db, new Map(itens), brief.massa_final_g, maquina_id);
      const abaixo = t.itens.filter(i => i.gramas < maq.dose_minima_g && canal_mat.get(i.canal) !== solvente_id).map(i => canal_mat.get(i.canal));
      if (!abaixo.length) return;
      for (const m of abaixo) {
        avisos.push(`${db.nome(m)} removido: dose abaixo do mínimo da máquina (${fixo(maq.dose_minima_g * 1000, 0)} mg)`);
        itens.delete(m);
      }
      _renormalizar(itens, travados, alvo_g, solvente_id);
    }
  }

  function _montar(db, maquina_id, brief, prot, apoio, base, preench, solvente_id, notas = []) {
    const conc_g = brief.massa_final_g * brief.concentracao_pct / 100.0;
    let pesos, p_preench, p_base;
    if (prot === null) {                                    // só famílias + base
      pesos = []; p_preench = PESO_SO_FAMILIAS - PESO_NOTA * notas.length; p_base = 1.0 - PESO_SO_FAMILIAS;
    } else {
      const escala = 1.0 - (preench.length ? PESO_PREENCHIMENTO : 0.0) - PESO_NOTA * notas.length;
      pesos = [[prot, (apoio ? PESO_PROTAGONISTA : PESO_SEM_APOIO) * escala]].concat(apoio ? [[apoio, PESO_APOIO * escala]] : []);
      p_preench = PESO_PREENCHIMENTO; p_base = PESO_BASE * escala;
    }
    let itens = new Map();
    const somar = (m, g) => itens.set(m, (itens.has(m) ? itens.get(m) : 0.0) + g);
    const avisos = [];
    for (const [ac, peso] of pesos) for (const [m, f] of ac.materiais) somar(m, conc_g * peso * f);
    for (const [m, p] of base) somar(m, conc_g * p_base * p);
    for (const [m, p] of preench) somar(m, conc_g * p_preench * p);
    for (const [m, p] of notas) somar(m, conc_g * PESO_NOTA * p);
    _corrigir(db, maquina_id, itens, brief, conc_g, solvente_id, avisos);
    if (solvente_id === null) {
      avisos.push('a máquina não tem canal de solvente: só o concentrado é dosado');
      return [itens, avisos];
    }
    // Os vidros diluídos já trazem solvente: o que falta para a massa final é a massa DISPENSADA, não a dos ativos.
    const dispensar = arom => soma(traduzir_itens(db, arom, brief.massa_final_g, maquina_id).itens.map(i => i.gramas));
    let aromaticos = new Map([...itens].filter(([m]) => m !== solvente_id));
    let dispensado = dispensar(aromaticos);
    if (dispensado > brief.massa_final_g * 0.98) {
      const k = brief.massa_final_g * 0.98 / dispensado;
      itens = new Map([...aromaticos].map(([m, g]) => [m, g * k]));
      avisos.push(`concentração reduzida para ${porcento(soma(itens.values()) / brief.massa_final_g, 1)}: os vidros diluídos ocupam o volume`);
      aromaticos = new Map(itens);
      dispensado = dispensar(aromaticos);
    }
    itens.set(solvente_id, Math.max(brief.massa_final_g - dispensado, 0.0));
    const real = soma([...itens].filter(([m]) => m !== solvente_id).map(([, g]) => g)) / brief.massa_final_g * 100;
    if (real < brief.concentracao_pct * 0.95) {
      avisos.push(`concentração real de ${fixo(real, 1)}% (pedido ${fmt_g(brief.concentracao_pct)}%): os tetos de uso e de IFRA seguraram os materiais`);
    }
    return [itens, avisos];
  }

  function _deficit(pesos, ...acordes) {
    if (!Object.keys(pesos).length) return {};
    const cobertos = {};
    for (const a of acordes) for (const [f, sh] of Object.entries(a.familias)) cobertos[f] = (cobertos[f] === undefined ? 0.0 : cobertos[f]) + sh / acordes.length;
    const out = {};
    for (const [f, w] of Object.entries(pesos)) {
      const d = w - (cobertos[f] === undefined ? 0.0 : cobertos[f]);
      if (d > 1e-9) out[f] = Math.max(d, 0.0);
    }
    return out;
  }

  function compor(db, maquina_id, brief, n = 3) {
    const inv = inventario(db, maquina_id);
    const proibidos = _proibidos(db, brief);
    const pesos = brief.pesos();
    const sem_pedido = !Object.keys(pesos).length;
    let acordes = _acordes_da_maquina(db, inv)
      .filter(a => ![...a.materiais.keys()].some(m => proibidos.has(m)) && !brief.evitar_notas.includes(a.nota));
    for (const a of acordes) a.pontuacao = _pontuar(a, brief, pesos);
    acordes.sort((a, b) => (b.pontuacao - a.pontuacao) || (a.id - b.id));
    if (!sem_pedido || brief.notas.length) acordes = acordes.filter(a => a.pontuacao >= PONTUACAO_MIN);   // com pedido, só entra acorde que combina com ele
    const solvente_id = _solvente(db, maquina_id);
    const usados = new Set(), saida = [];
    for (let k = 0; k < n; k++) {
      const livres = acordes.filter(a => !usados.has(a.id));
      const ja_usados = acordes.filter(x => usados.has(x.id));
      const prot = livres.find(a => ja_usados.every(c => _jaccard(a, c) < 0.8)) || null;
      if (prot === null && (k > 0 || sem_pedido)) break;
      if (prot === null) {                                  // nenhum acorde combina: compõe por famílias
        const preench = _preenchimento(db, inv, proibidos, pesos, k);
        const base = _camada_base(db, inv, proibidos, k);
        const [nd, sem_nota] = _notas_diretas(db, inv, proibidos, brief.notas, new Set());
        const [itens, avisos] = _montar(db, maquina_id, brief, null, null, base, preench, solvente_id, nd);
        for (const nota of sem_nota) avisos.push(`a nota '${nota}' que você pediu não tem como ser feita nesta máquina`);
        const nome = 'Composição por famílias: ' + Object.keys(pesos).sort((a, b) => pesos[b] - pesos[a]).slice(0, 3).join(' + ');
        const c = new Candidato({ nome, protagonista_id: 0, itens, massa_final_g: brief.massa_final_g, avisos });
        c.explicacao = ['Nenhum acorde do dicionário combina com o pedido nesta máquina; montado por famílias',
          'Famílias: ' + preench.map(([m]) => db.nome(m)).join(', ')];
        if (base.length) c.explicacao.push('Base: ' + base.map(([m]) => db.nome(m)).join(', '));
        c.traducao = traduzir_itens(db, itens, brief.massa_final_g, maquina_id);
        c.resultado = validar(db, maquina_id, { itens: c.traducao.itens, massa_final_g: brief.massa_final_g });
        saida.push(c);
        continue;
      }
      const falta = _deficit(pesos, prot);
      const outros = livres.filter(a => a.id !== prot.id && _jaccard(a, prot) < 0.6 && (a.nota === null || a.nota !== prot.nota));
      let apoios;
      if (Object.keys(falta).length) {                      // o apoio vai atrás do que o protagonista não cobre
        const tot = soma(Object.values(falta));
        const alvo = Object.fromEntries(Object.entries(falta).map(([f, d]) => [f, d / tot]));
        const pedido = new Brief({ familias: alvo, notas: brief.notas });
        apoios = outros.map(a => [a, _pontuar(a, pedido, alvo)]).sort((x, y) => (y[1] - x[1]) || (x[0].id - y[0].id))
          .filter(([, s]) => s >= PONTUACAO_MIN).map(([a]) => a);
      } else {
        apoios = outros;
      }
      const apoio = apoios.length ? apoios[0] : null;
      const deficit = _deficit(pesos, ...[prot, apoio].filter(Boolean));
      const preench = soma(Object.values(deficit)) >= DEFICIT_MIN ? _preenchimento(db, inv, proibidos, deficit, k) : [];
      const base = _camada_base(db, inv, proibidos, k);
      usados.add(prot.id);
      if (apoio) usados.add(apoio.id);
      const cobertas = new Set([prot, apoio].filter(a => a && a.nota).map(a => a.nota));
      const [nd, sem_nota] = _notas_diretas(db, inv, proibidos, brief.notas, cobertas);
      const [itens, avisos] = _montar(db, maquina_id, brief, prot, apoio, base, preench, solvente_id, nd);
      for (const nota of sem_nota) avisos.push(`a nota '${nota}' que você pediu não tem como ser feita nesta máquina`);
      const c = new Candidato({ nome: prot.nome, protagonista_id: prot.id, itens, massa_final_g: brief.massa_final_g, avisos, pontuacao: prot.pontuacao });
      c.trocas = prot.trocas.concat(apoio ? apoio.trocas : []);
      c.escolhas_pendentes = prot.pendentes.concat(apoio ? apoio.pendentes : []);
      c.explicacao = [`Protagonista: ${prot.nome} (${porcento(prot.cobertura, 0)} do acorde original)`];
      if (apoio) c.explicacao.push(`Apoio: ${apoio.nome}`);
      if (preench.length) c.explicacao.push('Preenchimento para o que você pediu: ' + preench.map(([m]) => db.nome(m)).join(', '));
      if (nd.length) c.explicacao.push('Notas pedidas: ' + nd.map(([m]) => db.nome(m)).join(', '));
      if (base.length) c.explicacao.push('Base: ' + base.map(([m]) => db.nome(m)).join(', '));
      c.traducao = traduzir_itens(db, itens, brief.massa_final_g, maquina_id);
      c.resultado = validar(db, maquina_id, { itens: c.traducao.itens, massa_final_g: brief.massa_final_g });
      saida.push(c);
    }
    return saida;
  }

  function refinar(db, maquina_id, candidato, brief, ajuste) {
    if (!Object.hasOwn(AJUSTES, ajuste)) throw new ErroDeUso(`ajuste desconhecido: ${ajuste} (válidos: ${Object.keys(AJUSTES).join(', ')})`);
    const fam = { ...brief.familias };
    for (const [f, d] of Object.entries(AJUSTES[ajuste])) fam[f] = Math.max((fam[f] === undefined ? 0.0 : fam[f]) + d, 0.0);
    const novo = new Brief({ familias: fam, notas: brief.notas, evitar_notas: brief.evitar_notas, evitar_materiais: brief.evitar_materiais,
      concentracao_pct: brief.concentracao_pct, massa_final_g: brief.massa_final_g, preferir_acordes: [candidato.protagonista_id] });
    const r = compor(db, maquina_id, novo, 1);
    return r.length ? r[0] : null;
  }

  // ------------------------------------------------------------------------------------------------ questionario.py
  const CONCENTRACAO_MAX = 25.0;
  const PADRAO = { concentracao_pct: 15.0, massa_final_g: 26.5 };
  const PESO_FAMILIA_DA_NOTA = 0.5;

  function capacidades(db, maquina_id) {
    const inv = inventario(db, maquina_id);
    const familias = new Map(), cas = new Set();
    for (const mid of inv.keys()) {
      const m = db.materiais.get(mid);
      if (m.tipo_material === 'solvent') continue;
      if (m.familia_canonica) familias.set(m.familia_canonica, (familias.get(m.familia_canonica) || 0) + 1);
      if (m.cas) cas.add(m.cas);
    }
    const melhor_acorde = new Map();
    for (const a of db.acordes.values()) {
      if (a.nota_id === null) continue;
      melhor_acorde.set(a.nota_id, Math.max(melhor_acorde.has(a.nota_id) ? melhor_acorde.get(a.nota_id) : 0.0, instanciar(db, a.id, inv).cobertura_partes));
    }
    const diretos = new Set();
    for (const [nid, lista] of db.materiais_da_nota) if (lista.some(([mid]) => inv.has(mid))) diretos.add(nid);
    const notas = new Set();
    for (const n of db.notas.values()) if (diretos.has(n.id) || (melhor_acorde.has(n.id) ? melhor_acorde.get(n.id) : 0.0) >= COBERTURA_MIN) notas.add(n.slug);
    return { familias, notas, cas, lote_max_g: db.maquinas.get(maquina_id).lote_max_g };
  }

  function _opcao_ok(op, cap) {
    const r = op.requer || {};
    return ('familia' in r ? (cap.familias.get(r.familia) || 0) >= 1 : true)
      && ('nota' in r ? cap.notas.has(r.nota) : true)
      && ('cas' in r ? cap.cas.has(r.cas) : true)
      && ('massa_g' in r ? r.massa_g <= cap.lote_max_g + 1e-9 : true);
  }

  const _opcoes = (no, cap) => no.opcoes.filter(o => _opcao_ok(o, cap));
  const _tem_efeito = o => !!o.efeito && Object.keys(o.efeito).length > 0;    // {} é falso no Python: 'Tanto faz' e 'Nenhum' não têm efeito

  function _visivel(no, aceitas) {
    return Object.entries(no.se || {}).every(([nid, opcao]) => (aceitas[nid] || []).includes(opcao));
  }

  function _percurso(q, cap, respostas) {
    const aceitas = {}, feitas = [];
    for (const no of q.nos) {
      if (!_visivel(no, aceitas)) continue;
      const ops = _opcoes(no, cap);
      if (!ops.some(_tem_efeito)) continue;                 // nada útil a perguntar nesta máquina
      if (!Object.hasOwn(respostas, no.id)) return [feitas, no, ops];
      aceitas[no.id] = [...respostas[no.id]];
      feitas.push([no, aceitas[no.id]]);
    }
    return [feitas, null, []];
  }

  function proxima(respostas, q, cap) {
    const [feitas, no, ops] = _percurso(q, cap, respostas);
    if (no === null) return null;
    return { id: no.id, titulo: no.titulo, tipo: no.tipo, max: no.max === undefined ? 1 : no.max,
      opcoes: ops.map(o => ({ id: o.id, rotulo: o.rotulo })), respondidas: feitas.length };
  }

  function responder(respostas, no_id, escolhidas, q, cap) {
    const ordem = q.nos.map(n => n.id);
    if (!ordem.includes(no_id)) throw new ErroDeUso(`pergunta desconhecida: ${no_id}`);
    const [feitas, pendente] = _percurso(q, cap, respostas);
    const alcancaveis = new Set(feitas.map(([n]) => n.id));
    if (pendente) alcancaveis.add(pendente.id);
    if (!alcancaveis.has(no_id)) throw new ErroDeUso(`a pergunta '${no_id}' não está no caminho atual`);
    const no = q.nos.find(n => n.id === no_id);
    const ops = new Map(_opcoes(no, cap).map(o => [o.id, o]));
    escolhidas = [...new Set(escolhidas)];
    const max = no.max === undefined ? 1 : no.max;
    if (no.tipo === 'unica' && escolhidas.length !== 1) throw new ErroDeUso('escolha exatamente uma opção');
    if (no.tipo === 'multipla' && !(escolhidas.length >= 1 && escolhidas.length <= max)) throw new ErroDeUso(`escolha de 1 a ${max} opções`);
    for (const e of escolhidas) if (!ops.has(e)) throw new ErroDeUso(`opção indisponível: ${e}`);
    if (escolhidas.length > 1 && escolhidas.some(e => !_tem_efeito(ops.get(e)))) throw new ErroDeUso("'Tanto faz' e 'Nenhum' não combinam com outras opções");
    const novas = {};
    for (const [k, v] of Object.entries(respostas)) if (ordem.indexOf(k) < ordem.indexOf(no_id)) novas[k] = v;
    novas[no_id] = escolhidas;
    return novas;
  }

  function montar_brief(db, respostas, q, cap) {
    const [feitas] = _percurso(q, cap, respostas);
    const fam = {};
    let notas = [], evitar_notas = [];
    const cas = [];
    let conc = PADRAO.concentracao_pct, massa = PADRAO.massa_final_g;
    for (const [no, escolhidas] of feitas) {
      const por_id = new Map(no.opcoes.map(o => [o.id, o]));
      for (const e of escolhidas) {
        const ef = por_id.get(e).efeito || {};
        for (const [f, w] of Object.entries(ef.familias || {})) fam[f] = (fam[f] === undefined ? 0.0 : fam[f]) + w;
        notas = notas.concat(ef.notas || []);
        evitar_notas = evitar_notas.concat(ef.evitar_notas || []);
        cas.push(...(ef.evitar_cas || []));
        if (ef.concentracao_pct !== undefined) conc = ef.concentracao_pct;
        if (ef.massa_final_g !== undefined) massa = ef.massa_final_g;
      }
    }
    notas = [...new Set(notas)];
    for (const slug of notas) {
      const n = db.nota_por_slug.get(slug);
      if (n && n.familia_canonica) fam[n.familia_canonica] = (fam[n.familia_canonica] === undefined ? 0.0 : fam[n.familia_canonica]) + PESO_FAMILIA_DA_NOTA;
    }
    const evitar_materiais = [...new Set(cas.flatMap(c => db.por_cas.get(c) || []))].sort((a, b) => a - b);
    return new Brief({ familias: Object.fromEntries(Object.entries(fam).filter(([, w]) => w > 0)), notas,
      evitar_notas: [...new Set(evitar_notas)], evitar_materiais,
      concentracao_pct: Math.min(conc, CONCENTRACAO_MAX), massa_final_g: Math.min(massa, cap.lote_max_g) });
  }

  function caminho(respostas, q, cap) {
    const [feitas] = _percurso(q, cap, respostas);
    return feitas.map(([no, esc]) => ({ no: no.id, pergunta: no.titulo, respostas: esc.map(e => no.opcoes.find(o => o.id === e).rotulo) }));
  }

  // ------------------------------------------------------------------------------------------------ ajuste.py
  // Arredonda PARA BAIXO em 4 casas (as gramas da receita têm 4 casas; arredondar para cima passaria do limite).
  const piso4 = x => Math.floor(x * 1e4 + 1e-6) / 1e4;

  function maior_ativo(dispensado_max, diluicao_pct) {
    let a = piso4(dispensado_max * diluicao_pct / 100.0);
    while (a > 0 && pyround(a / (diluicao_pct / 100.0), 4) > dispensado_max) a = piso4(a - 1e-4);
    return Math.max(a, 0.0);
  }

  function limites(db, maquina_id, itens, massa_final_g) {
    const maq = db.maquinas.get(maquina_id);
    const solvente_id = _solvente(db, maquina_id);
    const atuais = new Map([...itens].filter(([m, g]) => m !== solvente_id && g > 0 && maq.ativos_do_material.has(m)));
    const t = traduzir_itens(db, atuais, massa_final_g, maquina_id, true);
    const canal_de = new Map();
    for (const [mid, lista] of maq.ativos_do_material) for (const c of lista) canal_de.set(c.canal, mid);
    const ocupa = new Map(t.itens.map(i => [canal_de.get(i.canal), i.gramas]));
    const linhas = [];
    for (const [mid, lista] of maq.ativos_do_material) {
      const m = db.materiais.get(mid);
      if (m.tipo_material === 'solvent') continue;
      const livre = Math.min(Math.max(massa_final_g - soma([...ocupa].filter(([j]) => j !== mid).map(([, v]) => v)), 0.0), maq.lote_max_g);
      let melhor = null;                                    // [ativo, por quê] no canal que deixa o ingrediente chegar mais longe
      for (const c of lista) {
        const estoque = estoque_g(c.volume_atual_ml, c.densidade_g_ml);
        const limita = estoque !== null && estoque < livre;
        const ativo = maior_ativo(limita ? estoque : livre, c.diluicao_pct);
        if (melhor === null || ativo > melhor[0]) melhor = [ativo, limita ? 'estoque' : 'frasco'];
      }
      const [st, lim] = m.ifra;
      const teto_ifra = st === 'limite' ? piso4(lim / 100.0 * massa_final_g) : st === 'proibido' ? 0.0 : null;
      const pela_ifra = teto_ifra !== null && teto_ifra < melhor[0];
      linhas.push({ material_id: mid, nome: m.nome, familia: m.familia_canonica, gramas: atuais.has(mid) ? atuais.get(mid) : 0.0,
        max_g: pela_ifra ? teto_ifra : melhor[0], limitado_por: pela_ifra ? 'ifra' : melhor[1],
        min_dose_g: maq.dose_minima_g * Math.min(...lista.map(c => c.diluicao_pct)) / 100.0 });
    }
    const familia = x => x.familia || '';
    linhas.sort((a, b) => ((a.gramas > 0 ? 0 : 1) - (b.gramas > 0 ? 0 : 1)) || (-a.gramas - -b.gramas) || (familia(a) < familia(b) ? -1 : familia(a) > familia(b) ? 1 : 0) || (a.material_id - b.material_id));
    const ocupado = soma(ocupa.values());
    return { massa_final_g, ocupado_g: ocupado, folga_g: Math.max(massa_final_g - ocupado, 0.0), ingredientes: linhas };
  }

  function aplicar(db, maquina_id, itens, massa_final_g, novos, nome = '') {
    const maq = db.maquinas.get(maquina_id);
    const solvente_id = _solvente(db, maquina_id);
    if (massa_final_g <= 0) throw new ErroDeUso('a massa final tem de ser maior que zero');
    if (massa_final_g > maq.lote_max_g + 1e-9) throw new ErroDeUso(`a massa final de ${fmt_g(massa_final_g)} g passa do lote da máquina (${fmt_g(maq.lote_max_g)} g)`);
    const aromaticos = new Map([...itens].filter(([m, g]) => m !== solvente_id && g > 0));
    for (const [mid, g] of novos) {
      if (mid === solvente_id) throw new ErroDeUso('o solvente se ajusta sozinho: ele é o que sobra no frasco');
      if (!maq.ativos_do_material.has(mid)) throw new ErroDeUso(`o material ${mid} não está nesta máquina`);
      if (g === null || g <= 0) aromaticos.delete(mid);
      else aromaticos.set(mid, pyround(g, 4));
    }
    const t = traduzir_itens(db, aromaticos, massa_final_g, maquina_id, true);
    const dispensado = soma(t.itens.map(i => i.gramas));
    const resto = Math.max(massa_final_g - dispensado, 0.0);
    const final = new Map(aromaticos);
    const com_solvente = solvente_id !== null && resto >= maq.dose_minima_g && !t.inviaveis.length;   // menos que a dose mínima não dá para dosar
    if (com_solvente) {
      final.set(solvente_id, resto);
      const ts = traduzir_itens(db, new Map([[solvente_id, resto]]), massa_final_g, maquina_id);
      t.itens = t.itens.concat(ts.itens);
      t.faltando = t.faltando.concat(ts.faltando);
      t.inviaveis = t.inviaveis.concat(ts.inviaveis);
    }
    const c = new Candidato({ nome, protagonista_id: 0, itens: final, massa_final_g });
    c.traducao = t;
    c.resultado = validar(db, maquina_id, { itens: t.itens, massa_final_g });
    for (const x of t.inviaveis) {
      c.resultado.violacoes.push(_viol('NAO_CABE_NO_FRASCO', 'erro', `${x.nome}: ${fixo(x.gramas_ativos, 2)} g de ativo não cabem em nenhum canal (lote, estoque do vidro ou frasco)`));
    }
    if (t.excede) c.resultado.violacoes.push(_viol('NAO_CABE_NO_FRASCO', 'erro', `os ingredientes ocupam ${fixo(dispensado, 1)} g e o frasco tem ${fmt_g(massa_final_g)} g`));
    const conc = soma(aromaticos.values()) / massa_final_g * 100;
    if (conc > CONCENTRACAO_MAX) c.avisos.push(`concentração de ${fixo(conc, 1)}%: acima de ${fmt_g(CONCENTRACAO_MAX)}% (extrato); confira se tudo dissolve no etanol`);
    if (solvente_id !== null && !com_solvente && !t.inviaveis.length) c.avisos.push('sem etanol: o frasco ficou só com os ingredientes');
    return c;
  }

  // ------------------------------------------------------------------------------------------------ apresentacao.py
  function nome_amigavel(db, nome) {
    const base = nome.replace(/\([^)]*\)/g, ' ').replaceAll('/', ' ').replaceAll(':', ' ');
    const uteis = (base.match(/[A-Za-zÀ-ú]+/g) || []).map(p => db.glossario.get(p.toLowerCase())).filter(p => p);
    if (!uteis.length) return nome.replace(/\([^)]*\)|Key Accord/g, '').replace(/\s+/g, ' ').trim() || nome;
    const saida = [];
    for (const p of uteis) if (!saida.includes(p)) saida.push(p);
    if (saida.length === 1) return saida[0];
    const s = saida.join(' ');
    return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
  }

  function perfil(db, itens) {
    const massa = new Map();
    let tot = 0.0;
    for (const [mid, g] of itens) {
      const m = db.materiais.get(mid);
      if (m.tipo_material === 'solvent') continue;
      tot += g;
      const fam = m.familia_canonica || 'outros';
      massa.set(fam, (massa.has(fam) ? massa.get(fam) : 0.0) + g);
    }
    const ordem = [...massa].sort((a, b) => b[1] - a[1]).slice(0, 5);
    return tot ? ordem.map(([f, g]) => [db.familias_pt[f] || 'outros', pyround(100.0 * g / tot, 1)]) : [];
  }

  // ------------------------------------------------------------------------------------------------ quimica.py
  function cuidados(db, itens) {
    const presentes = [...itens].filter(([m, g]) => g > 0 && db.materiais.get(m).tipo_material !== 'solvent').map(([m]) => db.materiais.get(m));
    const ids_com = grupo => presentes.filter(m => m.grupos.includes(grupo)).map(m => m.id);
    const out = [];
    for (const r of db.regras_quimicas) {
      let envolvidos;
      if (r.tipo === 'par') {
        const a = ids_com(r.a.grupo), b = ids_com(r.b.grupo), juntos = new Set([...a, ...b]);
        envolvidos = a.length && b.length && juntos.size > 1 ? juntos : new Set();
      } else {
        envolvidos = new Set(presentes.filter(m => r.alvo.cas.includes(m.cas)).map(m => m.id));
      }
      if (envolvidos.size) {
        out.push({ regra: r.id, gravidade: r.gravidade, confianca: r.confianca, titulo: r.titulo, texto: r.texto, dica: r.dica,
          materiais: [...envolvidos].sort((x, y) => x - y), fontes: r.fontes });
      }
    }
    return out;
  }

  function descrever(db, maquina_id, c, mostrar_tecnico = false, evitar = []) {
    const aro = new Map([...c.itens].filter(([m]) => db.materiais.get(m).tipo_material !== 'solvent'));
    const tot = soma(aro.values());
    const parte = prefixo => { const e = c.explicacao.find(x => x.startsWith(prefixo)); return e === undefined ? null : e.split(': ').slice(1).join(': '); };
    const texto_prot = parte('Protagonista:'), apoio = parte('Apoio:');
    const prot = texto_prot === null ? null : texto_prot.split(' (')[0];
    const pf = perfil(db, c.itens);
    const titulo = prot ? nome_amigavel(db, prot) + (apoio ? ` com ${nome_amigavel(db, apoio).toLowerCase()}` : '')
      : pf.length ? 'Composição de ' + pf.slice(0, 2).map(([f]) => f.toLowerCase()).join(' e ') : c.nome;
    const nome_do_ingrediente = m => db.nome(m).split(' - ')[0].split(' CAS')[0].slice(0, 46);
    const ingredientes = [...aro].sort((a, b) => pyround(b[1], 4) - pyround(a[1], 4) || a[0] - b[0]).map(([m, g]) => ({ nome: nome_do_ingrediente(m), gramas: pyround(g, 3), pct: pyround(100.0 * g / tot, 1) }));
    const avisos_quimicos = cuidados(db, c.itens).map(x => ({ ...x, materiais: x.materiais.map(nome_do_ingrediente) }));
    const alergias = [...evitar].sort((a, b) => a - b).filter(m => aro.has(m)).map(nome_do_ingrediente);
    const motivos = (c.resultado ? c.resultado.violacoes : []).filter(v => v.nivel === 'erro').map(v => v.mensagem);
    const formula = {};
    for (const [m, g] of c.itens) formula[String(m)] = pyround(g, 4);
    const out = {
      titulo, valido: c.valido, perfil: pf.map(([f, p]) => ({ familia: f, pct: p })),
      descricao: pf.length ? 'Predominam ' + pf.slice(0, 2).map(([f, p]) => `${f.toLowerCase()} (${fmt_g(p)}%)`).join(' e ') + '.' : '',
      concentracao_pct: pyround(100.0 * tot / c.massa_final_g, 1), massa_final_g: c.massa_final_g,
      ingredientes, cuidados: avisos_quimicos, alergias, motivos, protagonista_id: c.protagonista_id,
      escolhas: c.escolhas_pendentes.map(p => ({ item: p.item, opcoes: p.opcoes })), formula,
    };
    if (mostrar_tecnico) {
      const maq = db.maquinas.get(maquina_id);
      const nome_do_canal = i => db.nome(maq.por_canal.get(i.canal).material_id);
      out.tecnico = {
        avisos: c.avisos, trocas: c.trocas, explicacao: c.explicacao,
        violacoes: (c.resultado ? c.resultado.violacoes : []).map(v => ({ codigo: v.codigo, nivel: v.nivel, mensagem: v.mensagem })),
        job: { nome: titulo, itens: c.traducao.itens.map(i => ({ canal: i.canal, material: nome_do_canal(i).slice(0, 40), gramas: i.gramas })) },
      };
    }
    return out;
  }

  // ------------------------------------------------------------------------------------------------ mapa da máquina do cliente
  // A pessoa diz o que há em cada vidro da própria máquina; o app passa a compor só com isso. Não existe no Python: o banco só
  // tem as máquinas de demonstração. O resto do motor enxerga a máquina dela como qualquer outra (db.maquinas).
  const ID_PROPRIA = 'minha';
  const PADRAO_MAQUINA = { dose_minima_g: 0.02, tolerancia_pct: 2.0, tolerancia_g: 0.02, lote_max_g: 44.0 };   // os mesmos das máquinas do banco
  const MAX_CANAIS = 200;

  function limpar_mapa(bruto) {
    const num = v => (v === null || v === undefined || v === '' ? null : Number(v));
    const canais = Array.isArray(bruto && bruto.canais) ? bruto.canais : [];
    return { nome: String((bruto && bruto.nome) || 'Minha máquina').slice(0, 40) || 'Minha máquina',
      canais: canais.map(c => ({ canal: num(c.canal), material_id: num(c.material_id), diluicao_pct: num(c.diluicao_pct),
        volume_atual_ml: num(c.volume_atual_ml), densidade_g_ml: num(c.densidade_g_ml) })) };
  }

  function _maquina_do_mapa(mapa) {
    return { id: ID_PROPRIA, nome: mapa.nome, ...PADRAO_MAQUINA,
      canais: mapa.canais.map(c => ({ canal: c.canal, material_id: c.material_id, diluicao_pct: c.diluicao_pct, volume_atual_ml: c.volume_atual_ml,
        densidade_g_ml: c.densidade_g_ml, ativo: true })).sort((a, b) => a.canal - b.canal) };
  }

  function resumo_do_mapa(db, mapa) {
    db.adicionar_maquina({ ..._maquina_do_mapa(mapa), id: '__previa' });
    try {
      const inv = inventario(db, '__previa'), cap = capacidades(db, '__previa');
      return { canais: mapa.canais.length, materiais: inv.size, familias: Object.fromEntries(cap.familias), notas: cap.notas.size,
        acordes: _acordes_da_maquina(db, inv).length, acordes_do_motor: db.acordes_motor.length };
    } finally { db.remover_maquina('__previa'); }
  }

  function validar_mapa(db, bruto) {
    const mapa = limpar_mapa(bruto), erros = [], avisos = [];
    if (!mapa.canais.length) erros.push('Coloque pelo menos um vidro (o etanol, para começar).');
    if (mapa.canais.length > MAX_CANAIS) erros.push(`O máximo são ${MAX_CANAIS} vidros.`);
    const numeros = new Set(), pares = new Set();
    mapa.canais.forEach((c, i) => {
      const m = db.materiais.get(c.material_id);
      const onde = `Vidro ${Number.isInteger(c.canal) ? c.canal : '#' + (i + 1)}` + (m ? ` (${m.nome})` : '');
      if (!Number.isInteger(c.canal) || c.canal < 0) erros.push(`${onde}: o número do vidro tem de ser um inteiro a partir de 0.`);
      else if (numeros.has(c.canal)) erros.push(`${onde}: o número ${c.canal} está repetido.`);
      else numeros.add(c.canal);
      if (!m) { erros.push(`${onde}: escolha o material.`); return; }
      if (!(c.diluicao_pct > 0 && c.diluicao_pct <= 100)) erros.push(`${onde}: a diluição tem de ficar entre 0 e 100%.`);
      if (!(c.volume_atual_ml >= 0)) erros.push(`${onde}: informe o volume que há no vidro, em ml.`);
      if (c.densidade_g_ml !== null && !(c.densidade_g_ml >= 0.5 && c.densidade_g_ml <= 2)) erros.push(`${onde}: a densidade tem de ficar entre 0,5 e 2 g/ml (ou fique em branco).`);
      const par = c.material_id + '|' + c.diluicao_pct;
      if (pares.has(par)) erros.push(`${onde}: já existe outro vidro com este material nesta diluição.`);
      pares.add(par);
      if (m.ifra[0] === 'proibido' || db.excluidos.has(c.material_id)) avisos.push(`${onde}: tem proibição ou restrição de uso; o app não vai usá-lo nas receitas.`);
    });
    if (mapa.canais.length && !mapa.canais.some(c => db.materiais.has(c.material_id) && db.materiais.get(c.material_id).tipo_material === 'solvent')) {
      avisos.push('Nenhum vidro de etanol: o app só dosa o concentrado, sem completar o frasco.');
    }
    return { erros, avisos, resumo: erros.length ? null : resumo_do_mapa(db, mapa) };
  }

  const _sem_acento = s => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

  function buscar_materiais(db, consulta, limite = 12) {
    const q = _sem_acento(consulta);
    if (q.length < 2) return [];
    if (!db._busca) db._busca = [...db.materiais.values()].map(m => ({ m, texto: _sem_acento(m.nome) + ' ' + _sem_acento(m.cas || '') }));
    const achados = db._busca.filter(x => x.texto.includes(q)).sort((a, b) => (a.texto.startsWith(q) ? 0 : 1) - (b.texto.startsWith(q) ? 0 : 1) || a.m.id - b.m.id);
    return achados.slice(0, limite).map(({ m }) => ({ id: m.id, nome: m.nome, cas: m.cas, familia: m.familia_canonica, tipo: m.tipo_material }));
  }

  // ------------------------------------------------------------------------------------------------ servidor.py -> chamadas locais
  const FORMATO_ARQUIVO = 'perfume.receitas.v1';           // identifica o arquivo de exportação; a versão sobe se o formato mudar
  const MAX_IMPORTADAS = 2000;

  function sanear(r, agora) {
    if (!r || typeof r !== 'object' || typeof r.nome !== 'string' || !Array.isArray(r.itens) || !Number.isInteger(r.nota) || r.nota < 1 || r.nota > 5) return null;
    const itens = r.itens.filter(i => i && Number.isInteger(i.id) && typeof i.nome === 'string' && Number.isFinite(i.gramas) && i.gramas > 0)
      .map(i => ({ id: i.id, cas: typeof i.cas === 'string' ? i.cas : null, nome: i.nome, gramas: i.gramas }));
    if (!itens.length) return null;
    const resp = r.respostas && typeof r.respostas === 'object' && !Array.isArray(r.respostas) ? r.respostas : {};
    return { nome: r.nome.slice(0, 80), maquina: String(r.maquina || ''), massa_final_g: Number.isFinite(r.massa_final_g) && r.massa_final_g > 0 ? r.massa_final_g : 26.5,
      nota: r.nota, comentario: typeof r.comentario === 'string' ? r.comentario.slice(0, 300) || null : null,
      criada_em: typeof r.criada_em === 'string' ? r.criada_em : agora(), pai_id: null,
      respostas: Object.values(resp).every(v => Array.isArray(v) && v.every(x => typeof x === 'string')) ? resp : {},
      protagonista_id: Number.isInteger(r.protagonista_id) ? r.protagonista_id : 0, itens };
  }

  function limpar_respostas(q, respostas) {                // receita salva por uma versão antiga do questionário: fica só o que ele ainda conhece
    const conhecidas = new Map(q.nos.map(n => [n.id, new Set(n.opcoes.map(o => o.id))]));
    const out = {};
    for (const [no, esc] of Object.entries(respostas)) {
      const ok = conhecidas.has(no) ? esc.filter(e => conhecidas.get(no).has(e)) : [];
      if (ok.length) out[no] = ok;
    }
    return out;
  }

  /* Os mesmos pedidos que app/servidor.py atende por HTTP, respondidos aqui mesmo. As receitas salvas ficam no `armazenamento`
   * ({ler(), gravar(lista)}): localStorage no celular, memória nos testes. Cada item guarda id, CAS e nome do material, porque
   * um dados.json novo pode renumerar os ids: ao abrir, o item é religado pelo id (se CAS/nome conferem) ou pelo CAS/nome. */
  function criar_app(db, armazenamento, agora = () => new Date().toISOString(), propria = { ler: () => null, gravar: () => {} }) {
    const caps = new Map();
    const cap_de = mid => { if (!caps.has(mid)) caps.set(mid, capacidades(db, mid)); return caps.get(mid); };
    const q = db.questionario;
    const maquina = corpo => { if (!db.maquinas.has(corpo.maquina)) throw new ErroDeUso('máquina desconhecida'); return corpo.maquina; };

    function religar(item) {                                // o mesmo material do catálogo: por id, senão por nome+CAS, senão só pelo CAS
      const mesmo = m => m.nome === item.nome && (m.cas || null) === (item.cas || null);
      const por_id = db.materiais.get(item.id);
      if (por_id && mesmo(por_id)) return por_id.id;
      const igual = [...db.materiais.values()].find(mesmo);
      if (igual) return igual.id;
      return item.cas && db.por_cas.has(item.cas) ? db.por_cas.get(item.cas)[0] : null;
    }

    function apresentar_salva(r, mid, tecnico, evitar) {
      const itens = new Map(), sumidos = [];
      for (const it of r.itens) {
        const m = religar(it);
        if (m === null) sumidos.push(it.nome); else itens.set(m, (itens.has(m) ? itens.get(m) : 0.0) + it.gramas);
      }
      const trad = traduzir_itens(db, itens, r.massa_final_g, mid);
      const c = new Candidato({ nome: r.nome, protagonista_id: r.protagonista_id || 0, itens, massa_final_g: r.massa_final_g });
      c.traducao = trad;
      c.resultado = trad.completa && !sumidos.length ? validar(db, mid, { itens: trad.itens, massa_final_g: r.massa_final_g }) : null;
      const out = descrever(db, mid, c, tecnico, evitar);
      out.titulo = r.nome;
      out.faltando = trad.faltando.map(f => ({ nome: f.nome, equivalentes: f.equivalentes.map(e => e.nome) }))
        .concat(trad.inviaveis.map(f => ({ nome: f.nome, equivalentes: [] })), sumidos.map(nome => ({ nome, equivalentes: [] })));
      return out;
    }

    // a máquina do cliente: guardada com CAS e nome de cada material, religada ao catálogo de hoje (como as receitas)
    let mapa_ativo = null, perdidos = [];
    const registrar_propria = mapa => { db.adicionar_maquina(_maquina_do_mapa(mapa)); caps.delete(ID_PROPRIA); };
    (function carregar_propria() {
      const bruto = propria.ler();
      if (!bruto || !Array.isArray(bruto.canais)) return;
      const canais = [];
      for (const c of bruto.canais) {
        const id = religar({ id: c.material_id, cas: c.material_cas || null, nome: c.material_nome || '' });
        if (id === null) perdidos.push(c.material_nome || String(c.material_id)); else canais.push({ ...c, material_id: id });
      }
      mapa_ativo = limpar_mapa({ nome: bruto.nome, canais });
      if (!validar_mapa(db, mapa_ativo).erros.length) registrar_propria(mapa_ativo);
    })();

    const lista = () => armazenamento.ler();
    const resumo = r => ({ id: r.id, nome: r.nome, maquina: r.maquina, nota: r.nota, comentario: r.comentario, criada_em: r.criada_em, pai_id: r.pai_id || null });
    const achar = id => { const r = lista().find(x => x.id === id); if (!r) throw new ErroDeUso('receita não encontrada'); return r; };

    const rotas = {
      '/api/maquinas': () => ({ maquinas: [...db.maquinas.values()].map(m => ({ id: m.id, nome: m.nome })) }),

      '/api/proxima': corpo => {
        const mid = maquina(corpo), r = corpo.respostas || {};
        return { pergunta: proxima(r, q, cap_de(mid)), caminho: caminho(r, q, cap_de(mid)) };
      },

      '/api/responder': corpo => {
        const mid = maquina(corpo);
        return { respostas: responder(corpo.respostas || {}, corpo.no, corpo.escolhidas || [], q, cap_de(mid)) };
      },

      '/api/compor': corpo => {
        const mid = maquina(corpo), r = corpo.respostas || {}, cap = cap_de(mid);
        if (proxima(r, q, cap) !== null) throw new ErroDeUso('o questionário ainda não terminou');
        const b = montar_brief(db, r, q, cap);
        return { candidatos: compor(db, mid, b, 3).map(c => descrever(db, mid, c, !!corpo.tecnico)), ajustes: Object.keys(AJUSTES) };
      },

      '/api/refinar': corpo => {
        const mid = maquina(corpo), b = montar_brief(db, corpo.respostas || {}, q, cap_de(mid));
        const base = new Candidato({ nome: '', protagonista_id: parseInt(corpo.protagonista_id, 10) || 0, itens: new Map(), massa_final_g: b.massa_final_g });
        const novo = refinar(db, mid, base, b, corpo.ajuste);
        if (novo === null) throw new ErroDeUso('não consegui refinar esse pedido nesta máquina');
        return { candidato: descrever(db, mid, novo, !!corpo.tecnico) };
      },

      '/api/materiais': corpo => ({ materiais: buscar_materiais(db, String(corpo.q || '')) }),

      '/api/mapa': () => ({ mapa: mapa_ativo, perdidos, registrada: db.maquinas.has(ID_PROPRIA) }),

      '/api/mapa/modelo': corpo => {
        const m = db.maquinas.get(corpo.de);
        if (!m) throw new ErroDeUso('máquina desconhecida');
        return { mapa: { nome: 'Minha máquina', canais: m.canais.filter(c => c.ativo).map(c => ({ canal: c.canal, material_id: c.material_id,
          diluicao_pct: c.diluicao_pct, volume_atual_ml: c.volume_atual_ml, densidade_g_ml: c.densidade_g_ml })) } };
      },

      '/api/mapa/validar': corpo => validar_mapa(db, corpo.mapa),

      '/api/mapa/salvar': corpo => {
        const mapa = limpar_mapa(corpo.mapa), v = validar_mapa(db, mapa);
        if (v.erros.length) throw new ErroDeUso(v.erros[0] + (v.erros.length > 1 ? ` (e mais ${v.erros.length - 1})` : ''));
        propria.gravar({ nome: mapa.nome, canais: mapa.canais.map(c => { const m = db.materiais.get(c.material_id); return { ...c, material_nome: m.nome, material_cas: m.cas }; }) });
        mapa_ativo = mapa;
        perdidos = [];
        registrar_propria(mapa);
        return { maquina: ID_PROPRIA, resumo: v.resumo, avisos: v.avisos };
      },

      '/api/mapa/excluir': () => {
        propria.gravar(null);
        db.remover_maquina(ID_PROPRIA);
        caps.delete(ID_PROPRIA);
        mapa_ativo = null;
        perdidos = [];
        return {};
      },

      '/api/ajustar': corpo => {
        const mid = maquina(corpo);
        const em_ordem = obj => new Map(Object.entries(obj || {}).map(([k, v]) => [parseInt(k, 10), v === null ? null : Number(v)]).sort((a, b) => a[0] - b[0]));   // a ordem canônica é pelo id do material
        const massa = Number(corpo.massa_final_g || 26.5);
        const c = aplicar(db, mid, em_ordem(corpo.itens), massa, em_ordem(corpo.novos), corpo.nome || '');
        const evitados = corpo.respostas && Object.keys(corpo.respostas).length ? montar_brief(db, corpo.respostas, q, cap_de(mid)).evitar_materiais : [];   // alergias declaradas no questionário
        const saida = descrever(db, mid, c, !!corpo.tecnico, evitados);
        if (corpo.nome) saida.titulo = corpo.nome;
        saida.faltando = c.traducao.faltando.map(f => ({ nome: f.nome, equivalentes: f.equivalentes.map(e => e.nome) }));
        return { candidato: saida, limites: limites(db, mid, c.itens, massa), avisos: c.avisos, evitados,
          problemas: c.resultado.violacoes.filter(v => v.nivel === 'erro').map(v => v.mensagem) };
      },

      '/api/salvar': corpo => {
        const mid = maquina(corpo);
        const itens = Object.entries(corpo.itens || {}).map(([k, v]) => [parseInt(k, 10), Number(v)]).filter(([m, g]) => g > 0 && db.materiais.has(m));
        const nota = corpo.nota;
        if (!itens.length || !Number.isInteger(nota) || nota < 1 || nota > 5) throw new ErroDeUso('faltam os ingredientes ou a nota (1 a 5)');
        const todas = lista();
        const r = {
          id: todas.reduce((m, x) => Math.max(m, x.id), 0) + 1, nome: String(corpo.nome || 'Sem nome').slice(0, 80), maquina: mid,
          massa_final_g: Number(corpo.massa_final_g || 26.5), nota, comentario: String(corpo.comentario || '').slice(0, 300) || null,
          criada_em: agora(), pai_id: corpo.pai_id || null, respostas: corpo.respostas || {}, protagonista_id: parseInt(corpo.protagonista_id, 10) || 0,
          itens: itens.map(([m, g]) => { const x = db.materiais.get(m); return { id: m, cas: x.cas, nome: x.nome, gramas: g }; }),
        };
        armazenamento.gravar(todas.concat([r]));
        return { id: r.id };
      },

      '/api/receitas': () => ({ receitas: lista().map(resumo).sort((a, b) => b.id - a.id) }),

      '/api/receita': corpo => {
        const r = achar(corpo.id), mid = [corpo.maquina, r.maquina].find(m => db.maquinas.has(m)) || db.maquinas.keys().next().value;   // a máquina de origem pode ter saído dos dados
        const respostas = limpar_respostas(q, r.respostas), evitados = montar_brief(db, respostas, q, cap_de(mid)).evitar_materiais;
        return { receita: { ...resumo(r), respostas, protagonista_id: r.protagonista_id }, maquina: mid, candidato: apresentar_salva(r, mid, !!corpo.tecnico, evitados),
          ajustes: Object.keys(AJUSTES), evitados };
      },

      '/api/excluir': corpo => { achar(corpo.id); armazenamento.gravar(lista().filter(x => x.id !== corpo.id)); return {}; },

      '/api/exportar': () => ({ formato: FORMATO_ARQUIVO, dados: db.versao, receitas: lista() }),

      '/api/importar': corpo => {
        const c = corpo.conteudo;
        if (!c || c.formato !== FORMATO_ARQUIVO || !Array.isArray(c.receitas) || c.receitas.length > MAX_IMPORTADAS) throw new ErroDeUso('arquivo de receitas inválido');
        const todas = lista(), chave = r => r.nome + '|' + r.criada_em;
        const ja = new Set(todas.map(chave));
        let prox = todas.reduce((m, x) => Math.max(m, x.id), 0);
        const novas = [];
        for (const bruta of c.receitas) {                   // o arquivo vem de fora: só entra o que tem a forma de uma receita
          const r = sanear(bruta, agora);
          if (r && !ja.has(chave(r))) { ja.add(chave(r)); novas.push({ ...r, id: ++prox }); }
        }
        armazenamento.gravar(todas.concat(novas));
        return { importadas: novas.length, ignoradas: c.receitas.length - novas.length };
      },
    };

    return {
      chamar(rota, corpo = {}) {
        if (!Object.hasOwn(rotas, rota)) throw new ErroDeUso('não encontrado');
        return rotas[rota](corpo);
      },
    };
  }

  return {
    Banco, ErroDeUso, Brief, criar_app, ID_PROPRIA,         // o que o app usa
    inventario, instanciar, parecidos_em, validar, traduzir_itens, compor, refinar, descrever, cuidados, capacidades,   // o que os testes de paridade chamam direto
    numeros: { soma, fixo, pyround, porcento, fmt_g },
  };
});
