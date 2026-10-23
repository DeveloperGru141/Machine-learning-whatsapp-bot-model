import type { WASocket, WAMessage } from '@whiskeysockets/baileys';
import { db } from '../memory/db.js';

export class MessageReactor {
  /**
   * Determine if the incoming message qualifies for an emoji reaction.
   * Reactions are strictly group-only per user request.
   */
  public shouldReact(text: string, isGroup: boolean): boolean {
    if (!isGroup) return false;
    const lower = (text || '').toLowerCase();
    // Only react when there is an authentic emotional or conversational trigger
    return /(lol|lmao|haha|😂|rofl|lmfao|🤣|thanks|thank you|goat|fire|amazing|awesome|facts|fr\b|no cap|sad|rip|sorry)/i.test(lower);
  }

  /**
   * Analyzes message text and context, querying learned patterns from dialogue_exemplars,
   * and returns an appropriate emoji reaction.
   */
  public getReactionEmoji(text: string): string {
    const raw = (text || '').trim();
    const lower = raw.toLowerCase();

    if (!lower) {
      return '👀';
    }

    // Determine target vibe category based on keyword analysis
    let vibe: string | null = null;
    let fallbackEmoji = '👀';

    // 1. Keyword analysis mapped to vibe classifications & default emojis
    if (/(lol|lmao|haha|😂|rofl|lmfao|🤣)/i.test(lower)) {
      vibe = 'humor';
      fallbackEmoji = '😂';
    } else if (/\?|\b(what|how|why|who|when|where|which)\b/i.test(lower)) {
      vibe = 'question_answer';
      fallbackEmoji = '🤔';
    } else if (/\b(thanks|thank you|goat|fire|amazing|awesome|appreciate)\b/i.test(lower)) {
      vibe = 'appreciation';
      fallbackEmoji = '🔥';
    } else if (/\b(hi|hello|hey|gm|good morning|gn|good night|sup)\b/i.test(lower)) {
      vibe = 'greeting';
      fallbackEmoji = '👋';
    } else if (/\b(yes|facts|true|fr|no cap|bet|agreed?)\b/i.test(lower)) {
      vibe = 'agreement';
      fallbackEmoji = '💯';
    } else if (/\b(sad|rip|sorry|damn)\b/i.test(lower)) {
      vibe = 'sadness';
      fallbackEmoji = '😔';
    }

    // 2. Query dialogue_exemplars for learned patterns matching the vibe classification
    if (vibe) {
      try {
        const rows = db.prepare(`
          SELECT response_text, vibe_classification
          FROM dialogue_exemplars
          WHERE vibe_classification = ?
             OR vibe_classification LIKE ?
          ORDER BY quality_score DESC
          LIMIT 1
        `).all(vibe, `%${vibe}%`) as Array<{ response_text?: string; vibe_classification?: string }>;

        if (rows.length > 0 && rows[0].response_text) {
          // If a learned pattern contains a prominent emoji reaction, prioritize it
          const emojiMatch = rows[0].response_text.match(/\p{Extended_Pictographic}/u);
          if (emojiMatch && emojiMatch[0]) {
            return emojiMatch[0];
          }
        }
      } catch (err: any) {
        console.error('[MessageReactor] Error checking dialogue_exemplars:', err?.message || err);
      }

      return fallbackEmoji;
    }

    // 3. If no keyword triggered, check if dialogue_exemplars has a direct context match
    try {
      const contextMatch = db.prepare(`
        SELECT response_text, vibe_classification
        FROM dialogue_exemplars
        WHERE ? LIKE ('%' || context_text || '%')
          AND vibe_classification IS NOT NULL
        ORDER BY quality_score DESC
        LIMIT 1
      `).get(lower) as { response_text?: string; vibe_classification?: string } | undefined;

      if (contextMatch?.vibe_classification) {
        const matchedVibe = contextMatch.vibe_classification.toLowerCase();
        if (matchedVibe.includes('humor') || matchedVibe.includes('banter')) return '😂';
        if (matchedVibe.includes('question')) return '🤔';
        if (matchedVibe.includes('appreciation')) return '🔥';
        if (matchedVibe.includes('greeting')) return '👋';
        if (matchedVibe.includes('agreement')) return '💯';
        if (matchedVibe.includes('sad')) return '😔';
      }
    } catch {
      // Fallback silently
    }

    // Default fallback
    return '👀';
  }

  /**
   * Sends an emoji reaction to the specified WhatsApp message.
   */
  public async reactToMessage(
    sock: WASocket,
    msg: WAMessage,
    emoji: string
  ): Promise<void> {
    if (!msg.key?.remoteJid) return;

    try {
      await sock.sendMessage(msg.key.remoteJid!, {
        react: { text: emoji, key: msg.key },
      });
      console.log(`[MessageReactor] Reacted with "${emoji}" to message ${msg.key.id} in ${msg.key.remoteJid}`);
    } catch (err: any) {
      console.error('[MessageReactor] Failed to react to message:', err?.message || err);
    }
  }
}

export const messageReactor = new MessageReactor();
