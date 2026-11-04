// Food estimation from a photo and/or a text description, called straight from the phone.
// Providers: Google Gemini (free tier with a free API key) or Anthropic Claude (paid key).
// Both return the same shape: {meal, items:[{name, amount, grams, kcal, protein, carbs, fat}], notes}

const PROMPT = `You are a nutrition estimator. Identify every distinct food and drink in the input.
For each item estimate the portion (a household amount like "1 cup" or "2 slices" plus grams),
calories (kcal), protein, carbs and fat in grams. Use typical recipes for mixed dishes and
include visible oils, sauces and drinks. If the user gives corrections, they override what you
see in the photo. Be realistic, not conservative: photo estimates usually undercount calories.
Give a short meal name. "notes" is one sentence on the biggest uncertainty (or empty).`;

const SCHEMA = {
  type: 'object',
  properties: {
    meal: { type: 'string' },
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          amount: { type: 'string' },
          grams: { type: 'number' },
          kcal: { type: 'number' },
          protein: { type: 'number' },
          carbs: { type: 'number' },
          fat: { type: 'number' },
        },
        required: ['name', 'amount', 'grams', 'kcal', 'protein', 'carbs', 'fat'],
        additionalProperties: false,
      },
    },
    notes: { type: 'string' },
  },
  required: ['meal', 'items', 'notes'],
  additionalProperties: false,
};

// Gemini's responseSchema is an OpenAPI subset without additionalProperties.
function geminiSchema(s) {
  if (Array.isArray(s)) return s.map(geminiSchema);
  if (!s || typeof s !== 'object') return s;
  const out = {};
  for (const [k, v] of Object.entries(s)) {
    if (k === 'additionalProperties') continue;
    out[k] = typeof v === 'object' ? geminiSchema(v) : v;
  }
  return out;
}

function userText(text, previous) {
  let t = '';
  if (previous) t += `Your previous estimate was:\n${JSON.stringify(previous.items.map(({ name, amount, kcal }) => ({ name, amount, kcal })))}\n`;
  if (text) t += `User description / corrections: ${text}\n`;
  return t || 'Estimate the food in this photo.';
}

export function aiReady(settings) {
  const a = settings.ai;
  return (a.provider === 'gemini' && a.geminiKey) || (a.provider === 'claude' && a.claudeKey);
}

export async function estimateFood({ image, text, previous }, settings) {
  const a = settings.ai;
  if (a.provider === 'gemini') return gemini(image, userText(text, previous), a);
  if (a.provider === 'claude') return claude(image, userText(text, previous), a);
  throw new Error('No AI provider set up. Add a key in Settings → AI.');
}

async function gemini(image, text, a) {
  const parts = [];
  if (image) parts.push({ inline_data: { mime_type: image.mime, data: image.base64 } });
  parts.push({ text });
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(a.geminiModel)}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': a.geminiKey },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: PROMPT }] },
      contents: [{ role: 'user', parts }],
      generationConfig: { responseMimeType: 'application/json', responseSchema: geminiSchema(SCHEMA) },
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Gemini ${res.status}: ${body.error?.message || res.statusText}`);
  const txt = body.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('') || '';
  return normalise(JSON.parse(txt));
}

// The Anthropic SDK is loaded on demand from a CDN (this feature needs the network anyway).
const SDK_URL = 'https://esm.sh/@anthropic-ai/sdk@0.136.0';
let sdk;

async function claude(image, text, a) {
  if (!sdk) sdk = (await import(SDK_URL)).default;
  const client = new sdk({ apiKey: a.claudeKey, dangerouslyAllowBrowser: true });
  const content = [];
  if (image) content.push({ type: 'image', source: { type: 'base64', media_type: image.mime, data: image.base64 } });
  content.push({ type: 'text', text });
  const msg = await client.messages.create({
    model: a.claudeModel,
    max_tokens: 4000,
    system: PROMPT,
    messages: [{ role: 'user', content }],
    output_config: { effort: 'low', format: { type: 'json_schema', schema: SCHEMA } },
  });
  if (msg.stop_reason === 'refusal') throw new Error('Claude declined this request.');
  const txt = msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  return normalise(JSON.parse(txt));
}

function normalise(r) {
  const num = (x) => (isFinite(Number(x)) ? Math.round(Number(x) * 10) / 10 : 0);
  return {
    meal: r.meal || 'Meal',
    notes: r.notes || '',
    items: (r.items || []).map((i) => ({
      name: i.name || '?', amount: i.amount || '', grams: num(i.grams),
      kcal: Math.round(num(i.kcal)), protein: num(i.protein), carbs: num(i.carbs), fat: num(i.fat),
    })),
  };
}

// Cheap connectivity check for the Settings screen.
export async function testAI(settings) {
  const r = await estimateFood({ text: 'one medium banana' }, settings);
  return `${r.items[0]?.name}: ${r.items[0]?.kcal} kcal`;
}

export async function listGeminiModels(key) {
  if (!key) throw new Error('Paste a Gemini key first');
  const res = await fetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=200', { headers: { 'x-goog-api-key': key } });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Gemini ${res.status}: ${j.error?.message || res.statusText}`);
  return (j.models || []).filter((m) => (m.supportedGenerationMethods || []).includes('generateContent')).map((m) => m.name.replace(/^models\//, ''));
}
