const crypto = require('crypto');
const { askAI, listModels, view: aiView } = require('../lib/ai');
const { who, teamByCode, tokenFor, teamTouch, teamList, teamAdd, teamDel, graph, getSession, saveSession, clearSession, getSettings, setSetting, delSetting, gemini, fixModel, sig, authed, passwordOk,
  getFb, saveFb, clearFb, ttToken, ttSaveTokens, ttClear, ttAccess, ttApi } = require('../lib/common');

const redirect = (res, to) => { res.statusCode = 302; res.setHeader('Location', to); res.end(); };
const json = (res, code, obj) => { res.statusCode = code; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(obj)); };
const fail = (res, msg) => { res.statusCode = 400; res.setHeader('Content-Type', 'text/html'); res.end(`<body style="font:16px system-ui;padding:40px;max-width:560px"><h3>Couldn't connect</h3><p>${String(msg).replace(/</g, '&lt;')}</p><a href="/">Back</a>`); };

/* ---------------- AI prompts ---------------- */
const BASE = `You are Vex, the analytics strategist inside Vexalytics, a private social analytics dashboard for Instagram, Facebook Pages and TikTok.
You receive DATA: a JSON object with the active dashboard view (DATA.activeView), a complete breakdown per connected platform (DATA.platforms.instagram / facebook / tiktok: account, KPIs, timing, formats, captions, demographics, account insights, promoted-vs-organic statistics) and EVERY analysed post with all of its metrics (DATA.platforms.*.posts).
Rules:
- Use ONLY numbers that appear in DATA. Never invent metrics, benchmarks or competitor figures. If something is missing, or a platform is not connected, say so.
- Prefer the precomputed tables and statistics in DATA over doing arithmetic on raw rows. If you must calculate, show the numbers used.
- Every claim needs evidence: the number and the sample size n. When n is below 5, say the sample is small. Name posts by platform, date and format.
- All times are Algeria time (UTC+1). Dates are YYYY-MM-DD.
- "e" (engagement) is: Instagram likes + comments; Facebook reactions + comments + shares; TikTok likes + comments + shares. Do not compare raw e across platforms without saying so. Posts under 48 hours old ("mature":false) and posts with hidden likes are excluded from performance stats.
- "reach" is unique accounts reached (Instagram, Facebook). "views" is total plays/impressions-style views. TikTok gives views only (no reach, no audience data). Never call views "reach".
- PROMOTED vs ORGANIC: every post has promo.status = paid | likely_paid | organic and promo.source = meta_ads | meta_insights | manual | estimate. paid with source meta_ads, meta_insights or manual is CONFIRMED. likely_paid is only a statistical ESTIMATE (an unusually high reach/views with low engagement per reach): always call it an estimate. TikTok does not expose ad data, so TikTok statuses are estimates unless source is manual. Facebook paid/organic views come from Meta (paidViews, organicViews). Instagram reports likes on the promoted ad version separately from the post, so a boosted Instagram post's likes + comments understate its total engagement.
- Never mix promoted posts into organic conclusions (best time, best format, caption advice, growth levers) unless you say so explicitly. When asked about performance, show organic and promoted separately.
- Be direct and practical. No filler, no generic social-media advice that the data does not support.
- Reply in the language the user writes in (default English). Use Markdown: short headings, tables where useful, bullet lists for actions.`;

