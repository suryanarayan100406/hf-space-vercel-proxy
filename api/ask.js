// api/ask.js
const axios = require("axios");
const { Client } = require("@gradio/client");

const HF_SPACE = process.env.HF_SPACE || "exoticsuryaa/llm-by-surya"; // owner/space-name
const HF_TOKEN = process.env.HF_TOKEN || ""; // hf_xxx if private
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const DEFAULT_TIMEOUT = 30000;

let gradioClient = null;
let connecting = null;

async function getClient() {
  if (gradioClient) return gradioClient;
  if (connecting) return connecting;
  connecting = (async () => {
    if (HF_TOKEN) process.env.HF_TOKEN = HF_TOKEN; // client reads HF_TOKEN env for private spaces
    const c = await Client.connect(HF_SPACE);
    gradioClient = c;
    connecting = null;
    return gradioClient;
  })();
  return connecting;
}

async function callHfChat(message) {
  const client = await getClient();
  // API name from screenshot is "/chat" expecting { message: "..." }
  const res = await client.predict("/chat", { message });
  // normalize
  if (typeof res === "string") return res;
  if (res && res.data) {
    if (Array.isArray(res.data) && res.data.length) return String(res.data[0]);
    if (typeof res.data === "string") return res.data;
  }
  try { return JSON.stringify(res); } catch(e) { return String(res); }
}

async function callOpenAI(query) {
  if (!OPENAI_API_KEY) throw new Error("OPENAI_API_KEY not configured");
  const url = "https://api.openai.com/v1/chat/completions";
  const body = { model: process.env.OPENAI_MODEL || "gpt-4o-mini", messages: [{ role: "user", content: query }], max_tokens: 512 };
  const r = await axios.post(url, body, { headers: { Authorization: `Bearer ${OPENAI_API_KEY}` }, timeout: DEFAULT_TIMEOUT });
  return r.data?.choices?.[0]?.message?.content ?? JSON.stringify(r.data);
}

module.exports = async (req, res) => {
  if (req.method === "GET") return res.status(200).json({ status: "ok", note: "POST {query:'...', models:['hf']}" });
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed, use POST" });

  const body = req.body || {};
  const query = body.query || body.prompt || (body.message ? body.message : null);
  if (!query || typeof query !== "string") return res.status(400).json({ error: 'Body must be JSON with a "query" string' });

  const models = Array.isArray(body.models) && body.models.length ? body.models : ["hf"];

  const tasks = models.map(m => {
    if (m === "hf") {
      return callHfChat(query).then(t => ({ model: "hf", ok: true, text: t })).catch(e => ({ model: "hf", ok: false, error: String(e.message || e) }));
    }
    if (m === "openai") {
      return callOpenAI(query).then(t => ({ model: "openai", ok: true, text: t })).catch(e => ({ model: "openai", ok: false, error: String(e.message || e) }));
    }
    return Promise.resolve({ model: m, ok: false, error: "unknown model" });
  });

  try {
    const results = await Promise.all(tasks);
    return res.json({ query, results, timestamp: new Date().toISOString() });
  } catch (err) {
    return res.status(500).json({ error: String(err.message || err) });
  }
};
