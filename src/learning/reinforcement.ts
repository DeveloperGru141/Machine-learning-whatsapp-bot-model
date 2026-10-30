import { db } from '../memory/db.js';

export interface BotCorrectionRecord {
  id: number;
  chat_jid: string;
  user_jid: string;
  bot_message_text: string;
  correction_text: string;
  learned_rule: string;
  created_at: number;
}

export class ReinforcementEngine {
  // Regex identifying when a user is correcting or rebuking a bot response
  private correctionRegex =
    /\b(?:no\s+(?:it'?s|that'?s|that\s+is|you'?re|you\s+are|na|is|not|he\s+is|she\s+is)|that(?:'s|\s+is)\s+wrong|you(?:'re|\s+are)\s+wrong|you\s+made\s+a\s+mistake|not\s+true|incorrect|false\s+info|wrong\s+info|don'?t\s+say\s+that|stop\s+saying\s+that|say\s+.+\s+instead|next\s+time\s+(?:say|tell|reply|do)|correction:?|na\s+lie|lie\s+lie|you\s+dey\s+lie|you\s+lie)\b/i;

  /**
   * Checks whether an incoming message is an explicit correction of the bot.
   */
  public isCorrection(text?: string | null): boolean {
    if (!text || typeof text !== 'string') return false;
    const clean = text.trim();
    if (clean.length < 3 || clean.length > 500) return false;
    return this.correctionRegex.test(clean);
  }

  /**
   * Processes a direct user correction to a previous bot response:
   * 1. Slashes the quality score of the previous bot response in dialogue_exemplars so it is never repeated.
   * 2. Extracts and saves the learned correction rule into bot_corrections and user/group facts.
   * 3. Returns the extracted learned rule.
   */
  public async handleCorrection(
    chatJid: string,
    userJid: string,
    correctionText: string
  ): Promise<{ handled: boolean; learnedRule?: string }> {
    try {
      // 1. Look up the most recent bot message in this chat
      const lastBotRow = await db.prepare(`
        SELECT id, message_text FROM chat_logs
        WHERE chat_jid = ? AND sender_jid = 'bot' AND message_text IS NOT NULL
        ORDER BY id DESC LIMIT 1
      `).get(chatJid) as { id: number; message_text: string } | undefined;

      if (!lastBotRow || !lastBotRow.message_text) {
        return { handled: false };
      }

      const botMistake = lastBotRow.message_text.trim();
      const userFeedback = correctionText.trim();

      // 2. Direct Negative Reinforcement: Slash quality score of flawed response in dialogue_exemplars
      try {
        await db.prepare(`
          UPDATE dialogue_exemplars
          SET quality_score = 0.0
          WHERE chat_jid = ? AND response_text = ?
        `).run(chatJid, botMistake);

        // Delete any severely penalized exemplars
        await db.prepare(`
          DELETE FROM dialogue_exemplars
          WHERE quality_score <= 0.2
        `).run();
      } catch (err: any) {
        console.warn('[ReinforcementEngine] Warning updating dialogue_exemplars:', err?.message || err);
      }

      // 3. Extract concise actionable rule
      const learnedRule = this.formatCorrectionRule(botMistake, userFeedback);

      // 4. Save into bot_corrections table
      const now = Date.now();
      await db.prepare(`
        INSERT INTO bot_corrections (chat_jid, user_jid, bot_message_text, correction_text, learned_rule, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(chatJid, userJid, botMistake, userFeedback, learnedRule, now);

      // 5. Reinforce into user_facts or group_facts for persistent cross-session memory
      const isGroup = chatJid.endsWith('@g.us');
      if (isGroup) {
        await db.prepare(`
          INSERT INTO group_facts (group_jid, topic, summary, updated_at)
          VALUES (?, ?, ?, ?)
          ON CONFLICT(group_jid, topic) DO UPDATE SET summary = excluded.summary, updated_at = excluded.updated_at
        `).run(chatJid, `Correction: ${userFeedback.slice(0, 30)}`, learnedRule, now);
      } else {
        await db.prepare(`
          INSERT INTO user_facts (user_jid, fact, category, updated_at)
          VALUES (?, ?, 'correction', ?)
          ON CONFLICT(user_jid, fact) DO UPDATE SET updated_at = excluded.updated_at
        `).run(userJid, learnedRule, now);
      }

      console.log(`[ReinforcementEngine] 🎯 Direct reinforcement recorded for ${chatJid}: "${learnedRule}"`);
      return { handled: true, learnedRule };
    } catch (err: any) {
      console.error('[ReinforcementEngine] Error handling correction:', err?.message || err);
      return { handled: false };
    }
  }

  /**
   * Retrieves active learned corrections for this chat to inject into the system prompt.
   */
  public async getActiveCorrections(chatJid: string, limit = 3): Promise<string[]> {
    try {
      const rows = await db.prepare(`
        SELECT learned_rule FROM bot_corrections
        WHERE chat_jid = ?
        ORDER BY id DESC LIMIT ?
      `).all(chatJid, limit) as unknown as Array<{ learned_rule: string }>;

      return rows.map((r) => r.learned_rule);
    } catch {
      return [];
    }
  }

  private formatCorrectionRule(botMistake: string, userFeedback: string): string {
    const compactMistake = botMistake.length > 80 ? botMistake.slice(0, 77) + '...' : botMistake;
    const compactFeedback = userFeedback.length > 120 ? userFeedback.slice(0, 117) + '...' : userFeedback;
    return `Previous bot mistake: "${compactMistake}" -> User correction: "${compactFeedback}". Never repeat that mistake.`;
  }
}

export const reinforcementEngine = new ReinforcementEngine();
