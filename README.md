# HF Space → Vercel Proxy

This repo is a Vercel serverless proxy that can call a HuggingFace Gradio Space (run/predict),
and optionally OpenAI (Chat Completions). It exposes a single endpoint:

POST /api/ask
Body: { "query": "your prompt", "models": ["hf","openai","gemini"] }

Responses:
{
  "query": "...",
  "results": [
    { "model": "hf", "text": "..." },
    { "model": "openai", "text": "..." }
  ],
  "timestamp": "..."
}

## Setup

1. Copy / rename `.env.example` to `.env` locally for dev testing (do not commit).
2. Set environment variables in Vercel dashboard:
   - HF_SPACE_URL e.g. https://exoticsuryaa-llm-by-surya.hf.space
   - HF_TOKEN (if your space is private)
   - OPENAI_API_KEY (if you want OpenAI)
   - OPENAI_MODEL (optional)
   - GOOGLE_API_ENDPOINT (if you want Gemini; must be configured)

## Local testing (optional)
Install dependencies:
