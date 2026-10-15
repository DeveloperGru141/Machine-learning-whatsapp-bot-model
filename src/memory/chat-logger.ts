import { db } from './db.js';

export interface LogMessageInput {
  chatJid: string;
  senderJid: string;
  senderName: string;
  isGroup: boolean;
  contentType: 'text' | 'sticker' | 'image' | 'audio' | 'document' | 'video' | string;
  messageText?: string;
  stickerFilename?: string;
  timestamp: number;
}

export class ChatLogger {
  private insertLogStmt = db.prepare(`
    INSERT INTO chat_logs (chat_jid, sender_jid, sender_name, is_group, content_type, message_text, sticker_filename, timestamp)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
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
      this.insertLogStmt.run(
        input.chatJid,
        input.senderJid,
        input.senderName,
        input.isGroup ? 1 : 0,
        input.contentType,
        input.messageText ?? null,
        input.stickerFilename ?? null,
        input.timestamp
      );

      // If a user in chat sent a sticker, analyze what message preceded it to learn the pattern
      if (input.contentType === 'sticker' && input.stickerFilename) {
        this.learnStickerPatternFromContext(input.chatJid, input.stickerFilename);
      }
    } catch (err) {
      console.error('Failed to log message:', err);
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
}

export const chatLogger = new ChatLogger();
