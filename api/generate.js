// Vercel Serverless Function — Event Ops Copilot Phase 2
// The API key is read from the environment variable GEMINI_API_KEY (set in Vercel). NEVER paste the key in this file.
// Try the configured model first, then common Flash names. A 404 (model not found) moves on to the next name automatically.
const MODELS = [...new Set([(process.env.GEMINI_MODEL || '').trim(), 'gemini-flash-latest', 'gemini-2.5-flash', 'gemini-3-flash-preview', 'gemini-2.5-flash-lite', 'gemini-2.0-flash'].filter(Boolean))];
let goodModel = null; // remembers the first model that worked
const LIMIT = 10, WINDOW = 60 * 60 * 1000; // 10 requests per visitor per hour (best effort)
const hits = new Map();

const SCHEMA = {
  type: 'OBJECT',
  properties: {
    announcements: { type: 'OBJECT', properties: {
      en: { type: 'STRING' }, zh_hant: { type: 'STRING' }, zh_hans: { type: 'STRING' } },
      required: ['en', 'zh_hant', 'zh_hans'] },
    risks: { type: 'ARRAY', items: { type: 'OBJECT', properties: {
      level: { type: 'STRING', enum: ['H', 'M', 'L'] },
      risk_en: { type: 'STRING' }, risk_zh: { type: 'STRING' },
      mitigation_en: { type: 'STRING' }, mitigation_zh: { type: 'STRING' }, owner: { type: 'STRING' } },
      required: ['level', 'risk_en', 'risk_zh', 'mitigation_en', 'mitigation_zh', 'owner'] } }
  },
  required: ['announcements', 'risks']
};

function clean(b) {
  const s = (v, n = 120) => String(v ?? '').replace(/[<>]/g, '').slice(0, n);
  const num = v => Math.max(0, Math.min(100000, Number(v) || 0));
  const m = b.guestMixPct || {};
  return {
    name: s(b.name), type: s(b.type, 40), venue: s(b.venue, 40), capacity: num(b.capacity), attendance: num(b.attendance),
    date: s(b.date, 10), start: s(b.start, 5), durationHours: num(b.durationHours), gates: num(b.gates), budget: s(b.budget, 20),
    outdoor: b.outdoor === 'yes' ? 'yes' : 'no', under21Possible: b.under21Possible === 'yes' ? 'yes' : 'no',
    guestMixPct: { mainland: num(m.mainland), hongkong: num(m.hongkong), macau: num(m.macau), international: num(m.international) },
    existingRisks: (Array.isArray(b.existingRisks) ? b.existingRisks : []).slice(0, 20).map(x => s(x, 150))
  };
}

function txt(v) { return typeof v === 'string' ? v.trim() : (v == null ? '' : String(v).trim()); }
function lvl(v) { const x = txt(v).toUpperCase(); if (x.startsWith('H')) return 'H'; if (x.startsWith('L')) return 'L'; return 'M'; }
// Lenient normalise + check. Returns '' if OK, otherwise the reason (shown on the page for debugging).
function check(d) {
  if (Array.isArray(d)) d = d[0];
  if (!d || typeof d !== 'object') return 'not an object';
  const a = d.announcements || d.announcement || {};
  const ann = {
    en: txt(a.en || a.english || a.EN),
    zh_hant: txt(a.zh_hant || a['zh-Hant'] || a.zh_tw || a.traditional),
    zh_hans: txt(a.zh_hans || a['zh-Hans'] || a.zh_cn || a.simplified)
  };
  for (const k of ['en', 'zh_hant', 'zh_hans']) if (ann[k].length < 10) return 'announcement ' + k + ' missing';
  const risks = (Array.isArray(d.risks) ? d.risks : []).map(r => ({
    level: lvl(r && r.level),
    risk_en: txt(r && r.risk_en), risk_zh: txt(r && r.risk_zh),
    mitigation_en: txt(r && r.mitigation_en), mitigation_zh: txt(r && r.mitigation_zh),
    owner: txt(r && r.owner) || 'Event Ops'
  })).filter(r => r.risk_en && r.risk_zh && r.mitigation_en && r.mitigation_zh).slice(0, 3);
  if (!risks.length) return 'no usable risks';
  d.announcements = ann; d.risks = risks;
  return '';
}

