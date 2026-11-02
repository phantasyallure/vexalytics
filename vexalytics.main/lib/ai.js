// Multi-provider AI with automatic fallback: best option first, then the next, then lower ones.
const { gemini, fixModel, setSetting } = require('./common');
const LABEL = { claude: 'Claude', openai: 'ChatGPT', gemini: 'Gemini' };
const DEF = { claude: 'claude-opus-5-5, claude-sonnet-5-5, claude-haiku-5-5', openai: 'gpt-5, gpt-5-mini' };
const LIMIT = /quota|rate.?limit|429|overload|exhaust|credit|billing|insufficient|capacity|too many|resource|busy|529|503|timeout|did not answer|stalled/i;
const list = s => String(s || '').split(',').map(x => x.trim()).filter(Boolean);
const toMsgs = c => c.map(m => ({ role: m.role === 'model' || m.role === 'assistant' ? 'assistant' : 'user', content: (m.parts || []).map(p => p.text || '').join('') || m.content || '' }));

function keysOf(st) { const e = process.env; return { claude: st.claude_key || e.ANTHROPIC_API_KEY, openai: st.openai_key || e.OPENAI_API_KEY, gemini: st.gemini_key || e.GEMINI_API_KEY }; }
function normOrder(s) {
  const seen = []; list(String(s || 'claude,openai,gemini').toLowerCase().replace(/chatgpt|gpt/g, 'openai')).forEach(x => { if (LABEL[x] && !seen.includes(x)) seen.push(x); });
  Object.keys(LABEL).forEach(x => { if (!seen.includes(x)) seen.push(x); }); return seen;
}
function buildChain(st) {
  const k = keysOf(st), models = { claude: list(st.claude_models || DEF.claude), openai: list(st.openai_models || DEF.openai), gemini: [fixModel(st.gemini_model)] };
  const chain = []; normOrder(st.ai_order).forEach(p => { if (k[p]) models[p].forEach(m => chain.push({ p, m, key: k[p] })); }); return chain;
}
function view(st) {
  const k = keysOf(st), mk = x => x ? '••••' + x.slice(-4) : '', e = process.env;
  return { has: !!(k.claude || k.openai || k.gemini), masked: mk(k.gemini), model: fixModel(st.gemini_model), fromEnv: !st.gemini_key && !!e.GEMINI_API_KEY,
    gemini: { has: !!k.gemini }, openai: { has: !!k.openai, masked: mk(k.openai), models: st.openai_models || DEF.openai, fromEnv: !st.openai_key && !!e.OPENAI_API_KEY },
    claude: { has: !!k.claude, masked: mk(k.claude), models: st.claude_models || DEF.claude, fromEnv: !st.claude_key && !!e.ANTHROPIC_API_KEY }, order: normOrder(st.ai_order).join(', ') };
}

async function http(url, headers, body, ms, name) {
  let r, j = {};
  try { r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(ms) }); }
  catch (e) { throw new Error(name + (e.name === 'TimeoutError' ? ' did not answer in time' : ' could not be reached')); }
  try { j = await r.json(); } catch {}
  if (!r.ok) throw new Error(name + ' ' + r.status + ': ' + ((j.error && (j.error.message || j.error)) || 'request failed'));
  return j;
}
async function callOne(c, o) {
  const msgs = toMsgs(o.contents);
  if (c.p === 'claude') {
    const j = await http('https://api.anthropic.com/v1/messages', { 'x-api-key': c.key, 'anthropic-version': '2023-06-01' },
      { model: c.m, max_tokens: o.maxTokens, ...(o.system ? { system: o.system } : {}), messages: msgs }, o.ms, 'Claude');
    const t = (j.content || []).map(x => x.text || '').join(''); if (!t) throw new Error('Claude returned an empty answer.'); return t;
  }
  if (c.p === 'openai') {
    const j = await http('https://api.openai.com/v1/chat/completions', { Authorization: 'Bearer ' + c.key },
      { model: c.m, max_completion_tokens: o.maxTokens, messages: [...(o.system ? [{ role: 'system', content: o.system }] : []), ...msgs] }, o.ms, 'ChatGPT');
    const t = j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content; if (!t) throw new Error('ChatGPT returned an empty answer.'); return t;
  }
  return gemini({ key: c.key, model: c.m, system: o.system, contents: o.contents, maxTokens: o.maxTokens, temperature: o.temperature, plain: o.plain, budget: o.ms, noRetry: !o.last });
}

// Tries every option in order. Options that just hit a limit rest for 10 minutes so the next request goes straight to a working one.
async function askAI(st, o) {
  const chain = buildChain(st); if (!chain.length) throw new Error('Add an AI key in Settings first.');
  const now = Date.now(); let ready = chain.filter(c => !(Date.parse(st['cool:' + c.p + ':' + c.m]) > now)); if (!ready.length) ready = chain;
  const notes = [], t0 = now, cap = o.cap || 25000;
  for (let i = 0; i < ready.length; i++) {
    const c = ready[i], left = 52000 - (Date.now() - t0); if (left < 4000) break;
    try {
      const text = await callOne(c, { ...o, ms: Math.min(cap, left), last: i === ready.length - 1 });
      return { text, via: LABEL[c.p] + ' · ' + c.m, fb: c !== chain[0] };
    } catch (e) {
      notes.push(LABEL[c.p] + ' ' + c.m + ': ' + String(e.message).slice(0, 140));
      if (LIMIT.test(e.message)) { try { const u = new Date(Date.now() + 600000).toISOString(); await setSetting('cool:' + c.p + ':' + c.m, u); st['cool:' + c.p + ':' + c.m] = u; } catch {} }
    }
  }
  throw new Error('Every AI option failed. ' + notes.join(' | '));
}
async function testKey(p, key, models) {
  let err; for (const m of models) { try { await callOne({ p, m, key }, { plain: true, contents: [{ role: 'user', parts: [{ text: 'Reply with the single word OK.' }] }], maxTokens: 64, ms: 20000, last: true }); return; } catch (e) { err = e; } }
  throw new Error(LABEL[p] + ' rejected it: ' + (err && err.message));
}
module.exports = { askAI, testKey, view, normOrder, list, LABEL, DEF };
