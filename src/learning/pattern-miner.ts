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
  private emojiRegex =
    /(?:\p{Extended_Pictographic}|\p{Emoji_Presentation})(?:\uFE0F|\p{Emoji_Modifier})?(?:\u200D(?:\p{Extended_Pictographic}|\p{Emoji_Presentation})(?:\uFE0F|\p{Emoji_Modifier})?)*/gu;

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

      // 1. Detect High-Humor / Banter Pattern (Learn only from human users, never bot replies)
      if (
        current.sender_jid !== 'bot' &&
        current.sender_jid !== 'Forgelabs assistant' &&
        current.content_type === 'text' &&
        current.message_text &&
        this.laughterRegex.test(current.message_text)
      ) {
        if (previous.content_type === 'text' && previous.message_text) {
          this.recordDialogueExemplar(chatJid, previous.message_text, current.message_text, 'humor');
        }
      }

      // 2. Evaluate User Feedback to Bot Replies (Positive rewards vs Explicit disapproval)
      // Note: If a user ignores or does not reply, it is NEVER marked as negative (silence is 100% neutral on WhatsApp).
      if (
        (previous.sender_jid === 'bot' || previous.sender_jid === 'Forgelabs assistant') &&
        current.sender_jid !== 'bot' &&
        current.sender_jid !== 'Forgelabs assistant' &&
        current.content_type === 'text' &&
        current.message_text
      ) {
        this.evaluateBotFeedback(chatJid, previous.message_text, current.message_text);
      }

      // 3. Periodically update Chat Style Profile (e.g. every few messages)
      this.updateChatStyleProfile(chatJid);
    } catch (err) {
      // Fail silently in background to avoid disrupting main loop
    }
  }

  private positiveFeedbackRegex = /\b(lol|lmao|lmfao|rofl|haha|hahaha|hehe|lwkmd|💀|😂|🤣|sharp|correct|spot on|you sabi|valid|facts|no cap|nice one|bless|thanks|thank you|good bot|smart|fire)\b/i;
  private explicitDisapprovalRegex = /\b(shut up|you too dey talk|stop talking|stop messaging|wrong info|shut it|annoying bot|abeg keep quiet)\b/i;

  /**
   * Evaluates user reactions to previous bot responses:
   * - Positive laughter / hype / gratitude increases exemplar quality score.
   * - Explicit disapproval (e.g. 'shut up', 'you too dey talk') lowers quality score.
   * - CRITICAL: When a user ignores the bot or changes topic, it is NEVER penalized. Silence is completely neutral.
   */
  public evaluateBotFeedback(chatJid: string, botMessageText: string | null, userReaction: string): void {
    if (!botMessageText) return;
    const trimmedBot = botMessageText.trim();

    if (this.positiveFeedbackRegex.test(userReaction)) {
      try {
        db.prepare(`
          UPDATE dialogue_exemplars
          SET quality_score = MIN(2.5, quality_score + 0.4)
          WHERE chat_jid = ? AND response_text = ?
        `).run(chatJid, trimmedBot);
      } catch {}
    } else if (this.explicitDisapprovalRegex.test(userReaction)) {
      try {
        db.prepare(`
          UPDATE dialogue_exemplars
          SET quality_score = MAX(0.2, quality_score - 0.5)
          WHERE chat_jid = ? AND response_text = ?
        `).run(chatJid, trimmedBot);
      } catch {}
    }
    // No penalty for being ignored or left on read - users ignore messages for any random reason.
  }

  private recordDialogueExemplar(chatJid: string, contextText: string, responseText: string, vibe: string): void {
    if (!contextText || !responseText) return;
    const trimmedContext = contextText.trim();
    const trimmedResponse = responseText.trim();
    if (trimmedContext.length < 2 || trimmedResponse.length < 3) return;

    // Enforce strict max 0-1 emoji policy
    const emojiCount = (trimmedResponse.match(this.emojiRegex) || []).length;
    if (emojiCount > 1) return;

    // Guard against robotic clichés or outdated names
    const lower = trimmedResponse.toLowerCase();
    if (
      lower.includes('as an ai') ||
      lower.includes('how can i help') ||
      lower.includes('i am an ai') ||
      lower.includes('feel free to ask') ||
      lower.includes('certainly!') ||
      lower.includes('sure thing!') ||
      lower.includes('nova')
    ) {
      return;
    }

    db.prepare(`
      INSERT INTO dialogue_exemplars (chat_jid, context_text, response_text, response_type, sticker_filename, vibe_classification, quality_score, created_at)
      VALUES (?, ?, ?, 'text', NULL, ?, 1.0, ?)
    `).run(chatJid, trimmedContext, trimmedResponse, vibe, Date.now());
  }

  /**
   * Computes the rolling linguistic profile of a chat:
   * average length, sticker frequency, dominant emojis, and formality style.
   */
  public updateChatStyleProfile(chatJid: string): void {
    const stats = db.prepare(`
      SELECT 
        COUNT(*) as total,
        AVG(CASE WHEN content_type = 'text' THEN LENGTH(COALESCE(message_text, '')) ELSE NULL END) as avg_len
      FROM chat_logs
      WHERE chat_jid = ?
    `).get(chatJid) as unknown as { total: number; avg_len: number | null };

    if (!stats || stats.total === 0) return;

    const avgLength = stats.avg_len || 0;

    // Determine formality style
    let formality = 'casual';
    if (avgLength > 80) formality = 'detailed';
    else if (avgLength < 25) formality = 'short_punchy';

    db.prepare(`
      INSERT INTO chat_style_profiles (chat_jid, total_messages, sticker_ratio, avg_length, formality_style, updated_at)
      VALUES (?, ?, 0.0, ?, ?, ?)
      ON CONFLICT(chat_jid) DO UPDATE SET
        total_messages = excluded.total_messages,
        sticker_ratio = 0.0,
        avg_length = excluded.avg_length,
        formality_style = excluded.formality_style,
        updated_at = excluded.updated_at
    `).run(chatJid, stats.total, avgLength, formality, Date.now());
  }
}

export const patternMiner = new PatternMiner();
