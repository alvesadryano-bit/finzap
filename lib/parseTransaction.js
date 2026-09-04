/**
 * parseTransaction — núcleo do FinZap.
 * Converte texto livre (mensagem digitada, transcrição de áudio ou OCR de um recibo)
 * em um lançamento financeiro estruturado.
 *
 * Funciona 100% offline e é usado pelos dois lados:
 *   - backend: mensagens vindas do webhook do WhatsApp
 *   - frontend: simulador de chat no navegador
 */

export const CATEGORIAS = [
  { id: 'alimentacao', label: 'Alimentação', emoji: '🍔', cor: '#f97316' },
  { id: 'mercado',     label: 'Mercado',     emoji: '🛒', cor: '#22c55e' },
  { id: 'transporte',  label: 'Transporte',  emoji: '🚗', cor: '#3b82f6' },
  { id: 'moradia',     label: 'Moradia',     emoji: '🏠', cor: '#a855f7' },
  { id: 'saude',       label: 'Saúde',       emoji: '💊', cor: '#ef4444' },
  { id: 'lazer',       label: 'Lazer',       emoji: '🎬', cor: '#ec4899' },
  { id: 'educacao',    label: 'Educação',    emoji: '📚', cor: '#14b8a6' },
  { id: 'assinaturas', label: 'Assinaturas', emoji: '📺', cor: '#6366f1' },
  { id: 'compras',     label: 'Compras',     emoji: '🛍️', cor: '#eab308' },
  { id: 'salario',     label: 'Salário',     emoji: '💼', cor: '#10b981' },
  { id: 'outros',      label: 'Outros',      emoji: '📦', cor: '#94a3b8' },
];

const CATEGORIA_POR_ID = Object.fromEntries(CATEGORIAS.map((c) => [c.id, c]));

/** Palavras-chave -> categoria (ordem importa: primeiro match vence). */
const REGRA_CATEGORIA = [
  ['salario',       /\b(sal[áa]rio|pagamento caiu|13[ºo]|f[ée]rias|b[ôo]nus|comiss[ãa]o|rest(itui|)|reembolso|estorno|dividendo|aluguel recebido)\b/i],
  ['transporte',    /\b(uber|99app|99 ?pop|cabify|t[áa]xi|taxi|gasolina|etanol|[áa]lcool|diesel|combust[íi]vel|posto|estacionamento|ped[áa]gio|passagem|metr[ôo]|[ôo]nibus|onibus|bilhete [úu]nico|vt\b|carro|moto|oficina|pneu|ipva|licenciamento|manuten[çc][ãa]o do carro)\b/i],
  ['mercado',       /\b(mercado|supermercado|hortifr[úu]ti|padaria|a[çc]ougue|sacola?o|feira|carrefour|p[ãa]o de a[çc][úu]car|assai|atacad[ãa]o|atacadao|extra|dia\b|tenda|sams? ?club|quitanda)\b/i],
  ['alimentacao',   /\b(ifood|rapi|restaurante|lanchonete|lanche|pizza|sushi|hamburg|burguer|burger|almo[çc]o|janta|jantar|caf[ée]|barzinho|bar\b|cerveja|bebida|refei[çc][ãa]o|delivery|quentinha|marmita|padoca)\b/i],
  ['moradia',       /\b(aluguel|condom[íi]nio|energia|luz|enel|sabesp|[áa]gua|g[áa]s|gás de cozinha|internet|wifi|wi-fi|vivo|claro|tim\b|oi\b|iptu|faxina|diarista|reforma|m[óo]vel)\b/i],
  ['saude',         /\b(farm[áa]cia|drogaria|rem[ée]dio|medicamento|consulta|m[ée]dic|dentista|exame|plano de sa[úu]de|unimed|amil|hospital|laborat[óo]rio|psic[óo]log|fisio|academia|smart ?fit|personal)\b/i],
  ['lazer',         /\b(cinema|netflix|spotify|disney|hbo|max\b|prime video|show|ingresso|viagem|hotel|airbnb|festa|balada|passeio|parque|game|steam|playstation|xbox|livro)\b/i],
  ['educacao',      /\b(curso|faculdade|mensalidade escolar|escola|apostila|udemy|alura|livro did[áa]tico|material escolar|ingl[êe]s|p[óo]s[- ]gradua[çc][ãa]o)\b/i],
  ['assinaturas',   /\b(assinatura|mensalidade|anuidade|plano mensal|renova[çc][ãa]o (do|de) plano)\b/i],
  ['compras',       /\b(shopping|loja|amazon|mercado ?livre|magalu|magazine|shopee|aliexpress|shein|roupa|t[êe]nis|sapato|presente|eletronico|celular|iphone|notebook)\b/i],
];

