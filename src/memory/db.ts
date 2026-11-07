import { AsyncLocalStorage } from 'node:async_hooks';
import { createClient, type Client, type InArgs, type InValue, type Transaction } from '@libsql/client';
import { config } from '../config/env.js';
import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'node:url';

// Use the managed Turso database directly when credentials are configured.
// Keep a local libSQL file as the development fallback.
const dbDir = path.dirname(config.paths.database);
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

if (Boolean(config.turso.databaseUrl) !== Boolean(config.turso.authToken)) {
  throw new Error('Turso requires both TURSO_DATABASE_URL and TURSO_AUTH_TOKEN.');
}

const transactionContext = new AsyncLocalStorage<Transaction>();
const localUrl = pathToFileURL(config.paths.database).toString();
const client: Client = config.turso.databaseUrl
  ? createClient({
      url: config.turso.databaseUrl,
      authToken: config.turso.authToken,
      readYourWrites: true,
    })
  : createClient({ url: localUrl });

function statementArgs(args: unknown[]): InArgs {
  return args.map((value) => (value === undefined ? null : value)) as InValue[];
}

class AsyncDatabaseStatement {
  constructor(private readonly sql: string) {}

  private execute(args: unknown[] = []) {
    const statement = { sql: this.sql, args: statementArgs(args) };
    const transaction = transactionContext.getStore();
    return transaction ? transaction.execute(statement) : client.execute(statement);
  }

  async run(...args: unknown[]): Promise<{ changes: number; lastInsertRowid?: number }> {
    const result = await this.execute(args);
    return {
      changes: Number(result.rowsAffected),
      lastInsertRowid: result.lastInsertRowid == null ? undefined : Number(result.lastInsertRowid),
    };
  }

  async get(...args: unknown[]): Promise<Record<string, unknown> | undefined> {
    const result = await this.execute(args);
    return result.rows[0] as Record<string, unknown> | undefined;
  }

  async all(...args: unknown[]): Promise<Array<Record<string, unknown>>> {
    const result = await this.execute(args);
    return result.rows as Array<Record<string, unknown>>;
  }
}

export const db = {
  prepare(sql: string): AsyncDatabaseStatement {
    return new AsyncDatabaseStatement(sql);
  },

  async exec(sql: string): Promise<void> {
    const transaction = transactionContext.getStore();
    if (transaction) {
      await transaction.executeMultiple(sql);
      return;
    }
    await client.executeMultiple(sql);
  },

  async transaction<T>(operation: () => Promise<T> | T): Promise<T> {
    const transaction = await client.transaction('write');
    try {
      const result = await transactionContext.run(transaction, operation);
      await transaction.commit();
      return result;
    } catch (error) {
      if (!transaction.closed) await transaction.rollback();
      throw error;
    }
  },

  close(): void {
    client.close();
  },
};

