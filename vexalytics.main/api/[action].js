const { graph, getSession, saveSession, clearSession, sig, authed, passwordOk } = require('../lib/common');

const redirect = (res, to) => { res.statusCode = 302; res.setHeader('Location', to); res.end(); };
const json = (res, code, obj) => { res.statusCode = code; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(obj)); };
const fail = (res, msg) => { res.statusCode = 400; res.setHeader('Content-Type', 'text/html'); res.end(`<body style="font:16px system-ui;padding:40px;max-width:560px"><h3>Couldn't connect</h3><p>${String(msg).replace(/</g, '&lt;')}</p><a href="/">Back</a>`); };

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
        return json(res, 200, { profile, media, online });
      } catch (e) { return json(res, 400, { error: e.message + ' — try reconnecting.' }); }
    }
    json(res, 404, { error: 'Not found' });
  } catch (e) { fail(res, e.message); }
};