const PERIODS = { day: ['daily', 'Daily', 'today and tomorrow'], week: ['weekly', 'Weekly', 'the next 7 days'], month: ['monthly', 'Monthly', 'the next 30 days'] };
const PLAN = {
  day: ['Daily plan', `Build a plan for TODAY (and tomorrow if today's best slots have passed). Give: the exact posting slots in Algeria time with the evidence behind each, the platform, format and caption angle for each post (based on the best ORGANIC posts in DATA), 3 engagement actions for the hour after posting (replies, comments, stories) and the one metric to check tonight. Keep it to one page.`],
  week: ['Weekly plan', `Build a 7-day plan starting tomorrow. Start with 3 lines on the weekly rhythm the data supports. Then a table: Day | Time (Algeria) | Platform | Format | Content idea (based on themes of the best organic captions) | Goal. Use the best days/times and formats from DATA for each connected platform. End with the 3 metrics to check at the end of the week and what result would mean the plan worked.`],
  month: ['Monthly plan', `Build a concrete 30-day content plan from the data. Start with 4 lines on the strategy and the posting rhythm the data supports. Then a table per week: Day | Time (Algeria) | Platform | Format | Content idea (based on themes of the best organic captions) | Goal. End with the 3 metrics to track weekly and what result would mean the plan works.`]
};
const REPORTS = {
  full: ['{A} performance report', `Write a complete, detailed {a} performance report using the WHOLE dataset and every connected platform. Sections: 1) Executive summary (6 lines max), 2) This period vs the previous period per platform (table, from DATA.activeView.period and each platform's period), 3) What is working (with evidence), 4) What is not working (with evidence), 5) Promoted vs organic: how many posts were promoted, confirmed or estimated, reach and engagement of each group, and what that means, 6) Best times and audience, 7) Content and format analysis, 8) Top 5 and bottom 3 ORGANIC posts per platform and why they differ (quote date, format, reach/views, engagement), 9) Priority actions for {H} (max 7, ordered by impact, each with the metric to watch), 10) Data caveats (what each platform's API does not provide).`],
  timing: ['Timing and audience report', `Analyse WHEN to post and WHO the audience is, for each connected platform. Include: the audience-online pattern (source and confidence), the best 5 slots with evidence, how the user's own ORGANIC post results compare with the audience peaks, demographics if present, and a test plan for {H} (what to post when, what to compare). Be explicit about how reliable each conclusion is.`],
  content: ['Content and captions report', `Analyse the content on every connected platform. Include: format comparison (organic posts only), caption length and hashtag effects, recurring themes in the best vs the weakest captions (read the captions in DATA), reach/saves/shares insights where present, a list of specific post ideas for {H} based on what already works, and what to stop doing.`],
  growth: ['{A} growth report', `Analyse growth and reach for the {a} period in DATA.activeView.period and each platform. Include: follower trend, reach/views and profile activity from the account insights, engagement trend over time (period.trend), posting frequency vs results, the 3 biggest growth levers supported by the data, and realistic targets for {H} expressed relative to each account's own history.`],
  promo: ['Promoted vs organic report', `Write a detailed promoted-vs-organic report for every connected platform. For each platform: how posts were detected (promo.source), the count of confirmed promoted, estimated promoted and organic posts, then a table comparing Organic vs Promoted: posts | median reach (or views) | median engagement | median engagement per reach | share of total reach. List every promoted post (platform, date, format, reach/views, engagement, ad spend/paid views when present) and flag the estimated ones as estimates. Explain what the promoted posts added on top of organic delivery, whether promoted posts were chosen from the strongest organic posts, which organic posts look like good boost candidates (strong engagement per reach, never promoted), and the caveats of each platform's data. End with concrete recommendations for {H}.`],
  compare: ['Platform comparison report', `Compare every connected platform side by side. Include: audience size and growth, posting frequency, reach or views per post, engagement per post and per follower (state each platform's definition of engagement), best formats, best times, organic vs promoted share, and the 3 clearest differences. Say which platform gives the best return on effort according to the data and why, and what cannot be compared. End with an allocation recommendation for {H}.`]
};
function reportSpec(type, period) {
  const P = PERIODS[period] || PERIODS.week, t = type === 'plan' ? PLAN[period] || PLAN.week : REPORTS[type];
  if (!t) return null;
  const f = x => x.replace(/\{A\}/g, P[1]).replace(/\{a\}/g, P[0]).replace(/\{H\}/g, P[2]);
  return [f(t[0]), f(t[1]) + ` The reporting period is ${P[0]} (DATA.activeView.period): lead with it, and use the full history as evidence.`];
}

const clip = (s, n) => String(s || '').slice(0, n);
const cleanMsgs = m => (Array.isArray(m) ? m : []).slice(-14).map(x => ({ role: x.role === 'assistant' ? 'model' : 'user', parts: [{ text: clip(x.content, 6000) }] })).filter(x => x.parts[0].text);
const bodyJSON = ctx => { const t = JSON.stringify(ctx || {}); return t.length > 700000 ? t.slice(0, 700000) + ' …[DATA TRUNCATED: say so if the answer depends on what is missing]' : t; };

/* ---------------- helpers ---------------- */
const chunked = async (items, size, fn) => {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(...await Promise.all(items.slice(i, i + size).map(fn)));
  return out;
};
const num = v => (v == null || v === '' || isNaN(+v) ? null : +v);
const parseInsight = d => d.values && d.values[0] && d.values[0].value != null ? d.values[0].value : d.total_value ? d.total_value.value : null;

// Reads a paid/organic split out of an insights response, whatever shape Meta returns it in.
function paidSplit(j, metric) {
  const d = ((j && j.data) || []).find(x => x.name === metric); if (!d) return null;
  let paid = null, org = null;
  const take = (key, val) => {
    const k = String(key).toLowerCase();
    if (/^(true|1|ads?|paid|from_ads)$/.test(k)) paid = (paid || 0) + val;
    else if (/^(false|0|organic|non_ads?|not_from_ads)$/.test(k)) org = (org || 0) + val;
  };
  const tv = d.total_value;
  if (tv && Array.isArray(tv.breakdowns)) tv.breakdowns.forEach(b => (b.results || []).forEach(r => take((r.dimension_values || []).join(','), Number(r.value) || 0)));
  (d.values || []).forEach(v => { if (v && v.value && typeof v.value === 'object') for (const k in v.value) take(k, Number(v.value[k]) || 0); });
  if (paid === null && org === null) return null;
  return { paid: paid || 0, organic: org || 0 };
}
const fixTime = t => { const d = new Date(String(t || '').replace(/([+-]\d\d)(\d\d)$/, '$1:$2')); return isNaN(d) ? null : d.toISOString(); };

/* ---------------- Instagram ---------------- */
const IG_FIELDS = 'id,caption,media_type,media_product_type,timestamp,like_count,comments_count,permalink,thumbnail_url,media_url';
const IG_SETS = {
  REELS: ['reach,saved,shares,total_interactions,views,ig_reels_avg_watch_time,ig_reels_video_view_total_time', 'reach,saved,shares,total_interactions,views', 'reach,saved,shares,total_interactions', 'reach,saved'],
  FEED: ['reach,saved,shares,total_interactions,views,follows,profile_visits', 'reach,saved,shares,total_interactions,views', 'reach,saved,shares,total_interactions', 'reach,saved,total_interactions', 'reach,saved']
};
async function igPostInsights(m, access_token, good) {
  const type = m.media_product_type === 'REELS' ? 'REELS' : 'FEED', sets = IG_SETS[type], first = good[type] || 0;
  const order = [first, ...sets.map((_, i) => i).filter(i => i !== first)];
  for (const i of order) {
    try {
      const j = await graph(`/${m.id}/insights`, { metric: sets[i], access_token }), o = {};
      (j.data || []).forEach(d => { const v = parseInsight(d); if (v != null) o[d.name] = v; });
      good[type] = i; return o;
    } catch (e) { /* try a smaller metric set */ }
  }
  return null;
}
async function igAccountInsights(id, access_token) {
  const until = Math.floor(Date.now() / 1000), since = until - 28 * 86400, o = {};
  const series = async m => (await graph(`/${id}/insights`, { metric: m, period: 'day', since, until, access_token })).data[0].values.map(v => ({ t: v.end_time, v: v.value }));
  const total = async m => (await graph(`/${id}/insights`, { metric: m, metric_type: 'total_value', period: 'day', since, until, access_token })).data[0].total_value.value;
  const demo = async b => {
    const q = { metric: 'follower_demographics', period: 'lifetime', metric_type: 'total_value', breakdown: b, access_token };
    let j; try { j = await graph(`/${id}/insights`, { ...q, timeframe: 'last_30_days' }); } catch { j = await graph(`/${id}/insights`, q); }
    return j.data[0].total_value.breakdowns[0].results.map(r => ({ k: r.dimension_values.join(' · '), v: r.value })).sort((a, b) => b.v - a.v).slice(0, 8);
  };
  const jobs = {
    reachDays: () => series('reach'), followerDays: () => series('follower_count'),
    views: () => total('views'), reach: () => total('reach'), interactions: () => total('total_interactions'),
    accountsEngaged: () => total('accounts_engaged'), profileViews: () => total('profile_views'), websiteClicks: () => total('website_clicks'),
    likes: () => total('likes'), comments: () => total('comments'), shares: () => total('shares'), saves: () => total('saves'),
    age: () => demo('age'), gender: () => demo('gender'), city: () => demo('city'), country: () => demo('country')
  };
  const keys = Object.keys(jobs), res = await Promise.allSettled(keys.map(k => jobs[k]()));
  res.forEach((r, i) => { if (r.status === 'fulfilled') o[keys[i]] = r.value; });
  return o;
}
// Paid side of boosted Instagram posts (needs the ads_read permission; silently skipped without it).
async function igAdStats(media, access_token) {
  const jobs = [];
  media.forEach(m => (m.promo && m.promo.ads || []).slice(0, 4).forEach(a => jobs.push({ m, a })));
  const list = jobs.slice(0, 30);
  await chunked(list, 6, async ({ m, a }) => {
    try {
      const j = await graph(`/${a.id}/insights`, { fields: 'reach,impressions,spend,clicks', date_preset: 'maximum', access_token });
      const r = j.data && j.data[0]; if (!r) return;
      const P = m.promo.paid = m.promo.paid || { ads: 0, reach: 0, impressions: 0, spend: 0, clicks: 0 };
      P.ads++; P.reach += num(r.reach) || 0; P.impressions += num(r.impressions) || 0; P.spend += num(r.spend) || 0; P.clicks += num(r.clicks) || 0;
    } catch (e) { /* no ad access */ }
  });
}

/* ---------------- Facebook Page ---------------- */
const FB_POST_FIELDS = 'id,message,created_time,permalink_url,full_picture,status_type,shares,attachments{media_type,type},reactions.summary(true).limit(0),comments.summary(true).limit(0)';
function fbFormat(p) {
  const a = p.attachments && p.attachments.data && p.attachments.data[0], mt = a ? String(a.media_type || '').toLowerCase() : '', ty = a ? String(a.type || '').toLowerCase() : '', link = p.permalink_url || '';
  if (/\/reel\//.test(link)) return 'Reels';
  if (mt === 'video' || /video/.test(ty)) return 'Video';
  if (mt === 'album' || ty === 'album') return 'Carousel';
  if (mt === 'photo' || ty === 'photo') return 'Photo';
  if (mt === 'link' || ty === 'share' || /link/.test(ty)) return 'Link';
  return a ? 'Other' : 'Text';
}
async function fbPostInsights(id, access_token) {
  const o = {};
  const get = async (metric, extra = {}) => {
    for (const per of [{}, { period: 'lifetime' }]) { try { return await graph(`/${id}/insights`, { metric, access_token, ...extra, ...per }); } catch (e) { /* next variant */ } }
    return null;
  };
  const [a, b] = await Promise.all([get('post_total_media_view_unique,post_media_view'), get('post_media_view', { breakdown: 'is_from_ads' })]);
  let base = a;
  if (!base) { const [r, v] = await Promise.all([get('post_total_media_view_unique'), get('post_media_view')]); base = { data: [...(r && r.data || []), ...(v && v.data || [])] }; }
  (base.data || []).forEach(d => { const v = parseInsight(d); if (v != null && typeof v !== 'object') { if (d.name === 'post_total_media_view_unique') o.reach = +v; if (d.name === 'post_media_view') o.views = +v; } });
  const sp = b && paidSplit(b, 'post_media_view');
  if (sp) { o.paid_views = sp.paid; o.organic_views = sp.organic; if (o.views == null) o.views = sp.paid + sp.organic; }
  return Object.keys(o).length ? o : null;
}
async function fbPageInsights(id, token) {
  const until = Math.floor(Date.now() / 1000), since = until - 28 * 86400, o = {};
  const first = async (p, params) => { const j = await graph(`/${id}/insights`, { access_token: token, ...params }); return (j.data || [])[0]; };
  const day = async m => ((await first(id, { metric: m, period: 'day', since, until })).values || []).map(v => ({ t: v.end_time, v: Number(v.value) || 0 }));
  const d28 = async m => { const d = await first(id, { metric: m, period: 'days_28' }); const v = d && d.values && d.values[d.values.length - 1]; return v ? Number(v.value) : null; };
  const geo = async m => { const d = await first(id, { metric: m, period: 'day' }); const v = d && d.values && d.values[d.values.length - 1], val = v && v.value; if (!val || typeof val !== 'object') throw new Error('none'); return Object.entries(val).map(([k, x]) => ({ k, v: Number(x) })).sort((a, b) => b.v - a.v).slice(0, 8); };
  const split = async () => { const j = await graph(`/${id}/insights`, { metric: 'page_media_view', period: 'days_28', breakdown: 'is_from_ads', access_token: token }); const s = paidSplit(j, 'page_media_view'); if (!s) throw new Error('none'); return s; };
  const jobs = {
    viewsDays: () => day('page_media_view'), reachDays: () => day('page_total_media_view_unique'), reach: () => d28('page_total_media_view_unique'),
    engDays: () => day('page_post_engagements'), followDays: () => day('page_daily_follows_unique'), unfollowDays: () => day('page_daily_unfollows_unique'),
    pageViewsDays: () => day('page_views_total'), viewsSplit: split, country: () => geo('page_follows_country'), city: () => geo('page_follows_city')
  };
  const keys = Object.keys(jobs), res = await Promise.allSettled(keys.map(k => jobs[k]()));
  res.forEach((r, i) => { if (r.status === 'fulfilled' && r.value != null) o[keys[i]] = r.value; });
  const sum = a => a ? a.reduce((x, y) => x + y.v, 0) : null;
  if (o.viewsDays) o.views = sum(o.viewsDays);
  if (o.engDays) o.interactions = sum(o.engDays);
  if (o.followDays) o.newFollows = sum(o.followDays);
  if (o.unfollowDays) o.unfollows = sum(o.unfollowDays);
  if (o.pageViewsDays) o.profileViews = sum(o.pageViewsDays);
  return o;
}

module.exports = async (req, res) => {
  const { META_APP_ID: ID, META_APP_SECRET: SECRET, SUPABASE_URL, SUPABASE_SERVICE_KEY, DASH_PASSWORD, TIKTOK_CLIENT_KEY: TTK, TIKTOK_CLIENT_SECRET: TTS } = process.env;
  const base = (process.env.BASE_URL || `https://${req.headers['x-forwarded-host'] || req.headers.host}`).replace(/\/$/, '');
  const REDIRECT = base + '/api/callback', TT_REDIRECT = base + '/api/ttcallback';
  const action = req.query.action;
  const configured = !!(ID && SECRET && SUPABASE_URL && SUPABASE_SERVICE_KEY && DASH_PASSWORD);
  const ttConfigured = !!(TTK && TTS);
  const cookie = (n, v, age) => `${n}=${v}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${age}`;

  try {
    if (action === 'status') {
      const me = configured ? await who(req) : null;
      let plats = { ig: false, fb: false, tt: false }, names = {}, perms = [];
      if (me) {
        const [s, st] = await Promise.all([getSession(), getSettings()]);
        plats = { ig: !!(s && s.ig_id), fb: !!(st.fb_page_id && st.fb_page_token), tt: !!(st.tt_refresh || st.tt_access) };
        names = { fb: st.fb_page_name || '', meta: (s && s.page_name) || '' };
        perms = (st.meta_perms || '').split(',').filter(Boolean);
      }
      return json(res, 200, { configured, authed: !!me, role: me && me.role, name: me && me.name, canAI: !!me && (me.role === 'owner' || me.role === 'viewer_ai'), connected: plats.ig || plats.fb || plats.tt, plats, names, perms, ttConfigured });
    }
    if (action === 'signout') {
      res.setHeader('Set-Cookie', ['sid=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0', 'tid=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0']);
      return redirect(res, '/');
    }
    if (!configured) return json(res, 500, { error: 'Environment variables are missing.' });

    if (action === 'auth' && req.method === 'POST') {
      const pw = String((req.body && req.body.password) || '');
      const set = (n, v) => `${n}=${v}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=2592000`, exp = n => `${n}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;
      if (passwordOk(pw)) { res.setHeader('Set-Cookie', [set('sid', sig()), exp('tid')]); return json(res, 200, { ok: true, role: 'owner' }); }
      const row = await teamByCode(pw); // not the owner password: maybe a team access code
      if (!row) { await new Promise(r => setTimeout(r, 700)); return json(res, 401, { error: 'Wrong password or access code.' }); }
      teamTouch(row.id).catch(() => {});
      res.setHeader('Set-Cookie', [set('tid', tokenFor(row)), exp('sid')]);
      return json(res, 200, { ok: true, role: row.role });
    }

    const me = await who(req);
    if (!me) return json(res, 401, { error: 'Password required.' });
    const owner = me.role === 'owner';
    if (['login', 'callback', 'logout', 'settings', 'team', 'ttlogin', 'ttcallback', 'ttlogout', 'promo'].includes(action) && !owner) return json(res, 403, { error: 'Only the owner can do this.' });

    /* ---------- Team access codes (owner only) ---------- */
    if (action === 'team') {
      if (req.method !== 'POST') return json(res, 200, { members: await teamList() });
      const b = req.body || {};
      try {
        if (b.del) { await teamDel(b.del); return json(res, 200, { members: await teamList() }); }
        const name = String(b.name || '').trim().slice(0, 40), role = b.role === 'viewer_ai' ? 'viewer_ai' : 'viewer';
        if (!name) return json(res, 400, { error: 'Give this person a name first.' });
        if ((await teamList()).length >= 20) return json(res, 400, { error: 'You can have up to 20 team members. Revoke one first.' });
        const { code } = await teamAdd(name, role);
        return json(res, 200, { code, members: await teamList() });
      } catch (e) { return json(res, 400, { error: e.message }); }
    }

    /* ---------- Meta login: Instagram + Facebook Page in one go ---------- */
    if (action === 'login') {
      const basic = 'instagram_basic,instagram_manage_insights,pages_show_list,pages_read_engagement';
      // ?basic=1 is the fallback link on the connect screen if Meta rejects the extra permissions.
      const scope = process.env.META_SCOPES || (req.query.basic ? basic : basic + ',read_insights,ads_read');
      const q = process.env.META_CONFIG_ID // Facebook Login for Business uses a configuration instead of scopes
        ? `config_id=${process.env.META_CONFIG_ID}&response_type=code&override_default_response_type=true`
        : `scope=${scope}&response_type=code`;
      return redirect(res, `https://www.facebook.com/v23.0/dialog/oauth?client_id=${ID}&redirect_uri=${encodeURIComponent(REDIRECT)}&${q}`);
    }

    if (action === 'callback') {
      if (req.query.error || !req.query.code) return fail(res, 'Meta login was cancelled or denied.');
      const short = await graph('/oauth/access_token', { client_id: ID, client_secret: SECRET, redirect_uri: REDIRECT, code: req.query.code });
      const long = await graph('/oauth/access_token', { grant_type: 'fb_exchange_token', client_id: ID, client_secret: SECRET, fb_exchange_token: short.access_token });
      const pages = await graph('/me/accounts', { fields: 'name,access_token,instagram_business_account{id,username},connected_instagram_account{id,username}', limit: 100, access_token: long.access_token });
      const list = pages.data || [];
      const hit = list.find(p => p.instagram_business_account || p.connected_instagram_account) || list[0];
      if (!hit) return fail(res, 'Meta returned no Pages for this login. Reconnect and make sure the Page is selected and allowed on the login screen. If the Page belongs to a business portfolio, add the business_management permission (or set META_SCOPES) and reconnect.');
      const ig = hit.instagram_business_account || hit.connected_instagram_account;
      const r = await saveSession({ token: long.access_token, ig_id: ig ? ig.id : '', page_name: hit.name });
      if (!r.ok) return fail(res, 'Could not save the login to Supabase: ' + (await r.text()));
      if (hit.access_token) { try { await saveFb({ id: hit.id, token: hit.access_token, name: hit.name }); } catch (e) { return fail(res, e.message); } }
      try { const pm = await graph('/me/permissions', { access_token: long.access_token }); await setSetting('meta_perms', (pm.data || []).filter(x => x.status === 'granted').map(x => x.permission).join(',')); } catch (e) { /* optional */ }
      return redirect(res, '/');
    }

    if (action === 'logout') { await clearSession(); await clearFb(); return redirect(res, '/'); }

    /* ---------- TikTok login (Login Kit v2) ---------- */
    if (action === 'ttlogin') {
      if (!ttConfigured) return fail(res, 'Add TIKTOK_CLIENT_KEY and TIKTOK_CLIENT_SECRET in Vercel, redeploy, then try again.');
      const state = crypto.randomBytes(16).toString('hex');
      res.setHeader('Set-Cookie', cookie('ttstate', state, 600));
      return redirect(res, `https://www.tiktok.com/v2/auth/authorize/?client_key=${encodeURIComponent(TTK)}&scope=${encodeURIComponent('user.info.basic,user.info.profile,user.info.stats,video.list')}&response_type=code&redirect_uri=${encodeURIComponent(TT_REDIRECT)}&state=${state}`);
    }
    if (action === 'ttcallback') {
      if (req.query.error || !req.query.code) return fail(res, 'TikTok login was cancelled or denied' + (req.query.error_description ? ': ' + req.query.error_description : '.'));
      const m = (req.headers.cookie || '').match(/(?:^|; )ttstate=([a-f0-9]+)/);
      if (!m || m[1] !== String(req.query.state || '')) return fail(res, 'The TikTok login could not be verified (state mismatch). Start again from Settings.');
      try {
        const j = await ttToken({ client_key: TTK, client_secret: TTS, code: req.query.code, grant_type: 'authorization_code', redirect_uri: TT_REDIRECT });
        await ttSaveTokens(j);
      } catch (e) { return fail(res, e.message + ' (the redirect URI in the TikTok developer portal must be exactly ' + TT_REDIRECT + ')'); }
      res.setHeader('Set-Cookie', cookie('ttstate', '', 0));
      return redirect(res, '/');
    }
    if (action === 'ttlogout') {
      try { const a = await ttAccess(); if (a && ttConfigured) await fetch('https://open.tiktokapis.com/v2/oauth/revoke/', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_key: TTK, client_secret: TTS, token: a.token }), signal: AbortSignal.timeout(8000) }); } catch (e) { /* revoke is best-effort */ }
      await ttClear(); return redirect(res, '/');
    }

    /* ---------- manual promoted / organic marks (owner only) ---------- */
    if (action === 'promo' && req.method === 'POST') {
      const b = req.body || {}, key = String(b.platform || '') + ':' + String(b.id || '');
      if (!/^(ig|fb|tt):[A-Za-z0-9_.-]{3,80}$/.test(key)) return json(res, 400, { error: 'Bad post reference.' });
      if (!['paid', 'organic', 'auto'].includes(b.mark)) return json(res, 400, { error: 'Bad mark.' });
      try {
        const st = await getSettings(); let o = {}; try { o = JSON.parse(st.promo_overrides || '{}'); } catch { o = {}; }
        if (b.mark === 'auto') delete o[key]; else o[key] = b.mark;
        await setSetting('promo_overrides', JSON.stringify(o));
        return json(res, 200, { overrides: o });
      } catch (e) { return json(res, 400, { error: e.message }); }
    }

    /* ---------- Gemini settings (the key never goes back to the browser) ---------- */
    if (action === 'settings') {
      const st = await getSettings();
      if (req.method !== 'POST') {
        const v = aiView(st);
        if (req.query.models) { try { v.models = v.has ? await listModels(st.gemini_key || process.env.GEMINI_API_KEY) : []; } catch (e) { v.models = []; v.modelsError = e.message; } }
        return json(res, 200, v);
      }
      const b = req.body || {};
      try {
        if (b.list) {
          const lk = String(b.key || '').trim().replace(/^["']+|["']+$/g, '') || st.gemini_key || process.env.GEMINI_API_KEY;
          if (!lk) return json(res, 400, { error: 'Paste your Gemini API key first.' });
          try { return json(res, 200, { models: await listModels(lk) }); } catch (e) { return json(res, 400, { error: 'Google rejected the key: ' + e.message }); }
        }
        if (b.clear) { await delSetting('gemini_key'); delete st.gemini_key; return json(res, 200, aiView(st)); }
        const ok = m => /^[A-Za-z0-9._-]{3,60}$/.test(m);
        const model = fixModel(b.model || st.gemini_model);
        const backup = b.backup === undefined ? (st.gemini_backup || '') : String(b.backup || '').trim().replace(/^models\//, '');
        if (!ok(model) || (backup && !ok(backup))) return json(res, 400, { error: 'Model name looks invalid.' });
        const gk = String(b.key || '').trim().replace(/^["']+|["']+$/g, '');
        if (gk && !/^[\x21-\x7E]{15,500}$/.test(gk)) return json(res, 400, { error: 'The key has spaces or line breaks in it. Copy it again and paste only the key.' });
        const key = gk || st.gemini_key || process.env.GEMINI_API_KEY;
        if (!key) return json(res, 400, { error: 'Paste your Gemini API key first.' });
        const warn = [];
        for (const m of [model, backup].filter(Boolean)) {
          try { await gemini({ key, model: m, plain: true, contents: [{ role: 'user', parts: [{ text: 'Reply with the single word OK.' }] }] }); }
          catch (e) {
            if (/demand|overload|unavailable|quota|rate.?limit|429|503|exhaust|busy/i.test(e.message)) { warn.push(m + ' is busy right now'); continue; } // the key is fine, the model is just busy
            return json(res, 400, { error: 'Gemini rejected ' + m + ': ' + e.message });
          }
        }
        if (gk) { await setSetting('gemini_key', gk); st.gemini_key = gk; }
        await setSetting('gemini_model', model); st.gemini_model = model;
        if (backup) await setSetting('gemini_backup', backup); else await delSetting('gemini_backup');
        st.gemini_backup = backup;
        return json(res, 200, { ...aiView(st), warn: warn.join('; ') });
      } catch (e) { return json(res, 400, { error: e.message }); }
    }

    /* ---------- AI chat and reports (tries the best option first, falls back automatically) ---------- */
    if ((action === 'chat' || action === 'report') && req.method === 'POST') {
      if (!(owner || me.role === 'viewer_ai')) return json(res, 403, { error: 'Your access does not include the AI agent.' });
      const st = await getSettings(), b = req.body || {};
      if (!aiView(st).has) return json(res, 400, { error: 'Add an AI key in Settings first.' });
      const data = bodyJSON(b.context);
      try {
        if (action === 'report') {
          const R = reportSpec(b.type, b.period); if (!R) return json(res, 400, { error: 'Unknown report type.' });
          const o = await askAI(st, { maxTokens: 16384, temperature: 0.3, cap: 45000, system: BASE + '\n\nDATA:\n' + data,
            contents: [{ role: 'user', parts: [{ text: R[1] + ' Start with a single H1 title: "' + R[0] + '".' }] }] });
          return json(res, 200, { md: o.text, title: R[0], via: o.via, fb: o.fb });
        }
        const contents = cleanMsgs(b.messages);
        if (!contents.length || contents[contents.length - 1].role !== 'user') return json(res, 400, { error: 'Empty message.' });
        const o = await askAI(st, { maxTokens: 8192, temperature: 0.3, cap: 25000, system: BASE + '\nIn chat, keep answers focused (under 220 words) unless the user asks for a detailed analysis or report: then be thorough and use every relevant number in DATA. Keep tables to at most 4 columns so they read well on a phone.\n\nDATA:\n' + data, contents });
        return json(res, 200, { reply: o.text, via: o.via, fb: o.fb });
      } catch (e) { return json(res, 400, { error: e.message }); }
    }

    /* ---------- Instagram data ---------- */
    if (action === 'data') {
      const s = await getSession();
      if (!s || !s.ig_id) return json(res, 401, { error: 'Instagram is not connected.' });
      const access_token = s.token;
      try {
        const [profile, st] = await Promise.all([
          graph(`/${s.ig_id}`, { fields: 'username,name,followers_count,follows_count,media_count,profile_picture_url', access_token }),
          getSettings()
        ]);
        // boost_ads_list tells us which posts were boosted as ads. If this token cannot read it, retry without it.
        let first, boostField = true;
        try { first = await graph(`/${s.ig_id}/media`, { fields: IG_FIELDS + ',boost_ads_list', limit: 50, access_token }); }
        catch (e) { boostField = false; first = await graph(`/${s.ig_id}/media`, { fields: IG_FIELDS, limit: 50, access_token }); }
        let media = first.data, next = first.paging && first.paging.next;
        for (let i = 0; i < 2 && next; i++) { const n = await graph(next); media = media.concat(n.data); next = n.paging && n.paging.next; }
        // The field only counts as working if at least one post carries it (it is omitted when the token has no ad access).
        const boostOk = boostField && media.some(m => Array.isArray(m.boost_ads_list));
        media.forEach(m => {
          m.platform = 'ig';
          const ads = Array.isArray(m.boost_ads_list) ? m.boost_ads_list.map(a => ({ id: String(a.ad_id || a.id || ''), status: String(a.ad_status || a.status || '') })).filter(a => a.id) : [];
          m.promo = boostOk ? { flag: ads.length > 0, src: 'meta_ads', ads } : { flag: null, src: null };
          delete m.boost_ads_list;
        });
        let online = null;
        try { online = (await graph(`/${s.ig_id}/insights`, { metric: 'online_followers', period: 'lifetime', access_token })).data[0].values; } catch {}
        // Per-post reach / saves / shares / views for the 40 newest posts, account-level insights and ad spend for boosted posts, all in parallel.
        const good = {};
        const [ins, insights] = await Promise.all([
          chunked(media.slice(0, 40), 10, m => igPostInsights(m, access_token, good)),
          igAccountInsights(s.ig_id, access_token).catch(() => ({})),
          boostOk ? igAdStats(media.filter(m => m.promo.ads.length), access_token) : null
        ]);
        ins.forEach((x, i) => { if (x) media[i].ins = x; });
        let overrides = {}; try { overrides = JSON.parse(st.promo_overrides || '{}'); } catch {}
        res.setHeader('Cache-Control', 'private, max-age=60');
        return json(res, 200, { platform: 'ig', profile, media, online, insights, promoApi: boostOk, overrides, fetchedAt: new Date().toISOString() });
      } catch (e) { return json(res, 400, { error: e.message + ' — try reconnecting.' }); }
    }

    /* ---------- Facebook Page data ---------- */
    if (action === 'fbdata') {
      const f = await getFb();
      if (!f) return json(res, 401, { error: 'No Facebook Page connected. Reconnect with Meta in Settings.' });
      const token = f.token;
      try {
        const [p, st] = await Promise.all([
          graph(`/${f.id}`, { fields: 'name,username,fan_count,followers_count,link,picture.width(200).height(200)', access_token: token }),
          getSettings()
        ]);
        const first = await graph(`/${f.id}/published_posts`, { fields: FB_POST_FIELDS, limit: 50, access_token: token });
        let posts = first.data || [], next = first.paging && first.paging.next;
        for (let i = 0; i < 2 && next; i++) { try { const n = await graph(next); posts = posts.concat(n.data || []); next = n.paging && n.paging.next; } catch (e) { break; } }
        const media = posts.map(x => ({
          id: x.id, platform: 'fb', caption: x.message || '', timestamp: fixTime(x.created_time),
          like_count: num(x.reactions && x.reactions.summary && x.reactions.summary.total_count) || 0,
          comments_count: num(x.comments && x.comments.summary && x.comments.summary.total_count) || 0,
          shares: num(x.shares && x.shares.count) || 0, permalink: x.permalink_url || '', thumbnail_url: x.full_picture || '', media_url: x.full_picture || '',
          fmt: fbFormat(x), promo: { flag: null, src: null }
        })).filter(x => x.timestamp);
        const [ins, insights] = await Promise.all([
          chunked(media.slice(0, 40), 8, m => fbPostInsights(m.id, token).catch(() => null)),
          fbPageInsights(f.id, token).catch(() => ({}))
        ]);
        ins.forEach((x, i) => {
          if (!x) return; media[i].ins = x;
          if (x.paid_views != null) media[i].promo = { flag: x.paid_views > 0, src: 'meta_insights' };
        });
        const promoApi = media.some(m => m.promo.src);
        const followers = p.followers_count || p.fan_count || 0;
        let overrides = {}; try { overrides = JSON.parse(st.promo_overrides || '{}'); } catch {}
        res.setHeader('Cache-Control', 'private, max-age=60');
        return json(res, 200, { platform: 'fb', profile: { username: p.username || p.name, name: p.name, followers_count: followers, media_count: media.length, profile_picture_url: p.picture && p.picture.data && p.picture.data.url || '', link: p.link || '' }, media, online: null, insights, promoApi, overrides, fetchedAt: new Date().toISOString() });
      } catch (e) { return json(res, 400, { error: e.message + ' — try reconnecting with Meta (the Page needs the pages_read_engagement and read_insights permissions).' }); }
    }

    /* ---------- TikTok data ---------- */
    if (action === 'ttdata') {
      let a;
      try { a = await ttAccess(); } catch (e) { return json(res, 400, { error: e.message + ' — reconnect TikTok in Settings.' }); }
      if (!a) return json(res, 401, { error: 'TikTok is not connected.' });
      try {
        const st = await getSettings();
        let u;
        try { u = (await ttApi('/user/info/?fields=open_id,avatar_url,display_name,bio_description,profile_deep_link,is_verified,username,follower_count,following_count,likes_count,video_count', { token: a.token })).user; }
        catch (e) { u = (await ttApi('/user/info/?fields=open_id,avatar_url,display_name', { token: a.token })).user; }
        u = u || {};
        const VF = 'id,title,video_description,duration,cover_image_url,share_url,create_time,view_count,like_count,comment_count,share_count';
        let vids = [], cursor, more = true;
        for (let i = 0; i < 5 && more; i++) { // 20 per page, newest 100
          const d = await ttApi('/video/list/?fields=' + VF, { method: 'POST', token: a.token, body: { max_count: 20, ...(cursor ? { cursor } : {}) } });
          vids = vids.concat(d.videos || []); more = !!d.has_more; cursor = d.cursor;
        }
        const media = vids.map(v => ({
          id: String(v.id), platform: 'tt', caption: v.title || v.video_description || '', timestamp: new Date((v.create_time || 0) * 1000).toISOString(),
          like_count: num(v.like_count) || 0, comments_count: num(v.comment_count) || 0, shares: num(v.share_count) || 0,
          permalink: v.share_url || '', thumbnail_url: v.cover_image_url || '', media_url: v.cover_image_url || '', fmt: 'Video', duration: num(v.duration),
          ins: { views: num(v.view_count) || 0, shares: num(v.share_count) || 0 }, promo: { flag: null, src: null } // TikTok's Display API has no ad flag
        })).filter((x, i) => vids[i].create_time);
        let overrides = {}; try { overrides = JSON.parse(st.promo_overrides || '{}'); } catch {}
        res.setHeader('Cache-Control', 'private, max-age=60');
        return json(res, 200, { platform: 'tt', profile: { username: u.username || u.display_name || 'tiktok', name: u.display_name || '', followers_count: u.follower_count || 0, following: u.following_count || 0, likes_total: u.likes_count || 0, media_count: u.video_count != null ? u.video_count : media.length, profile_picture_url: u.avatar_url || '', link: u.profile_deep_link || '', verified: !!u.is_verified }, media, online: null, insights: { totalLikes: u.likes_count ?? null, totalVideos: u.video_count ?? null, following: u.following_count ?? null }, promoApi: false, overrides, fetchedAt: new Date().toISOString() });
      } catch (e) { return json(res, 400, { error: e.message }); }
    }
    json(res, 404, { error: 'Not found' });
  } catch (e) { fail(res, e.message); }
};
