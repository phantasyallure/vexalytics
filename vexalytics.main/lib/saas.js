// Accounts, plans, website pixel and admin console. Routed from api/[action].js.
const crypto = require('crypto');
const { sb, rows, userToken, userFromReq, authed } = require('./common');

const ACTIONS = new Set(['register', 'ulogin', 'me', 'plans', 'planreq', 'sites', 'sitestats', 'px', 'collect', 'adm']);
const has = a => ACTIONS.has(a);
const json = (res, code, o) => { res.statusCode = code; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(o)); };
const body = req => { let b = req.body; if (typeof b === 'string') { try { b = JSON.parse(b); } catch { b = {}; } } return b || {}; };
const cookie = (id) => [`ux=${id ? userToken(id) : ''}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${id ? 2592000 : 0}`, 'sid=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0', 'tid=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0']; // a customer login always replaces any owner/team session

const hashPw = pw => { const s = crypto.randomBytes(16).toString('hex'); return s + ':' + crypto.scryptSync(pw, s, 32).toString('hex'); };
const checkPw = (pw, h) => { const [s, k] = String(h).split(':'); if (!s || !k) return false; const a = Buffer.from(k, 'hex'), b = crypto.scryptSync(pw, s, 32); return a.length === b.length && crypto.timingSafeEqual(a, b); };
const pub = a => ({ id: a.id, email: a.email, name: a.name, lang: a.lang, plan_id: a.plan_id, interval: a.plan_interval, status: a.plan_status, until: a.plan_until });

async function limits(a) {
  const active = a.plan_status === 'active' && a.plan_until && Date.parse(a.plan_until) > Date.now();
  if (active) { const p = (await rows(await sb('plans?id=eq.' + a.plan_id + '&select=*')))[0]; if (p) return { max_sites: p.max_sites, ai: p.ai, plan: p.name }; }
  return { max_sites: 1, ai: false, plan: 'trial' };
}

/* ---------- pixel script (served at /px.js) ---------- */
const script = origin => `(function(){var s=document.currentScript,k=s&&s.getAttribute('data-key');if(!k)return;var E='${origin}/api/collect',sid;
try{sid=localStorage.getItem('vx_sid');if(!sid){sid=Math.random().toString(36).slice(2)+Date.now().toString(36);localStorage.setItem('vx_sid',sid)}}catch(e){sid=Math.random().toString(36).slice(2)}
function send(o){o.k=k;o.s=sid;o.p=o.p||location.pathname;o.r=document.referrer;var b=JSON.stringify(o);try{if(!(navigator.sendBeacon&&navigator.sendBeacon(E,new Blob([b],{type:'text/plain'}))))throw 0}catch(e){fetch(E,{method:'POST',body:b,keepalive:true,mode:'no-cors'})}}
function load(){var n=performance.getEntriesByType&&performance.getEntriesByType('navigation')[0];return n?Math.round(n.loadEventEnd||n.domContentLoadedEventEnd):null}
function once(key){try{if(sessionStorage.getItem(key))return false;sessionStorage.setItem(key,1)}catch(e){}return true}
function boot(){setTimeout(function(){send({t:'pageview',l:load()});
 if(/thank|order-received|order-confirmation|checkout\\/success|confirmation|merci|commande/i.test(location.href)&&once('vx_o'+location.pathname)){var v=null,c=null;try{if(window.Shopify&&Shopify.checkout){v=Shopify.checkout.total_price;c=Shopify.checkout.currency}}catch(e){}send({t:'order',v:v,c:c})}},50)}
window.addEventListener('error',function(e){send({t:'error',e:String(e.message||'error').slice(0,160)})});
window.addEventListener('unhandledrejection',function(e){send({t:'error',e:'promise: '+String(e.reason&&e.reason.message||e.reason).slice(0,140)})});
window.Vexalytics={track:function(t,d){d=d||{};send({t:t==='order'?'order':'event',e:t,v:d.value,c:d.currency})}};
document.readyState==='complete'?boot():window.addEventListener('load',boot)})();`;

const siteCache = new Map();
async function siteByKey(k) {
  if (siteCache.has(k)) return siteCache.get(k);
  const r = (await rows(await sb('px_sites?key=eq.' + encodeURIComponent(k) + '&select=id,domain')))[0] || null;
  if (r) siteCache.set(k, r); return r;
}
const host = u => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } };
const source = ref => { const h = host(ref); if (!h) return 'direct'; if (/instagram|l\.instagram/.test(h)) return 'instagram'; if (/facebook|fb\.com|fb\.me/.test(h)) return 'facebook'; if (/tiktok/.test(h)) return 'tiktok'; if (/google|bing|duckduckgo|yahoo/.test(h)) return 'search'; return 'other'; };