// Initialize database tables
export async function initDatabase() {
  await db.exec(`
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
      message_id TEXT,
      is_noise INTEGER DEFAULT 0,
      timestamp INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_chat_logs_chat ON chat_logs(chat_jid, timestamp);
    CREATE INDEX IF NOT EXISTS idx_chat_logs_dm_inbound_latest
      ON chat_logs(chat_jid, id DESC) WHERE is_group = 0 AND sender_jid != 'bot';
    CREATE INDEX IF NOT EXISTS idx_chat_logs_dm_inbound_time
      ON chat_logs(timestamp, chat_jid, id) WHERE is_group = 0 AND sender_jid != 'bot';
    CREATE INDEX IF NOT EXISTS idx_chat_logs_bot_reply_lookup
      ON chat_logs(chat_jid, id DESC) WHERE sender_jid = 'bot';
    CREATE INDEX IF NOT EXISTS idx_chat_logs_bot_reply_time
      ON chat_logs(chat_jid, timestamp, id) WHERE sender_jid = 'bot';

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
      created_at INTEGER NOT NULL,
      source_type TEXT NOT NULL DEFAULT 'unknown'
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
      language_source TEXT NOT NULL DEFAULT 'default',
      language_candidate TEXT,
      language_candidate_count INTEGER NOT NULL DEFAULT 0,
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

    -- Baileys may expose a phone-number JID and a separate LID for the same person.
    CREATE TABLE IF NOT EXISTS contact_jid_aliases (
      alias_jid TEXT PRIMARY KEY,
      contact_jid TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_contact_jid_aliases_contact ON contact_jid_aliases(contact_jid);

    -- Pending status-meme reservations prevent overlapping scheduler paths exceeding the daily cap.
    CREATE TABLE IF NOT EXISTS status_meme_reservations (
      reservation_id TEXT PRIMARY KEY,
      reserved_at INTEGER NOT NULL
    );

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

    -- Durable retry state for individual inbound DMs that still need a response.
    CREATE TABLE IF NOT EXISTS dm_reply_attempts (
      inbound_log_id INTEGER PRIMARY KEY,
      chat_jid TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'failed',
      attempts INTEGER NOT NULL DEFAULT 0,
      last_attempt_at INTEGER NOT NULL DEFAULT 0,
      next_attempt_at INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      completed_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_dm_reply_attempts_retry ON dm_reply_attempts(status, next_attempt_at);

    -- Live conversation examples are eligible for training only after the speaker opts in.
    CREATE TABLE IF NOT EXISTS training_consents (
      user_jid TEXT PRIMARY KEY,
      opted_in INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL
    );

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

    -- Contact Relay Sessions: routes replies from messaged contacts back to whoever requested the dispatch
    CREATE TABLE IF NOT EXISTS contact_relay_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      requester_jid TEXT NOT NULL,
      requester_name TEXT,
      origin_chat_jid TEXT NOT NULL,
      origin_is_group INTEGER DEFAULT 0,
      target_jid TEXT NOT NULL,
      target_phone TEXT,
      dispatched_text TEXT NOT NULL,
      status TEXT DEFAULT 'pending',
      created_at INTEGER NOT NULL,
      replied_at INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_contact_relay_target ON contact_relay_sessions(target_jid, status);
    CREATE INDEX IF NOT EXISTS idx_contact_relay_phone ON contact_relay_sessions(target_phone, status);

    -- WhatsApp Channel Motivational Quotes Bank (scraped from Quotes📖 channel 0029Vb7S3VAFCCoXEIdW5n2k)
    CREATE TABLE IF NOT EXISTS channel_quotes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      quote_text TEXT NOT NULL UNIQUE,
      author TEXT,
      niche TEXT NOT NULL, -- 'tech_coding' | 'wealth_business' | 'academic_discipline' | 'general_growth'
      image_path TEXT,
      channel_source TEXT DEFAULT '0029Vb7S3VAFCCoXEIdW5n2k',
      channel_message_id TEXT,
      used_count INTEGER DEFAULT 0,
      last_used_at INTEGER DEFAULT 0,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_channel_quotes_niche ON channel_quotes(niche, used_count);

    -- WhatsApp Channel Memes Bank (scraped from Memes channel 0029Vb6oS4LJkK7AvtORyH46 with 2hr cooldown)
    CREATE TABLE IF NOT EXISTS channel_memes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      caption TEXT NOT NULL,
      media_type TEXT DEFAULT 'text', -- 'image' | 'video' | 'text'
      media_url TEXT,
      image_path TEXT,
      channel_source TEXT DEFAULT '0029Vb6oS4LJkK7AvtORyH46',
      channel_message_id TEXT,
      used_count INTEGER DEFAULT 0,
      last_posted_at INTEGER DEFAULT 0,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_channel_memes_posted ON channel_memes(last_posted_at, used_count);

    -- Contact Save Reminders: Safe, human-paced, anti-ban contact outreach for WhatsApp status visibility
    CREATE TABLE IF NOT EXISTS contact_save_reminders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      contact_jid TEXT UNIQUE NOT NULL,
      phone_number TEXT NOT NULL,
      contact_name TEXT,
      template_index INTEGER DEFAULT 0,
      message_sent TEXT NOT NULL,
      status TEXT DEFAULT 'pending', -- 'pending' | 'sent' | 'failed' | 'skipped'
      error_reason TEXT,
      created_at INTEGER NOT NULL,
      sent_at INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_contact_reminders_status ON contact_save_reminders(status);
    CREATE INDEX IF NOT EXISTS idx_contact_reminders_phone ON contact_save_reminders(phone_number);

    -- Bot Runtime Settings (TTS Voice ID, feature toggles, cadence configuration)
    CREATE TABLE IF NOT EXISTS bot_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );

    -- WhatsApp Auth Session Store: persistent backup of multi-file auth keys & bundle
    CREATE TABLE IF NOT EXISTS whatsapp_session_store (
      id TEXT PRIMARY KEY,
      bundle TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );

    -- Anti-ViewOnce Media Vault (captured view-once images/videos/audio)
    CREATE TABLE IF NOT EXISTS view_once_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      message_id TEXT UNIQUE NOT NULL,
      chat_jid TEXT NOT NULL,
      chat_name TEXT,
      sender_jid TEXT NOT NULL,
      sender_name TEXT,
      is_group INTEGER NOT NULL,
      media_type TEXT NOT NULL, -- 'image' | 'video' | 'audio'
      caption TEXT,
      file_path TEXT NOT NULL,
      file_size INTEGER DEFAULT 0,
      timestamp INTEGER NOT NULL,
      retrieved_count INTEGER DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_view_once_chat ON view_once_messages(chat_jid);
    CREATE INDEX IF NOT EXISTS idx_view_once_sender ON view_once_messages(sender_jid);
    CREATE INDEX IF NOT EXISTS idx_view_once_time ON view_once_messages(timestamp);
  `);

  // Safe migration for existing databases
  try {
    await db.exec(`ALTER TABLE contacts ADD COLUMN is_introduced INTEGER DEFAULT 0;`);
  } catch {
    // Column already exists
  }

  try {
    await db.exec(`ALTER TABLE chat_logs ADD COLUMN is_noise INTEGER DEFAULT 0;`);
  } catch {
    // Column already exists
  }

  try {
    await db.exec(`ALTER TABLE chat_logs ADD COLUMN message_id TEXT;`);
  } catch {
    // Column already exists
  }

  for (const [column, definition] of [
    ['language_source', "TEXT NOT NULL DEFAULT 'default'"],
    ['language_candidate', 'TEXT'],
    ['language_candidate_count', 'INTEGER NOT NULL DEFAULT 0'],
  ]) {
    try { await db.exec(`ALTER TABLE user_profiles ADD COLUMN ${column} ${definition};`); } catch {}
  }
  try { await db.exec("ALTER TABLE fine_tuning_pairs ADD COLUMN source_type TEXT NOT NULL DEFAULT 'unknown';"); } catch {}

  try {
    await db.exec(`ALTER TABLE channel_quotes ADD COLUMN image_path TEXT;`);
  } catch {
    // Column already exists
  }

  try {
    await db.exec(`CREATE INDEX IF NOT EXISTS idx_chat_logs_clean ON chat_logs(chat_jid, is_noise, timestamp);`);
  } catch {}

  // Ensure contacts who already have bot replies in chat_logs are marked as introduced
  try {
    await db.exec(`
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

  await seedContactsFromVcfIfEmpty();
  await cleanTrainingTablesAndSeedUnreplied();
}

async function cleanTrainingTablesAndSeedUnreplied(): Promise<void> {
  try {
    // Purge any accidental raw tool tags or error strings from fine_tuning_pairs & dialogue_exemplars
    await db.exec(`
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

    // Permanently purge any stale 'Marv' (230652813291679@lid) entries across all tables so it never loops
    try {
      await db.prepare(`DELETE FROM chat_logs WHERE chat_jid = '230652813291679@lid' OR sender_name = 'Marv' OR LOWER(message_text) LIKE '%so you really are alive%'`).run();
      await db.prepare(`DELETE FROM contacts WHERE jid = '230652813291679@lid' OR phone_number = '230652813291679' OR LOWER(display_name) = 'marv'`).run();
      await db.prepare(`DELETE FROM user_profiles WHERE user_jid = '230652813291679@lid' OR LOWER(display_name) = 'marv'`).run();
      await db.prepare(`DELETE FROM learning_checkpoints WHERE chat_jid = '230652813291679@lid'`).run();
      await db.prepare(`DELETE FROM analytics_events WHERE chat_jid = '230652813291679@lid'`).run();
      await db.prepare(`DELETE FROM fine_tuning_pairs WHERE user_message LIKE '%So you really are alive%' OR system_prompt LIKE '%Marv%'`).run();
    } catch {}

  } catch {}
}

export async function runDatabasePostInitMaintenance(): Promise<void> {
  try {
    const { chatCleaner } = await import('../learning/chat-cleaner.js');
    await chatCleaner.cleanExistingLogs();
  } catch (error) {
    console.warn('[DB] Existing chat-log cleanup skipped:', error);
  }

  try {
    const { vectorStore } = await import('../learning/vector-store.js');
    await vectorStore.indexHistoricalBanter();
  } catch (error) {
    console.warn('[DB] Historical vector indexing skipped:', error);
  }
}

async function seedContactsFromVcfIfEmpty(): Promise<void> {
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
    const imported = await db.transaction(async () => {
      let count = 0;
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
        await insertContact.run(phone, jid, displayName, notes, now, now);
        count++;
      }
      return count;
    });
    if (imported > 0) console.log(`📇 [DB] Synced ${imported} contact cards from contacts.vcf.`);
  } catch {}
}

