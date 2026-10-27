# WhatsApp Modular Bot

A TypeScript WhatsApp bot built with Baileys, an LLM agent, modular tools, and a local SQLite memory store. The project supports direct-message conversations, selected group tools, scheduled reminders, and media features.

> The bot connects through the WhatsApp Web protocol using Baileys, an unofficial client library. It is not the official WhatsApp Cloud API. Review WhatsApp's current terms and your deployment requirements before using it.

## What it does

- Replies to text and supported media messages through a configurable LLM provider.
- Uses per-chat conversation summaries, recent history, and user preferences for continuity.
- Matches a DM partner's current language and register. Clear language preferences can be saved to that person's profile.
- Resolves phone-number JIDs and Baileys LID aliases to the same saved contact when sync data provides both.
- Provides modular tools for memory, contacts, groups, scheduling, web search, documents, media, and voice notes.
- Publishes scheduled WhatsApp Status content through one status send path that strips internal reasoning and tool markup.
- Limits status memes to two per WAT day with at least six hours between posts; one daily meme slot is randomized in the afternoon/evening window.
- Applies bounded inbound request concurrency and per-user rate limits.

## Project layout

- `src/agent`: prompt construction, LLM calls, and tool orchestration.
- `src/core`: WhatsApp client, queue, context management, sender, rate limits, and health server.
- `src/memory`: SQLite schema, profiles, contacts, chat history, and persistent summaries.
- `src/learning`: style adaptation, retrieval, and approved dataset export.
- `src/plugins`: optional bot capabilities.
- `scripts`: data curation and operational scripts.
- `data/`: local database and curated training artifacts.
- `assets/`: bundled media and stickers.

## Requirements

- Node.js 22.5 or later.
- npm.
- Python is only needed for the optional data scripts; the npm scripts use `uv`.

## Setup

1. Install dependencies:

   ```sh
   npm install
   ```

2. Copy `.env.example` to `.env` and fill in only the settings needed for your deployment. Common settings include:

   - `LLM_PROVIDER`, `GROQ_API_KEY`, and the selected model settings.
   - `PAIRING_METHOD` and `PAIRING_PHONE_NUMBER` if using pairing code.
   - `BOT_NAME`, `BOT_PREFIX`, and `BOT_OWNERS`.
   - `PORT`, `SESSIONS_DIR`, and `DATABASE_PATH`.

   Add provider keys for optional features only when you enable them. Keep `.env`, WhatsApp session credentials, local databases, contact exports, and training source files out of public repositories.

3. Start the development process:

   ```sh
   npm run dev
   ```

4. Pair the WhatsApp account using the configured QR or pairing-code flow, then start the built app in production:

   ```sh
   npm run build
   npm start
   ```

The HTTP server exposes health/status routes, including `/health`. Do not expose operational routes publicly without the protections configured for your deployment.

## Memory and language preferences

The bot keeps a short recent message window and periodically stores a compact summary for each chat. It also stores per-user profile facts and language preferences in SQLite. Summary generation ignores marked noise and caps the transcript size.

Conversation text, retrieved facts, and saved profile details are reference data. They do not override the bot's system instructions. Avoid storing secrets or sensitive personal information in memory.

Language selection works conservatively:

- The latest message guides the language for that reply when it is clearly recognized.
- A direct request such as “reply to me in Yoruba” saves that preference.
- An explicitly saved preference stays in effect until the sender asks to change it.
- Repeated, high-confidence language signals may update the inferred preference.
- If the message is mixed or ambiguous, the bot follows the saved preference or uses English.

## Contact matching

Baileys may represent the same person with both a phone-number JID and a LID. Contact sync stores available identifiers as aliases for one canonical phone contact. Phone lookups use exact matches; name searches prefer exact names before partial matches. A LID without a known phone-number mapping is not treated as a phone number.

## Queue and outbound safeguards

The request queue runs at most three handlers at once and holds at most 50 waiting requests. When full, it rejects new work and preserves requests already waiting. A slow task keeps its concurrency slot until it finishes, preventing overlapping work for the same chat.

The inbound user limit is six messages per minute. Outbound messages use a shared queue and a global cap. A WhatsApp restriction signal pauses outbound activity; the bot does not attempt to disguise or bypass platform enforcement. Status content is sanitized before dispatch so model reasoning tags and tool directives are not sent.

## Training data

The pipeline no longer searches Downloads, reads WhatsApp database backups, or includes live SQLite chats, contact records, memories, or automatically mined dialogue in fine-tuning exports.

- `data/curated_seed.jsonl` contains selected built-in conversational examples; identity, creator, and contact examples are omitted because system rules and contact tools handle those behaviors.
- `data/public_training.jsonl` is produced by the optional public-dataset importer.
- `data/approved_training.jsonl` receives examples from the explicit chat importer after privacy filtering.
- Generate the built-in source with `node scripts/seed_training_data.js`. Generate public-source examples with `uv run --python 3.15 python scripts/ingest_web_datasets.py`.
- The chat importer requires one explicitly selected WhatsApp text export and the exact assistant sender label. It creates only user-to-assistant pairs and skips common secrets, identifiers, email addresses, and phone-number-like values.
- Review the export and get participants' consent before importing private conversations.
- `npm run validate-data` reads only those three source files, filters malformed or sensitive examples, deduplicates pairs, applies a seeded shuffle, and writes `train.jsonl`, `validation.jsonl`, and `finetune_dataset.jsonl`.
- The database export tool includes curated and public-source examples only. The file-based validator includes explicitly approved chat data; live conversation logs are excluded from both paths.

Example import command:

```sh
npm run ingest -- --input "./reviewed-export.txt" --assistant-sender "Me"
npm run validate-data
```

Do not commit private exports or `approved_training.jsonl`. The validator follows the standard practice of keeping held-out data separate from training and avoiding data-derived transformations that leak between splits. See the [scikit-learn common pitfalls guide](https://scikit-learn.org/stable/common_pitfalls) and [Hugging Face Datasets processing guide](https://huggingface.co/docs/datasets/process).

## Scheduled Status memes

The scheduled Status-meme job chooses a randomized daily time within its configured WAT window. Status posting also enforces a two-per-day cap and six-hour spacing across scheduled and manual meme sends. Other Status categories use the shared sanitizer and send path.

## Useful commands

```sh
npm run dev          # Run TypeScript directly with watch mode
npm run build        # Compile TypeScript into dist/
npm start            # Run the compiled app
npm run validate-data
npm run ingest -- --input "./reviewed-export.txt" --assistant-sender "Me"
```

## Security and repository hygiene

- Never commit `.env`, WhatsApp session files, local SQLite databases, contact exports, or private training sources.
- Rotate any provider key that has been pasted into chat, logs, or source control.
- Check `git status --short` before committing, and inspect generated JSONL for personal information without printing message contents to shared logs.
- Baileys and WhatsApp behavior can change; keep dependencies and deployment configuration current.
