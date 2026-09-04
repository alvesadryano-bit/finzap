/**
 * Provedores de IA — plugáveis via variáveis de ambiente.
 *
 *   AI_PROVIDER=openai  OPENAI_API_KEY=sk-...
 *   AI_PROVIDER=gemini  GEMINI_API_KEY=...
 *   (sem nada)          -> provider "mock", devolve transcrições de demonstração
 *
 * Duas tarefas:
 *   transcreverAudio(buffer, mimeType) -> string
 *   lerRecibo(buffer, mimeType)        -> string  (texto extraído da imagem)
 */

const PROVIDER = (process.env.AI_PROVIDER || 'mock').toLowerCase();

/* ------------------------------------------------------------------ */
/* Mock (usado na demo e nos testes — não precisa de chave)             */
/* ------------------------------------------------------------------ */

const AUDIO_DEMO = [
  'Oi, acabei de gastar trinta e cinco reais no mercado, pode anotar aí.',
  'Paguei cento e vinte reais de combustível hoje no posto.',
  'Recebi o salário, três mil e quinhentos reais.',
  'Gastei quarenta e cinco no uber agora há pouco.',
];

const RECEIPT_DEMO = [
  'SUPERMERCADO PAO DE ACUCAR\nCNPJ 12.345.678/0001-90\nARROZ 5KG 28,90\nFEIJAO 1KG 9,50\nCARNE 2KG 78,40\nSUBTOTAL 274,50\nTOTAL 274,50\nCARTAO DEBITO VISA 274,50',
  'IFOOD * RESTAURANTE SABOR\nSUBTOTAL 42,90\nENTREGA 7,99\nTOTAL 50,89\nPAGAMENTO PIX 50,89',
  'FARMACIA DROGA RAIA\nITEM 1 34,90\nTOTAL 34,90\nCARTAO CREDITO 34,90',
];

let mockIdx = 0;
const mock = {
  nome: 'mock',
  async transcreverAudio() {
    const t = AUDIO_DEMO[mockIdx % AUDIO_DEMO.length];
    mockIdx += 1;
    return t;
  },
  async lerRecibo() {
    return RECEIPT_DEMO[0];
  },
};

/* ------------------------------------------------------------------ */
/* OpenAI: Whisper para áudio, GPT-4o para imagem                       */
/* ------------------------------------------------------------------ */

const openai = {
  nome: 'openai',
  async transcreverAudio(buffer, mimeType = 'audio/ogg') {
    const form = new FormData();
    const ext = mimeType.includes('mpeg') ? 'mp3' : mimeType.includes('wav') ? 'wav' : mimeType.includes('mp4') || mimeType.includes('aac') ? 'm4a' : 'ogg';
    form.append('file', new Blob([buffer], { type: mimeType }), `audio.${ext}`);
    form.append('model', process.env.OPENAI_AUDIO_MODEL || 'whisper-1');
    form.append('language', 'pt');
    const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
      body: form,
    });
    if (!res.ok) throw new Error(`OpenAI ${res.status}: ${await res.text()}`);
    return (await res.json()).text;
  },
  async lerRecibo(buffer, mimeType = 'image/jpeg') {
    const b64 = buffer.toString('base64');
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
      body: JSON.stringify({
        model: process.env.OPENAI_VISION_MODEL || 'gpt-4o-mini',
        messages: [
          { role: 'system', content: 'Você extrai dados de notas fiscais e comprovantes. Responda APENAS com uma linha: "TOTAL <valor>" seguida de "ESTABELECIMENTO <nome>" e as formas de pagamento. Sem comentários.' },
          { role: 'user', content: [
            { type: 'text', text: 'Extraia o total pago, o nome do estabelecimento e a forma de pagamento desta imagem.' },
            { type: 'image_url', image_url: { url: `data:${mimeType};base64,${b64}` } },
          ] },
        ],
        max_tokens: 200,
      }),
    });
    if (!res.ok) throw new Error(`OpenAI ${res.status}: ${await res.text()}`);
    const j = await res.json();
    return j.choices?.[0]?.message?.content || '';
  },
};

/* ------------------------------------------------------------------ */
/* Google Gemini: áudio e imagem no mesmo endpoint                      */
/* ------------------------------------------------------------------ */

const gemini = {
  nome: 'gemini',
  modelo: () => process.env.GEMINI_MODEL || 'gemini-2.0-flash',
  async _inline(buffer, mimeType, prompt) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.modelo()}:generateContent?key=${process.env.GEMINI_API_KEY}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [
          { text: prompt },
          { inline_data: { mime_type: mimeType, data: buffer.toString('base64') } },
        ] }],
      }),
    });
    if (!res.ok) throw new Error(`Gemini ${res.status}: ${await res.text()}`);
    const j = await res.json();
    return j.candidates?.[0]?.content?.parts?.map((p) => p.text).join('\n') || '';
  },
  transcreverAudio(buffer, mimeType = 'audio/ogg') {
    return this._inline(buffer, mimeType, 'Transcreva este áudio em português brasileiro. Responda apenas com a transcrição, sem comentários.');
  },
  lerRecibo(buffer, mimeType = 'image/jpeg') {
    return this._inline(buffer, mimeType, 'Extraia desta nota/comprovante: "TOTAL <valor>", "ESTABELECIMENTO <nome>" e a forma de pagamento. Sem comentários.');
  },
};

/* ------------------------------------------------------------------ */

export function getProvider() {
  if (PROVIDER === 'openai') {
    if (!process.env.OPENAI_API_KEY) throw new Error('AI_PROVIDER=openai exige OPENAI_API_KEY');
    return openai;
  }
  if (PROVIDER === 'gemini') {
    if (!process.env.GEMINI_API_KEY) throw new Error('AI_PROVIDER=gemini exige GEMINI_API_KEY');
    return gemini;
  }
  return mock;
}

export async function transcreverAudio(buffer, mimeType) {
  return (await getProvider().transcreverAudio(buffer, mimeType)).trim();
}

export async function lerRecibo(buffer, mimeType) {
  return (await getProvider().lerRecibo(buffer, mimeType)).trim();
}

export function providerInfo() {
  const p = getProvider();
  return { nome: p.nome, mock: p.nome === 'mock' };
}
