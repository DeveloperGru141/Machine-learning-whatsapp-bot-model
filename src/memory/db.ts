import { DatabaseSync } from 'node:sqlite';
import { config } from '../config/env.js';
import fs from 'fs';
import path from 'path';

// Ensure data directory exists
const dbDir = path.dirname(config.paths.database);
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

export const db = new DatabaseSync(config.paths.database);

// Initialize database tables
export function initDatabase() {
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 10000;
    PRAGMA synchronous = NORMAL;

    -- Raw chat message stream for pattern learning and context
    CREATE TABLE IF NOT EXISTS chat_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_jid TEXT NOT NULL,
      sender_jid TEXT NOT NULL,
      sender_name TEXT,
      is_group INTEGER NOT NULL,
      content_type TEXT NOT NULL,
      message_text TEXT,
      sticker_filename TEXT,
      timestamp INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_chat_logs_chat ON chat_logs(chat_jid, timestamp);

    -- Long-term continuous facts learned about users
    CREATE TABLE IF NOT EXISTS user_facts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_jid TEXT NOT NULL,
      fact TEXT NOT NULL,
      category TEXT DEFAULT 'general',
      updated_at INTEGER NOT NULL,
      UNIQUE(user_jid, fact)
    );

    -- Group topics, culture, and context memory
    CREATE TABLE IF NOT EXISTS group_facts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      group_jid TEXT NOT NULL,
      topic TEXT NOT NULL,
      summary TEXT,
      updated_at INTEGER NOT NULL,
      UNIQUE(group_jid, topic)
    );

    -- Sticker catalog and learned contextual trigger patterns
    CREATE TABLE IF NOT EXISTS sticker_catalog (
      filename TEXT PRIMARY KEY,
      vibe_tags TEXT NOT NULL,
      description TEXT,
      learned_triggers TEXT,
      usage_count INTEGER DEFAULT 0,
      added_at INTEGER NOT NULL
    );

    -- Chat Style Profiles: Continuous ML-style profiling of chat vibe and tone
    CREATE TABLE IF NOT EXISTS chat_style_profiles (
      chat_jid TEXT PRIMARY KEY,
      total_messages INTEGER DEFAULT 0,
      sticker_ratio REAL DEFAULT 0.0,
      avg_length REAL DEFAULT 0.0,
      humor_score REAL DEFAULT 0.0,
      top_emojis TEXT DEFAULT '[]',
      slang_tokens TEXT DEFAULT '[]',
      formality_style TEXT DEFAULT 'casual',
      updated_at INTEGER NOT NULL
    );

    -- Dialogue Exemplars: Real high-quality dialogue turns mined across chats for dynamic few-shot in-context learning
    CREATE TABLE IF NOT EXISTS dialogue_exemplars (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_jid TEXT NOT NULL,
      context_text TEXT NOT NULL,
      response_text TEXT,
      response_type TEXT NOT NULL, -- 'text', 'sticker', 'text_and_sticker'
      sticker_filename TEXT,
      vibe_classification TEXT,    -- 'banter', 'humor', 'agreement', 'question_answer', 'greeting'
      quality_score REAL DEFAULT 1.0,
      created_at INTEGER NOT NULL
    );

    -- Fine-Tuning Pairs: Curated instruction/response datasets ready for export to JSONL
    CREATE TABLE IF NOT EXISTS fine_tuning_pairs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      system_prompt TEXT NOT NULL,
      user_message TEXT NOT NULL,
      assistant_response TEXT NOT NULL,
      tools_invoked TEXT,
      created_at INTEGER NOT NULL
    );

    -- Persistent Per-User Memory & Preferences
    CREATE TABLE IF NOT EXISTS user_profiles (
      user_jid TEXT PRIMARY KEY,
      display_name TEXT,
      preferred_language TEXT DEFAULT 'en',
      personality_notes TEXT DEFAULT '',
      first_seen INTEGER NOT NULL,
      last_seen INTEGER NOT NULL,
      total_messages INTEGER DEFAULT 0,
      is_owner INTEGER DEFAULT 0
    );

    -- Conversation Summaries: Compact history rollups for context window management
    CREATE TABLE IF NOT EXISTS conversation_summaries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_jid TEXT NOT NULL,
      summary TEXT NOT NULL,
      messages_covered INTEGER NOT NULL,
      from_timestamp INTEGER NOT NULL,
      to_timestamp INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_conversation_summaries_chat ON conversation_summaries(chat_jid, to_timestamp);

    -- Contacts Book: Automatic and manual contact saving, address book indexing, and vCard export
    CREATE TABLE IF NOT EXISTS contacts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      phone_number TEXT NOT NULL,
      jid TEXT NOT NULL UNIQUE,
      display_name TEXT NOT NULL,
      custom_name TEXT,
      notes TEXT,
      tags TEXT DEFAULT '[]',
      is_auto_saved INTEGER DEFAULT 1,
      is_introduced INTEGER DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_contacts_phone ON contacts(phone_number);
    CREATE INDEX IF NOT EXISTS idx_contacts_name ON contacts(display_name);
  `);

  // Safe migration for existing databases
  try {
    db.exec(`ALTER TABLE contacts ADD COLUMN is_introduced INTEGER DEFAULT 0;`);
  } catch {
    // Column already exists
  }

  // Ensure contacts who already have bot replies in chat_logs are marked as introduced
  try {
    db.exec(`
      UPDATE contacts
      SET is_introduced = 1
      WHERE is_introduced = 0
        AND EXISTS (
          SELECT 1 FROM chat_logs l
          WHERE l.chat_jid = contacts.jid
            AND l.sender_jid = 'bot'
        );
    `);
  } catch {}
}

// Auto-initialize tables on module load
initDatabase();

