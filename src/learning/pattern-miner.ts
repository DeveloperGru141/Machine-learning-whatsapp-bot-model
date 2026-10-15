import { db } from '../memory/db.js';

interface MessageRow {
  id: number;
  chat_jid: string;
  sender_jid: string;
  sender_name: string;
  is_group: number;
  content_type: string;
  message_text: string | null;
  sticker_filename: string | null;
  timestamp: number;
}

export class PatternMiner {
  private laughterRegex = /\b(lol|lmao|lmfao|rofl|haha|hahaha|hehe|kikiki|lwkmd|dead|💀|😂|🤣)\b/i;
  private emojiRegex = /[\p{Emoji_Presentation}\p{Extended_Pictographic}]/gu;

  /**
   * Evaluates a newly received message in the context of recent chat turns
   * and extracts conversational patterns, style metrics, and exemplars.
   */
  public analyzeInteraction(chatJid: string): void {
    try {
      // Get the last 4 messages in chronological order
      const recent = db.prepare(`
        SELECT * FROM chat_logs
        WHERE chat_jid = ?
        ORDER BY id DESC LIMIT 4
      `).all(chatJid) as unknown as MessageRow[];

      if (recent.length < 2) return;
      const history = recent.reverse();
      const current = history[history.length - 1];
      const previous = history[history.length - 2];

      // 1. Detect Sticker Reaction Pattern
      if (current.content_type === 'sticker' && previous.content_type === 'text' && previous.message_text) {
        this.recordStickerExemplar(chatJid, previous.message_text, current.sticker_filename);
      }

      // 2. Detect High-Humor / Banter Pattern
      if (current.content_type === 'text' && current.message_text && this.laughterRegex.test(current.message_text)) {
        if (previous.content_type === 'text' && previous.message_text) {
          this.recordDialogueExemplar(chatJid, previous.message_text, current.message_text, 'humor');
        }
      }

      // 3. Periodically update Chat Style Profile (e.g. every few messages)
      this.updateChatStyleProfile(chatJid);
    } catch (err) {
      // Fail silently in background to avoid disrupting main loop
    }
  }

  private recordStickerExemplar(chatJid: string, contextText: string, stickerFilename: string | null): void {
    db.prepare(`
      INSERT INTO dialogue_exemplars (chat_jid, context_text, response_text, response_type, sticker_filename, vibe_classification, quality_score, created_at)
      VALUES (?, ?, ?, 'sticker', ?, 'reaction', 1.2, ?)
    `).run(chatJid, contextText, '[Sent Sticker]', stickerFilename, Date.now());
  }

  private recordDialogueExemplar(chatJid: string, contextText: string, responseText: string, vibe: string): void {
    db.prepare(`
      INSERT INTO dialogue_exemplars (chat_jid, context_text, response_text, response_type, sticker_filename, vibe_classification, quality_score, created_at)
      VALUES (?, ?, ?, 'text', NULL, ?, 1.0, ?)
    `).run(chatJid, contextText, responseText, vibe, Date.now());
  }

  /**
   * Computes the rolling linguistic profile of a chat:
   * average length, sticker frequency, dominant emojis, and formality style.
   */
  public updateChatStyleProfile(chatJid: string): void {
    const stats = db.prepare(`
      SELECT 
        COUNT(*) as total,
        AVG(CASE WHEN content_type = 'text' THEN LENGTH(COALESCE(message_text, '')) ELSE NULL END) as avg_len,
        SUM(CASE WHEN content_type = 'sticker' THEN 1 ELSE 0 END) as sticker_count
      FROM chat_logs
      WHERE chat_jid = ?
    `).get(chatJid) as unknown as { total: number; avg_len: number | null; sticker_count: number };

    if (!stats || stats.total === 0) return;

    const stickerRatio = stats.total > 0 ? (stats.sticker_count / stats.total) : 0;
    const avgLength = stats.avg_len || 0;

    // Determine formality style
    let formality = 'casual';
    if (avgLength > 80) formality = 'detailed';
    else if (stickerRatio > 0.3) formality = 'sticker_heavy';
    else if (avgLength < 25) formality = 'short_punchy';

    db.prepare(`
      INSERT INTO chat_style_profiles (chat_jid, total_messages, sticker_ratio, avg_length, formality_style, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(chat_jid) DO UPDATE SET
        total_messages = excluded.total_messages,
        sticker_ratio = excluded.sticker_ratio,
        avg_length = excluded.avg_length,
        formality_style = excluded.formality_style,
        updated_at = excluded.updated_at
    `).run(chatJid, stats.total, stickerRatio, avgLength, formality, Date.now());
  }
}

export const patternMiner = new PatternMiner();
