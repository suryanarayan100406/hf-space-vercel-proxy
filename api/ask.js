// api/ask.js
// Vercel serverless function that calls your Gradio Space using @gradio/client
// POST /api/ask  body: { "query": "text", "models": ["hf","openai"] }

const { Client } = require("@gradio/client");
const axios = require("axios");

// Env vars
const HF_SPACE = process.env.HF_SPACE || "exoticsuryaa/llm-by-surya"; // owner/space-name as in docs
const HF_TOKEN = process.env.HF_TOKEN || ""; // leave blank for public spaces
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const DEFAULT_TIMEOUT = 30000;

let gradioClient = null;
let clientConnecting = null;

async function getGradioClient() {
  if (gradioClient) return gradioClient;
  if (clientConnecting) return clientConnecting; // avoid race
  clientConnecting = (async () => {
    try {
      if (HF_TOKEN) process.env.HF_TOKEN = HF_TOKEN; // @gradio/client reads HF_TOKEN env for private spaces
      // Connect to the space (owner/space-name)
      const c = await Client.connect(HF_SPACE);
      gradioClient = c;
      clientConnecting = null;
      return gradioClient;
    } catch (err) {
      clientConnecting = null;
      throw err;
    }
  })();
  return clientConnecting;
}

async function callHfChat(message) {
  const client = await getGradioClient();
  // API name shown in your screenshot is "/chat"; pass the required param object
  // client.predict returns the same structure the UI uses. We normalize to string.
  const res = await client.predict("/chat", { message });
  // Typical return shapes vary. Normalize common cases:
  if (res === null || typeof res === "undefined") return "";
  if (typeof res === "string") return res;
  // if result.data exists (some Gradio clients return { data: [...] })
  if (res.data) {
    if (Array.isArray(res.data) && res.data.length) return String(res.data[0]);
    if (typeof res.data === "string") return res.data;
  }
  // fallback stringify
  try { return JSON.stringify(res); } catch(e) { return String(res); }
}

async function callOpenAI(query) {
  if (!OPENAI_API_KEY) throw new Error("OPENAI_API_KEY not configured");
  const url = "https://api.openai.com/v1/chat/completions";
  const body = {
    model: process.env.OPENAI_MODEL || "gpt-4o-mini",
    messages: [{ role: "user", content: query }],
    max_tokens: 512
  };
  const r = await axios.post(url, body, {
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, "Content-Type": "application/json" },
    timeout: DEFAULT_TIMEOUT
  });
  return r.data?.choices?.[0]?.message?.content ?? JSON.stringify(r.data);
}

module.exports = async function handler(req, res) {
  // Basic GET health check
  if (req.method === "GET") {
    return res.status(200).json({ status: "ok", note: "POST /api/ask with JSON {query: '...', models:['hf']}" });
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed, use POST" });
  }

  const body = req.body || {};
  const query = body.query || body.prompt || (body.message ? body.message : null);
  if (!query || typeof query !== "string") {
    return res.status(400).json({ error: 'Body must be JSON with a "query" string' });
  }

  const models = Array.isArray(body.models) && body.models.length ? body.models : ["hf"];

  // Run requested model calls in parallel; simple normalization.
  const calls = models.map(m => {
    if (m === "hf") {
      return callHfChat(query)
        .then(r => ({ model: "hf", ok: true, text: r }))
        .catch(e => ({ model: "hf", ok: false, error: String(e.message || e) }));
    }
    if (m === "openai") {
      return callOpenAI(query)
        .then(r => ({ model: "openai", ok: true, text: r }))
        .catch(e => ({ model: "openai", ok: false, error: String(e.message || e) }));
    }
    // unknown model
    return Promise.resolve({ model: m, ok: false, error: "unknown model" });
  });

  try {
    const results = await Promise.all(calls);
    // Normalize to consistent output
    const normalized = results.map(r => {
      if (r.ok) return { model: r.model, text: r.text };
      return { model: r.model, error: r.error };
    });
    return res.json({ query, results: normalized, timestamp: new Date().toISOString() });
  } catch (err) {
    return res.status(500).json({ error: String(err.message || err) });
  }
};
