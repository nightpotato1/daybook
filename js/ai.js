// Food estimation from a photo and/or a text description, called straight from the phone with plain fetch.
// Providers: Google Gemini (free key, default) or Anthropic Claude (paid key). No SDK, no third-party code.
// Both return {meal, items:[{name, amount, grams, kcal, protein, carbs, fat}], notes, kcal_low, kcal_high,
// assumed:[{name, kcal}], questions:[string]}. Every error thrown is a one-line message for the user.
import { getMeta, setMeta } from './db.js';
import { saveSettings } from './metrics.js';

const TIMEOUT_MS = 45000;
export const GEMINI_DAILY_LIMIT = 20; // third-party figure for the free tier; AI Studio shows the real one

const PROMPT = `You are a nutrition estimator. Identify every distinct food and drink in the input.
For each item estimate the portion (a household amount like "1 cup" or "2 slices" plus grams),
calories (kcal), protein, carbs and fat in grams. Use typical recipes for mixed dishes and
include cooking oil, ghee, butter, sauces, dressings, sugar in drinks and other hidden calories
that are usually present even when not visible. Be realistic, not conservative: photo estimates
usually undercount calories.
Give a short meal name. "notes" is one sentence on the biggest uncertainty (or empty).
"kcal_low" and "kcal_high" are a plausible range for the whole meal's calories (the items' total
should sit inside it). "assumed" lists hidden ingredients you added or deliberately left out
(for example cooking oil, butter on toast, sugar in tea) with the kcal you gave each, empty if none.
"questions" is at most 2 short yes/no questions whose answers would change the estimate most,
empty if nothing matters.
If a previous estimate and corrections are given, the previous list is the current truth (the user
may have edited it). Apply the corrections, newest last, and return the FULL corrected item list.
Keep every item the corrections do not mention identical (same name, amount, grams and numbers).`;

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
    kcal_low: { type: 'number' },
    kcal_high: { type: 'number' },
    assumed: {
      type: 'array',
      items: {
        type: 'object',
        properties: { name: { type: 'string' }, kcal: { type: 'number' } },
        required: ['name', 'kcal'],
        additionalProperties: false,
      },
    },
    questions: { type: 'array', items: { type: 'string' } },
  },
  required: ['meal', 'items', 'notes', 'kcal_low', 'kcal_high', 'assumed', 'questions'],
  additionalProperties: false,
};

// Gemini's responseSchema is an OpenAPI subset: no additionalProperties, no min/max keywords.
const GEMINI_DROP = new Set(['additionalProperties', 'minimum', 'maximum', 'minItems', 'maxItems', 'minLength', 'maxLength']);
function geminiSchema(s) {
  if (Array.isArray(s)) return s.map(geminiSchema);
  if (!s || typeof s !== 'object') return s;
  const out = {};
  for (const [k, v] of Object.entries(s)) {
    if (GEMINI_DROP.has(k)) continue;
    out[k] = typeof v === 'object' ? geminiSchema(v) : v;
  }
  return out;
}

function systemPrompt(a) {
  const ctx = (a.foodContext || '').trim();
  return ctx ? `${PROMPT}\n\nThe user's usual foods, cuisine and measures (use these to interpret names and portions):\n${ctx}` : PROMPT;
}

function userText(text, previous, corrections) {
  const parts = [];
  if (previous && previous.length) {
    const prev = previous.map(({ name, amount, grams, kcal, protein, carbs, fat }) => ({ name, amount, grams, kcal, protein, carbs, fat }));
    parts.push(`Previous estimate (current truth, possibly edited by the user):\n${JSON.stringify(prev)}`);
  }
  const all = (corrections || []).filter(Boolean);
  if (all.length) parts.push(`Corrections, oldest first:\n${all.map((c, i) => `${i + 1}. ${c}`).join('\n')}`);
  else if (text) parts.push(`User description: ${text}`);
  if (previous && previous.length) parts.push('Return the full corrected item list.');
  return parts.join('\n\n') || 'Estimate the food in this photo.';
}

export function aiReady(settings) {
  const a = settings.ai || {};
  return !!((a.provider === 'gemini' && a.geminiKey) || (a.provider === 'claude' && a.claudeKey));
}