// Auto-initialize tables on module load
await initDatabase();

export async function logAutonomousAction(actionType: string, targetChat: string, targetName: string, summary: string): Promise<void> {
  try {
    await db.prepare(`
      INSERT INTO autonomous_actions (action_type, target_chat, target_name, summary, timestamp)
      VALUES (?, ?, ?, ?, ?)
    `).run(actionType, targetChat, targetName, summary, Date.now());
  } catch (err: any) {
    console.error('[DB] Error logging autonomous action:', err.message);
  }
}

export async function getRecentAutonomousActions(limit = 10): Promise<Array<{ id: number; action_type: string; target_chat: string; target_name: string; summary: string; timestamp: number }>> {
  try {
    return await db.prepare(`
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

export async function upsertKnownGroup(groupJid: string, subject: string, memberCount: number = 0, isAdmin: boolean = false): Promise<void> {
  try {
    const cleanSubject = (subject || '').trim();
    if (!groupJid || !cleanSubject) return;

    await db.prepare(`
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

export async function getAllKnownGroups(limit = 50): Promise<KnownGroup[]> {
  try {
    return await db.prepare(`
      SELECT group_jid, subject, member_count, is_admin, updated_at
      FROM known_groups
      ORDER BY updated_at DESC
      LIMIT ?
    `).all(limit) as unknown as KnownGroup[];
  } catch {
    return [];
  }
}

export async function findKnownGroup(nameOrJid: string): Promise<KnownGroup | null> {
  try {
    const raw = (nameOrJid || '').trim();
    if (!raw) return null;

    if (raw.endsWith('@g.us')) {
      const byJid = await db.prepare('SELECT * FROM known_groups WHERE group_jid = ?').get(raw) as unknown as KnownGroup;
      if (byJid) return byJid;
    }

    const bySub = await db.prepare(`
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

export async function setGroupAdminStatus(groupJid: string, isAdmin: boolean): Promise<void> {
  try {
    await db.prepare(`
      UPDATE known_groups SET is_admin = ?, updated_at = ? WHERE group_jid = ?
    `).run(isAdmin ? 1 : 0, Date.now(), groupJid);
  } catch (err: any) {
    console.error('[DB] Error updating group admin status:', err?.message || err);
  }
}

export interface RelaySession {
  id: number;
  requester_jid: string;
  requester_name: string | null;
  origin_chat_jid: string;
  origin_is_group: number;
  target_jid: string;
  target_phone: string | null;
  dispatched_text: string;
  status: 'pending' | 'replied' | 'expired';
  created_at: number;
  replied_at: number | null;
}

export async function recordRelaySession(params: {
  requesterJid: string;
  requesterName?: string;
  originChatJid: string;
  originIsGroup: boolean;
  targetJid: string;
  targetPhone?: string;
  dispatchedText: string;
}): Promise<number> {
  try {
    const res = await db.prepare(`
      INSERT INTO contact_relay_sessions (
        requester_jid, requester_name, origin_chat_jid, origin_is_group,
        target_jid, target_phone, dispatched_text, status, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)
    `).run(
      params.requesterJid,
      params.requesterName || null,
      params.originChatJid,
      params.originIsGroup ? 1 : 0,
      params.targetJid,
      params.targetPhone || null,
      params.dispatchedText,
      Date.now()
    );
    return Number(res.lastInsertRowid || 0);
  } catch (err: any) {
    console.error('[DB] Error recording relay session:', err?.message || err);
    return 0;
  }
}

export async function findActiveRelaySession(senderJid: string, senderPhone?: string): Promise<RelaySession | null> {
  try {
    const maxAge = Date.now() - 48 * 60 * 60 * 1000; // Active within past 48 hours
    const cleanPhone = senderPhone ? senderPhone.replace(/\D/g, '') : '';

    let row = await db.prepare(`
      SELECT * FROM contact_relay_sessions
      WHERE target_jid = ? AND status = 'pending' AND created_at >= ?
      ORDER BY id DESC LIMIT 1
    `).get(senderJid, maxAge) as unknown as RelaySession | undefined;

    if (!row && cleanPhone) {
      row = await db.prepare(`
        SELECT * FROM contact_relay_sessions
        WHERE target_phone = ? AND status = 'pending' AND created_at >= ?
        ORDER BY id DESC LIMIT 1
      `).get(cleanPhone, maxAge) as unknown as RelaySession | undefined;
    }

    // Also match if senderJid is an LID or vice-versa
    if (!row && senderJid.endsWith('@lid')) {
      row = await db.prepare(`
        SELECT * FROM contact_relay_sessions
        WHERE target_jid = ? AND status = 'pending' AND created_at >= ?
        ORDER BY id DESC LIMIT 1
      `).get(senderJid, maxAge) as unknown as RelaySession | undefined;
    }

    return row || null;
  } catch (err: any) {
    console.error('[DB] Error querying active relay session:', err?.message || err);
    return null;
  }
}

export async function markRelaySessionReplied(id: number): Promise<void> {
  try {
    await db.prepare(`
      UPDATE contact_relay_sessions
      SET status = 'replied', replied_at = ?
      WHERE id = ?
    `).run(Date.now(), id);
  } catch (err: any) {
    console.error('[DB] Error marking relay session replied:', err?.message || err);
  }
}

export type QuoteNiche = 'tech_coding' | 'wealth_business' | 'academic_discipline' | 'general_growth';

export interface ChannelQuote {
  id: number;
  quote_text: string;
  author: string | null;
  niche: QuoteNiche;
  image_path: string | null;
  channel_source: string;
  channel_message_id: string | null;
  used_count: number;
  last_used_at: number;
  created_at: number;
}

/**
 * Inserts or updates a quote scraped from the WhatsApp channel.
 */
export async function saveChannelQuote(
  quoteText: string,
  author?: string | null,
  niche: QuoteNiche = 'general_growth',
  channelSource: string = '0029Vb7S3VAFCCoXEIdW5n2k',
  messageId?: string | null,
  imagePath?: string | null
): Promise<boolean> {
  try {
    const cleanText = (quoteText || '').trim();
    if (!cleanText || cleanText.length < 10) return false;

    const cleanAuthor = author ? author.trim() : null;

    await db.prepare(`
      INSERT INTO channel_quotes (quote_text, author, niche, image_path, channel_source, channel_message_id, used_count, last_used_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?)
      ON CONFLICT(quote_text) DO UPDATE SET
        author = COALESCE(excluded.author, channel_quotes.author),
        image_path = COALESCE(excluded.image_path, channel_quotes.image_path),
        niche = CASE WHEN channel_quotes.niche = 'general_growth' THEN excluded.niche ELSE channel_quotes.niche END
    `).run(cleanText, cleanAuthor, niche, imagePath || null, channelSource, messageId || null, Date.now());
    return true;
  } catch (err: any) {
    console.error('[DB] Error saving channel quote:', err?.message || err);
    return false;
  }
}

/**
 * Retrieves the freshest, least recently used quote matching a specific niche.
 */
export async function getFreshestQuoteForNiche(niche: QuoteNiche): Promise<ChannelQuote | null> {
  try {
    // Pick from matching niche with lowest used_count, ordered by last_used_at ASC
    let quote = await db.prepare(`
      SELECT * FROM channel_quotes
      WHERE niche = ?
      ORDER BY CASE WHEN instr(image_path, 'newsletter_') > 0 THEN 0 ELSE 1 END,
               used_count ASC, last_used_at ASC, RANDOM()
      LIMIT 1
    `).get(niche) as unknown as ChannelQuote | undefined;

    // Fallback to general_growth if niche has no quotes yet
    if (!quote) {
      quote = await db.prepare(`
        SELECT * FROM channel_quotes
        ORDER BY used_count ASC, last_used_at ASC, RANDOM()
        LIMIT 1
      `).get() as unknown as ChannelQuote | undefined;
    }

    return quote || null;
  } catch (err: any) {
    console.error('[DB] Error getting quote for niche:', err?.message || err);
    return null;
  }
}

/**
 * Marks a quote as used so the scheduler rotates smoothly without repeating recently used quotes.
 */
export async function markQuoteUsed(id: number): Promise<void> {
  try {
    await db.prepare(`
      UPDATE channel_quotes
      SET used_count = used_count + 1, last_used_at = ?
      WHERE id = ?
    `).run(Date.now(), id);
  } catch (err: any) {
    console.error('[DB] Error marking quote used:', err?.message || err);
  }
}

/**
 * Returns all stored channel quotes with pagination.
 */
export async function getAllChannelQuotes(limit = 100): Promise<ChannelQuote[]> {
  try {
    return await db.prepare(`
      SELECT * FROM channel_quotes
      ORDER BY id DESC
      LIMIT ?
    `).all(limit) as unknown as ChannelQuote[];
  } catch {
    return [];
  }
}

/**
 * Retrieves statistics about stored quotes.
 */
export async function getChannelQuotesStats(): Promise<{ total: number; byNiche: Record<string, number> }> {
  try {
    const totalRow = await db.prepare('SELECT COUNT(*) as count FROM channel_quotes').get() as { count: number };
    const rows = await db.prepare('SELECT niche, COUNT(*) as count FROM channel_quotes GROUP BY niche').all() as Array<{ niche: string; count: number }>;
    const byNiche: Record<string, number> = {};
    for (const r of rows) {
      byNiche[r.niche] = r.count;
    }
    return {
      total: totalRow?.count || 0,
      byNiche,
    };
  } catch {
    return { total: 0, byNiche: {} };
  }
}

export interface ChannelMeme {
  id: number;
  caption: string;
  media_type: 'image' | 'video' | 'text';
  media_url: string | null;
  image_path: string | null;
  channel_source: string;
  channel_message_id: string | null;
  used_count: number;
  last_posted_at: number;
  created_at: number;
}

/**
 * Inserts or updates a meme scraped from the WhatsApp channel (0029Vb6oS4LJkK7AvtORyH46).
 */
export async function saveChannelMeme(
  caption: string,
  mediaType: 'image' | 'video' | 'text' = 'text',
  mediaUrl?: string | null,
  imagePath?: string | null,
  channelSource: string = '0029Vb6oS4LJkK7AvtORyH46',
  messageId?: string | null
): Promise<boolean> {
  try {
    const cleanCaption = (caption || '').trim();
    if (!cleanCaption || cleanCaption.length < 5) return false;

    await db.prepare(`
      INSERT INTO channel_memes (caption, media_type, media_url, image_path, channel_source, channel_message_id, used_count, last_posted_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?)
    `).run(cleanCaption, mediaType, mediaUrl || null, imagePath || null, channelSource, messageId || null, Date.now());
    return true;
  } catch (err: any) {
    console.error('[DB] Error saving channel meme:', err?.message || err);
    return false;
  }
}

/**
 * Retrieves the freshest, least recently posted meme for the next 2-hour interval.
 */
export async function getFreshestMemeForPosting(): Promise<ChannelMeme | null> {
  try {
    const meme = await db.prepare(`
      SELECT * FROM channel_memes
      ORDER BY CASE WHEN media_type = 'image' AND instr(image_path, 'newsletter_') > 0 THEN 0 ELSE 1 END,
               used_count ASC, last_posted_at ASC, RANDOM()
      LIMIT 1
    `).get() as unknown as ChannelMeme | undefined;

    return meme || null;
  } catch (err: any) {
    console.error('[DB] Error getting meme for posting:', err?.message || err);
    return null;
  }
}

/**
 * Marks a meme as posted and records the exact timestamp to enforce the 2-hour cooldown.
 */
export async function markMemePosted(id: number): Promise<void> {
  try {
    await db.prepare(`
      UPDATE channel_memes
      SET used_count = used_count + 1, last_posted_at = ?
      WHERE id = ?
    `).run(Date.now(), id);
  } catch (err: any) {
    console.error('[DB] Error marking meme posted:', err?.message || err);
  }
}

/**
 * Gets the timestamp of the most recently posted meme across all channels.
 */
export async function getLatestMemePostedTimestamp(): Promise<number> {
  try {
    const row = await db.prepare('SELECT MAX(last_posted_at) as latest FROM channel_memes').get() as { latest: number | null };
    return row?.latest || 0;
  } catch {
    return 0;
  }
}

/**
 * Retrieves statistics about stored channel memes.
 */
export async function getChannelMemesStats(): Promise<{ total: number; latestPostedAt: number; totalUsed: number }> {
  try {
    const totalRow = await db.prepare('SELECT COUNT(*) as count FROM channel_memes').get() as { count: number };
    const latestRow = await db.prepare('SELECT MAX(last_posted_at) as latest FROM channel_memes').get() as { latest: number | null };
    const usedRow = await db.prepare('SELECT SUM(used_count) as used FROM channel_memes').get() as { used: number | null };
    return {
      total: totalRow?.count || 0,
      latestPostedAt: latestRow?.latest || 0,
      totalUsed: usedRow?.used || 0,
    };
  } catch {
    return { total: 0, latestPostedAt: 0, totalUsed: 0 };
  }
}

/**
 * Returns recent channel memes for listing and inspection.
 */
export async function getAllChannelMemes(limit = 30): Promise<ChannelMeme[]> {
  try {
    return await db.prepare(`
      SELECT * FROM channel_memes
      ORDER BY id DESC
      LIMIT ?
    `).all(limit) as unknown as ChannelMeme[];
  } catch {
    return [];
  }
}

export interface ContactReminderRecord {
  id: number;
  contact_jid: string;
  phone_number: string;
  contact_name: string | null;
  template_index: number;
  message_sent: string;
  status: 'pending' | 'sent' | 'failed' | 'skipped';
  error_reason: string | null;
  created_at: number;
  sent_at: number | null;
}

/**
 * Records that a contact save reminder message was successfully dispatched to a contact.
 */
export async function recordContactReminderSent(
  contactJid: string,
  phoneNumber: string,
  contactName: string,
  templateIndex: number,
  messageSent: string
): Promise<void> {
  const now = Date.now();
  try {
    await db.prepare(`
      INSERT INTO contact_save_reminders (
        contact_jid, phone_number, contact_name, template_index, message_sent, status, created_at, sent_at
      ) VALUES (?, ?, ?, ?, ?, 'sent', ?, ?)
      ON CONFLICT(contact_jid) DO UPDATE SET
        phone_number = excluded.phone_number,
        contact_name = excluded.contact_name,
        template_index = excluded.template_index,
        message_sent = excluded.message_sent,
        status = 'sent',
        sent_at = excluded.sent_at
    `).run(contactJid, phoneNumber, contactName, templateIndex, messageSent, now, now);
  } catch (err: any) {
    console.error('[DB] Error recording contact reminder sent:', err?.message || err);
  }
}

/**
 * Records that a contact save reminder failed for a given contact.
 */
export async function recordContactReminderFailed(
  contactJid: string,
  phoneNumber: string,
  contactName: string,
  errorReason: string
): Promise<void> {
  const now = Date.now();
  try {
    await db.prepare(`
      INSERT INTO contact_save_reminders (
        contact_jid, phone_number, contact_name, template_index, message_sent, status, error_reason, created_at
      ) VALUES (?, ?, ?, 0, '', 'failed', ?, ?)
      ON CONFLICT(contact_jid) DO UPDATE SET
        status = 'failed',
        error_reason = excluded.error_reason
    `).run(contactJid, phoneNumber, contactName, errorReason, now);
  } catch (err: any) {
    console.error('[DB] Error recording contact reminder failed:', err?.message || err);
  }
}

/**
 * Checks whether a contact has already been messaged with a contact save reminder.
 */
export async function isContactAlreadyReminded(jidOrPhone: string): Promise<boolean> {
  if (!jidOrPhone) return false;
  const digits = jidOrPhone.replace(/\D/g, '');
  try {
    const row = await db.prepare(`
      SELECT 1 FROM contact_save_reminders
      WHERE (contact_jid = ? OR phone_number = ? OR contact_jid LIKE ?)
        AND status = 'sent'
      LIMIT 1
    `).get(jidOrPhone, digits, `%${digits}%`);
    return Boolean(row);
  } catch {
    return false;
  }
}

/**
 * Retrieves aggregate statistics for contact save reminders.
 */
export async function getContactReminderStats(): Promise<{
  totalReminded: number;
  totalFailed: number;
  latestSentAt: number;
}> {
  try {
    const sentRow = await db.prepare(`SELECT COUNT(*) as c, MAX(sent_at) as latest FROM contact_save_reminders WHERE status = 'sent'`).get() as { c: number; latest: number | null };
    const failedRow = await db.prepare(`SELECT COUNT(*) as c FROM contact_save_reminders WHERE status = 'failed'`).get() as { c: number };
    return {
      totalReminded: sentRow?.c || 0,
      totalFailed: failedRow?.c || 0,
      latestSentAt: sentRow?.latest || 0,
    };
  } catch {
    return { totalReminded: 0, totalFailed: 0, latestSentAt: 0 };
  }
}

/**
 * Returns recent reminder records.
 */
export async function getAllContactReminders(limit = 100): Promise<ContactReminderRecord[]> {
  try {
    return await db.prepare(`
      SELECT * FROM contact_save_reminders
      ORDER BY id DESC
      LIMIT ?
    `).all(limit) as unknown as ContactReminderRecord[];
  } catch {
    return [];
  }
}

/**
 * Retrieves a persistent bot configuration setting from SQLite bot_settings table.
 */
export async function getBotSetting(key: string, defaultValue = ''): Promise<string> {
  try {
    const row = await db.prepare('SELECT value FROM bot_settings WHERE key = ? LIMIT 1').get(key) as { value: string } | undefined;
    return row?.value || defaultValue;
  } catch {
    return defaultValue;
  }
}

/**
 * Persists a bot configuration setting to SQLite bot_settings table.
 */
export async function setBotSetting(key: string, value: string): Promise<void> {
  try {
    const now = Date.now();
    await db.prepare(`
      INSERT INTO bot_settings (key, value, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET
        value = excluded.value,
        updated_at = excluded.updated_at
    `).run(key, value, now);
  } catch (err: any) {
    console.error(`[DB] Error setting bot_setting for key ${key}:`, err?.message || err);
  }
}

export interface ViewOnceRecord {
  id: number;
  message_id: string;
  chat_jid: string;
  chat_name?: string | null;
  sender_jid: string;
  sender_name?: string | null;
  is_group: number;
  media_type: 'image' | 'video' | 'audio';
  caption?: string | null;
  file_path: string;
  file_size: number;
  timestamp: number;
  retrieved_count: number;
}

/**
 * Saves a captured View-Once media message into the vault.
 */
export async function saveViewOnceMessage(data: {
  message_id: string;
  chat_jid: string;
  chat_name?: string;
  sender_jid: string;
  sender_name?: string;
  is_group: boolean;
  media_type: 'image' | 'video' | 'audio';
  caption?: string;
  file_path: string;
  file_size?: number;
  timestamp: number;
}): Promise<boolean> {
  try {
    const stmt = db.prepare(`
      INSERT OR REPLACE INTO view_once_messages (
        message_id, chat_jid, chat_name, sender_jid, sender_name,
        is_group, media_type, caption, file_path, file_size, timestamp
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    await stmt.run(
      data.message_id,
      data.chat_jid,
      data.chat_name || null,
      data.sender_jid,
      data.sender_name || null,
      data.is_group ? 1 : 0,
      data.media_type,
      data.caption || null,
      data.file_path,
      data.file_size || 0,
      data.timestamp
    );
    return true;
  } catch (err: any) {
    console.error('[DB] Error saving view-once message:', err.message);
    return false;
  }
}

/**
 * Retrieves the latest captured View-Once messages, optionally filtered by sender or chat name.
 */
export async function getLatestViewOnceMessages(limit: number = 10, filterQuery?: string): Promise<ViewOnceRecord[]> {
  try {
    if (filterQuery && filterQuery.trim()) {
      const q = `%${filterQuery.trim().toLowerCase()}%`;
      return await db
        .prepare(
          `
        SELECT * FROM view_once_messages 
        WHERE LOWER(sender_name) LIKE ? OR LOWER(chat_name) LIKE ? OR LOWER(caption) LIKE ? OR sender_jid LIKE ?
        ORDER BY timestamp DESC LIMIT ?
      `
        )
        .all(q, q, q, q, limit) as unknown as ViewOnceRecord[];
    }
    return await db.prepare(`SELECT * FROM view_once_messages ORDER BY timestamp DESC LIMIT ?`).all(limit) as unknown as ViewOnceRecord[];
  } catch (err: any) {
    console.error('[DB] Error getting view-once messages:', err.message);
    return [];
  }
}

/**
 * Retrieves a single View-Once message by its DB id or message_id.
 */
export async function getViewOnceMessageById(idOrMsgId: number | string): Promise<ViewOnceRecord | null> {
  try {
    if (typeof idOrMsgId === 'number' || /^\d+$/.test(String(idOrMsgId))) {
      return (await db.prepare(`SELECT * FROM view_once_messages WHERE id = ?`).get(Number(idOrMsgId)) as unknown as ViewOnceRecord) || null;
    }
    return (await db.prepare(`SELECT * FROM view_once_messages WHERE message_id = ?`).get(String(idOrMsgId)) as unknown as ViewOnceRecord) || null;
  } catch {
    return null;
  }
}

/**
 * Increments the retrieved count of a View-Once message record.
 */
export async function markViewOnceRetrieved(id: number): Promise<void> {
  try {
    await db.prepare(`UPDATE view_once_messages SET retrieved_count = retrieved_count + 1 WHERE id = ?`).run(id);
  } catch {}
}

/**
 * Persists the WhatsApp multi-file auth session bundle to the database.
 */
export async function saveSessionBundleToDb(bundle: string): Promise<void> {
  try {
    await db.prepare(`
      INSERT INTO whatsapp_session_store (id, bundle, updated_at)
      VALUES ('session_bundle', ?, ?)
      ON CONFLICT(id) DO UPDATE SET bundle = excluded.bundle, updated_at = excluded.updated_at
    `).run(bundle, Date.now());
  } catch (err: any) {
    console.warn('[DB] Failed to save session bundle to whatsapp_session_store:', err?.message || err);
  }
}

/**
 * Retrieves the WhatsApp session bundle from the database.
 */
export async function getSessionBundleFromDb(): Promise<string | undefined> {
  try {
    const row = await db.prepare(`SELECT bundle FROM whatsapp_session_store WHERE id = 'session_bundle'`).get() as { bundle?: string } | undefined;
    return row?.bundle;
  } catch {
    return undefined;
  }
}





