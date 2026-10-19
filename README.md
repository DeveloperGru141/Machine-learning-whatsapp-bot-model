# Forgelabs Assistant — Agentic WhatsApp Bot

Engineered by **Ademola** (Aspiring ML/AI Engineer). Built on `@whiskeysockets/baileys`, multi-tier Groq (`qwen/qwen3.8-27b` -> `openai/gpt-oss-120b` -> `openai/gpt-oss-20b`), Google Gemini (`gemini-3.5-flash-lite`), and SQLite WAL persistent memory.

---

## Production Features
- **Sub-2s Latency & Smart Intent Tool Router**: Zero tool schemas sent on casual turns (~590-token prompt); dynamic 1–3 tool injection on action turns.
- **Multi-Provider & Multi-Key Auto-Failover**: Supports comma-separated `GROQ_API_KEY=key1,key2` across Qwen 3.8 27B & GPT-OSS 120B/20B, with automatic failover to Google Gemini 3.5 Flash-Lite (1,500 RPD free tier).
- **Fine-Tuned Persona & Auto-Seeding**: Automatically seeds 353+ curated Nigerian WhatsApp dialogue exemplars from `data/train.jsonl` into SQLite on first boot.
- **Anti-Ban Compliance**: Human reading/typing presence simulation, per-chat and global velocity rate limiting, and `@lid` stanza sanitization.
- **Built-in Health Server**: Exposes `GET /health` on `PORT` (default `3000`) for Docker, Render, Railway, Koyeb, Fly.io, and UptimeRobot monitoring.
Bot developing a bit of humanlike sentience😂😂
