import { db } from '../memory/db.js';
import { chatCleaner } from './chat-cleaner.js';
import { reinforcementEngine } from './reinforcement.js';
import { vectorStore } from './vector-store.js';

interface MessageRow {
  id: number;
  chat_jid: string;
  sender_jid: string;
  sender_name: string;
  is_group: number;
  content_type: string;
  message_text: string | null;
  sticker_filename: string | null;
  is_noise?: number;
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
  public async analyzeInteraction(chatJid: string): Promise<void> {
    try {
      // Get the last 4 clean, non-noise messages in chronological order
      const recent = await db.prepare(`
        SELECT * FROM chat_logs
        WHERE chat_jid = ? AND is_noise = 0
        ORDER BY id DESC LIMIT 4
      `).all(chatJid) as unknown as MessageRow[];

      if (recent.length < 2) return;
      const history = recent.reverse();
      const current = history[history.length - 1];
      const previous = history[history.length - 2];

      if (!current.message_text || chatCleaner.isNoise(current.message_text, current.content_type)) {
        return;
      }

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

          // If in a group chat, index into local vector search space for future group banter retrieval
          if (current.is_group) {
            await vectorStore.indexBanter(
              chatJid,
              current.sender_jid,
              current.sender_name || 'Member',
              current.message_text,
              previous.message_text,
              'humor'
            );
          }
        }
      }

      // 2. Evaluate User Feedback & Direct Corrections to Bot Replies
      if (
        (previous.sender_jid === 'bot' || previous.sender_jid === 'Forgelabs assistant') &&
        current.sender_jid !== 'bot' &&
        current.sender_jid !== 'Forgelabs assistant' &&
        current.content_type === 'text' &&
        current.message_text
      ) {
        // Direct Reinforcement: Check if user is correcting a mistake or rebuking the bot
        if (reinforcementEngine.isCorrection(current.message_text)) {
          await reinforcementEngine.handleCorrection(chatJid, current.sender_jid, current.message_text);
        } else {
          this.evaluateBotFeedback(chatJid, previous.message_text, current.message_text);
        }
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
  public async evaluateBotFeedback(chatJid: string, botMessageText: string | null, userReaction: string): Promise<void> {
    if (!botMessageText) return;
    const trimmedBot = botMessageText.trim();

    if (this.positiveFeedbackRegex.test(userReaction)) {
      try {
        await db.prepare(`
          UPDATE dialogue_exemplars
          SET quality_score = MIN(2.5, quality_score + 0.4)
          WHERE chat_jid = ? AND response_text = ?
        `).run(chatJid, trimmedBot);
      } catch {}
    } else if (this.explicitDisapprovalRegex.test(userReaction)) {
      try {
        await db.prepare(`
          UPDATE dialogue_exemplars
          SET quality_score = MAX(0.2, quality_score - 0.5)
          WHERE chat_jid = ? AND response_text = ?
        `).run(chatJid, trimmedBot);
      } catch {}
    }
    // No penalty for being ignored or left on read - users ignore messages for any random reason.
  }

  private async recordDialogueExemplar(chatJid: string, contextText: string, responseText: string, vibe: string): Promise<void> {
    if (!contextText || !responseText) return;
    const trimmedContext = contextText.trim();
    const trimmedResponse = responseText.trim();
    if (trimmedContext.length < 2 || trimmedResponse.length < 3) return;

    // Allow natural conversational emojis (up to 3 max for exemplars)
    const emojiCount = (trimmedResponse.match(this.emojiRegex) || []).length;
    if (emojiCount > 3) return;

    // Guard against robotic clichés, raw tool tags, or outdated names
    const lower = trimmedResponse.toLowerCase();
    if (
      lower.includes('<tool_call>') ||
      lower.includes('</tool_call>') ||
      lower.includes('<function=') ||
      lower.includes('<think>') ||
      lower.includes('network slow') ||
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

    await db.prepare(`
      INSERT INTO dialogue_exemplars (chat_jid, context_text, response_text, response_type, sticker_filename, vibe_classification, quality_score, created_at)
      VALUES (?, ?, ?, 'text', NULL, ?, 1.0, ?)
    `).run(chatJid, trimmedContext, trimmedResponse, vibe, Date.now());
  }

  /**
   * Computes the rolling linguistic profile of a chat:
   * average length, sticker frequency, dominant emojis, and formality style.
   */
  public async updateChatStyleProfile(chatJid: string): Promise<void> {
    const stats = await db.prepare(`
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

    // Extract dominant emojis from recent messages in this chat
    let topEmojisJson = '["😂","🤝","🔥"]';
    try {
      const recentLogs = await db.prepare(`
        SELECT message_text FROM chat_logs
        WHERE chat_jid = ? AND content_type = 'text' AND message_text IS NOT NULL
        ORDER BY id DESC LIMIT 50
      `).all(chatJid) as Array<{ message_text: string }>;

      const counts = new Map<string, number>();
      for (const r of recentLogs) {
        const matches = r.message_text.match(this.emojiRegex) || [];
        for (const em of matches) {
          counts.set(em, (counts.get(em) || 0) + 1);
        }
      }
      const sorted = Array.from(counts.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 4)
        .map(([em]) => em);

      if (sorted.length > 0) {
        topEmojisJson = JSON.stringify(sorted);
      }
    } catch {}

    await db.prepare(`
      INSERT INTO chat_style_profiles (chat_jid, total_messages, sticker_ratio, avg_length, top_emojis, formality_style, updated_at)
      VALUES (?, ?, 0.0, ?, ?, ?, ?)
      ON CONFLICT(chat_jid) DO UPDATE SET
        total_messages = excluded.total_messages,
        sticker_ratio = 0.0,
        avg_length = excluded.avg_length,
        top_emojis = excluded.top_emojis,
        formality_style = excluded.formality_style,
        updated_at = excluded.updated_at
    `).run(chatJid, stats.total, avgLength, topEmojisJson, formality, Date.now());
  }
}

export const patternMiner = new PatternMiner();
