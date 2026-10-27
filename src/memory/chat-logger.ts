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

  public logMessage(input: LogMessageInput): void {
    try {
      let sanitizedText: string | null = null;
      let hasSensitive = false;
      if (input.messageText) {
        const scrubbed = sensitiveDataFilter.scrubSensitiveText(input.messageText);
        sanitizedText = chatCleaner.sanitizeText(scrubbed.scrubbedText);
        hasSensitive = scrubbed.isSensitive;
      }
      const isNoise = (hasSensitive || chatCleaner.isNoise(sanitizedText, input.contentType)) ? 1 : 0;

      this.insertLogStmt.run(
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
    } catch (err) {
      console.error('Failed to log message:', err);
    }
  }

  public logOutboundMessage(chatJid: string, text: string): void {
    try {
      const scrubbed = sensitiveDataFilter.scrubSensitiveText(text).scrubbedText;
      this.insertLogStmt.run(
        chatJid,
        'bot',
        config.bot.name,
        chatJid.endsWith('@g.us') ? 1 : 0,
        'text',
        scrubbed,
        null,
        0,
        Date.now(),
        null
      );
    } catch (err) {
      console.error('Failed to log outbound message:', err);
    }
  }

  public logOutboundSticker(chatJid: string, filename: string, _vibe?: string): void {
    try {
      this.insertLogStmt.run(
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

  public getLastMessage(chatJid: string, senderJid?: string): { message_id: string; sender_jid: string; message_text: string } | null {
    try {
      if (senderJid) {
        return (
          (db.prepare(`
            SELECT message_id, sender_jid, message_text FROM chat_logs
            WHERE chat_jid = ? AND sender_jid = ? AND message_id IS NOT NULL
            ORDER BY id DESC LIMIT 1
          `).get(chatJid, senderJid) as any) || null
        );
      }
      return (
        (db.prepare(`
          SELECT message_id, sender_jid, message_text FROM chat_logs
          WHERE chat_jid = ? AND sender_jid != 'bot' AND message_id IS NOT NULL
          ORDER BY id DESC LIMIT 1
        `).get(chatJid) as any) || null
      );
    } catch {
      return null;
    }
  }

  private learnStickerPatternFromContext(chatJid: string, stickerFilename: string): void {
    try {
      const priorMessages = db.prepare(`
        SELECT message_text FROM chat_logs
        WHERE chat_jid = ? AND content_type = 'text' AND message_text IS NOT NULL
        ORDER BY id DESC LIMIT 2
      `).all(chatJid) as unknown as Array<{ message_text: string }>;

      if (priorMessages.length > 0) {
        const contextSummary = priorMessages.map(m => m.message_text).reverse().join(' -> ');
        this.updateStickerPatternStmt.run(contextSummary, stickerFilename);
      }
    } catch {
      // Ignore background pattern update errors
    }
  }

  public getRecentChatHistory(chatJid: string, limit: number = 15): Array<{ sender_name: string; message_text: string; content_type: string }> {
    const rows = db.prepare(`
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
  public updateLatestMessageText(chatJid: string, contentType: string, text: string): void {
    try {
      db.prepare(`
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
  public hasBotRepliedAfter(chatJid: string, timestamp: number): boolean {
    try {
      const row = db.prepare(`
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
  public isLastMessageFromUser(chatJid: string): boolean {
    try {
      const row = db.prepare(`
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