function stats(ev, days) {
  const day = t => t.slice(0, 10), by = {}, pages = {}, src = {}, vis = new Set(), errs = {};
  let views = 0, orders = 0, revenue = 0, lsum = 0, ln = 0, errors = 0, last = null;
  for (let i = 0; i < days; i++) { const d = new Date(Date.now() - (days - 1 - i) * 86400000).toISOString().slice(0, 10); by[d] = { d, views: 0, orders: 0, errors: 0 }; }
  ev.forEach(e => {
    const d = by[day(e.t)]; if (!last || e.t > last) last = e.t;
    if (e.type === 'pageview') { views++; vis.add(e.sid); if (d) d.views++; pages[e.path] = (pages[e.path] || 0) + 1; if (e.load_ms > 0) { lsum += e.load_ms; ln++; } const s = source(e.ref); src[s] = (src[s] || 0) + 1; }
    else if (e.type === 'order') { orders++; revenue += Number(e.val) || 0; if (d) d.orders++; }
    else if (e.type === 'error') { errors++; if (d) d.errors++; errs[e.err] = (errs[e.err] || 0) + 1; }
  });
  const avg = ln ? Math.round(lsum / ln) : null, errRate = views ? errors / views * 100 : 0;
  let score = views ? 100 - Math.max(0, ((avg || 0) - 1500) / 50) - Math.min(40, errRate * 8) : null;
  if (score != null) score = Math.max(0, Math.round(score));
  const top = (o, n) => Object.entries(o).sort((a, b) => b[1] - a[1]).slice(0, n);
  return { visitors: vis.size, views, orders, revenue, conv: vis.size ? orders / vis.size * 100 : 0, avgLoad: avg, errors, errRate, score, last,
    daily: Object.values(by), pages: top(pages, 8), sources: top(src, 6), errList: top(errs, 5) };
}

