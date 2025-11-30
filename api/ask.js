// api/ask.js (robust, with graceful fallback + debug output)
// Copy-paste this file and push to GitHub (Vercel will redeploy).

const axios = require('axios');

const HF_SPACE = process.env.HF_SPACE || 'exoticsuryaa/llm-by-surya'; // owner/space-name
const HF_SPACE_URL = process.env.HF_SPACE_URL || ''; // e.g. https://exoticsuryaa-llm-by-surya.hf.space
const HF_TOKEN = process.env.HF_TOKEN || '';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const DEFAULT_TIMEOUT = 25000;
const CLIENT_CONNECT_TIMEOUT = 15000; // ms for client.connect

// Helper: safe base
function safeBase(url) { return url.replace(/\/+$/, ''); }

// Helper: sleep
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

// Try to use @gradio/client (ESM) via dynamic import.
// Returns connected client or throws.
async function tryGetGradioClient() {
  // dynamic import with timeout
  let mod;
  const imp = import('@gradio/client').then(m => m).catch(e => { throw new Error('import_gradio_failed: ' + (e.message || e)); });
  // race with timeout
  const clientModule = await Promise.race([
    imp,
    new Promise((_, rej) => setTimeout(() => rej(new Error('import_gradio_timeout')), CLIENT_CONNECT_TIMEOUT))
  ]);
  // resolve export
  const Client = clientModule.Client ?? clientModule.default?.Client ?? clientModule.default;
  if (!Client) throw new Error('gradio_client_no_Client_export');
  // client.connect may need HF_TOKEN env set for private spaces
  if (HF_TOKEN) process.env.HF_TOKEN = HF_TOKEN;
  // connect with timeout and retry once
  let connected = null;
  try {
    connected = await Promise.race([
      Client.connect(HF_SPACE),
      new Promise((_, rej) => setTimeout(() => rej(new Error('client_connect_timeout')), CLIENT_CONNECT_TIMEOUT))
    ]);
  } catch (err) {
    // wait short and try once more
    await sleep(500);
    connected = await Promise.race([
      Client.connect(HF_SPACE),
      new Promise((_, rej) => setTimeout(() => rej(new Error('client_connect_timeout_2')), CLIENT_CONNECT_TIMEOUT))
    ]);
  }
  return connected;
}

// HTTP fallback to HF Space /run/predict etc.
async function callHfHttpFallback(query) {
  if (!HF_SPACE_URL) throw new Error('HF_SPACE_URL not configured for HTTP fallback');

  const base = safeBase(HF_SPACE_URL);
  const endpoints = [
    `${base}/run/predict`,
    `${base}/api/predict`,
    `${base}/predict`
  ];
  const payloads = [
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
    for (const payload of payloads) {
      try {
        const r = await axios.post(url, payload, { headers, timeout: DEFAULT_TIMEOUT });
        attempts.push({ ok: true, url, status: r.status });
        const d = r.data;
        if (d && Array.isArray(d.data) && d.data.length) return { text: String(d.data[0]), debug: attempts };
        if (d && typeof d.data === 'string') return { text: d.data, debug: attempts };
        if (typeof d === 'string') return { text: d, debug: attempts };
        return { text: JSON.stringify(d), debug: attempts };
      } catch (err) {
        const resp = err.response;
        attempts.push({ ok: false, url, status: resp ? resp.status : null, error: resp ? resp.data : (err.message || String(err)) });
      }
    }
  }
  const e = new Error('no_http_hf_endpoint');
  e.attempts = attempts;
  throw e;
}

// Main exported handler
module.exports = async (req, res) => {
  // Basic health on GET
  if (req.method === 'GET') {
    return res.status(200).json({ status: 'ok', note: 'POST JSON {query:\"...\"}' });
  }

  // Only POST supported for normal calls
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed, use POST' });
  }

  // Parse request
  const body = req.body || {};
  const query = body.query || body.prompt || (body.message ? body.message : null);
  if (!query || typeof query !== 'string') {
    return res.status(400).json({ error: 'Body must be JSON with a \"query\" string' });
  }

  // Determine models requested
  const models = Array.isArray(body.models) && body.models.length ? body.models : ['hf'];

  // We'll collect results and debug info
  const results = [];

  // Try to call models sequentially (to make debugging easier). You can parallelize later.
  for (const model of models) {
    if (model === 'hf') {
      // Try: 1) gradio client if available; 2) HTTP fallback
      let ok = false, text = null, debug = { client_error: null, http_attempts: null };

      // 1) try gradio client
      try {
        const client = await tryGetGradioClient();
        // attempt predict, wrapped with timeout
        const p = client.predict('/chat', { message: query });
        const resp = await Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('predict_timeout')), DEFAULT_TIMEOUT))]);
        // normalize resp
        if (typeof resp === 'string') text = resp;
        else if (resp && resp.data) {
          if (Array.isArray(resp.data) && resp.data.length) text = String(resp.data[0]);
          else if (typeof resp.data === 'string') text = resp.data;
          else text = JSON.stringify(resp.data);
        } else text = JSON.stringify(resp);
        ok = true;
      } catch (err) {
        debug.client_error = String(err.message || err);
        // fallthrough to HTTP fallback
      }

      // 2) HTTP fallback if client failed
      if (!ok) {
        try {
          const hfHttp = await callHfHttpFallback(query);
          text = hfHttp.text;
          debug.http_attempts = hfHttp.debug || null;
          ok = true;
        } catch (errHttp) {
          // both failed
          debug.http_attempts = errHttp.attempts || errHttp.summary || String(errHttp);
          results.push({ model: 'hf', ok: false, error: 'HF calls failed', debug });
          continue; // to next model
        }
      }

      results.push({ model: 'hf', ok, text, debug });
      continue;
    }

    if (model === 'openai') {
      // simple OpenAI call
      if (!OPENAI_API_KEY) {
        results.push({ model: 'openai', ok: false, error: 'OPENAI_API_KEY not configured' });
        continue;
      }
      try {
        const r = await axios.post('https://api.openai.com/v1/chat/completions',
          { model: process.env.OPENAI_MODEL || 'gpt-4o-mini', messages: [{ role: 'user', content: query }], max_tokens: 512 },
          { headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' }, timeout: DEFAULT_TIMEOUT }
        );
        const txt = r.data?.choices?.[0]?.message?.content ?? JSON.stringify(r.data);
        results.push({ model: 'openai', ok: true, text: txt });
      } catch (err) {
        const resp = err.response;
        results.push({ model: 'openai', ok: false, error: resp ? JSON.stringify(resp.data) : (err.message || String(err)) });
      }
      continue;
    }

    // Unknown model
    results.push({ model, ok: false, error: 'unknown model' });
  } // end models loop

  // Return normalized results
  return res.json({ query, results, timestamp: new Date().toISOString() });
};
