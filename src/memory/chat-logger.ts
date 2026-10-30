import { db } from './db.js';
import { config } from '../config/env.js';
import { chatCleaner } from '../learning/chat-cleaner.js';
import { sensitiveDataFilter } from '../security/sensitive-data-filter.js';

export interface LogMessageInput {
  chatJid: string;
  senderJid: string;
  senderName: string;
  isGroup: boolean;
  contentType: 'text' | 'sticker' | 'image' | 'audio' | 'document' | 'video' | string;
  messageText?: string;
  stickerFilename?: string;
  messageId?: string;
  timestamp: number;
}

export class ChatLogger {
  private insertLogStmt = db.prepare(`
    INSERT INTO chat_logs (chat_jid, sender_jid, sender_name, is_group, content_type, message_text, sticker_filename, is_noise, timestamp, message_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  private updateStickerPatternStmt = db.prepare(`
    UPDATE sticker_catalog 
    SET usage_count = usage_count + 1,
        learned_triggers = json_insert(
          COALESCE(learned_triggers, '[]'), 
          '$[#]', 
          ?
        )
    WHERE filename = ?
  `);

  public async logMessage(input: LogMessageInput): Promise<number | null> {
    try {
      let sanitizedText: string | null = null;
      let hasSensitive = false;
      if (input.messageText) {
        const scrubbed = sensitiveDataFilter.scrubSensitiveText(input.messageText);
        sanitizedText = chatCleaner.sanitizeText(scrubbed.scrubbedText);
        hasSensitive = scrubbed.isSensitive;
      }
      const isNoise = (hasSensitive || chatCleaner.isNoise(sanitizedText, input.contentType)) ? 1 : 0;

      const result = await this.insertLogStmt.run(
        input.chatJid,
        input.senderJid,
        input.senderName,
        input.isGroup ? 1 : 0,
        input.contentType,
        sanitizedText,
        input.stickerFilename ?? null,
        isNoise,
        input.timestamp,
        input.messageId ?? null
      );

      // If a user in chat sent a sticker, analyze what message preceded it to learn the pattern
      if (input.contentType === 'sticker' && input.stickerFilename) {
        this.learnStickerPatternFromContext(input.chatJid, input.stickerFilename);
      }
      return Number(result.lastInsertRowid);
    } catch (err) {
      console.error('Failed to log message:', err);
      return null;
    }
  }

  public async logOutboundMessage(chatJid: string, text: string, messageId?: string | null): Promise<void> {
    try {
      const scrubResult = sensitiveDataFilter.scrubSensitiveText(text);
      const scrubbed = scrubResult.scrubbedText;
      const isNoise = scrubResult.isSensitive || chatCleaner.isNoise(scrubbed, 'text');
      await this.insertLogStmt.run(
        chatJid,
        'bot',
        config.bot.name,
        chatJid.endsWith('@g.us') ? 1 : 0,
        'text',
        scrubbed,
        null,
        isNoise ? 1 : 0,
        Date.now(),
        messageId ?? null
      );
    } catch (err) {
      console.error('Failed to log outbound message:', err);
    }
  }

  public async logOutboundMedia(chatJid: string, contentType: string, messageId?: string | null): Promise<void> {
    try {
      await this.insertLogStmt.run(
        chatJid,
        'bot',
        config.bot.name,
        chatJid.endsWith('@g.us') ? 1 : 0,
        contentType,
        null,
        null,
        0,
        Date.now(),
        messageId ?? null
      );
    } catch (err) {
      console.error('Failed to log outbound media:', err);
    }
  }

  public parseTrainingConsentDirective(text: string): boolean | null {
    const command = (text || '').trim().toLowerCase().replace(/^\//, '!');
    if (/^!?training\s+(?:consent|opt[ -]?in|allow)$/.test(command)) return true;
    if (/^!?training\s+(?:forget|revoke|opt[ -]?out|stop)$/.test(command)) return false;
    return null;
  }

  public async setTrainingConsent(userJid: string, optedIn: boolean): Promise<void> {
    if (!userJid) return;
    const alias = await db.prepare('SELECT contact_jid FROM contact_jid_aliases WHERE alias_jid = ? LIMIT 1')
      .get(userJid) as { contact_jid: string } | undefined;
    const consentJid = alias?.contact_jid || userJid;
    await db.prepare(`
      INSERT INTO training_consents (user_jid, opted_in, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(user_jid) DO UPDATE SET opted_in = excluded.opted_in, updated_at = excluded.updated_at
    `).run(consentJid, optedIn ? 1 : 0, Date.now());
  }

  public async claimUnrepliedAttempt(inboundLogId: number, chatJid: string, now = Date.now()): Promise<boolean> {
    try {
      const result = await db.prepare(`
        INSERT INTO dm_reply_attempts (
          inbound_log_id, chat_jid, status, attempts, last_attempt_at, next_attempt_at, last_error, completed_at
        ) VALUES (?, ?, 'in_progress', 1, ?, 0, NULL, NULL)
        ON CONFLICT(inbound_log_id) DO UPDATE SET
          status = 'in_progress',
          attempts = dm_reply_attempts.attempts + 1,
          last_attempt_at = excluded.last_attempt_at,
          last_error = NULL,
          completed_at = NULL
        WHERE dm_reply_attempts.status != 'sent'
          AND dm_reply_attempts.next_attempt_at <= ?
          AND (dm_reply_attempts.status != 'in_progress' OR dm_reply_attempts.last_attempt_at < ?)
      `).run(inboundLogId, chatJid, now, now, now - 10 * 60_000);
      return Number(result.changes) > 0;
    } catch (err) {
      console.warn('[ChatLogger] Could not claim unreplied DM attempt:', err);
      return false;
    }
  }

  public async finishUnrepliedAttempt(inboundLogId: number, sent: boolean, error?: string, now = Date.now()): Promise<void> {
    try {
      const row = await db.prepare('SELECT attempts FROM dm_reply_attempts WHERE inbound_log_id = ?')
        .get(inboundLogId) as { attempts: number } | undefined;
      const attempts = Math.max(1, Number(row?.attempts || 1));
      const retryDelay = Math.min(30 * 60_000, 60_000 * 2 ** Math.min(attempts - 1, 5));
      const safeError = error
        ? sensitiveDataFilter.scrubSensitiveText(error).scrubbedText.replace(/\s+/g, ' ').slice(0, 200)
        : 'No outbound response was dispatched';
      await db.prepare(`
        UPDATE dm_reply_attempts
        SET status = ?, next_attempt_at = ?, last_error = ?, completed_at = ?
        WHERE inbound_log_id = ?
      `).run(sent ? 'sent' : 'failed', sent ? 0 : now + retryDelay, sent ? null : safeError, sent ? now : null, inboundLogId);
    } catch (err) {
      console.warn('[ChatLogger] Could not finish unreplied DM attempt:', err);
    }
  }

  public async logOutboundSticker(chatJid: string, filename: string, _vibe?: string): Promise<void> {
    try {
      await this.insertLogStmt.run(
        chatJid,
        'bot',
        config.bot.name,
        chatJid.endsWith('@g.us') ? 1 : 0,
        'sticker',
        null, // Keep message_text null so LLM context never sees internal bracket text or markdown
        filename,
        0,
        Date.now(),
        null
      );
    } catch (err) {
      console.error('Failed to log outbound sticker:', err);
    }
  }

  public async getLastMessage(chatJid: string, senderJid?: string): Promise<{ message_id: string; sender_jid: string; message_text: string } | null> {
    try {
      if (senderJid) {
        return (
          (await db.prepare(`
            SELECT message_id, sender_jid, message_text FROM chat_logs
            WHERE chat_jid = ? AND sender_jid = ? AND message_id IS NOT NULL
            ORDER BY id DESC LIMIT 1
          `).get(chatJid, senderJid) as any) || null
        );
      }
      return (
        (await db.prepare(`
          SELECT message_id, sender_jid, message_text FROM chat_logs
          WHERE chat_jid = ? AND sender_jid != 'bot' AND message_id IS NOT NULL
          ORDER BY id DESC LIMIT 1
        `).get(chatJid) as any) || null
      );
    } catch {
      return null;
    }
  }

  private async learnStickerPatternFromContext(chatJid: string, stickerFilename: string): Promise<void> {
    try {
      const priorMessages = await db.prepare(`
        SELECT message_text FROM chat_logs
        WHERE chat_jid = ? AND content_type = 'text' AND message_text IS NOT NULL
        ORDER BY id DESC LIMIT 2
      `).all(chatJid) as unknown as Array<{ message_text: string }>;

      if (priorMessages.length > 0) {
        const contextSummary = priorMessages.map(m => m.message_text).reverse().join(' -> ');
        await this.updateStickerPatternStmt.run(contextSummary, stickerFilename);
      }
    } catch {
      // Ignore background pattern update errors
    }
  }

  public async getRecentChatHistory(chatJid: string, limit: number = 15): Promise<Array<{ sender_name: string; message_text: string; content_type: string }>> {
    const rows = await db.prepare(`
      SELECT sender_name, message_text, content_type
      FROM chat_logs
      WHERE chat_jid = ?
      ORDER BY id DESC LIMIT ?
    `).all(chatJid, limit) as unknown as Array<{ sender_name: string; message_text: string; content_type: string }>;
    return rows.reverse();
  }

  /**
   * Updates the message_text of the most recent message of a given content_type in a chat (e.g. after transcribing audio).
   */
  public async updateLatestMessageText(chatJid: string, contentType: string, text: string): Promise<void> {
    try {
      await db.prepare(`
        UPDATE chat_logs
        SET message_text = ?
        WHERE id = (
          SELECT id FROM chat_logs
          WHERE chat_jid = ? AND content_type = ? AND sender_jid != 'bot'
          ORDER BY id DESC LIMIT 1
        )
      `).run(text, chatJid, contentType);
    } catch (err) {
      console.error('Failed to update latest message text:', err);
    }
  }

  /**
   * Checks if the bot has already replied to this chat after a given message timestamp.
   * Uses both timestamp and row ID ordering to stay immune to minor clock skew between WhatsApp servers and local time.
   */
  public async hasBotRepliedAfter(chatJid: string, timestamp: number): Promise<boolean> {
    try {
      const row = await db.prepare(`
        SELECT id FROM chat_logs
        WHERE chat_jid = ?
          AND sender_jid = 'bot'
          AND (
            timestamp >= ?
            OR (
              ? > 0
              AND id > COALESCE(
                (SELECT MAX(id) FROM chat_logs WHERE chat_jid = ? AND sender_jid != 'bot' AND timestamp <= ?),
                0
              )
            )
          )
          AND COALESCE(message_text, '') NOT LIKE 'network slow small%'
        LIMIT 1
      `).get(chatJid, timestamp, timestamp, chatJid, timestamp);
      return !!row;
    } catch {
      return false;
    }
  }

  /**
   * Checks if the most recent message in the chat was from a user (unreplied).
   */
  public async isLastMessageFromUser(chatJid: string): Promise<boolean> {
    try {
      const row = await db.prepare(`
        SELECT sender_jid FROM chat_logs
        WHERE chat_jid = ?
          AND NOT (sender_jid = 'bot' AND COALESCE(message_text, '') LIKE 'network slow small%')
        ORDER BY id DESC LIMIT 1
      `).get(chatJid) as { sender_jid: string } | undefined;
      return !!row && row.sender_jid !== 'bot';
    } catch {
      return false;
    }
  }
}

export const chatLogger = new ChatLogger();
