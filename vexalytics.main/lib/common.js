try { require('dns').setDefaultResultOrder('ipv4first'); } catch {}
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
const fixModel = m => { m = String(m || '').trim().replace(/^models\//, ''); return m || DEFAULT_MODEL; };
async function gemini({ key, model, system, contents, maxTokens = 8192, temperature = 0.5, plain = false, budget = 50000, noRetry = false }) {
  model = fixModel(model);
  if (!/^[A-Za-z0-9._-]+$/.test(model)) throw new Error('Invalid model name.');
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
  // Uses Node's own https module (not fetch) and forces IPv4, and records how far the request got, so a stall can be pinpointed.
  let stage = 'start';
  const post = (body, ms) => new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = require('https').request({ hostname: u.hostname, path: u.pathname, method: 'POST', family: 4,
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key, 'Content-Length': Buffer.byteLength(body) } }, res => {
      stage = 'got-headers'; const chunks = [];
      res.on('data', d => chunks.push(d));
      res.on('end', () => { let j = {}; try { j = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch {} resolve({ r: { ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode }, j }); });
      res.on('error', reject);
    });
    req.on('socket', sock => { stage = 'socket'; sock.on('lookup', () => { stage = 'dns-ok'; }); sock.on('connect', () => { stage = 'tcp-connected'; }); sock.on('secureConnect', () => { stage = 'tls-ok'; }); });
    req.setTimeout(ms, () => { const e = new Error('timeout'); e.name = 'TimeoutError'; e.code = 'stalled-after-' + stage; req.destroy(e); });
    req.on('error', reject);
    req.end(body);
  });
  const call = async (thinking, ms) => {
    if (plain) return post(JSON.stringify({ contents }), ms);
    const generationConfig = { temperature, maxOutputTokens: maxTokens };
    if (thinking) generationConfig.thinkingConfig = { thinkingLevel: 'low' };
    return post(JSON.stringify({ systemInstruction: { parts: [{ text: system }] }, contents, generationConfig }), ms);
  };
  // Total budget stays under Vercel's 60 s function limit, so we always return a readable message instead of Vercel's HTML error page.
  const t0 = Date.now(), left = () => budget - (Date.now() - t0);
  let out;
  try {
    try { out = await call(!plain, Math.min(28000, left())); }
    catch (e) { if (e.name !== 'TimeoutError' || left() < 6000) throw e; out = await call(false, left()); } // one retry without the thinking option
    // Overloaded (429/5xx) or bad thinking option: one short pause, then one plain retry if time allows
    if (!noRetry && !out.r.ok && (out.r.status === 400 || out.r.status === 429 || out.r.status >= 500)) {
      const m = (out.j.error && out.j.error.message) || '';
      if ((/think/i.test(m) || out.r.status >= 500 || out.r.status === 429) && left() > 8000) {
        await new Promise(res => setTimeout(res, out.r.status === 400 ? 0 : 1500));
        try { out = await call(false, left()); } catch (e) { /* keep the first answer from Google if the retry stalls */ if (e.name !== 'TimeoutError') throw e; }
      }
    }
  } catch (e) {
    const why = [e.name, e.code, e.cause && (e.cause.code || e.cause.message)].filter(Boolean).join(' / ');
    throw new Error((e.name === 'TimeoutError' ? 'Gemini did not answer in time' : 'Could not reach Gemini') + ' [build v6, model ' + model + ', ' + why + ', after ' + (Date.now() - t0) + ' ms]');
  }
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

// ---- team access: personal codes (stored hashed), revocable at any time ----
const norm = c => String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const tHash = c => crypto.createHash('sha256').update('team:' + norm(c)).digest('hex');
const tSig = (id, h) => crypto.createHmac('sha256', (process.env.DASH_PASSWORD || '') + '|team').update(id + ':' + h).digest('hex');
const tokenFor = row => row.id + '.' + tSig(row.id, row.code_hash);
const rows = async r => { const j = await r.json().catch(() => []); return Array.isArray(j) ? j : []; };
async function teamByCode(code) {
  if (norm(code).length < 8) return null;
  return (await rows(await sb('team_codes?code_hash=eq.' + tHash(code) + '&active=eq.true&select=*')))[0] || null;
}
async function teamFromReq(req) {
  const m = (req.headers.cookie || '').match(/(?:^|; )tid=(\d+)\.([a-f0-9]+)/); if (!m) return null;
  const row = (await rows(await sb('team_codes?id=eq.' + m[1] + '&active=eq.true&select=*')))[0]; if (!row) return null;
  const a = Buffer.from(m[2]), b = Buffer.from(tSig(row.id, row.code_hash));
  return a.length === b.length && crypto.timingSafeEqual(a, b) ? row : null;
}
async function who(req) {
  if (authed(req)) return { role: 'owner', name: 'Owner' };
  const t = await teamFromReq(req); return t ? { role: t.role, name: t.name, id: t.id } : null;
}
const teamTouch = id => sb('team_codes?id=eq.' + Number(id), { method: 'PATCH', body: JSON.stringify({ last_used: new Date().toISOString() }) });
const teamList = async () => rows(await sb('team_codes?select=id,name,role,created_at,last_used&active=eq.true&order=created_at.desc'));
function newCode() { const A = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; let s = ''; for (let i = 0; i < 12; i++) s += A[crypto.randomInt(A.length)]; return 'VX-' + s.slice(0, 4) + '-' + s.slice(4, 8) + '-' + s.slice(8); }
async function teamAdd(name, role) {
  const code = newCode(), r = await sb('team_codes', { method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify({ name, role, code_hash: tHash(code) }) });
  const j = await r.json().catch(() => null);
  if (!r.ok || !j || !j[0]) throw new Error('Could not create the code. Run the team_codes block from supabase.sql in Supabase first. (' + JSON.stringify(j).slice(0, 120) + ')');
  return { code, row: j[0] };
}
const teamDel = id => sb('team_codes?id=eq.' + Number(id), { method: 'DELETE' });

module.exports = { who, teamByCode, tokenFor, teamTouch, teamList, teamAdd, teamDel, graph, getSession, saveSession, clearSession, getSettings, setSetting, delSetting, gemini, fixModel, DEFAULT_MODEL, sig, authed, passwordOk };
