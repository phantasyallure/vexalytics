const crypto = require('crypto');
const G = 'https://graph.facebook.com/v23.0';

async function graph(p, params = {}) {
  const u = new URL(p.startsWith('http') ? p : G + p);
  Object.entries(params).forEach(([k, v]) => u.searchParams.set(k, v));
  const j = await (await fetch(u)).json();
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

module.exports = { graph, getSession, saveSession, clearSession, sig, authed, passwordOk };
