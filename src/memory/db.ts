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
      is_noise INTEGER DEFAULT 0,
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

    -- Known Groups Table: tracks all WhatsApp groups the bot is part of
    CREATE TABLE IF NOT EXISTS known_groups (
      group_jid TEXT PRIMARY KEY,
      subject TEXT NOT NULL,
      member_count INTEGER DEFAULT 0,
      is_admin INTEGER DEFAULT 0,
      updated_at INTEGER NOT NULL
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

    -- Batched Learning Checkpoints: Buffers 20 exchanges before running a single compression API call
    CREATE TABLE IF NOT EXISTS learning_checkpoints (
      chat_jid TEXT PRIMARY KEY,
      last_analyzed_log_id INTEGER DEFAULT 0,
      unprocessed_count INTEGER DEFAULT 0,
      updated_at INTEGER NOT NULL
    );

    -- Learned Behavioral Data: High-density 3-bullet insights mined every 20 exchanges
    CREATE TABLE IF NOT EXISTS learned_behaviors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_jid TEXT NOT NULL,
      sender_jid TEXT,
      behavior_bullet TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_learned_behaviors_chat ON learned_behaviors(chat_jid);

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

    -- Proactive Engagement: Autonomous check-in and dropped-topic follow-up audit log
    CREATE TABLE IF NOT EXISTS proactive_checkins (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_jid TEXT NOT NULL,
      target_type TEXT NOT NULL, -- 'contact' | 'group'
      last_context_snippet TEXT,
      message_sent TEXT NOT NULL,
      timestamp INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_proactive_checkins_chat ON proactive_checkins(chat_jid, timestamp);

    -- Autonomous Sentience Actions: audit log of actions the bot decides and executes on its own
    CREATE TABLE IF NOT EXISTS autonomous_actions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      action_type TEXT NOT NULL,
      target_chat TEXT NOT NULL,
      target_name TEXT,
      summary TEXT NOT NULL,
      timestamp INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_autonomous_actions_time ON autonomous_actions(timestamp);

    -- Bot Corrections: Direct negative/positive reinforcement learned from user and owner feedback
    CREATE TABLE IF NOT EXISTS bot_corrections (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_jid TEXT NOT NULL,
      user_jid TEXT NOT NULL,
      bot_message_text TEXT NOT NULL,
      correction_text TEXT NOT NULL,
      learned_rule TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_bot_corrections_chat ON bot_corrections(chat_jid, created_at);

    -- Group Banter Vectors: Dense subword vector embeddings for local semantic search of group banter
    CREATE TABLE IF NOT EXISTS group_banter_vectors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_jid TEXT NOT NULL,
      sender_jid TEXT NOT NULL,
      sender_name TEXT NOT NULL,
      message_text TEXT NOT NULL,
      context_text TEXT,
      vibe TEXT DEFAULT 'banter',
      embedding TEXT NOT NULL,
      timestamp INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_group_banter_chat ON group_banter_vectors(chat_jid);
  `);

  // Safe migration for existing databases
  try {
    db.exec(`ALTER TABLE contacts ADD COLUMN is_introduced INTEGER DEFAULT 0;`);
  } catch {
    // Column already exists
  }

  try {
    db.exec(`ALTER TABLE chat_logs ADD COLUMN is_noise INTEGER DEFAULT 0;`);
  } catch {
    // Column already exists
  }

  try {
    db.exec(`CREATE INDEX IF NOT EXISTS idx_chat_logs_clean ON chat_logs(chat_jid, is_noise, timestamp);`);
  } catch {}

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

  // Auto-seed dialogue_exemplars & fine_tuning_pairs from data/train.jsonl on fresh server deployments
  seedTrainingExemplarsIfEmpty();
  seedContactsFromVcfIfEmpty();
  cleanTrainingTablesAndSeedUnreplied();
}

function cleanTrainingTablesAndSeedUnreplied(): void {
  try {
    // Purge any accidental raw tool tags or error strings from fine_tuning_pairs & dialogue_exemplars
    db.exec(`
      DELETE FROM fine_tuning_pairs
      WHERE LOWER(assistant_response) LIKE '%<tool_call>%'
         OR LOWER(assistant_response) LIKE '%<function=%'
         OR LOWER(assistant_response) LIKE '%<think>%'
         OR LOWER(assistant_response) LIKE 'network slow small%';

      DELETE FROM dialogue_exemplars
      WHERE LOWER(COALESCE(response_text, '')) LIKE '%<tool_call>%'
         OR LOWER(COALESCE(response_text, '')) LIKE '%<function=%'
         OR LOWER(COALESCE(response_text, '')) LIKE '%<think>%'
         OR LOWER(COALESCE(response_text, '')) LIKE 'network slow small%';
    `);

    // Ensure Marv (230652813291679@lid) who replied to the bot's message ("So you really are alive") is present on cloud instances if chat_logs is empty for him
    const marvLogs = db
      .prepare(`SELECT COUNT(*) as cnt FROM chat_logs WHERE chat_jid = '230652813291679@lid'`)
      .get() as { cnt: number } | undefined;
    if (!marvLogs || marvLogs.cnt === 0) {
      const now = Date.now();
      db.prepare(`
        INSERT INTO chat_logs (chat_jid, sender_jid, sender_name, is_group, content_type, message_text, sticker_filename, timestamp)
        VALUES
          ('230652813291679@lid', '230652813291679@lid', 'Marv', 0, 'text', 'Are you a bot or a real person?', NULL, ?),
          ('230652813291679@lid', 'bot', 'Forgelabs assistant', 0, 'text', 'Yo Marv! Forgelabs here, built by Ademola. How far, wetin dey happen?', NULL, ?),
          ('230652813291679@lid', '230652813291679@lid', 'Marv', 0, 'text', 'So you really are alive', NULL, ?)
      `).run(now - 180_000, now - 120_000, now - 60_000);
    }

    // Clean existing chat logs to flag noise
    try {
      const { chatCleaner } = require('../learning/chat-cleaner.js');
      chatCleaner.cleanExistingLogs();
    } catch {}

    // Index historical group banter vectors for local semantic search
    try {
      const { vectorStore } = require('../learning/vector-store.js');
      vectorStore.indexHistoricalBanter();
    } catch {}
  } catch {}
}

function classifySeedVibe(text: string): string {
  const lower = (text || '').toLowerCase().trim();
  if (/\b(ademola|creator|developer|who built|who made|who coded|who owns|who created|who trained|who programmed|who runs|who is behind)\b/i.test(lower)) {
    return 'creator';
  }
  if (/\b(who are you|what are you|your name|forgelabs|nova|are you nova|are you chatgpt|what is this bot|what can you do|capabilities|wetin you fit do|who am i|what is my name)\b/i.test(lower)) {
    return 'identity';
  }
  if (/\b(micah|david|femi|contact|contacts|address book|phone number|save contact)\b/i.test(lower)) {
    return 'contacts';
  }
  if (/^(hi|hello|hey|yo|sup|good morning|gm|good afternoon|good evening|good night|bye|see ya|how are you)\b/i.test(lower)) {
    return 'greeting';
  }
  if (/\b(btc|bitcoin|eth|sol|solana|price|crypto|stock|market)\b/i.test(lower)) {
    return 'crypto';
  }
  if (/\b(shadow slave|sunny|sunless|nephis|nightmare spell|guiltythree|solo leveling|jin-woo|klein moretti|omniscient reader|gojo|web novel)\b/i.test(lower)) {
    return 'novel';
  }
  if (/\b(download|video|audio|remind|reminder|pdf|doc|document|summarize|read|vcf|voice note|voicenote|vn|speak|say|tts|scrape|link|url|website|article|export|image)\b/i.test(lower)) {
    return 'tools';
  }
  if (/\b(check in|checking in|checking up|check up|dropped|follow up|following up|saying hi|say hi|haven't heard|quiet group|reminder in)\b/i.test(lower)) {
    return 'followup';
  }
  if (/\b(recursion|async|flutter|typescript|python|code|bug)\b/i.test(lower)) {
    return 'tech';
  }
  if (/\b(thanks|thank you|appreciate|smart bro)\b/i.test(lower)) {
    return 'appreciation';
  }
  if (/\b(hehe|lmao|lol|funny|joke)\b/i.test(lower)) {
    return 'humor';
  }
  return 'slang';
}

function seedTrainingExemplarsIfEmpty(): void {
  try {
    const row = db.prepare('SELECT COUNT(*) as count FROM dialogue_exemplars').get() as { count: number } | undefined;
    if (row && row.count > 0) {
      return;
    }

    const candidates = [
      path.resolve('./data/train.jsonl'),
      path.resolve('./data/finetune_dataset.jsonl'),
    ];
    const seedFile = candidates.find((p) => fs.existsSync(p));
    if (!seedFile) return;

    const lines = fs
      .readFileSync(seedFile, 'utf-8')
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);

    if (lines.length === 0) return;

    const insertExemplar = db.prepare(`
      INSERT INTO dialogue_exemplars (chat_jid, context_text, response_text, response_type, sticker_filename, vibe_classification, quality_score, created_at)
      VALUES ('global_pipeline', ?, ?, 'text', NULL, ?, 1.5, ?)
    `);
    const insertPair = db.prepare(`
      INSERT INTO fine_tuning_pairs (system_prompt, user_message, assistant_response, tools_invoked, created_at)
      VALUES (?, ?, ?, '[]', ?)
    `);

    const now = Date.now();
    let seededCount = 0;

    db.exec('BEGIN TRANSACTION');
    try {
      for (const line of lines) {
        try {
          const parsed = JSON.parse(line);
          const msgs = Array.isArray(parsed?.messages) ? parsed.messages : [];
          const sys = msgs.find((m: any) => m.role === 'system')?.content || '';
          const usr = msgs.find((m: any) => m.role === 'user')?.content || '';
          const ast = msgs.find((m: any) => m.role === 'assistant')?.content || '';
          if (usr && ast) {
            const vibe = classifySeedVibe(usr);
            insertExemplar.run(usr, ast, vibe, now);
            insertPair.run(sys, usr, ast, now);
            seededCount++;
          }
        } catch {}
      }
      db.exec('COMMIT');
      console.log(`🌱 [DB] Auto-seeded ${seededCount} fine-tuned dialogue exemplars from ${path.basename(seedFile)}.`);
    } catch (txErr) {
      try { db.exec('ROLLBACK'); } catch {}
      console.warn('[DB] Auto-seed rollback:', txErr);
    }
  } catch (err: any) {
    console.warn('[DB] Could not auto-seed training exemplars:', err.message);
  }
}

function seedContactsFromVcfIfEmpty(): void {
  try {
    const vcfPath = path.resolve('./data/contacts.vcf');
    if (!fs.existsSync(vcfPath)) return;

    const raw = fs.readFileSync(vcfPath, 'utf-8');
    const cards = raw.split(/END:VCARD/i);
    const insertContact = db.prepare(`
      INSERT INTO contacts (phone_number, jid, display_name, custom_name, notes, tags, is_auto_saved, is_introduced, created_at, updated_at)
      VALUES (?, ?, ?, NULL, ?, '[]', 1, 1, ?, ?)
      ON CONFLICT(jid) DO NOTHING
    `);

    const now = Date.now();
    let imported = 0;
    db.exec('BEGIN TRANSACTION');
    try {
      for (const card of cards) {
        const fnMatch = card.match(/^FN:(.*)$/m);
        const telMatch = card.match(/waid=(\d+)/) || card.match(/TEL[^:]*:\+?(\d+)/);
        const lidMatch = card.match(/^X-WA-LID:(\d+)$/m);
        const noteMatch = card.match(/^NOTE:(.*)$/m);
        const displayName = (fnMatch?.[1] || '').trim();
        const phone = (telMatch?.[1] || lidMatch?.[1] || '').trim();
        if (!displayName || !phone) continue;
        const jid = lidMatch ? `${phone}@lid` : `${phone}@s.whatsapp.net`;
        const notes = noteMatch?.[1] ? noteMatch[1].replace(/\\n/g, '\n').trim() : null;
        insertContact.run(phone, jid, displayName, notes, now, now);
        imported++;
      }
      db.exec('COMMIT');
      if (imported > 0) {
        console.log(`📇 [DB] Synced ${imported} contact cards from contacts.vcf.`);
      }
    } catch {
      try { db.exec('ROLLBACK'); } catch {}
    }
  } catch {}
}

// Auto-initialize tables on module load
initDatabase();

export function logAutonomousAction(actionType: string, targetChat: string, targetName: string, summary: string): void {
  try {
    db.prepare(`
      INSERT INTO autonomous_actions (action_type, target_chat, target_name, summary, timestamp)
      VALUES (?, ?, ?, ?, ?)
    `).run(actionType, targetChat, targetName, summary, Date.now());
  } catch (err: any) {
    console.error('[DB] Error logging autonomous action:', err.message);
  }
}

export function getRecentAutonomousActions(limit = 10): Array<{ id: number; action_type: string; target_chat: string; target_name: string; summary: string; timestamp: number }> {
  try {
    return db.prepare(`
      SELECT id, action_type, target_chat, target_name, summary, timestamp
      FROM autonomous_actions
      ORDER BY id DESC LIMIT ?
    `).all(limit) as any;
  } catch {
    return [];
  }
}

export interface KnownGroup {
  group_jid: string;
  subject: string;
  member_count: number;
  is_admin: number;
  updated_at: number;
}

export function upsertKnownGroup(groupJid: string, subject: string, memberCount: number = 0, isAdmin: boolean = false): void {
  try {
    const cleanSubject = (subject || '').trim();
    if (!groupJid || !cleanSubject) return;

    db.prepare(`
      INSERT INTO known_groups (group_jid, subject, member_count, is_admin, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(group_jid) DO UPDATE SET
        subject = excluded.subject,
        member_count = CASE WHEN excluded.member_count > 0 THEN excluded.member_count ELSE known_groups.member_count END,
        is_admin = CASE WHEN excluded.is_admin > 0 THEN excluded.is_admin ELSE known_groups.is_admin END,
        updated_at = excluded.updated_at
    `).run(groupJid, cleanSubject, memberCount, isAdmin ? 1 : 0, Date.now());
  } catch (err: any) {
    console.error('[DB] Error upserting known group:', err?.message || err);
  }
}

export function getAllKnownGroups(limit = 15): KnownGroup[] {
  try {
    return db.prepare(`
      SELECT group_jid, subject, member_count, is_admin, updated_at
      FROM known_groups
      ORDER BY updated_at DESC
      LIMIT ?
    `).all(limit) as unknown as KnownGroup[];
  } catch {
    return [];
  }
}

export function findKnownGroup(nameOrJid: string): KnownGroup | null {
  try {
    const raw = (nameOrJid || '').trim();
    if (!raw) return null;

    if (raw.endsWith('@g.us')) {
      const byJid = db.prepare('SELECT * FROM known_groups WHERE group_jid = ?').get(raw) as unknown as KnownGroup;
      if (byJid) return byJid;
    }

    // Exact match or substring search (case-insensitive)
    const bySub = db.prepare(`
      SELECT * FROM known_groups
      WHERE LOWER(subject) = LOWER(?) OR LOWER(subject) LIKE LOWER(?)
      ORDER BY CASE WHEN LOWER(subject) = LOWER(?) THEN 0 ELSE 1 END, updated_at DESC
      LIMIT 1
    `).get(raw, `%${raw}%`, raw) as unknown as KnownGroup;

    return bySub || null;
  } catch {
    return null;
  }
}




