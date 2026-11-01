const { graph, getSession, saveSession, clearSession, getSettings, setSetting, delSetting, gemini, sig, authed, passwordOk } = require('../lib/common');

const redirect = (res, to) => { res.statusCode = 302; res.setHeader('Location', to); res.end(); };
const json = (res, code, obj) => { res.statusCode = code; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(obj)); };
const fail = (res, msg) => { res.statusCode = 400; res.setHeader('Content-Type', 'text/html'); res.end(`<body style="font:16px system-ui;padding:40px;max-width:560px"><h3>Couldn't connect</h3><p>${String(msg).replace(/</g, '&lt;')}</p><a href="/">Back</a>`); };

/* ---------------- AI prompts ---------------- */
const BASE = `You are Vex, the analytics strategist inside Vexalytics, a private Instagram analytics dashboard.
You receive DATA: a JSON digest of the account (profile, KPIs, timing, formats, captions, demographics, account-level insights and every analysed post).
Rules:
- Use ONLY numbers that appear in DATA. Never invent metrics, benchmarks or competitor figures. If something is missing, say so.
- Every time you make a claim, give the evidence (number and sample size n). When n is below 5, say the sample is small.
- All times are Algeria time (UTC+1). Dates are YYYY-MM-DD.
- "e" is likes + comments. Posts under 48 hours old ("mature":false) and posts with hidden likes are excluded from performance stats.
- Be direct and practical. No filler, no generic social-media advice that the data does not support.
- Reply in the language the user writes in (default English). Use Markdown: short headings, tables where useful, bullet lists for actions.`;

const REPORTS = {
  full: ['Full performance report', `Write a complete performance report using the WHOLE dataset. Sections: 1) Executive summary (5 lines max), 2) Account snapshot (table of KPIs), 3) What is working (with evidence), 4) What is not working (with evidence), 5) Best times and audience, 6) Content and format analysis, 7) Top 5 and bottom 3 posts and why they differ, 8) Priority actions for the next 30 days (max 7, ordered by impact, each with the metric to watch), 9) Data caveats.`],
  plan: ['30-day content plan', `Build a concrete 30-day content plan from the data. Start with 4 lines on the strategy and the posting rhythm the data supports. Then a table per week: Day | Time (Algeria) | Format | Content idea (based on themes of the best captions) | Goal. Use the best days/times and best formats from DATA. End with the 3 metrics to track weekly and what result would mean the plan works.`],
  timing: ['Timing and audience report', `Analyse WHEN to post and WHO the audience is. Include: the audience-online pattern (source and confidence), the best 5 slots with evidence, how the user's own post results compare with the audience peaks, demographics if present, and a 3-week timing test plan (what to post when, what to compare). Be explicit about how reliable each conclusion is.`],
  content: ['Content and captions report', `Analyse the content. Include: format comparison, caption length and hashtag effects, recurring themes in the best vs the weakest captions (read the captions in DATA), reach/saves/shares insights where present, a list of 10 specific post ideas based on what already works, and what to stop doing.`],
  growth: ['Growth report', `Analyse growth and reach. Include: follower trend, reach and profile activity from the account insights, engagement trend over time (use post dates), posting frequency vs results, the 3 biggest growth levers supported by the data, and realistic 30-day targets expressed relative to the account's own history.`]
};

const clip = (s, n) => String(s || '').slice(0, n);
const cleanMsgs = m => (Array.isArray(m) ? m : []).slice(-14).map(x => ({ role: x.role === 'assistant' ? 'model' : 'user', parts: [{ text: clip(x.content, 6000) }] })).filter(x => x.parts[0].text);

/* ---------------- per-post and account insights ---------------- */
const SETS = ['reach,saved,shares,total_interactions,views', 'reach,saved,shares,total_interactions', 'reach,saved,total_interactions', 'reach,saved'];
async function postInsights(id, access_token) {
  for (const metric of SETS) {
    try {
      const j = await graph(`/${id}/insights`, { metric, access_token }), o = {};
      (j.data || []).forEach(d => { const v = d.values && d.values[0] ? d.values[0].value : d.total_value ? d.total_value.value : null; if (v != null) o[d.name] = v; });
      return o;
    } catch (e) { /* try a smaller metric set */ }
  }
  return null;
}
async function chunked(items, size, fn) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(...await Promise.all(items.slice(i, i + size).map(fn)));
  return out;
}
async function accountInsights(id, access_token) {
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
    age: () => demo('age'), gender: () => demo('gender'), city: () => demo('city'), country: () => demo('country')
  };
  const keys = Object.keys(jobs), res = await Promise.allSettled(keys.map(k => jobs[k]()));
  res.forEach((r, i) => { if (r.status === 'fulfilled') o[keys[i]] = r.value; });
  return o;
}

