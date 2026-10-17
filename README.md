# Forgelabs Assistant — Agentic WhatsApp Bot

Engineered by **Ademola** (Aspiring ML/AI Engineer). Built on `@whiskeysockets/baileys`, multi-tier Groq (`qwen/qwen3.8-27b` -> `openai/gpt-oss-120b` -> `openai/gpt-oss-20b`), Google Gemini (`gemini-3.5-flash-lite`), and SQLite WAL persistent memory.

---

## Production Features
- **Sub-2s Latency & Smart Intent Tool Router**: Zero tool schemas sent on casual turns (~590-token prompt); dynamic 1–3 tool injection on action turns.
- **Multi-Provider & Multi-Key Auto-Failover**: Supports comma-separated `GROQ_API_KEY=key1,key2` across Qwen 3.8 27B & GPT-OSS 120B/20B, with automatic failover to Google Gemini 3.5 Flash-Lite (1,500 RPD free tier).
- **Fine-Tuned Persona & Auto-Seeding**: Automatically seeds 353+ curated Nigerian WhatsApp dialogue exemplars from `data/train.jsonl` into SQLite on first boot.
- **Anti-Ban Compliance**: Human reading/typing presence simulation, per-chat and global velocity rate limiting, and `@lid` stanza sanitization.
- **Built-in Health Server**: Exposes `GET /health` on `PORT` (default `3000`) for Docker, Render, Railway, Koyeb, Fly.io, and UptimeRobot monitoring.

---

## Deploying to External Servers

### 1. Keep Your Existing WhatsApp Session (Zero Re-Pairing Needed)
To deploy without having to re-link your WhatsApp number (`07058967815`):
1. Copy your local `./sessions` folder and `./data/bot.sqlite` to the external server.
2. Make sure **only 1 instance** of the bot is running at any time (stop your local bot before starting the external server instance to avoid WhatsApp `440 Stream Conflict` disconnects).

---

### Option A: Ubuntu / Debian VPS (with PM2)
```bash
# 1. Install system dependencies (Node 22+, Python3, FFmpeg, edge-tts, yt-dlp)
sudo apt update && sudo apt install -y python3 python3-pip ffmpeg
pip3 install --break-system-packages edge-tts yt-dlp

# 2. Install Node packages & compile TypeScript
npm ci
npm run build

# 3. Configure .env (copy from .env.example)
cp .env.example .env
nano .env

# 4. Launch in single-instance fork mode via PM2
npm install -g pm2
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup
```

---

### Option B: Docker / Cloud Container (Railway, Render, Fly.io, Coolify, VPS)
```bash
# Build the production image
docker build -t forgelabs-bot .

# Run with persistent volumes for WhatsApp sessions and SQLite database
docker run -d \
  --name forgelabs-bot \
  --restart unless-stopped \
  --env-file .env \
  -p 3000:3000 \
  -v $(pwd)/sessions:/app/sessions \
  -v $(pwd)/data:/app/data \
  forgelabs-bot
```

---

### Health Check Endpoint
Once running, verify live server status at:
```bash
curl http://localhost:3000/health
```