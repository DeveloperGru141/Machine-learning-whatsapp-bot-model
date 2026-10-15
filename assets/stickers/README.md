# WhatsApp Sticker Directory

Drop your `.webp` stickers into this directory!

## How It Works
1. Every `.webp` file placed here is automatically scanned, indexed, and cataloged into the bot's local SQLite database.
2. The bot uses the filename as the initial mood/vibe tags (e.g., `funny_laugh.webp`, `dancing_cat.webp`, `facepalm.webp`, `fire_celebration.webp`).
3. As the bot participates in chats, it observes chatting patterns and contextual moods. The Groq reasoning engine (`openai/gpt-oss-120b`) autonomously decides when to trigger sticker replies from this catalog to match the vibe of the conversation.