module.exports = async (req, res) => {
  const { META_APP_ID: ID, META_APP_SECRET: SECRET, SUPABASE_URL, SUPABASE_SERVICE_KEY, DASH_PASSWORD } = process.env;
  const base = (process.env.BASE_URL || `https://${req.headers['x-forwarded-host'] || req.headers.host}`).replace(/\/$/, '');
  const REDIRECT = base + '/api/callback';
  const action = req.query.action;
  const configured = !!(ID && SECRET && SUPABASE_URL && SUPABASE_SERVICE_KEY && DASH_PASSWORD);

  try {
    if (action === 'status') {
      const ok = authed(req);
      return json(res, 200, { configured, authed: ok, connected: configured && ok ? !!(await getSession()) : false });
    }
    if (!configured) return json(res, 500, { error: 'Environment variables are missing.' });

    if (action === 'auth' && req.method === 'POST') {
      const pw = (req.body && req.body.password) || '';
      if (!passwordOk(pw)) return json(res, 401, { error: 'Wrong password.' });
      res.setHeader('Set-Cookie', `sid=${sig()}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=2592000`);
      return json(res, 200, { ok: true });
    }

    if (!authed(req)) return json(res, 401, { error: 'Password required.' });

    if (action === 'login') {
      const scope = 'instagram_basic,instagram_manage_insights,pages_show_list,pages_read_engagement';
      const q = process.env.META_CONFIG_ID // Facebook Login for Business uses a configuration instead of scopes
        ? `config_id=${process.env.META_CONFIG_ID}&response_type=code&override_default_response_type=true`
        : `scope=${scope}&response_type=code`;
      return redirect(res, `https://www.facebook.com/v23.0/dialog/oauth?client_id=${ID}&redirect_uri=${encodeURIComponent(REDIRECT)}&${q}`);
    }

    if (action === 'callback') {
      if (req.query.error || !req.query.code) return fail(res, 'Meta login was cancelled or denied.');
      const short = await graph('/oauth/access_token', { client_id: ID, client_secret: SECRET, redirect_uri: REDIRECT, code: req.query.code });
      const long = await graph('/oauth/access_token', { grant_type: 'fb_exchange_token', client_id: ID, client_secret: SECRET, fb_exchange_token: short.access_token });
      const pages = await graph('/me/accounts', { fields: 'name,instagram_business_account{id,username},connected_instagram_account{id,username}', access_token: long.access_token });
      const list = pages.data || [];
      const hit = list.find(p => p.instagram_business_account || p.connected_instagram_account);
      if (!hit) return fail(res, list.length
        ? 'Meta returned these Pages, but none has a linked Instagram professional account: ' + list.map(p => p.name).join(', ') + '. Link your Instagram to the Page in Page settings, then reconnect.'
        : 'Meta returned no Pages for this login. Reconnect and make sure the Page is selected and allowed on the login screen. If the Page belongs to a business portfolio, tell Claude.');
      hit.instagram_business_account = hit.instagram_business_account || hit.connected_instagram_account;
      const r = await saveSession({ token: long.access_token, ig_id: hit.instagram_business_account.id, page_name: hit.name });
      if (!r.ok) return fail(res, 'Could not save the login to Supabase: ' + (await r.text()));
      return redirect(res, '/');
    }

    if (action === 'logout') { await clearSession(); return redirect(res, '/'); }

    /* ---------- Gemini settings (the key never goes back to the browser) ---------- */
    if (action === 'settings') {
      const st = await getSettings(), envKey = process.env.GEMINI_API_KEY || '';
      const view = () => { const k = st.gemini_key || envKey; return { has: !!k, masked: k ? '••••' + k.slice(-4) : '', model: st.gemini_model || 'gemini-2.5-flash', fromEnv: !st.gemini_key && !!envKey }; };
      if (req.method !== 'POST') return json(res, 200, view());
      const b = req.body || {};
      if (b.clear) { await delSetting('gemini_key'); delete st.gemini_key; return json(res, 200, view()); }
      const model = String(b.model || st.gemini_model || 'gemini-2.5-flash').trim().replace(/^models\//, '');
      if (!/^[A-Za-z0-9._-]{3,60}$/.test(model)) return json(res, 400, { error: 'Model name looks invalid.' });
      const key = String(b.key || '').trim();
      if (key) {
        if (!/^[A-Za-z0-9_-]{20,}$/.test(key)) return json(res, 400, { error: 'That does not look like a Gemini API key.' });
        try { await gemini({ key, model, system: 'Reply with the single word OK.', contents: [{ role: 'user', parts: [{ text: 'ping' }] }], maxTokens: 256 }); }
        catch (e) { return json(res, 400, { error: 'Gemini rejected it: ' + e.message }); }
        await setSetting('gemini_key', key); st.gemini_key = key;
      } else if (!(st.gemini_key || envKey)) return json(res, 400, { error: 'Paste your Gemini API key first.' });
      await setSetting('gemini_model', model); st.gemini_model = model;
      return json(res, 200, view());
    }

    /* ---------- AI chat and reports ---------- */
    if ((action === 'chat' || action === 'report') && req.method === 'POST') {
      const st = await getSettings(), key = st.gemini_key || process.env.GEMINI_API_KEY;
      if (!key) return json(res, 400, { error: 'Add your Gemini API key in Settings first.' });
      const model = st.gemini_model || 'gemini-2.5-flash', b = req.body || {};
      const data = clip(JSON.stringify(b.context || {}), 150000);
      try {
        if (action === 'report') {
          const R = REPORTS[b.type]; if (!R) return json(res, 400, { error: 'Unknown report type.' });
          const md = await gemini({ key, model, maxTokens: 16384, temperature: 0.4, system: BASE + '\n\nDATA:\n' + data,
            contents: [{ role: 'user', parts: [{ text: R[1] + ' Start with a single H1 title: "' + R[0] + '".' }] }] });
          return json(res, 200, { md, title: R[0] });
        }
        const contents = cleanMsgs(b.messages);
        if (!contents.length || contents[contents.length - 1].role !== 'user') return json(res, 400, { error: 'Empty message.' });
        const reply = await gemini({ key, model, maxTokens: 8192, system: BASE + '\nIn chat, keep answers short (under 180 words) unless asked for detail.\n\nDATA:\n' + data, contents });
        return json(res, 200, { reply });
      } catch (e) { return json(res, 400, { error: e.message }); }
    }

    if (action === 'data') {
      const s = await getSession();
      if (!s) return json(res, 401, { error: 'Not connected.' });
      const access_token = s.token;
      try {
        const profile = await graph(`/${s.ig_id}`, { fields: 'username,name,followers_count,media_count,profile_picture_url', access_token });
        const first = await graph(`/${s.ig_id}/media`, { fields: 'id,caption,media_type,media_product_type,timestamp,like_count,comments_count,permalink,thumbnail_url,media_url', limit: 50, access_token });
        let media = first.data, next = first.paging && first.paging.next;
        for (let i = 0; i < 2 && next; i++) { const n = await graph(next); media = media.concat(n.data); next = n.paging && n.paging.next; }
        let online = null;
        try { online = (await graph(`/${s.ig_id}/insights`, { metric: 'online_followers', period: 'lifetime', access_token })).data[0].values; } catch {}
        // Per-post reach / saves / shares / views for the 40 newest posts, plus account-level insights, all in parallel.
        const [ins, insights] = await Promise.all([
          chunked(media.slice(0, 40), 10, m => postInsights(m.id, access_token)),
          accountInsights(s.ig_id, access_token).catch(() => ({}))
        ]);
        ins.forEach((x, i) => { if (x) media[i].ins = x; });
        res.setHeader('Cache-Control', 'private, max-age=60');
        return json(res, 200, { profile, media, online, insights, fetchedAt: new Date().toISOString() });
      } catch (e) { return json(res, 400, { error: e.message + ' — try reconnecting.' }); }
    }
    json(res, 404, { error: 'Not found' });
  } catch (e) { fail(res, e.message); }
};