function prompt(e) {
  return `You are an event-operations writer for a FICTIONAL integrated resort in Macau called "Harbour Grand Resort".
Event brief (JSON): ${JSON.stringify(e)}

Write:
1) "announcements": a guest-facing pre-event announcement (120-180 words) in English (en), Traditional Chinese for Macau/HK (zh_hant) and Simplified Chinese (zh_hans). Same content in all three. Include date, door/start time, venue, arrival advice, shuttle to Border Gate / HZMB port / ferry terminals, and a bad-weather line (Typhoon Signal No. 8 or above / Black Rainstorm -> watch official channels).${e.under21Possible === 'yes' ? ' Include that guests under 21 must follow the event route and may not enter gaming areas.' : ''}
2) "risks": exactly 2 or 3 ADDITIONAL operational risks NOT already in existingRisks, each with level H/M/L, bilingual risk and mitigation (zh = Traditional Chinese), and an owner department.

Rules: Never invent artists, prices, phone numbers, URLs, statistics, laws or licence numbers. Do not mention gambling promotions. Use only facts from the brief; if something is unknown, write it generically. Plain text, no markdown.`;
}

async function callModel(model, e, key, useThinking) {
  const cfg = { temperature: 0.4, maxOutputTokens: 8192, responseMimeType: 'application/json', responseSchema: SCHEMA };
  if (useThinking) cfg.thinkingConfig = { thinkingBudget: 0 };
  return fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: prompt(e) }] }], generationConfig: cfg })
  });
}

async function callGemini(e, key) {
  const list = goodModel ? [goodModel, ...MODELS.filter(m => m !== goodModel)] : MODELS;
  let r = null, used = '', tried = [];
  for (const m of list) {
    r = await callModel(m, e, key, true);
    if (r.status === 400) r = await callModel(m, e, key, false); // some models reject thinkingConfig
    tried.push(m + ':' + r.status);
    if (r.status === 404) continue;          // model name not available -> try next
    used = m; break;
  }
  if (!r || !r.ok) { const err = new Error('Gemini HTTP ' + (r ? r.status : '?') + ' [' + tried.join(', ') + ']'); throw err; }
  goodModel = used;
  const j = await r.json();
  const c = j?.candidates?.[0];
  let text = (c?.content?.parts || []).filter(p => !p.thought).map(p => p.text || '').join('').trim();
  if (!text) throw new Error('empty AI reply (' + (c?.finishReason || 'no candidate') + ', ' + used + ')');
  text = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  const i = text.indexOf('{'), k = text.lastIndexOf('}');
  if (i >= 0 && k > i) text = text.slice(i, k + 1);
  try { return JSON.parse(text); }
  catch { throw new Error('AI JSON incomplete (' + (c?.finishReason || '?') + ', ' + used + ')'); }
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const key = process.env.GEMINI_API_KEY;
  if (!key) return res.status(503).json({ error: 'AI not configured' });

  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
  const now = Date.now(), h = (hits.get(ip) || []).filter(t => now - t < WINDOW);
  if (h.length >= LIMIT) return res.status(429).json({ error: 'Rate limit — try again later' });
  h.push(now); hits.set(ip, h);

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  const e = clean(body || {});

  let last = 'AI output failed validation';
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt && /HTTP 40[0-4]/.test(last)) break; // config errors: retrying won't help   // 1 automatic retry
    try {
      let d = await callGemini(e, key);
      if (Array.isArray(d)) d = d[0];
      const why = check(d);
      if (!why) return res.status(200).json({ announcements: d.announcements, risks: d.risks, model: goodModel });
      last = 'AI output failed validation: ' + why;
    } catch (err) { last = err.message; console.error('attempt', attempt + 1, err.message); }
  }
  return res.status(502).json({ error: last }); // front-end falls back to template
};
