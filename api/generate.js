// Vercel Serverless Function — Event Ops Copilot Phase 2
// The API key is read from the environment variable GEMINI_API_KEY (set in Vercel). NEVER paste the key in this file.
const MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
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

function valid(d) {
  if (!d || !d.announcements || !Array.isArray(d.risks)) return false;
  if (!['en', 'zh_hant', 'zh_hans'].every(k => typeof d.announcements[k] === 'string' && d.announcements[k].trim().length > 20)) return false;
  d.risks = d.risks.slice(0, 3);
  return d.risks.length > 0 && d.risks.every(r => ['H', 'M', 'L'].includes(r.level) && r.risk_en && r.risk_zh && r.mitigation_en && r.mitigation_zh);
}

function prompt(e) {
  return `You are an event-operations writer for a FICTIONAL integrated resort in Macau called "Harbour Grand Resort".
Event brief (JSON): ${JSON.stringify(e)}

Write:
1) "announcements": a guest-facing pre-event announcement (120-180 words) in English (en), Traditional Chinese for Macau/HK (zh_hant) and Simplified Chinese (zh_hans). Same content in all three. Include date, door/start time, venue, arrival advice, shuttle to Border Gate / HZMB port / ferry terminals, and a bad-weather line (Typhoon Signal No. 8 or above / Black Rainstorm -> watch official channels).${e.under21Possible === 'yes' ? ' Include that guests under 21 must follow the event route and may not enter gaming areas.' : ''}
2) "risks": exactly 2 or 3 ADDITIONAL operational risks NOT already in existingRisks, each with level H/M/L, bilingual risk and mitigation (zh = Traditional Chinese), and an owner department.

Rules: Never invent artists, prices, phone numbers, URLs, statistics, laws or licence numbers. Do not mention gambling promotions. Use only facts from the brief; if something is unknown, write it generically. Plain text, no markdown.`;
}

async function callGemini(e, key) {
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt(e) }] }],
      generationConfig: { temperature: 0.4, maxOutputTokens: 4096, responseMimeType: 'application/json', responseSchema: SCHEMA }
    })
  });
  if (!r.ok) throw new Error('Gemini HTTP ' + r.status);
  const j = await r.json();
  const text = j?.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '';
  return JSON.parse(text);
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

  for (let attempt = 0; attempt < 2; attempt++) {   // 1 automatic retry
    try {
      const d = await callGemini(e, key);
      if (valid(d)) return res.status(200).json(d);
    } catch (err) { console.error('attempt', attempt + 1, err.message); }
  }
  return res.status(502).json({ error: 'AI output failed validation' }); // front-end falls back to template
};
