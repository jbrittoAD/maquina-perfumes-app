/* O site de compartilhamento dentro do app (docs/11 §1, leva SITE-2): o MARKETPLACE local (publicar anúncio com a curva
 * de preço inicial + por ml da decisão 3, split 90/10 da decisão 11, lote mínimo de referência da decisão 14 no cartão),
 * o VÍNCULO F0 da máquina pelo código QR da telinha do ESP32 (payload `perfume://vincular?d=<id>&c=<código>`, §1.6) e a
 * REPOSIÇÃO da decisão 13 (§1.5.5): canal acabando → painel com as ofertas REAIS da tabela `oferta` que o exportar_pwa.py
 * traz no dados.json, e o permalink de carrinho Shopify `/cart/<variante>:<qtd>` quando a oferta tiver variante. Na leva
 * SITE-3, o PACOTE que leva a fórmula até a página da própria máquina (http://<ip>/imprimir#f=…, ver pacoteDaMaquina).
 *
 * Este módulo não desenha e não faz rede (o "testar conexão" do vínculo é fetch chamado pelo app.js, que avisa quando
 * não dá). NADA INVENTADO: o marketplace começa vazio; os preços default são a REFERÊNCIA do dono rotulada; sem variante
 * na oferta o link é o direto da loja; sem cobrança — o gateway é pendência. O motor não é tocado: quem precisa dele
 * recebe o `db` por argumento e só lê.
 *
 * Testes: pwa/teste/site.test.mjs.
 */