// corrections: every correction text so far, the newest last (text is used only when corrections is empty).
// signal: optional AbortSignal from the UI (Cancel button); the 45 s timeout is always applied.
export async function estimateFood({ image, text, previous, corrections, signal }, settings) {
  const a = settings.ai || {};
  const prompt = userText(text, previous, corrections);
  if (a.provider === 'gemini') {
    if (!a.geminiKey) throw new Error('No Gemini key. Get a free one at aistudio.google.com/apikey and paste it in Settings → AI.');
    return gemini(image, prompt, a, settings, signal);
  }
  if (a.provider === 'claude') {
    if (!a.claudeKey) throw new Error('No Claude key. Paste one in Settings → AI.');
    return claude(image, prompt, a, signal);
  }
  throw new Error('AI is off. Add a free Gemini key in Settings → AI, or type the numbers yourself.');
}

function withTimeout(signal) {
  const t = AbortSignal.timeout(TIMEOUT_MS);
  if (!signal) return t;
  return typeof AbortSignal.any === 'function' ? AbortSignal.any([signal, t]) : t;
}

function fetchError(e) {
  if (e && (e.name === 'TimeoutError' || e.name === 'AbortError')) {
    return new Error(e.name === 'TimeoutError' ? 'Timed out after 45 s. Check your signal and tap Estimate to retry.' : 'Cancelled.');
  }
  if (e instanceof TypeError) return new Error('No connection. Try again when you are online.');
  return e;
}

// ---------- call counter (Gemini only, per America/Los_Angeles day because that is when the free quota resets) ----------

let callsCache = null;

function pacificDay() {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  } catch { return new Date().toISOString().slice(0, 10); }
}

async function loadCalls() {
  if (!callsCache) callsCache = (await getMeta('aiCalls', null)) || { day: '', n: 0 };
  if (callsCache.day !== pacificDay()) callsCache = { day: pacificDay(), n: 0 };
  return callsCache;
}

async function countCall() {
  const c = await loadCalls();
  c.n += 1;
  await setMeta('aiCalls', { day: c.day, n: c.n });
}

export async function aiCallsToday() {
  return (await loadCalls()).n;
}

// ---------- Gemini ----------

const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta';

