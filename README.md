# Forgelabs Assistant 🤖

[![Node.js](https://img.shields.io/badge/Node.js-v22+-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![Baileys](https://img.shields.io/badge/WhatsApp-@whiskeysockets/baileys-25D366?logo=whatsapp&logoColor=white)](https://github.com/WhiskeySockets/Baileys)
[![Groq](https://img.shields.io/badge/Groq-Qwen%203.8%2027B%20%7C%20Multi--Key%20Pool-F55036?logo=groq&logoColor=white)](https://groq.com)
[![SQLite](https://img.shields.io/badge/Database-SQLite%20WAL-003B57?logo=sqlite&logoColor=white)](https://sqlite.org)
[![License](https://img.shields.io/badge/License-ISC-blue.svg)](LICENSE)

> *"This is Forgelabs Assistant — an Agentic WhatsApp Bot engineered for humanlike conversational flow, high availability, and multi-tier autonomy. Built from scratch with love and grit by **Ademola** (*Aspiring ML/AI Engineer*), with shout-outs to my brothers **Micah Okoh** and **Adeniran Glory**. We're going places! 🚀"*

**Forgelabs Assistant** is a modular, continuous-learning WhatsApp AI agent designed for high availability, humanlike conversational intelligence, and multimedia automation. It combines the speed and flexibility of modern agentic tool routing with strict anti-ban human behavior emulation, persistent vector and relational memory, and an end-to-end machine learning data generation pipeline.

---

## 🏛️ System Architecture

```mermaid
flowchart TD
    WA[WhatsApp Network / Signal Protocol] <-->|WebSockets| BAILEYS["@whiskeysockets/baileys v6.7+"]
    BAILEYS --> NORMALIZER[Message Normalizer & Media Extractor]
    NORMALIZER --> ANTISPAM[Anti-Spam & User Rate Limiter]
    ANTISPAM --> ROUTER[Smart Intent Router]
    
    subgraph LLM_CORE["Multi-Provider LLM Engine"]
        ROUTER --> HARNESS[Agent Harness]
        HARNESS --> CLIENT[LLM Client Multi-Key Pool]
        CLIENT -->|Primary: Sub-Second Latency| GROQ["Groq Multi-Key Pool (Qwen 3.8 27B)"]
        CLIENT -->|Auto-Failover Tier 1| GROQ_OSS["Groq Reasoning (GPT-OSS 120B / 20B)"]
        CLIENT -->|Auto-Failover Tier 2| CEREBRAS["Cerebras (Llama 3.3 70B)"]
        CLIENT -->|Auto-Failover Tier 3| OPENROUTER["OpenRouter (Fallback)"]
    end
    
    subgraph PLUGINS["Modular Plugin Suite (20+ Plugins, 73 Tools)"]
        HARNESS --> P_ADMIN[Group Admin & Moderation]
        HARNESS --> P_STICKER[Sticker Engine (550+ Catalog)]
        HARNESS --> P_SCHED[Scheduler & Channel Broadcaster]
        HARNESS --> P_MEDIA[Audio & Video Downloaders]
        HARNESS --> P_VOICE[Voice Synthesizer & Whisper]
        HARNESS --> P_RAG[SQLite RAG & User Profiles]
        HARNESS --> P_IMG[Free FLUX.1 Image Gen]
    end
    
    subgraph STORAGE_LAYER["Memory & Learning Engine"]
        HARNESS <--> SQLITE[(SQLite WAL Database)]
        NORMALIZER --> VECTOR_STORE[256-D Local Vector Store]
        VECTOR_STORE <--> SQLITE
        SQLITE --> RAG_ENGINE[Local Database RAG Engine]
        SQLITE --> DATASET_EXPORT["ML Dataset Pipeline (train.jsonl)"]
    end

    HARNESS --> ANTIBAN[Anti-Ban Engine & Presence Simulator]
    ANTIBAN --> SENDER[Outbound Message Sender]
    SENDER -->|Native Stanzas| BAILEYS
```

---

## ✨ Key Capabilities & Highlights

### 1. Ultra-Fast LLM Engine & Multi-Key Pooling
- **Primary Engine**: **Groq Qwen 27B** (`qwen/qwen3.8-27b`) delivering sub-second message response times.
- **Multi-Key Pool**: Comma-separated API keys (`GROQ_API_KEY=key1,key2,key3`) pool daily token limits across accounts (600,000+ tokens/day) with instant round-robin load distribution and automatic failover.
- **Failover Chain**: Automatic routing to `openai/gpt-oss-120b`, `openai/gpt-oss-20b`, Cerebras (`llama3.3-70b`), and OpenRouter.
- **Adaptive Context Budgeting**: Strict ~950 token budget prevents token bloat and rate-limit exhaustion.

### 2. Authentic Persona & Cultural Nuance
- **Natural Nigerian WhatsApp Flow**: Blends casual English with authentic Nigerian Pidgin and slang (*"how far"*, *"wetin dey happen"*, *"omo"*, *"abeg"*, *"no wahala"*, *"sharp sharp"*, *"my guy"*).
- **Distilled Responses**: Delivers punchy 1–3 sentence insights without encyclopedic textbook dumps or robotic AI clichés.
- **Zero Corporate Cliches**: Never outputs *"How can I help you?"*, *"Certainly! Here is..."*, or rocket emojis (🚀).
- **Introduction Flow**: Always begins introductions in plain English before transitioning into warm Pidgin/slang.

### 3. Creator Safeguards & Identity Protection
- **Creator & Owner**: **Ademola** (`08108574293 / +2348108574293`).
- **Owner Immunity**: Strictly immune from being kicked, removed, or demoted in any WhatsApp group, even if ordered by admins or superadmins.
- **Privacy Shield**: Never discloses or leaks Ademola's phone number or confidential address book contacts unless explicitly requested by the owner.
- **Boss Message Relay**: When anyone asks to *"message your boss"*, *"tell Ademola"*, or *"ping your creator"*, the bot immediately invokes `send_message_to_contact` to dispatch the message directly to Ademola with delivery receipts.

### 4. Group Administration Suite (Elevated Privileges)
- **Moderation Tools**: Kick bad actors (`kick_member`), add participants (`add_member`), and delete spam for everyone (`delete_group_message`).
- **Remote Group Control**: Lock/unlock group chat (`set_group_mode`), toggle announcement mode, and manage join requests (`approve_join_request`, `reject_join_request`).
- **Anti-Link Defense**: Intercepts unauthorized group invite links and immediately revokes spam messages.
- **Ephemeral Settings**: Sets disappearing message durations (`set_disappearing_messages`).

### 5. Automated Media & Daily Broadcast Engine
- **Daily 7:00 AM WhatsApp Status Broadcast**:
  - Posts signature animated motion design video featuring the winking red panda avatar with a golden star sparkle, transitioning into the luminous Forgelabs Assistant logo reveal.
  - Accompanied by curated morning bundle: top tech/AI news, inspirational Bible verse, motivational quote, and funny memes.
- **WhatsApp Channel Scraping**:
  - Automatically scrapes viral memes from WhatsApp Channel `Memes` with a strict 2-hour cooldown.
  - Automatically scrapes motivational quotes from WhatsApp Channel `Quotes📖` and delivers niche-tailored morning charges to groups.
- **Native Sticker Engine**:
  - Curated catalog of **550+ stickers** indexed by emotion, culture, and vibe.
  - Contextual mood-matching to drop fitting stickers in natural conversations.
- **Free FLUX.1 Image Generation**: Generates high-definition images using free open-source FLUX.1 models via Hugging Face Spaces.

### 6. Anti-Ban Human Simulation Engine
- **Realistic Typing & Reading**: Simulates human reading speeds (120–250 WPM) and typing presence (`composing`) with natural jitter (1.2s to 4.5s).
- **Velocity Throttling**: Caps message velocity at 25 msgs/min with chat cooldown debouncers.
- **Protocol Sanitization**: Normalizes E.164 phone numbers and scrubs internal `@lid` identifiers and technical WhatsApp IDs (WID/wa.id).

---

## 🧩 Modular Plugin Registry (70 Tools)

| Plugin | Key Tools | Description |
| :--- | :--- | :--- |
| **`groupAdminPlugin`** | `kick_member`, `add_member`, `delete_group_message`, `set_group_mode`, `tag_all` | Comprehensive group administration, anti-link enforcement, and join requests. |
| **`stickerPlugin`** | `send_contextual_sticker`, `create_sticker` | 550+ sticker catalog, WebP conversion via Sharp/FFmpeg, and vibe matching. |
| **`schedulerPlugin`** | `set_reminder`, `post_whatsapp_status`, `broadcast_group_motivation` | Cron-powered task execution, WhatsApp channel scraping, and status broadcasts. |
| **`contactPlugin`** | `send_message_to_contact`, `get_contact`, `save_contact` | Direct phone messaging without prior saving, CRM, and boss message relay. |
| **`imageGenPlugin`** | `generate_image` | Free AI image generation powered by open-source FLUX.1 models on HF Spaces. |
| **`audioDownloaderPlugin`** | `download_audio` | High-quality audio extraction from YouTube, TikTok, SoundCloud, and social links. |
| **`videoDownloaderPlugin`** | `download_video` | Multi-platform video downloader for Reels, TikTok, YouTube Shorts, and X. |
| **`voiceNotePlugin`** | `send_voice_note` | Synthesizes realistic human voice notes in articulate, professional English. |
| **`webSearchPlugin`** | `web_search` | Real-time web search and ground-truth validation for current information. |
| **`linkSummarizerPlugin`** | `summarize_link` | Web scraping and executive content summarization. |
| **`documentReaderPlugin`** | `read_document` | Extracts text and summarizes PDF, DOCX, and TXT files. |
| **`memoryPlugin`** | `search_memory`, `recall_conversation` | Local SQLite RAG layer retrieving user facts and conversation history. |
| **`engagementPlugin`** | `tell_joke`, `trivia_quiz`, `roast_user`, `motivate` | Interactive games, Nigerian pop culture banter, and community engagement. |
| **`viewOnceVaultPlugin`** | `inspect_view_once` | Safeguards and logs view-once media for audit and recovery. |
| **`datasetExporterPlugin`** | `export_training_data` | Compiles and filters conversation logs into fine-tuning datasets (`train.jsonl`). |

---

## 📁 Repository Structure

```
whatsapp-modular-bot/
├── assets/
│   ├── channel_media/           # Bundled starter media for broadcasts
│   ├── stickers/                # 550+ curated stickers categorized by vibe
│   ├── status_motion_design.gif # Avatar winking motion design GIF
│   └── status_motion_design.mp4 # Avatar winking motion design video (1080x1920)
├── data/
│   ├── contacts.vcf             # Preloaded contact cards
│   ├── finetune_dataset.jsonl   # 353+ curated Nigerian dialogue exemplars
│   ├── train.jsonl              # ML fine-tuning training set
│   └── validation.jsonl         # ML fine-tuning validation set
├── scripts/
│   ├── audit_training_data.py   # Dataset validation and quality auditor
│   ├── check_unreplied.py       # DM catch-up inspector
│   ├── generate_motion_design.py# Motion design video renderer
│   ├── ingest_chats.py          # WhatsApp export chat ingest pipeline
│   ├── ingest_web_datasets.py   # Web dataset parser
│   ├── seed_training_data.js    # SQLite exemplar seeder
│   └── validate_and_finetune.py # Tokenizer and format validator for fine-tuning
├── src/
│   ├── agent/                   # Agent harness, prompt builder, LLM multi-key client
│   ├── config/                  # Environment configuration and owner validation
│   ├── core/                    # Baileys client, context manager, RAG, normalizer, TTS
│   ├── learning/                # Vector store, pattern miner, reinforcement engine
│   ├── memory/                  # Database, chat logger, user profiles, contacts
│   ├── plugins/                 # 20+ plugins and dynamic tool registry
│   ├── security/                # Anti-ban engine, sensitive data filter, HTTP security
│   └── index.ts                 # Application entrypoint & HTTP server
├── test_boss_relay.mjs          # Boss recognition & instant messaging test suite
├── test_daily_broadcasts.mjs    # Channel scraping & status broadcast test suite
├── test_group_admin.mjs         # Elevated group admin test suite (34 tests)
├── test_new_features.cjs        # Master verification test suite (7 tests)
├── test_scheduler_timezone_and_routing.mjs # WAT timezone test suite
├── Dockerfile                   # Cloud container definition
├── ecosystem.config.cjs         # PM2 production process configuration
├── package.json                 # Node.js dependencies and run scripts
├── tsconfig.json                # TypeScript compiler configuration
└── sync.bat                     # Windows GitHub synchronization utility
```

---

## 🚀 Getting Started

### Prerequisites
- **Node.js**: `v22.5.0` or higher
- **Package Manager**: `npm` or `pnpm`
- **Python (Optional for ML pipeline)**: `Python 3.12+` with [`uv`](https://docs.astral.sh/uv/)

### Installation

1. **Clone the repository**:
   ```bash
   git clone https://github.com/DeveloperGru141/Machine-learning-whatsapp-bot-model.git
   cd Machine-learning-whatsapp-bot-model
   ```

2. **Install dependencies**:
   ```bash
   npm install
   ```

3. **Configure Environment Variables**:
   Create a `.env` file in the project root:
   ```env
   # Core Configuration
   BOT_NAME="Forgelabs assistant"
   BOT_CREATOR="ADEMOLA"
   BOT_PREFIX=""
   BOT_TIMEZONE="Africa/Lagos"
   PORT=3000

   # WhatsApp Linking
   PAIRING_METHOD="code"                     # "code" (8-digit pairing) or "qr"
   PAIRING_PHONE_NUMBER="07058967815"        # Bot phone number for pairing
   BOT_OWNERS="08108574293,2348108574293,102409552584830@lid"

   # Primary LLM: Groq Multi-Key Pool (supports comma-separated keys)
   LLM_PROVIDER="groq"
   GROQ_API_KEY="gsk_key1,gsk_key2"
   GROQ_MODEL="qwen/qwen3.8-27b"
   GROQ_TEMPERATURE=0.7
   GROQ_MAX_TOKENS=512

   # Fallback LLMs
   OPENROUTER_API_KEY=""
   CEREBRAS_API_KEY=""

   # Render Session Backup (Auto-populated by bot)
   SESSION_BUNDLE_BASE64=""
   ADMIN_AUTH_TOKEN="your_secure_admin_token"
   ```

4. **Build and Test**:
   ```bash
   # Compile TypeScript
   npm run build

   # Run automated test suite (57+ assertions)
   npm test
   ```

5. **Start Application**:
   ```bash
   # Development mode with hot-reload
   npm run dev

   # Production mode
   npm start
   ```

---

## 🌐 Cloud Deployment (Render / Docker)

The bot is fully optimized for **Render**, **Railway**, and **Fly.io**:

1. **Stateless Container Persistence**:
   - On connection, all 31 authentication session files are compressed and automatically backed up to Render via the Render API (`SESSION_BUNDLE_BASE64`).
   - On redeployment or crash recovery, credentials are automatically hydrated before Baileys initializes, ensuring **zero QR re-scans**.
2. **Web Pairing Portal**:
   - Access `https://<your-service-url>/pair` or `/qr` to pair a new WhatsApp account remotely from any browser.
3. **Keep-Alive & Monitoring**:
   - `GET /health`: Public health check probe (reporting socket status, uptime, and bot name) designed for uptime monitors (UptimeRobot, BetterUptime) without rate-limiting proxy IPs.
   - `GET /logs?token=<ADMIN_AUTH_TOKEN>`: Protected live server logs inspection.
   - `GET /session-bundle?token=<ADMIN_AUTH_TOKEN>`: Protected base64 session backup export.

---

## 🧪 Verification & Test Suites

Run the full automated test suite:
```bash
npm test
```

This executes:
- **`test_new_features.cjs`**: Verifies plain English intro flow, creator phone number privacy, owner kick/demote immunity, JID/WID sanitizer, and anti-generic response distillation.
- **`test_boss_relay.mjs`**: Verifies owner recognition across groups and instant message relay dispatch.
- **`test_group_admin.mjs`**: Verifies elevated admin privileges, anti-link deletion, and admin tool execution.

---

## 🤝 Acknowledgments & Credits

- Designed and built with dedication by **Ademola** (2026).
- Sincere appreciation to my brothers **Micah Okoh** and **Adeniran Glory** for continuous inspiration.
- Built on the open-source foundation of the **Baileys** community (`@whiskeysockets/baileys`).

---
*Forgelabs Assistant — Always sharp, witty, and reliable.* 🤝🔥