/** Verbos/termos que indicam ENTRADA de dinheiro. */
const REGRA_ENTRADA = /\b(recebi|caiu|entrou|ganh(ei|o)|vendi|venda|reembolso|estorno|devolu[çc][ãa]o|sal[áa]rio|pagamento caiu|pix recebido|deposito|dep[óo]sito|rendimento|juros recebido|aluguel recebido|freela(n|nce)? recebido|adiantamento)\b/i;

/** Termos que reforçam SAÍDA (têm prioridade menor que REGRA_ENTRADA). */
const REGRA_SAIDA = /\b(gastei|paguei|paguei |comprei|compra|pix|d[ée]bito|cart[ãa]o|boleto|conta|fatura|transferi|enviei|mandei|paguei a|quitei|abasteci|recarga)\b/i;

const REGRA_TRANSFERENCIA = /\b(pix|ted|doc\b|transfer[êe]ncia|transferi)\b/i;

/* ------------------------------------------------------------------ */
/* Normalização de texto                                               */
/* ------------------------------------------------------------------ */

export function normalizar(texto) {
  return String(texto || '')
    .replace(/\r/g, ' ')
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

/**
 * Tenta descobrir um valor monetário no texto.
 * Cobre: "R$ 1.234,56", "45,90", "45.90", "45", "3 mil", "2k", "1,5k", "12 reais".
 * Retorna null quando não há número plausível.
 */
export function extrairValor(texto) {
  let t = normalizar(texto);
  if (!t) return null;

  // remove datas e horas para não confundir "05/09" ou "18:30" com valor
  // (só "/" e "-" contam como data: "45.90" é valor, não 45 de setembro)
  t = t.replace(/\b\d{1,2}[\/\-]\d{1,2}([\/\-]\d{2,4})?\b/g, ' ');
  t = t.replace(/\b\d{1,2}:\d{2}(:\d{2})?\b/g, ' ');

  // números por extenso (comum em transcrição de áudio: "trinta e cinco reais")
  t = ' ' + substituirNumerosPorExtenso(t) + ' ';

  // "2k" / "1,5k" / "2.5k" / "3 mil" / "1,2 mil"
  const kMatch = t.match(/(\d{1,3}(?:[.,]\d{1,2})?)\s*(k\b|mil\b)/i);
  if (kMatch) {
    const base = parseFloat(kMatch[1].replace(',', '.'));
    if (!Number.isNaN(base)) return Math.round(base * 1000 * 100) / 100;
  }

  // remove CNPJ, CPF e telefones: viram "valores" falsos em OCR de nota fiscal
  t = t.replace(/\b\d{2}[.\s]?\d{3}[.\s]?\d{3}[\/\s]?\d{4}[-\s]?\d{2}\b/g, ' '); // CNPJ
  t = t.replace(/\b\d{3}[.\s]?\d{3}[.\s]?\d{3}[-\s]?\d{2}\b/g, ' ');              // CPF
  t = t.replace(/\b\(?0?\d{2}\)?[\s.-]?9?\d{4}[\s.-]?\d{4}\b/g, ' ');            // telefone

  // em recibo/nota, a linha "TOTAL" manda: usa ela e descarta o resto
  const linhaTotal = t.match(/(?:^|[\n;|])\s*(?:valor\s+)?(?:total(?:\s+(?:a\s+pagar|geral|da\s+nota|r\$))?|subtotal|total\s+liquido)\s*:?\s*(?:r\$\s*)?(\d[\d.,]*)/i);

  const candidatos = [];
  if (linhaTotal) candidatos.push(linhaTotal[1]);

  // 1) "R$ 1.234,56" / "R$1234" / "BRL 50"
  const reSimbolo = /(?:r\s?\$|brl)\s*(\d{1,3}(?:\.\d{3})+(?:,\d{1,2})?|\d+(?:[.,]\d{1,2})?)/gi;
  for (const m of t.matchAll(reSimbolo)) candidatos.push(m[1]);

  // 2) número seguido de "reais"/"conto(s)"/"pila"
  const rePalavra = /(\d{1,3}(?:\.\d{3})*(?:,\d{1,2})?)\s*(?:reais|real|conto|contos|pila)\b/gi;
  for (const m of t.matchAll(rePalavra)) candidatos.push(m[1]);

  // 3) qualquer número solto
  //    ordem importa: decimal ("45.90") tem que ser testado antes do inteiro ("45")
  const reSolto = /\b(\d{1,3}(?:\.\d{3})+,\d{1,2}|\d{1,3}(?:\.\d{3})+|\d+[.,]\d{1,2}|\d+)\b/g;
  for (const m of t.matchAll(reSolto)) candidatos.push(m[1]);

  for (const bruto of candidatos) {
    const v = parseNumeroBR(bruto);
    if (v != null && v > 0 && v < 100_000_000) return Math.round(v * 100) / 100;
  }
  return null;
}

/** Converte "1.234,56" -> 1234.56 ; "1234.56" -> 1234.56 ; "1.000" -> 1000 */
export function parseNumeroBR(bruto) {
  const s = String(bruto).trim();
  if (!s) return null;
  const temVirgula = s.includes(',');
  const temPonto = s.includes('.');

  if (temVirgula && temPonto) {
    // padrão brasileiro: ponto = milhar, vírgula = decimal
    return parseFloat(s.replace(/\./g, '').replace(',', '.'));
  }
  if (temVirgula) return parseFloat(s.replace(',', '.'));
  if (temPonto) {
    const decimais = s.split('.')[1] || '';
    // "1.234" com 3 dígitos decimais = milhar; "45.90" = decimal
    if (decimais.length === 3) return parseFloat(s.replace(/\./g, ''));
    return parseFloat(s);
  }
  const n = parseInt(s, 10);
  return Number.isNaN(n) ? null : n;
}

/* ------------------------------------------------------------------ */
/* Números por extenso (transcrições de áudio: "trinta e cinco reais")  */
/* ------------------------------------------------------------------ */

const UNIDADES_EXT = {
  um: 1, uma: 1, dois: 2, duas: 2, tres: 3, três: 3, quatro: 4, cinco: 5, seis: 6,
  sete: 7, oito: 8, nove: 9, dez: 10, onze: 11, doze: 12, treze: 13, catorze: 14,
  quatorze: 14, quinze: 15, dezesseis: 16, dezessete: 17, dezoito: 18, dezenove: 19,
};
const DEZENAS_EXT = {
  vinte: 20, trinta: 30, quarenta: 40, cinquenta: 50, sessenta: 60, setenta: 70,
  oitenta: 80, noventa: 90,
};
const CENTENAS_EXT = {
  cem: 100, cento: 100, duzentos: 200, trezentos: 300, quatrocentos: 400,
  quinhentos: 500, seiscentos: 600, setecentos: 700, oitocentos: 800, novecentos: 900,
};

/** Converte "trinta e cinco reais" -> "35 reais" (apenas quando não há algarismos na frase). */
export function substituirNumerosPorExtenso(texto) {
  const t = String(texto || '').toLowerCase();
  if (/\d/.test(t)) return t; // já tem algarismo: não mexe

  const palavras = t.split(/\s+/);
  const numeros = [];
  let atual = 0;
  let acumulou = false;

  for (const p of palavras) {
    const limpa = p.replace(/[^\p{L}]/gu, '');
    // "e"/"de" ligam as partes do número ("trinta e cinco"), não interrompem
    if (limpa === 'e' || limpa === 'de') continue;
    if (limpa in UNIDADES_EXT) { atual += UNIDADES_EXT[limpa]; acumulou = true; }
    else if (limpa in DEZENAS_EXT) { atual += DEZENAS_EXT[limpa]; acumulou = true; }
    else if (limpa in CENTENAS_EXT) { atual += CENTENAS_EXT[limpa]; acumulou = true; }
    else if (limpa === 'mil') { atual = (atual || 1) * 1000; acumulou = true; }
    else if (acumulou) { numeros.push(atual); atual = 0; acumulou = false; }
  }
  if (acumulou) numeros.push(atual);
  if (!numeros.length) return t;

  // mantém só o maior (o total costuma ser o último/maior da frase)
  const melhor = Math.max(...numeros);
  return `${t} ${melhor}`;
}

/* ------------------------------------------------------------------ */
/* Data                                                                */
/* ------------------------------------------------------------------ */

const DIAS_SEMANA = { dom: 0, domingo: 0, seg: 1, segunda: 1, ter: 2, terca: 2, qua: 3, quarta: 3, qui: 4, quinta: 4, sex: 5, sexta: 5, sab: 6, sabado: 6 };
const MESES = {
  janeiro: 0, jan: 0, fevereiro: 1, fev: 1, marco: 2, mar: 2, abril: 3, abr: 3,
  maio: 4, mai: 4, junho: 5, jun: 5, julho: 6, jul: 6, agosto: 7, ago: 7,
  setembro: 8, set: 8, outubro: 9, out: 9, novembro: 10, nov: 10, dezembro: 11, dez: 11,
};

/** Extrai uma data explícita ("ontem", "segunda", "05/09", "3 de agosto"). Senão, hoje. */
export function extrairData(texto, agora = new Date()) {
  const t = ' ' + normalizar(texto).toLowerCase() + ' ';
  const hoje = new Date(agora.getFullYear(), agora.getMonth(), agora.getDate());

  if (/\b(ontem)\b/.test(t)) return deslocarDias(hoje, -1);
  if (/\b(anteontem|antes de ontem)\b/.test(t)) return deslocarDias(hoje, -2);
  if (/\b(ante-?passado)\b/.test(t)) return deslocarDias(hoje, -7);
  if (/\b(hoje|agora|neste momento)\b/.test(t)) return hoje;

  // "05/09", "05-09-2026", "5.9"
  const dmy = t.match(/\b(\d{1,2})[\/.\-](\d{1,2})(?:[\/.\-](\d{2,4}))?\b/);
  if (dmy) {
    const dia = +dmy[1];
    const mes = +dmy[2] - 1;
    let ano = dmy[3] ? +dmy[3] : hoje.getFullYear();
    if (ano < 100) ano += 2000;
    if (dia >= 1 && dia <= 31 && mes >= 0 && mes <= 11) {
      const d = new Date(ano, mes, dia);
      // sem ano explícito: só assume o ano anterior se a data ficar muito no futuro
      // (gente anota gasto de hoje/ontem, não de daqui a meses)
      if (!dmy[3] && d.getTime() - hoje.getTime() > 30 * 864e5) d.setFullYear(d.getFullYear() - 1);
      return d;
    }
  }

  // "3 de agosto" / "3 de março"
  const porExtenso = t.match(/\b(\d{1,2})\s+de\s+([a-zç]+)\b/);
  if (porExtenso) {
    const mesNorm = porExtenso[2].normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/c/g, 'c');
    if (MESES[mesNorm] != null) {
      const d = new Date(hoje.getFullYear(), MESES[mesNorm], +porExtenso[1]);
      if (d.getTime() - hoje.getTime() > 30 * 864e5) d.setFullYear(d.getFullYear() - 1);
      return d;
    }
  }

  // "na segunda", "terça-feira" -> ocorrência mais recente
  const semana = t.match(/\b(?:na|no|nesta|nesse|nessa)?\s*(domingo|segunda|ter[çc]a|quarta|quinta|sexta|s[áa]bado)(?:-feira)?\b/);
  if (semana) {
    const chave = semana[1]
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/terca/, 'ter');
    const alvo = DIAS_SEMANA[chave];
    if (alvo != null) {
      const diff = (hoje.getDay() - alvo + 7) % 7 || 7;
      return deslocarDias(hoje, -diff);
    }
  }
  return hoje;
}

function deslocarDias(base, n) {
  const d = new Date(base);
  d.setDate(d.getDate() + n);
  return d;
}

/* ------------------------------------------------------------------ */
/* Categoria / descrição                                               */
/* ------------------------------------------------------------------ */

export function detectarCategoria(texto) {
  const t = normalizar(texto);
  for (const [id, regex] of REGRA_CATEGORIA) {
    if (regex.test(t)) return id;
  }
  return REGRA_ENTRADA.test(t) ? 'salario' : 'outros';
}

/** Extrai um "comerciante"/local depois de "no/na/em" (ex.: "no uber", "na farmácia"). */
export function detectarDescricao(texto) {
  const t = normalizar(texto);
  const m = t.match(/\b(?:no|na|nos|nas|em|pra|pro)\s+([a-zà-ú0-9&'.-]{2,25}(?:\s+[a-zà-ú0-9&'.-]{2,20})?)/i);
  if (!m) return null;
  const frase = m[1].trim().replace(/[.,!?;:]+$/, '');
  // ignora palavras que são só forma de pagamento ou marcadores genéricos
  if (/^(cart[ãa]o|boleto|dinheiro|pix|d[ée]bito|cr[ée]dito|total|valor|fim|dia|m[êe]s|come[çc]o|casa|trabalho|rua|conta|fatura|nome)/i.test(frase)) return null;
  return frase.toLowerCase();
}

