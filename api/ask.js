// api/ask.js
const axios = require('axios');

const HF_SPACE_URL = process.env.HF_SPACE_URL || '';
const HF_TOKEN = process.env.HF_TOKEN || '';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const DEFAULT_TIMEOUT = 25000;

function safeBase(url) {
  return url.replace(/\/+$/, '');
}

async function tryPost(url, payload, headers = {}) {
  try {
    const r = await axios.post(url, payload, { headers, timeout: DEFAULT_TIMEOUT });
    return { ok: true, url, status: r.status, data: r.data };
  } catch (err) {
    const resp = err.response;
    return {
      ok: false,
      url,
      status: resp ? resp.status : null,
      error: resp ? JSON.stringify(resp.data) : (err.message || String(err))
    };
  }
}

/**
 * Attempts common Gradio/Space HTTP endpoints and payload shapes.
 * Returns normalized string on success, otherwise throws with attempts array.
 */
async function callHfSpace(query) {
  if (!HF_SPACE_URL) throw new Error('HF_SPACE_URL not configured');

  const base = safeBase(HF_SPACE_URL);
  const endpoints = [
    `${base}/run/predict`,
    `${base}/api/predict`,
    `${base}/predict`,
    `${base}/run/predict/`,
    `${base}/api/predict/`
  ];

  const payloadVariants = [
    { data: [ query ] },
    { data: [ query ], fn_index: 0 },
    { input: query },
    { inputs: query },
    { message: query },
    { text: query }
  ];

  const headers = { 'Content-Type': 'application/json' };
  if (HF_TOKEN) headers['Authorization'] = `Bearer ${HF_TOKEN}`;

  const attempts = [];

  for (const url of endpoints) {
    for (const payload of payloadVariants) {
      const attempt = await tryPost(url, payload, headers);
      attempts.push(attempt);
      if (attempt.ok && attempt.status >= 200 && attempt.status < 300) {
        const d = attempt.data;
        // common Gradio shape: { data: [ "<result>" ] }
        if (d && Array.isArray(d.data) && d.data.length) return String(d.data[0]);
        if (d && typeof d.data === 'string') return d.data;
        if (typeof d === 'string') return d;
        // fallback stringify the object
        return JSON.stringify(d);
      }
    }
  }

  const summary = attempts.map(a =>
    a.ok ? `${a.url} => ${a.status}` : `${a.url} => ERR ${a.error}`
  );
  const e = new Error('No working HF endpoint found. See attempts.');
  e.attempts = attempts;
  e.summary = summary;
  throw e;
}

async function callOpenAI(query) {
  if (!OPENAI_API_KEY) throw new Error('OPENAI_API_KEY not configured');
  const url = 'https://api.openai.com/v1/chat/completions';
  const body = { model: process.env.OPENAI_MODEL || 'gpt-4o-mini', messages:[{role:'user',content:query}], max_tokens:512 };
  const r = await axios.post(url, body, { headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, 'Content-Type':'application/json' }, timeout: DEFAULT_TIMEOUT });
  return r.data?.choices?.[0]?.message?.content ?? JSON.stringify(r.data);
}

module.exports = async (req, res) => {
  if (req.method === 'GET') {
    return res.status(200).json({ status:'ok', note:'POST JSON {query:\"...\", models:[\"hf\",\"openai\"]}' });
  }
  if (req.method !== 'POST') return res.status(405).json({ error:'Method not allowed, use POST' });

  const body = req.body || {};
  const query = body.query || body.prompt || (body.message ? body.message : null);
  if (!query || typeof query !== 'string') return res.status(400).json({ error:'Body must be JSON with a \"query\" string' });

  const models = Array.isArray(body.models) && body.models.length ? body.models : ['hf'];

  const tasks = models.map(m => {
    if (m === 'hf') {
      return callHfSpace(query)
        .then(text => ({ model:'hf', ok:true, text }))
        .catch(err => ({ model:'hf', ok:false, error: err.message || String(err), debug: err.attempts || err.summary }));
    }
    if (m === 'openai') {
      return callOpenAI(query)
        .then(text => ({ model:'openai', ok:true, text }))
        .catch(err => ({ model:'openai', ok:false, error: err.message || String(err) }));
    }
    return Promise.resolve({ model:m, ok:false, error:'unknown model' });
  });

  const results = await Promise.all(tasks);
  return res.json({ query, results, timestamp: new Date().toISOString() });
};