(function (raiz, fabrica) {
  if (typeof module === 'object' && module.exports) module.exports = fabrica();
  else raiz.Site = fabrica();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  class ErroDeUso extends Error {}

  // ------------------------------------------------------------------ o anúncio do marketplace (decisões 9, 11, 12, 14)
  const FORMATO_ANUNCIO = 'perfume.anuncio.v1';        // o "produto" transferível por arquivo até haver nuvem
  const CHAVE_MARKETPLACE = 'perfume.marketplace.v1';  // os anúncios que ESTE aparelho conhece (publicados ou importados)
  const PRECO_INICIAL_REF = 1.00;                      // o padrão do formulário — rotulado junto dos exemplos do dono (§1.5.3)
  const PRECO_POR_ML_REF = 0.02;                       // decisão do dono 09/10: R$ 1 até 5 ml + R$ 0,02 por ml (10 ml = R$ 1,10)
  const ML_DA_BASE = 5;                                // o valor inicial cobre os 5 ml; o ml adicional entra por cima (decisão 3)
  const SPLIT = { autor: 0.9, plataforma: 0.1 };       // decisão 11: plataforma fica com 10%
  const TEXTO_SPLIT = 'você recebe 90% de cada impressão paga — plataforma 10%';
  const TEXTO_GATEWAY = 'pagamento chega com o gateway — pendência';
  const MAX_ITENS = 200;

  const centavos = n => Math.round((n + Number.EPSILON) * 100) / 100;
  const brl = n => 'R$ ' + Number(n).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const numeroOk = n => Number.isFinite(n) && n >= 0;

  /* O campo de preço do formulário: VAZIO é erro (pede o valor), zero só quando digitado — Number('') é 0 e publicaria
   * grátis sem a pessoa ter dito. Aceita vírgula decimal. */
  function lerPreco(texto, rotulo) {
    const t = String(texto ?? '').trim().replace(',', '.');
    if (t === '') throw new ErroDeUso(`preencha o ${rotulo} (digite 0 para compartilhar de graça)`);
    const n = Number(t);
    if (!numeroOk(n)) throw new ErroDeUso(`o ${rotulo} é um valor em reais, zero ou mais`);
    return n;
  }

  /* Data ISO que o navegador entende (o "publicado em" do cartão): lixo vindo de arquivo não vira "Invalid Date". */
  const dataValida = s => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}/.test(s) && !Number.isNaN(Date.parse(s));

  /* A curva da decisão 3: preço = inicial (cobre os 5 ml) + por_ml × (ml − 5). Zero nos dois = compartilhar. */
  function preco(anuncio, ml) {
    if (!numeroOk(anuncio.preco_inicial) || !numeroOk(anuncio.preco_por_ml)) return null;
    return centavos(anuncio.preco_inicial + anuncio.preco_por_ml * Math.max(0, ml - ML_DA_BASE));
  }

  function splitDo(valor) {
    if (!numeroOk(valor)) return null;
    const autor = centavos(valor * SPLIT.autor), plataforma = centavos(valor - autor);   // a plataforma fica com o troco do arredondamento
    return { autor, plataforma };
  }

  /* O rótulo do padrão: a reta que o dono DECIDIU em 09/10 (os três exemplos do docs/11 §1.5.3 não cabiam numa reta;
   * ele ficou com a que acerta o 10 ml), com o que ela dá calculado pela própria curva — não escrito à mão. O teto do
   * frasco é 50 ml (também decisão de 09/10), então o rótulo vai até lá. O autor pode mudar os dois valores. */
  const REF = { preco_inicial: PRECO_INICIAL_REF, preco_por_ml: PRECO_POR_ML_REF };
  const ROTULO_PRECO_REF = `padrão do dono: ${brl(PRECO_INICIAL_REF)} até ${ML_DA_BASE} ml + ${brl(PRECO_POR_ML_REF)} por ml adicional`
    + ` (dá ${brl(preco(REF, 10))} em 10 ml e ${brl(preco(REF, 50))} em 50 ml) — o autor pode mudar`;

  /* A prévia da tabela 5..100 ml que o formulário mostra ANTES de publicar. `ml_max` (o lote da máquina de referência,
   * em ml) marca as linhas que ela NÃO imprime: o anúncio não vende volume impossível sem dizer. */
  function previa(anuncio, volumes, ml_max = Infinity) {
    if (!Array.isArray(volumes) || !volumes.length) throw new ErroDeUso('passe a grade de volumes (Imprimir.VOLUMES_ML)');
    return volumes.map(ml => ({ ml, preco: preco(anuncio, ml), autor: splitDo(preco(anuncio, ml)).autor, acima: ml > ml_max + 1e-9 }));
  }

  const ehGratis = anuncio => anuncio.preco_inicial === 0 && anuncio.preco_por_ml === 0;
  const textoPreco = anuncio => ehGratis(anuncio)
    ? 'grátis — compartilhado pelo autor'
    : `${brl(preco(anuncio, ML_DA_BASE))} até ${ML_DA_BASE} ml · ${brl(anuncio.preco_por_ml)} por ml adicional`;

  /* A pirâmide do anúncio sai dos próprios materiais (nota de pirâmide do catálogo) — nada de texto livre inventado. */
  function piramideDe(db, itens) {
    const niveis = new Map();
    for (const it of itens) {
      const m = db.materiais.get(it.id);
      if (!m || !m.nota_piramide) continue;
      const nome = m.nome;
      if (!niveis.has(m.nota_piramide)) niveis.set(m.nota_piramide, []);
      if (!niveis.get(m.nota_piramide).includes(nome)) niveis.get(m.nota_piramide).push(nome);
    }
    return [...niveis].map(([nivel, nomes]) => ({ nivel, nomes }));
  }

  /* Monta o anúncio já validado: fórmula embutida (decisão 9 — quem compra recebe a fórmula, sem DRM local),
   * pirâmide, preço e o lote mínimo de REFERÊNCIA (decisão 14: calculado contra uma máquina real — na de quem
   * imprime pode mudar, e o cartão avisa). */
  function criar({ formula, nome, descricao = '', autor = '', preco_inicial = PRECO_INICIAL_REF, preco_por_ml = PRECO_POR_ML_REF,
                   lote_ref_ml = null, lote_ref_maquina = '', criada_em, id = null }) {
    if (typeof nome !== 'string' || !nome.trim()) throw new ErroDeUso('dê um nome ao anúncio');
    if (typeof autor !== 'string') throw new ErroDeUso('o nome do autor é um texto');          // comprimento APARA, não trava a publicação
    if (descricao !== null && typeof descricao !== 'string') throw new ErroDeUso('a descrição é um texto');
    if (!numeroOk(preco_inicial) || !numeroOk(preco_por_ml)) throw new ErroDeUso('preço inicial e por ml são valores em reais (podem ser zero)');
    if (!formula || !Array.isArray(formula.itens) || !formula.itens.length || formula.itens.length > MAX_ITENS) throw new ErroDeUso('o anúncio precisa de uma fórmula');
    if (!(formula.massa_final_g > 0)) throw new ErroDeUso('a fórmula do anúncio precisa de massa final');
    for (const i of formula.itens) {
      if (!i || !Number.isInteger(i.id) || typeof i.nome !== 'string' || !Number.isFinite(i.gramas) || !(i.gramas > 0)) throw new ErroDeUso('itens da fórmula: id, nome e gramas');
    }
    if (formula.concentracao_pct !== null && formula.concentracao_pct !== undefined
      && !(formula.concentracao_pct > 0 && formula.concentracao_pct <= 100)) throw new ErroDeUso('concentração entre 0 e 100');
    if (lote_ref_ml !== null && lote_ref_ml !== undefined && !numeroOk(lote_ref_ml)) throw new ErroDeUso('lote de referência em ml');
    return {
      id: id === null ? null : id, nome: nome.trim().slice(0, 80), descricao: (descricao || '').slice(0, 300) || null,
      autor: (autor || '').trim().slice(0, 60), preco_inicial: centavos(preco_inicial), preco_por_ml: centavos(preco_por_ml),
      lote_ref_ml: lote_ref_ml === undefined ? null : lote_ref_ml, lote_ref_maquina: String(lote_ref_maquina || ''),
      criada_em: criada_em === undefined ? new Date().toISOString() : dataValida(criada_em) ? criada_em : null,   // data ruim: "sem data", nunca inventada
      formula: { titulo: String(formula.titulo || nome).slice(0, 80), massa_final_g: formula.massa_final_g,
        concentracao_pct: formula.concentracao_pct === undefined ? null : formula.concentracao_pct,
        itens: formula.itens.map(i => ({ id: i.id, cas: typeof i.cas === 'string' ? i.cas : null, nome: i.nome, gramas: i.gramas })) },
    };
  }

  /* O arquivo do anúncio: o mesmo espírito do perfume.receitas.v1 — é isto que viaja até haver nuvem. */
  function arquivo(anuncio, versao) {
    return { formato: FORMATO_ANUNCIO, dados: versao || null, anuncio };
  }

  function doArquivo(json) {
    if (!json || typeof json !== 'object' || json.formato !== FORMATO_ANUNCIO || !json.anuncio || typeof json.anuncio !== 'object') return null;
    const a = json.anuncio;
    try {
      return criar({ formula: a.formula, nome: a.nome, descricao: a.descricao, autor: a.autor,
        preco_inicial: a.preco_inicial, preco_por_ml: a.preco_por_ml, lote_ref_ml: a.lote_ref_ml, lote_ref_maquina: a.lote_ref_maquina,
        criada_em: a.criada_em === undefined ? null : a.criada_em, id: null });   // o id do arquivo é de OUTRO aparelho: aqui ganha um novo
    } catch { return null; }
  }

  /* O mesmo material do catálogo deste app — a regra do motor para receitas importadas (criar_app → religar): pelo id
   * se nome e CAS conferem, senão por nome+CAS, senão só pelo CAS. Um anúncio vem de outro aparelho (outro dados.json:
   * os ids podem ser outros); o que não religa não entra calado. */
  function religar(db, item) {
    const mesmo = m => m.nome === item.nome && (m.cas || null) === (item.cas || null);
    const porId = db.materiais.get(item.id);
    if (porId && mesmo(porId)) return porId.id;
    for (const m of db.materiais.values()) if (mesmo(m)) return m.id;
    return item.cas && db.por_cas.has(item.cas) ? db.por_cas.get(item.cas)[0] : null;
  }

  function religarItens(db, itens) {
    const porId = new Map(), sumidos = [];
    for (const it of itens) {
      const id = religar(db, it);
      if (id === null) { sumidos.push(it.nome); continue; }
      const m = db.materiais.get(id), antes = porId.get(id);
      porId.set(id, { id, cas: m.cas || null, nome: m.nome, gramas: (antes ? antes.gramas : 0) + it.gramas });
    }
    return { itens: [...porId.values()], sumidos };
  }

  /* Importar o arquivo de um anúncio: valida a forma (doArquivo), religa os materiais ao catálogo deste app e RECUSA,
   * dizendo quais, se algum não religar — anúncio pela metade travaria a impressão. */
  function importar(json, db) {
    const a = doArquivo(json);
    if (!a) throw new ErroDeUso('este arquivo não é um anúncio (formato ' + FORMATO_ANUNCIO + ')');
    const r = religarItens(db, a.formula.itens);
    if (r.sumidos.length) {
      throw new ErroDeUso(`não importei: o anúncio usa ${r.sumidos.length === 1 ? 'um material' : 'materiais'} que este app não conhece`
        + ` (${r.sumidos.join(', ')}) — atualize o app ou peça ao autor um arquivo novo`);
    }
    a.formula.itens = r.itens;
    return a;
  }

  /* A lista local: começa VAZIA (nenhum anúncio fictício); o que entra é publicado aqui ou importado por arquivo. */
  function marketplace(lembrar) {
    const ler = () => { try { const t = lembrar.ler(CHAVE_MARKETPLACE); const j = t ? JSON.parse(t) : []; return Array.isArray(j) ? j : []; } catch { return []; } };
    return {
      listar: ler,
      tamanho() { return ler().length; },
      adicionar(anuncio) {
        const lista = ler();
        if (anuncio.id === null || lista.some(x => x.id === anuncio.id)) anuncio.id = lista.reduce((m, x) => Math.max(m, x.id || 0), 0) + 1;   // id repetido abriria/apagaria o anúncio errado
        lista.unshift(anuncio);
        lembrar.gravar(CHAVE_MARKETPLACE, JSON.stringify(lista));
        return anuncio;
      },
      remover(id) { const lista = ler().filter(a => a.id !== id); lembrar.gravar(CHAVE_MARKETPLACE, JSON.stringify(lista)); },
      achar(id) { return ler().find(a => a.id === id) || null; },
    };
  }

  // ------------------------------------------------------------------ vínculo de máquina (F0, docs/11 §1.2/§1.6)
  const CHAVE_VINCULOS = 'perfume.vinculos.v1';
  const ESTADO_HONESTO = 'vínculo local — sincroniza quando o servidor existir (F0-nuvem pendente)';

  /* O código de 6 dígitos que a telinha mostra: FNV-1a de 32 bits sobre os bytes do id do aparelho, módulo 10⁶, com
   * zeros à esquerda — a MESMA conta do firmware (software/firmware/src/vinculo.h, vinculo_codigo). */
  function codigoVinculo(dispositivo) {
    let h = 2166136261;
    for (const b of new TextEncoder().encode(String(dispositivo))) { h ^= b; h = Math.imul(h, 16777619) >>> 0; }
    return String(h % 1000000).padStart(6, '0');
  }

  /* O payload do QR da telinha: `perfume://vincular?d=<aparelho>&c=<código>`. Parse manual (esquema próprio não passa
   * pelo construtor de URL em todo navegador); aparelho alfanumérico curto e código de 6 dígitos, como o firmware gera. */
  function parseVinculo(texto) {
    if (typeof texto !== 'string') return null;
    const m = /^perfume:\/\/vincular\?([^\s#]+)/.exec(texto.trim());
    if (!m) return null;
    const params = new Map();
    for (const par of m[1].split('&')) {
      const [k, v = ''] = par.split('=');
      params.set(k, v);
    }
    let d = params.get('d') || '', c = params.get('c') || '';
    try { d = decodeURIComponent(d); c = decodeURIComponent(c); } catch { return null; }
    if (!/^[A-Za-z0-9_-]{4,32}$/.test(d) || !/^\d{6}$/.test(c)) return null;
    return { dispositivo: d, codigo: c };
  }

  function vinculos(lembrar) {
    const ler = () => { try { const t = lembrar.ler(CHAVE_VINCULOS); const j = t ? JSON.parse(t) : []; return Array.isArray(j) ? j : []; } catch { return []; } };
    return {
      listar: ler,
      vincular(texto, nome = '') {
        const v = parseVinculo(texto);
        if (!v) throw new ErroDeUso('não parece um código de vínculo (perfume://vincular?d=…&c=…)');
        if (v.codigo !== codigoVinculo(v.dispositivo)) throw new ErroDeUso('o código não confere com este aparelho — confira os 6 dígitos na telinha');
        const lista = ler();
        if (lista.some(x => x.dispositivo === v.dispositivo)) throw new ErroDeUso('este aparelho já está vinculado');
        const registro = { id: lista.reduce((m, x) => Math.max(m, x.id || 0), 0) + 1, dispositivo: v.dispositivo, codigo: v.codigo,
          nome: String(nome || '').trim().slice(0, 40) || 'Máquina ' + v.dispositivo.slice(-4), vinculado_em: new Date().toISOString() };
        lista.unshift(registro);
        lembrar.gravar(CHAVE_VINCULOS, JSON.stringify(lista));
        return registro;
      },
      revogar(id) { lembrar.gravar(CHAVE_VINCULOS, JSON.stringify(ler().filter(x => x.id !== id))); },
    };
  }

  // ------------------------------------------------------------------ reposição de químico (decisão 13, §1.5.5)
  /* A régua do "acabando": meio frasco pequeno (10 ml ≈ 8,3 g com densidade). Com densidade no canal (calibração v1) o
   * resta sai em gramas; sem, vale o volume DECLARADO no mapa — estoque teórico, rotulado. O limiar exato se calibra
   * quando a máquina reportar consumo real (F1+). */
  const LIMIAR_ML = 10;
  const LIMIAR_G = 8.3;
  const QTD_SUGERIDA = 1;                               // um frasco — compra manual, nada automático

  function acabando(canal) {
    if (!canal || canal.volume_atual_ml === null || canal.volume_atual_ml === undefined || !(canal.volume_atual_ml >= 0)) return null;
    const resta_g = canal.densidade_g_ml ? canal.densidade_g_ml * canal.volume_atual_ml : null;
    const eh = resta_g !== null ? resta_g <= LIMIAR_G + 1e-9 : canal.volume_atual_ml <= LIMIAR_ML + 1e-9;
    return { acabando: eh, resta_ml: canal.volume_atual_ml, resta_g: resta_g === null ? null : Math.round(resta_g * 10) / 10, teorico: resta_g === null };
  }

  const textoAcabando = info => info.resta_g !== null
    ? `restam ~${info.resta_g.toLocaleString('pt-BR', { maximumFractionDigits: 1 })} g no vidro`
    : `restam ${info.resta_ml} ml (estoque declarado — calibre o vidro para conferir em gramas)`;

  /* Preço por unidade quando o tamanho diz a unidade ("500 g" → R$/g; "20 ml" → R$/ml); sem tamanho, nada. */
  function precoPorUnidade(preco_loja, tamanho) {
    const m = /^(\d+(?:\.\d+)?)\s*(g|ml)$/i.exec(String(tamanho || '').trim());
    if (!m || !Number.isFinite(preco_loja) || !(Number(m[1]) > 0)) return null;
    return { valor: preco_loja / Number(m[1]), unidade: m[2].toLowerCase() };
  }

  /* As ofertas do dados.json (exportar_pwa.py traz a tabela `oferta` compactada por índice de loja/URL): expansão para
   * o painel. Só o que a coleta realmente viu — nenhuma loja ou preço inventado — com a DATA da coleta (`datas` + índice
   * por linha; dados.json antigo sem `datas` = sem data). Ordem: em estoque primeiro; preço só se compara POR UNIDADE e
   * entre ofertas de mesma unidade e mesma diluição (100 g não se compara com 20 ml, nem 10% DPG com puro); o resto
   * fica na ordem da coleta. */
  function ofertasDo(cru, material_id) {
    const o = cru && cru.ofertas;
    if (!o || !Array.isArray(o.lojas) || !Array.isArray(o.urls) || !o.por_material) return [];
    const comData = Array.isArray(o.datas);                 // o formato com data: [..., diluicao, data_idx, variante?]
    const linhas = o.por_material[String(material_id)] || [];
    return linhas.map((l, ordem) => {
      const [li, ui, preco_loja, tamanho, estoque, diluicao] = l;
      const data = comData ? o.datas[l[6]] : null;
      const variante = comData ? l[7] : l[6];
      return { loja: o.lojas[li] || '?', url: o.urls[ui] || null, preco: preco_loja, tamanho: tamanho || null,
        estoque: !!estoque, diluicao: diluicao || null, variante: variante || null, coletado_em: dataValida(data) ? data : null,
        por_unidade: precoPorUnidade(preco_loja, tamanho), ordem };
    }).sort((a, b) => {
      if (a.estoque !== b.estoque) return b.estoque - a.estoque;
      const ga = a.por_unidade ? a.por_unidade.unidade + '|' + (a.diluicao || '') : null;
      const gb = b.por_unidade ? b.por_unidade.unidade + '|' + (b.diluicao || '') : null;
      if (ga !== null && ga === gb) return a.por_unidade.valor - b.por_unidade.valor || a.ordem - b.ordem;
      return a.ordem - b.ordem;
    });
  }

  /* O permalink de carrinho Shopify (§1.5.5): `/cart/<variante>:<qtd>`. Só quando a oferta traz a variante — hoje a
   * coleta ainda não traz (pendência), e sem ela o link é o direto da loja. */
  function carrinho(oferta, qtd = QTD_SUGERIDA) {
    if (!oferta || typeof oferta.url !== 'string' || !/^https:\/\//.test(oferta.url)) return null;
    if (oferta.variante && /^\d+$/.test(String(oferta.variante))) {
      try { return new URL(oferta.url).origin + '/cart/' + oferta.variante + ':' + Math.max(1, Math.round(qtd)); } catch { return null; }
    }
    return oferta.url;
  }

  // ------------------------------------------------------------------ mandar imprimir na máquina da rede local (SITE-3)
  /* O app mora em https (Pages) e a máquina fala http na rede local: o navegador BLOQUEIA o fetch https→http (mixed
   * content), mas deixa ABRIR uma página http. Então o app abre a página que a própria máquina serve,
   * http://<ip>/imprimir#f=<pacote>, com a fórmula no FRAGMENTO (que não vai na requisição); lá a página da máquina
   * confere os canais contra o que ela tem, dosa (POST /api/formula) e acompanha. Pacote: software/PROTOCOLO.md. */
  const VERSAO_PACOTE = 1;
  const CHAVE_IP = 'perfume.maquina.ip.v1';

  /* As linhas da pré-checagem (vidro a vidro, o que o motor validou) viram o pacote; o canal é o do mapa escolhido
   * no app, e a página da máquina recusa canal que ela não tem — com a explicação. */
  function pacoteDaMaquina(nome, massa_g, linhas) {
    const itens = linhas.filter(l => l.usar_g > 0)
      .map(l => ({ canal: l.canal, nome: String(l.material), gramas: Math.round(l.usar_g * 10000) / 10000 }));
    if (!itens.length) throw new ErroDeUso('a fórmula não tem nada para dosar');
    return { v: VERSAO_PACOTE, nome: String(nome || 'Fórmula').slice(0, 80), massa_g: Math.round(massa_g * 100) / 100, itens };
  }

  /* base64url de JSON UTF-8 — cabe no fragmento sem escape e volta igual na página da máquina */
  function codificarPacote(pacote) {
    let bin = '';
    for (const b of new TextEncoder().encode(JSON.stringify(pacote))) bin += String.fromCharCode(b);
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  function decodificarPacote(txt) {
    const b64 = String(txt).replace(/-/g, '+').replace(/_/g, '/');
    const bin = atob(b64 + '='.repeat((4 - b64.length % 4) % 4));
    return JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, c => c.charCodeAt(0))));
  }

  /* O endereço da máquina na rede local: IPv4 (com porta opcional), aceitando que colem "http://" ou uma barra no fim. */
  function enderecoDaMaquina(texto) {
    const t = String(texto || '').trim().replace(/^https?:\/\//i, '').replace(/\/.*$/, '');
    const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?::(\d{1,5}))?$/.exec(t);
    if (!m || m.slice(1, 5).some(n => Number(n) > 255) || (m[5] && Number(m[5]) > 65535)) return null;
    return t;
  }
  const urlDaMaquina = endereco => 'http://' + endereco + '/imprimir';
  const urlImprimir = (endereco, pacote) => urlDaMaquina(endereco) + '#f=' + codificarPacote(pacote);

  function ipDaMaquina(lembrar) {
    return {
      ler: () => enderecoDaMaquina(lembrar.ler(CHAVE_IP)),
      gravar(texto) {
        const e = enderecoDaMaquina(texto);
        if (!e) throw new ErroDeUso('IP inválido — use o número que a telinha mostra, ex. 192.168.0.42');
        lembrar.gravar(CHAVE_IP, e);
        return e;
      },
    };
  }

  return {
    VERSAO_PACOTE, CHAVE_IP, pacoteDaMaquina, codificarPacote, decodificarPacote, enderecoDaMaquina, urlDaMaquina, urlImprimir, ipDaMaquina,
    ErroDeUso, FORMATO_ANUNCIO, CHAVE_MARKETPLACE, CHAVE_VINCULOS,
    PRECO_INICIAL_REF, PRECO_POR_ML_REF, ROTULO_PRECO_REF, ML_DA_BASE, SPLIT, TEXTO_SPLIT, TEXTO_GATEWAY, MAX_ITENS,
    LIMIAR_ML, LIMIAR_G, QTD_SUGERIDA, ESTADO_HONESTO,
    preco, splitDo, previa, ehGratis, textoPreco, lerPreco, dataValida, piramideDe, criar, arquivo, doArquivo, marketplace,
    religar, religarItens, importar,
    codigoVinculo, parseVinculo, vinculos, acabando, textoAcabando, ofertasDo, precoPorUnidade, carrinho,
  };
});