async function gemini(image, text, a, settings, signal, retried = false) {
  const parts = [];
  if (image) parts.push({ inline_data: { mime_type: image.mime, data: image.base64 } });
  parts.push({ text });
  let res;
  try {
    res = await fetch(`${GEMINI_BASE}/models/${encodeURIComponent(a.geminiModel)}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': a.geminiKey },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemPrompt(a) }] },
        contents: [{ role: 'user', parts }],
        generationConfig: { responseMimeType: 'application/json', responseSchema: geminiSchema(SCHEMA) },
      }),
      signal: withTimeout(signal),
    });
  } catch (e) { throw fetchError(e); }
  const body = await res.json().catch(() => ({}));
  if (res.ok) await countCall(); // only answered requests use quota
  if (!res.ok) {
    const msg = body.error?.message || res.statusText || '';
    const status = body.error?.status || '';
    if (res.status === 429) throw new Error('Free Gemini limit reached for today (resets midnight Pacific). Type the numbers or add a past food.');
    // a retired model id answers 404 (or 400 naming the model); other 400s must not change the setting
    if (res.status === 404 || (res.status === 400 && /model/i.test(msg))) {
      if (retried) throw new Error(`Model ${a.geminiModel} is not available. Pick another in Settings → AI.`);
      const picked = await pickGeminiModel(a.geminiKey).catch(() => null);
      if (!picked) throw new Error(`Model ${a.geminiModel} was retired and no replacement was found. Pick a model in Settings → AI.`);
      const old = a.geminiModel;
      a.geminiModel = picked;
      settings.ai = a;
      await saveSettings(settings);
      const r = await gemini(image, text, a, settings, signal, true);
      r.notice = `Model ${old} is gone; switched to ${picked} (saved in Settings).`;
      return r;
    }
    if (res.status === 400 && /api key|API_KEY/i.test(msg + status)) throw new Error('Gemini key rejected. Check it in Settings → AI.');
    if (res.status === 401 || res.status === 403) throw new Error('Gemini key rejected or not allowed. Check it in Settings → AI.');
    if (res.status >= 500) throw new Error(`Gemini is having trouble (HTTP ${res.status}). Try again in a minute.`);
    throw new Error(`Gemini refused the request (HTTP ${res.status}): ${oneLine(msg)}`);
  }
  const block = body.promptFeedback?.blockReason;
  if (block) throw new Error(`Gemini blocked this photo (${block}). Try a clearer photo or describe the food instead.`);
  const cand = body.candidates?.[0];
  const finish = cand?.finishReason;
  if (finish && finish !== 'STOP') {
    if (finish === 'MAX_TOKENS') throw new Error('Gemini ran out of room before finishing. Try fewer items or a shorter description.');
    throw new Error(`Gemini stopped early (${finish}). Try again or describe the food instead.`);
  }
  // thinking models may return reasoning parts flagged thought:true before the answer
  const txt = (cand?.content?.parts || []).filter((p) => !p.thought).map((p) => p.text || '').join('');
  return normalise(parseJSON(txt), 'gemini', a.geminiModel);
}

const FLASH_RE = /^gemini-(\d+(?:\.\d+)?)-flash(-lite)?$/;

// First current flash / flash-lite model: highest version, flash before flash-lite, no preview/exp names.
function pickFrom(names) {
  const scored = names.map((n) => ({ n, m: FLASH_RE.exec(n) })).filter((x) => x.m)
    .sort((x, y) => (parseFloat(y.m[1]) - parseFloat(x.m[1])) || ((x.m[2] ? 1 : 0) - (y.m[2] ? 1 : 0)));
  if (scored.length) return scored[0].n;
  return names.find((n) => /flash/.test(n) && !/preview|exp|tts|image|audio|live|embedding/.test(n)) || names.find((n) => /flash/.test(n)) || null;
}

async function pickGeminiModel(key) {
  return pickFrom(await listGeminiModels(key));
}

export async function listGeminiModels(key) {
  if (!key) throw new Error('Paste a Gemini key first.');
  let res;
  try {
    res = await fetch(`${GEMINI_BASE}/models?pageSize=200`, { headers: { 'x-goog-api-key': key }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (e) { throw fetchError(e); }
  const j = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 400 || res.status === 401 || res.status === 403) throw new Error('Gemini key rejected. Check it in Settings → AI.');
    if (res.status === 429) throw new Error('Gemini says too many requests. Try again in a minute.');
    throw new Error(`Gemini refused the request (HTTP ${res.status}): ${oneLine(j.error?.message || res.statusText)}`);
  }
  return (j.models || []).filter((m) => (m.supportedGenerationMethods || []).includes('generateContent')).map((m) => m.name.replace(/^models\//, ''));
}

// ---------- Claude ----------

const CLAUDE_BASE = 'https://api.anthropic.com/v1';
const claudeHeaders = (key) => ({
  'x-api-key': key,
  'anthropic-version': '2023-06-01',
  'anthropic-dangerous-direct-browser-access': 'true',
  'content-type': 'application/json',
});

async function claude(image, text, a, signal) {
  const content = [];
  if (image) content.push({ type: 'image', source: { type: 'base64', media_type: image.mime, data: image.base64 } });
  content.push({ type: 'text', text });
  let res;
  try {
    res = await fetch(`${CLAUDE_BASE}/messages`, {
      method: 'POST',
      headers: claudeHeaders(a.claudeKey),
      body: JSON.stringify({
        model: a.claudeModel,
        max_tokens: 4000,
        system: systemPrompt(a),
        messages: [{ role: 'user', content }],
        output_config: { effort: 'low', format: { type: 'json_schema', schema: SCHEMA } },
      }),
      signal: withTimeout(signal),
    });
  } catch (e) { throw fetchError(e); }
  const msg = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = oneLine(msg.error?.message || res.statusText || '');
    if (res.status === 401) throw new Error('Claude key rejected. Check it in Settings → AI.');
    if (res.status === 403) throw new Error('Claude key is not allowed to do this. Check it in Settings → AI.');
    if (res.status === 404) throw new Error(`Claude model ${a.claudeModel} not found. Pick another in Settings → AI.`);
    if (res.status === 429) throw new Error('Claude rate limit hit. Try again in a minute.');
    if (res.status === 402 || /credit|billing/i.test(detail)) throw new Error('Claude account has no credit. Top up at console.anthropic.com or switch to Gemini.');
    if (res.status === 529 || res.status >= 500) throw new Error(`Claude is overloaded (HTTP ${res.status}). Try again in a minute.`);
    throw new Error(`Claude refused the request (HTTP ${res.status}): ${detail}`);
  }
  if (msg.stop_reason === 'refusal') throw new Error('Claude declined this request. Try a different photo or describe the food.');
  if (msg.stop_reason === 'max_tokens') throw new Error('Claude ran out of room before finishing. Try fewer items or a shorter description.');
  const txt = (msg.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  return normalise(parseJSON(txt), 'claude', a.claudeModel);
}

async function listClaudeModels(key) {
  let res;
  try {
    res = await fetch(`${CLAUDE_BASE}/models?limit=100`, { headers: claudeHeaders(key), signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (e) { throw fetchError(e); }
  const j = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) throw new Error('Claude key rejected. Check it in Settings → AI.');
    throw new Error(`Claude refused the request (HTTP ${res.status}): ${oneLine(j.error?.message || res.statusText)}`);
  }
  return (j.data || []).map((m) => m.id);
}

// ---------- shared ----------

const oneLine = (s) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, 160);

function parseJSON(txt) {
  try { return JSON.parse(txt); } catch { throw new Error('AI returned something unreadable. Tap Estimate to try again.'); }
}

function normalise(r, provider, model) {
  const num = (x) => (isFinite(Number(x)) ? Math.round(Number(x) * 10) / 10 : 0);
  const items = (Array.isArray(r.items) ? r.items : []).map((i) => ({
    name: String(i.name || '?').trim() || '?', amount: String(i.amount || '').trim(), grams: num(i.grams),
    kcal: Math.round(num(i.kcal)), protein: num(i.protein), carbs: num(i.carbs), fat: num(i.fat),
  }));
  const total = items.reduce((s, i) => s + i.kcal, 0);
  let lo = Math.round(num(r.kcal_low)), hi = Math.round(num(r.kcal_high));
  if (!(lo > 0 && hi >= lo)) { lo = total; hi = total; }
  return {
    provider, model,
    meal: String(r.meal || 'Meal').trim() || 'Meal',
    notes: oneLine(r.notes),
    items,
    kcal_low: lo, kcal_high: hi,
    assumed: (Array.isArray(r.assumed) ? r.assumed : []).map((x) => ({ name: String(x?.name || '').trim(), kcal: Math.round(num(x?.kcal)) })).filter((x) => x.name),
    questions: (Array.isArray(r.questions) ? r.questions : []).map((q) => String(q || '').trim()).filter(Boolean).slice(0, 2),
  };
}

// Free connectivity check for Settings: lists models instead of spending an estimate.
export async function testAI(settings) {
  const a = settings.ai || {};
  if (a.provider === 'gemini') {
    const names = await listGeminiModels(a.geminiKey);
    const n = await aiCallsToday();
    if (names.includes(a.geminiModel)) return `Key works. ${a.geminiModel} is available. ${n}/${GEMINI_DAILY_LIMIT} estimates used today.`;
    const pick = pickFrom(names);
    return `Key works, but ${a.geminiModel} is not in your model list${pick ? ` (try ${pick})` : ''}. Pick one from "Load Gemini model list".`;
  }
  if (a.provider === 'claude') {
    if (!a.claudeKey) throw new Error('Paste a Claude key first.');
    const ids = await listClaudeModels(a.claudeKey);
    if (ids.includes(a.claudeModel)) return `Key works. ${a.claudeModel} is available.`;
    return `Key works, but ${a.claudeModel} is not in the model list (${ids.slice(0, 3).join(', ')}…).`;
  }
  throw new Error('AI is off. Pick a provider first.');
}