function detectarParcelas(texto) {
  const t = normalizar(texto);
  let m = t.match(/\b(?:em\s+)?(\d{1,2})\s*(?:x|vezes)\s*(?:de\s*)?(\d{1,3}(?:\.\d{3})*(?:,\d{1,2})?|\d+(?:[.,]\d{1,2})?)/i);
  if (m) {
    const total = parseNumeroBR(m[2]);
    return total ? { parcelas: +m[1], valorParcela: total } : null;
  }
  m = t.match(/\bparcela\s+(\d{1,2})\s*(?:de|\/)\s*(\d{1,2})/i);
  if (m) return { parcelaAtual: +m[1], parcelas: +m[2] };
  return null;
}

/* ------------------------------------------------------------------ */
/* Parser principal                                                    */
/* ------------------------------------------------------------------ */

/**
 * @param {string} texto  Texto livre (mensagem, transcrição ou OCR)
 * @param {{agora?: Date, fonte?: string, autor?: string}} [opts]
 * @returns {{ok: boolean, motivo?: string, transacao?: object, texto: string}}
 */
export function parseTransaction(texto, opts = {}) {
  const agora = opts.agora || new Date();
  const bruto = normalizar(texto);
  const baixo = bruto.toLowerCase();

  const base = {
    fonte: opts.fonte || 'texto',
    autor: opts.autor || 'eu',
    criadoEm: agora.toISOString(),
    textoOriginal: bruto,
  };

  if (!bruto) return { ok: false, motivo: 'vazio', texto: bruto };

  if (/^(oi|ol[áa]|oi tudo bem|bom dia|boa tarde|boa noite|menu|ajuda|help|\?)$/.test(baixo)) {
    return { ok: false, motivo: 'saudacao', texto: bruto };
  }
  if (/\b(quanto (gastei|gastamos|tenho)|meu saldo|resumo|extrato|relat[óo]rio|quanto sobrou|quanto entrou)\b/.test(baixo)) {
    return { ok: false, motivo: 'consulta', texto: bruto };
  }
  if (/\b(desfa(?:z|ç|c)|desfazer|apagar|apaga|cancelar|cancela|remover|remove|excluir|exclui|err(?:o|ado)|anula|estorna o [uú]ltimo|tira o [uú]ltimo|[uú]ltimo lan[çc]amento)\b/.test(baixo)) {
    return { ok: false, motivo: 'desfazer', texto: bruto };
  }

  const valor = extrairValor(bruto);
  if (valor == null) return { ok: false, motivo: 'sem_valor', texto: bruto };

  // "10x de 50" -> total 500
  const parcelas = detectarParcelas(bruto);
  let total = valor;
  if (parcelas && parcelas.parcelas && parcelas.valorParcela) total = Math.round(parcelas.parcelas * parcelas.valorParcela * 100) / 100;

  const entrada = REGRA_ENTRADA.test(bruto);
  const tipo = entrada ? 'entrada' : 'saida';
  const data = extrairData(bruto, agora);
  const descricao = detectarDescricao(bruto);
  const categoria = detectarCategoria(bruto);

  const transacao = {
    id: opts.id || `t_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
    valor: total,
    tipo,
    categoria,
    data: dataISO(data),
    descricao: descricao || CATEGORIA_POR_ID[categoria]?.label || 'Lançamento',
    forma: REGRA_TRANSFERENCIA.test(bruto) ? 'pix' : /\bcart[ãa]o\b/i.test(bruto) ? 'cartao' : /\bboleto\b/i.test(bruto) ? 'boleto' : 'outro',
    parcelas: parcelas?.parcelas || null,
    fonte: base.fonte,
    textoOriginal: bruto,
    criadoEm: base.criadoEm,
    autor: base.autor,
  };

  return { ok: true, transacao, texto: bruto, confianca: entrada || REGRA_SAIDA.test(bruto) ? 'alta' : 'media' };
}

export function dataISO(d) {
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dia = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${dia}`;
}

export function formatarBRL(v) {
  return (v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

export function formatarDataCurta(iso) {
  const [a, m, d] = iso.split('-').map(Number);
  return `${String(d).padStart(2, '0')}/${String(m).padStart(2, '0')}`;
}

/** Mensagem de confirmação que o bot devolve no WhatsApp. */
export function montarResposta(resultado, resumo) {
  if (!resultado.ok) return respostaDeErro(resultado, resumo);
  const t = resultado.transacao;
  const cat = CATEGORIA_POR_ID[t.categoria];
  const sinal = t.tipo === 'saida' ? '-' : '+';
  const linhas = [
    `${t.tipo === 'saida' ? '💸' : '💰'} *${t.tipo === 'saida' ? 'Gasto' : 'Entrada'} registrado*`,
    `${sinal} ${formatarBRL(t.valor)} — ${cat.emoji} ${cat.label}`,
    `🗓 ${formatarDataCurta(t.data)}${t.parcelas ? ` · ${t.parcelas}x de ${formatarBRL(t.valor / t.parcelas)}` : ''}`,
  ];
  if (t.textoOriginal && t.fonte !== 'texto') linhas.push(`_“${cortar(t.textoOriginal, 90)}”_`);
  if (resumo) {
    linhas.push('');
    linhas.push(`📊 *${resumo.mesLabel}*`);
    linhas.push(`Saídas: ${formatarBRL(resumo.saidas)} · Entradas: ${formatarBRL(resumo.entradas)}`);
    linhas.push(`Saldo do mês: *${formatarBRL(resumo.saldo)}*`);
    if (resumo.orcamento) {
      const pct = Math.round((resumo.saidas / resumo.orcamento) * 100);
      linhas.push(`Orçamento: ${barra(pct)} ${pct}% de ${formatarBRL(resumo.orcamento)}`);
    }
  }
  return linhas.join('\n');
}

function respostaDeErro(resultado, resumo) {
  const base = [];
  if (resultado.motivo === 'consulta' && resumo) {
    base.push(`📊 *${resumo.mesLabel}*`);
    base.push(`Saídas: ${formatarBRL(resumo.saidas)}`);
    base.push(`Entradas: ${formatarBRL(resumo.entradas)}`);
    base.push(`Saldo: *${formatarBRL(resumo.saldo)}*`);
    if (resumo.top?.length) {
      base.push('');
      base.push('*Maiores categorias*');
      resumo.top.forEach(([label, v]) => base.push(`${label}: ${formatarBRL(v)}`));
    }
    return base.join('\n');
  }
  if (resultado.motivo === 'desfazer') {
    return '🗑 Qual lançamento você quer apagar? Responda com o número (ex.: `apagar 2`) ou mande “último”.';
  }
  if (resultado.motivo === 'saudacao') {
    return [
      '👋 Oi! Sou o *FinZap*.',
      'Manda assim que eu registro:',
      '• “gastei 45 no uber”',
      '• “mercado 320,90”',
      '• 🎤 um áudio contando o gasto',
      '• 📷 a foto da nota/recibo',
      '',
      'E pergunte “quanto gastei?” quando quiser.',
    ].join('\n');
  }
  return '🤔 Não achei um valor nessa mensagem. Tenta algo como “paguei 32,90 no ifood” ou manda a foto do recibo.';
}

function barra(pct) {
  const cheio = Math.max(0, Math.min(10, Math.round(pct / 10)));
  return '▰'.repeat(cheio) + '▱'.repeat(10 - cheio);
}

function cortar(s, n) {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

/** Resumo do mês corrente, usado nas respostas do bot e no dashboard. */
export function resumirMes(transacoes, { agora = new Date(), orcamento = 0 } = {}) {
  const chave = `${agora.getFullYear()}-${String(agora.getMonth() + 1).padStart(2, '0')}`;
  const doMes = transacoes.filter((t) => t.data.startsWith(chave));
  const saidas = doMes.filter((t) => t.tipo === 'saida').reduce((s, t) => s + t.valor, 0);
  const entradas = doMes.filter((t) => t.tipo === 'entrada').reduce((s, t) => s + t.valor, 0);
  const porCategoria = {};
  for (const t of doMes.filter((x) => x.tipo === 'saida')) {
    porCategoria[t.categoria] = (porCategoria[t.categoria] || 0) + t.valor;
  }
  const top = Object.entries(porCategoria)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([id, v]) => [`${CATEGORIA_POR_ID[id]?.emoji || ''} ${CATEGORIA_POR_ID[id]?.label || id}`, v]);

  return {
    mesLabel: agora.toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' }).replace(/^./, (c) => c.toUpperCase()),
    mesChave: chave,
    saidas: Math.round(saidas * 100) / 100,
    entradas: Math.round(entradas * 100) / 100,
    saldo: Math.round((entradas - saidas) * 100) / 100,
    porCategoria,
    top,
    orcamento,
    quantidade: doMes.length,
  };
}

export { CATEGORIA_POR_ID };
