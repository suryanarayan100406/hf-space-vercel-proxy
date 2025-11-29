// api/ask.js
const axios = require('axios');

/**
 * Serverless API for Vercel:
 * POST /api/ask
 * Body: { query: string, models?: ["hf","openai","gemini"] }
 *
 * Environment variables:
 * - HF_SPACE_URL        e.g. https://exoticsuryaa-llm-by-surya.hf.space
 * - HF_TOKEN            (optional) hf_xxx if your space is private
 * - OPENAI_API_KEY      (optional) sk-...
 * - OPENAI_MODEL        (optional) e.g. gpt-4o-mini or gpt-4o (default gpt-4o-mini)
 * - GOOGLE_API_ENDPOINT (optional) placeholder for Gemini/Google GenAI endpoint
 *
 * NOTE: Vercel serverless timeouts may be short on free plan.
 */

const HF_SPACE_URL = process.env.HF_SPACE_URL || '';
const HF_TOKEN = process.env.HF_TOKEN || '';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const GOOGLE_API_ENDPOINT = process.env.GOOGLE_API_ENDPOINT || '';

const DEFAULT_TIMEOUT = 30000; // 30s Axios timeout (adjust; Vercel may cut earlier)

async function callHfSpace(query) {
  if (!HF_SPACE_URL) throw new Error('HF_SPACE_URL not configured');
  // Many Gradio Spaces accept POST to /run/predict with body { data: [<inputs>] }
  const url = HF_SPACE_URL.replace(/\/$/, '') + '/run/predict';
  const payload = { data: [query] };
  const headers = { 'Content-Type': 'application/json' };
  if (HF_TOKEN) headers['Authorization'] = `Bearer ${HF_TOKEN}`;

  const r = await axios.post(url, payload, { headers, timeout: DEFAULT_TIMEOUT });
  // response shape may be { data: ["..."] } or other; try to normalize
  if (r.data && Array.isArray(r.data.data) && r.data.data.length > 0) {
    return r.data.data[0];
  }
  // some Gradio apps return { "data": [ "<html>" ] } or raw object
  return r.data;
}

async function callOpenAI(query) {
  if (!OPENAI_API_KEY) throw new Error('OPENAI_API_KEY not configured');
  const url = 'https://api.openai.com/v1/chat/completions';
  const body = {
    model: OPENAI_MODEL,
    messages: [{ role: 'user', content: query }],
    max_tokens: 512
  };
  const headers = {
    'Authorization': `Bearer ${OPENAI_API_KEY}`,
    'Content-Type': 'application/json'
  };
  const r = await axios.post(url, body, { headers, timeout: DEFAULT_TIMEOUT });
  // Normalize
  try {
    return r.data.choices?.[0]?.message?.content ?? JSON.stringify(r.data);
  } catch (e) {
    return JSON.stringify(r.data);
  }
}

async function callGemini(query) {
  // Placeholder: set GOOGLE_API_ENDPOINT to a working GenAI endpoint or implement service-account flow.
  if (!GOOGLE_API_ENDPOINT) throw new Error('GOOGLE_API_ENDPOINT not configured for Gemini');
  // Implementation depends on your Google Cloud setup; this is a placeholder showing how you'd call it.
  const body = { input: query };
  const r = await axios.post(GOOGLE_API_ENDPOINT, body, { timeout: DEFAULT_TIMEOUT });
  return r.data;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed, use POST' });
  }

  const { query, models } = req.body || {};
  if (!query || typeof query !== 'string') {
    return res.status(400).json({ error: 'Body must be JSON with a "query" string' });
  }

  const selected = Array.isArray(models) && models.length > 0 ? models : ['hf'];

  // Run selected calls in parallel but respect short serverless time window.
  const tasks = selected.map(m => {
    if (m === 'hf') {
      return callHfSpace(query)
        .then(resp => ({ model: 'hf', ok: true, result: resp }))
        .catch(err => ({ model: 'hf', ok: false, error: String(err.message || err) }));
    }
    if (m === 'openai') {
      return callOpenAI(query)
        .then(resp => ({ model: 'openai', ok: true, result: resp }))
        .catch(err => ({ model: 'openai', ok: false, error: String(err.message || err) }));
    }
    if (m === 'gemini') {
      return callGemini(query)
        .then(resp => ({ model: 'gemini', ok: true, result: resp }))
        .catch(err => ({ model: 'gemini', ok: false, error: String(err.message || err) }));
    }
    return Promise.resolve({ model: m, ok: false, error: 'unknown model' });
  });

  // Wait for all tasks but enforce an overall timeout shorter than platform limits if you like.
  let results;
  try {
    results = await Promise.all(tasks);
  } catch (e) {
    // Unexpected
    return res.status(500).json({ error: 'Internal error', detail: String(e) });
  }

  // Normalize results to simple strings where possible
  const normalized = results.map(r => {
    if (r.ok) {
      if (typeof r.result === 'string') return { model: r.model, text: r.result };
      try {
        // if object or array, stringify
        return { model: r.model, text: JSON.stringify(r.result) };
      } catch (e) {
        return { model: r.model, text: String(r.result) };
      }
    } else {
      return { model: r.model, error: r.error };
    }
  });

  return res.json({ query, results: normalized, timestamp: new Date().toISOString() });
};
