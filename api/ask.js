// api/ask.js
// Uses dynamic import for @gradio/client (ESM) while keeping CommonJS style file for Vercel.

const axios = require('axios');

const HF_SPACE = process.env.HF_SPACE || 'exoticsuryaa/llm-by-surya';
const HF_TOKEN = process.env.HF_TOKEN || '';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const DEFAULT_TIMEOUT = 30000;

let gradioClient = null;
let connecting = null;

async function getClient() {
  if (gradioClient) return gradioClient;
  if (connecting) return connecting;

  connecting = (async () => {
    try {
      // Ensure HF_TOKEN in env for private spaces
      if (HF_TOKEN) process.env.HF_TOKEN = HF_TOKEN;

      // dynamic import of the ESM-only package
      const mod = await import('@gradio/client');
      const Client = mod.Client ?? mod.default?.Client ?? mod.default; // accommodate different exports
      if (!Client) throw new Error('@gradio/client did not export Client');

      // Connect using owner/space-name (same as docs)
      const client = await Client.connect(HF_SPACE);
      gradioClient = client;
      connecting = null;
      return gradioClient;
    } catch (err) {
      connecting = null;
      throw err;
    }
  })();

  return connecting;
}

async function callHfChat(message) {
  const client = await getClient();
  // API name from your Space docs is "/chat"
  const res = await client.predict('/chat', { message });

  // Normalize response
  if (res === null || typeof res === 'undefined') return '';
  if (typeof res === 'string') return res;
  if (res && res.data) {
    if (Array.isArray(res.data) && res.data.length) return String(res.data[0]);
    if (typeof res.data === 'string') return res.data;
  }
  try { return JSON.stringify(res); } catch (e) { return String(res); }
}

async function callOpenAI(query) {
  if (!OPENAI_API_KEY) throw new Error('OPENAI_API_KEY not configured');
  const url = 'https://api.openai.com/v1/chat/completions';
  const body = {
    model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
    messages: [{ role: 'user', content: query }],
    max_tokens: 512
  };
  const r = await axios.post(url, body, {
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
    timeout: DEFAULT_TIMEOUT
  });
  return r.data?.choices?.[0]?.message?.content ?? JSON.stringify(r.data);
}

module.exports = async (req, res) => {
  if (req.method === 'GET') {
    return res.status(200).json({ status: 'ok', note: 'POST /api/ask with JSON {query: \"...\", models: [\"hf\"] }' });
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed, use POST' });

  const body = req.body || {};
  const query = body.query || body.prompt || (body.message ? body.message : null);
  if (!query || typeof query !== 'string') return res.status(400).json({ error: 'Body must be JSON with a \"query\" string' });

  const models = Array.isArray(body.models) && body.models.length ? body.models : ['hf'];

  const tasks = models.map(m => {
    if (m === 'hf') {
      return callHfChat(query)
        .then(text => ({ model: 'hf', ok: true, text }))
        .catch(err => ({ model: 'hf', ok: false, error: String(err.message || err) }));
    }
    if (m === 'openai') {
      return callOpenAI(query)
        .then(text => ({ model: 'openai', ok: true, text }))
        .catch(err => ({ model: 'openai', ok: false, error: String(err.message || err) }));
    }
    return Promise.resolve({ model: m, ok: false, error: 'unknown model' });
  });

  try {
    const results = await Promise.all(tasks);
    return res.json({ query, results, timestamp: new Date().toISOString() });
  } catch (err) {
    return res.status(500).json({ error: String(err.message || err) });
  }
};
