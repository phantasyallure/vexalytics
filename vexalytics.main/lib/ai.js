// Gemini with an automatic backup model: if the main model hits a limit or fails, the backup answers.
const { gemini, fixModel, setSetting } = require('./common');
const LIMIT = /demand|unavailable|quota|rate.?limit|429|overload|exhaust|credit|billing|insufficient|capacity|too many|resource|busy|503|timeout|did not answer|stalled/i;
const keyOf = st => st.gemini_key || process.env.GEMINI_API_KEY;
const chainOf = st => { const a = fixModel(st.gemini_model), b = st.gemini_backup ? fixModel(st.gemini_backup) : ''; return b && b !== a ? [a, b] : [a]; };

function view(st) {
  const k = keyOf(st);
  return { has: !!k, masked: k ? '••••' + k.slice(-4) : '', model: fixModel(st.gemini_model), backup: st.gemini_backup || '',
    fromEnv: !st.gemini_key && !!process.env.GEMINI_API_KEY, gemini: { has: !!k } };
}

// The models this key can really use, straight from Google (so the list is never out of date).
async function listModels(key) {
  const r = await fetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=200', { headers: { 'x-goog-api-key': key }, signal: AbortSignal.timeout(15000) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((j.error && j.error.message) || 'Google returned ' + r.status);
  return (j.models || [])
    .filter(m => (m.supportedGenerationMethods || []).includes('generateContent') && /^models\/gemini/.test(m.name) && !/embed|tts|image|live|audio|aqa|robotics|computer|veo|imagen/i.test(m.name))
    .map(m => ({ id: m.name.replace(/^models\//, ''), label: m.displayName || m.name.replace(/^models\//, '') }))
    .sort((a, b) => b.id.localeCompare(a.id, undefined, { numeric: true }));
}

// Tries the main model, then the backup. A model that just hit a limit rests for 10 minutes.
async function askAI(st, o) {
  const key = keyOf(st); if (!key) throw new Error('Add your Gemini API key in Settings first.');
  const chain = chainOf(st), now = Date.now(), notes = [];
  let ready = chain.filter(m => !(Date.parse(st['cool:gemini:' + m]) > now)); if (!ready.length) ready = chain;
  for (let i = 0; i < ready.length; i++) {
    const m = ready[i], left = 52000 - (Date.now() - now); if (left < 4000) break;
    try {
      const text = await gemini({ key, model: m, system: o.system, contents: o.contents, maxTokens: o.maxTokens, temperature: o.temperature, budget: Math.min(o.cap || 25000, left), noRetry: i < ready.length - 1 });
      return { text, via: 'Gemini · ' + m, fb: m !== chain[0] };
    } catch (e) {
      notes.push(m + ': ' + String(e.message).slice(0, 140));
      if (LIMIT.test(e.message)) { try { const u = new Date(Date.now() + 600000).toISOString(); await setSetting('cool:gemini:' + m, u); st['cool:gemini:' + m] = u; } catch {} }
    }
  }
  throw new Error('Gemini could not answer. ' + notes.join(' | '));
}
module.exports = { askAI, listModels, view };
