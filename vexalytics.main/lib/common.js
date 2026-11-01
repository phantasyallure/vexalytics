const crypto = require('crypto');
const G = 'https://graph.facebook.com/v23.0';

async function graph(p, params = {}) {
  const u = new URL(p.startsWith('http') ? p : G + p);
  Object.entries(params).forEach(([k, v]) => u.searchParams.set(k, v));
  const j = await (await fetch(u, { signal: AbortSignal.timeout(12000) })).json();
  if (j.error) throw new Error(j.error.message);
  return j;
}

// Supabase REST (no SDK needed)
const sb = (path, opt = {}) => fetch(process.env.SUPABASE_URL + '/rest/v1/' + path, {
  ...opt,
  headers: { apikey: process.env.SUPABASE_SERVICE_KEY, Authorization: 'Bearer ' + process.env.SUPABASE_SERVICE_KEY, 'Content-Type': 'application/json', ...opt.headers }
});
async function getSession() {
  const r = await sb('ig_session?id=eq.1&select=*'); const j = await r.json();
  return Array.isArray(j) && j[0] ? j[0] : null;
}
const saveSession = s => sb('ig_session', { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates' }, body: JSON.stringify({ id: 1, ...s, updated_at: new Date().toISOString() }) });
const clearSession = () => sb('ig_session?id=eq.1', { method: 'DELETE' });

// key/value settings (Gemini key + model). Needs the app_settings table from supabase.sql
async function getSettings() {
  try {
    const r = await sb('app_settings?select=key,value'); const j = await r.json();
    const o = {}; if (Array.isArray(j)) j.forEach(x => { o[x.key] = x.value; });
    return o;
  } catch { return {}; }
}
async function setSetting(key, value) {
  const r = await sb('app_settings', { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates' }, body: JSON.stringify({ key, value, updated_at: new Date().toISOString() }) });
  if (!r.ok) throw new Error('Could not save settings. Run the new app_settings block from supabase.sql in Supabase, then try again. (' + (await r.text()).slice(0, 160) + ')');
}
const delSetting = key => sb('app_settings?key=eq.' + encodeURIComponent(key), { method: 'DELETE' });

// Gemini REST call. The key is sent in a header, never in the URL.
const DEFAULT_MODEL = 'gemini-3.8-flash';
// Old saved models (gemini-1.x / 2.x) are retired for new users, so quietly use the current default instead.
const fixModel = m => { m = String(m || '').trim().replace(/^models\//, ''); return !m || /^gemini-(1|2)\./.test(m) ? DEFAULT_MODEL : m; };
async function gemini({ key, model, system, contents, maxTokens = 8192, temperature = 0.5, plain = false }) {
  model = fixModel(model);
  if (!/^[A-Za-z0-9._-]+$/.test(model)) throw new Error('Invalid model name.');
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
  const call = async (thinking, ms) => {
    if (plain) { // bare request, identical to Google's own curl quickstart (used for the key test)
      const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key }, body: JSON.stringify({ contents }), signal: AbortSignal.timeout(ms) });
      return { r, j: await r.json().catch(() => ({})) };
    }
    const generationConfig = { temperature, maxOutputTokens: maxTokens };
    if (thinking) generationConfig.thinkingConfig = { thinkingLevel: 'low' }; // keep newer "thinking" models fast
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({ systemInstruction: { parts: [{ text: system }] }, contents, generationConfig }),
      signal: AbortSignal.timeout(ms)
    });
    return { r, j: await r.json().catch(() => ({})) };
  };
  let out;
  try {
    try { out = await call(!plain, 28000); }
    catch (e) { if (e.name !== 'TimeoutError') throw e; out = await call(false, 25000); } // one retry without the thinking option
    // Bad thinking option for this model, or overloaded: retry once plain
    if (!out.r.ok && (out.r.status === 400 || out.r.status === 429 || out.r.status >= 500)) {
      const m = (out.j.error && out.j.error.message) || '';
      if (/think/i.test(m) || out.r.status >= 500 || out.r.status === 429) out = await call(false, 25000);
    }
  } catch (e) { throw new Error(e.name === 'TimeoutError' ? 'Gemini did not answer in time (model: ' + model + '). Try again, or type a different model name in Settings.' : 'Could not reach Gemini.'); }
  const { r, j } = out;
  if (!r.ok) throw new Error((j.error && j.error.message) || 'Gemini error ' + r.status);
  const c = j.candidates && j.candidates[0];
  const text = c && c.content && c.content.parts ? c.content.parts.filter(p => !p.thought).map(p => p.text || '').join('') : '';
  if (!text) throw new Error(j.promptFeedback && j.promptFeedback.blockReason ? 'Gemini blocked this request: ' + j.promptFeedback.blockReason : c && c.finishReason === 'MAX_TOKENS' ? 'Gemini ran out of space before answering. Try a shorter question.' : 'Gemini returned an empty answer.');
  return text;
}

// password -> signed cookie
const sig = () => crypto.createHmac('sha256', process.env.DASH_PASSWORD || '').update('insights-session').digest('hex');
function authed(req) {
  const m = (req.headers.cookie || '').match(/(?:^|; )sid=([a-f0-9]+)/);
  if (!m || !process.env.DASH_PASSWORD) return false;
  const a = Buffer.from(m[1]), b = Buffer.from(sig());
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
const hash = s => crypto.createHash('sha256').update(String(s)).digest();
const passwordOk = p => crypto.timingSafeEqual(hash(p), hash(process.env.DASH_PASSWORD || ''));

module.exports = { graph, getSession, saveSession, clearSession, getSettings, setSetting, delSetting, gemini, fixModel, DEFAULT_MODEL, sig, authed, passwordOk };