async function handle(action, req, res, { base }) {
  const b = body(req);
  try {
    if (action === 'px') { res.setHeader('Content-Type', 'application/javascript; charset=utf-8'); res.setHeader('Cache-Control', 'public, max-age=300'); res.setHeader('Access-Control-Allow-Origin', '*'); return res.end(script(base)); }

    if (action === 'collect') {
      res.setHeader('Access-Control-Allow-Origin', '*'); res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      if (req.method === 'OPTIONS') { res.statusCode = 204; return res.end(); }
      const site = await siteByKey(String(b.k || '').slice(0, 64));
      const t = ['pageview', 'order', 'error', 'event'].includes(b.t) ? b.t : null;
      if (!site || !t) { res.statusCode = 204; return res.end(); }
      const oh = host(req.headers.origin || req.headers.referer || '');
      if (site.domain && oh && !(oh === site.domain || oh.endsWith('.' + site.domain)) && oh !== 'localhost') { res.statusCode = 204; return res.end(); }
      await sb('px_events', { method: 'POST', body: JSON.stringify({ site_id: site.id, type: t, path: String(b.p || '/').slice(0, 200), ref: String(b.r || '').slice(0, 300), sid: String(b.s || '').slice(0, 40),
        load_ms: Number.isFinite(+b.l) && +b.l > 0 && +b.l < 120000 ? Math.round(+b.l) : null, val: Number.isFinite(+b.v) ? +b.v : null, cur: b.c ? String(b.c).slice(0, 5) : null, err: b.e ? String(b.e).slice(0, 160) : null }) });
      res.statusCode = 204; return res.end();
    }

    if (action === 'plans') return json(res, 200, { plans: await rows(await sb('plans?active=eq.true&select=*&order=sort.asc')) });

    if (action === 'register' && req.method === 'POST') {
      const email = String(b.email || '').trim().toLowerCase(), pw = String(b.password || ''), name = String(b.name || '').trim().slice(0, 60);
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json(res, 400, { error: 'invalid_email' });
      if (pw.length < 8) return json(res, 400, { error: 'weak_password' });
      const r = await sb('accounts', { method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify({ email, name, pw: hashPw(pw), lang: ['en', 'fr', 'ar'].includes(b.lang) ? b.lang : 'en', plan_until: new Date(Date.now() + 14 * 864e5).toISOString() }) });
      const j = await r.json().catch(() => null);
      if (!r.ok || !j || !j[0]) return json(res, r.status === 409 ? 409 : 400, { error: r.status === 409 ? 'email_taken' : 'setup_needed' });
      res.setHeader('Set-Cookie', cookie(j[0].id)); return json(res, 200, { ok: true });
    }
    if (action === 'ulogin' && req.method === 'POST') {
      const a = (await rows(await sb('accounts?email=eq.' + encodeURIComponent(String(b.email || '').trim().toLowerCase()) + '&select=*')))[0];
      if (!a || a.suspended || !checkPw(String(b.password || ''), a.pw)) { await new Promise(r => setTimeout(r, 700)); return json(res, 401, { error: 'bad_login' }); }
      res.setHeader('Set-Cookie', cookie(a.id)); return json(res, 200, { ok: true });
    }

    const admin = authed(req), me = admin ? null : await userFromReq(req);
    if (action === 'adm') {
      if (!admin) return json(res, 403, { error: 'admin_only' });
      if (req.method === 'POST') {
        const n = x => Math.max(0, Math.round(Number(x) || 0));
        if (b.op === 'plan') {
          const p = { id: n(b.id), name: String(b.name || '').slice(0, 30), price_month: n(b.price_month), price_year: n(b.price_year), max_sites: n(b.max_sites), platforms: Math.min(3, n(b.platforms) || 1), ai: !!b.ai, active: b.active !== false, sort: n(b.sort) };
          if (!p.name) return json(res, 400, { error: 'name' });
          if (!p.id) { const all = await rows(await sb('plans?select=id&order=id.desc&limit=1')); p.id = (all[0] ? all[0].id : 0) + 1; }
          await sb('plans', { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates' }, body: JSON.stringify(p) });
        } else if (b.op === 'grant') { // activate a plan on an account (month = 31 days, year = 366)
          const iv = b.interval === 'year' ? 'year' : 'month';
          await sb('accounts?id=eq.' + n(b.account), { method: 'PATCH', body: JSON.stringify({ plan_id: n(b.plan), plan_interval: iv, plan_status: 'active', plan_until: new Date(Date.now() + (iv === 'year' ? 366 : 31) * 864e5).toISOString() }) });
          if (b.request) await sb('plan_requests?id=eq.' + n(b.request), { method: 'PATCH', body: JSON.stringify({ status: 'approved' }) });
        } else if (b.op === 'reject') await sb('plan_requests?id=eq.' + n(b.request), { method: 'PATCH', body: JSON.stringify({ status: 'rejected' }) });
        else if (b.op === 'suspend') await sb('accounts?id=eq.' + n(b.account), { method: 'PATCH', body: JSON.stringify({ suspended: !!b.on }) });
        else return json(res, 400, { error: 'op' });
      }
      const [users, plans, reqs] = await Promise.all([rows(await sb('accounts?select=id,email,name,plan_id,plan_interval,plan_status,plan_until,suspended,created_at&order=created_at.desc&limit=200')),
        rows(await sb('plans?select=*&order=sort.asc')), rows(await sb('plan_requests?select=*&status=eq.pending&order=created_at.desc'))]);
      return json(res, 200, { users, plans, requests: reqs });
    }

    if (!me) return json(res, 401, { error: 'login_required' });
    const lim = await limits(me);
    if (action === 'me') return json(res, 200, { account: pub(me), limits: lim, pending: await rows(await sb('plan_requests?account_id=eq.' + me.id + '&status=eq.pending&select=*')) });
    if (action === 'planreq' && req.method === 'POST') {
      const p = (await rows(await sb('plans?id=eq.' + Number(b.plan) + '&active=eq.true&select=id')))[0];
      if (!p) return json(res, 400, { error: 'plan' });
      await sb('plan_requests?account_id=eq.' + me.id + '&status=eq.pending', { method: 'DELETE' });
      await sb('plan_requests', { method: 'POST', body: JSON.stringify({ account_id: me.id, plan_id: p.id, interval: b.interval === 'year' ? 'year' : 'month' }) });
      return json(res, 200, { ok: true });
    }
    if (action === 'sites') {
      if (req.method === 'POST') {
        if (b.del) { await sb('px_sites?id=eq.' + Number(b.del) + '&account_id=eq.' + me.id, { method: 'DELETE' }); siteCache.clear(); }
        else {
          const list = await rows(await sb('px_sites?account_id=eq.' + me.id + '&select=id'));
          if (list.length >= lim.max_sites) return json(res, 403, { error: 'site_limit' });
          const domain = host(/^https?:/.test(b.domain) ? b.domain : 'https://' + String(b.domain || '').trim());
          if (!domain || !domain.includes('.')) return json(res, 400, { error: 'domain' });
          await sb('px_sites', { method: 'POST', body: JSON.stringify({ account_id: me.id, name: String(b.name || domain).slice(0, 60), domain, key: 'vx_' + crypto.randomBytes(12).toString('hex') }) });
        }
      }
      return json(res, 200, { sites: await rows(await sb('px_sites?account_id=eq.' + me.id + '&select=*&order=created_at.asc')), origin: base });
    }
    if (action === 'sitestats') {
      const site = (await rows(await sb('px_sites?id=eq.' + Number(req.query.id) + '&account_id=eq.' + me.id + '&select=*')))[0];
      if (!site) return json(res, 404, { error: 'not_found' });
      const days = [7, 30, 90].includes(Number(req.query.days)) ? Number(req.query.days) : 30;
      const ev = await rows(await sb('px_events?site_id=eq.' + site.id + '&t=gte.' + new Date(Date.now() - days * 864e5).toISOString() + '&select=t,type,path,ref,sid,load_ms,val,err&order=t.desc&limit=50000'));
      return json(res, 200, { site, days, ...stats(ev, days) });
    }
  } catch (e) { return json(res, 500, { error: 'server_error', detail: String(e.message).slice(0, 120) }); }
  json(res, 404, { error: 'Not found' });
}
module.exports = { has, handle };
