import { db } from '../memory/db.js';
import { llmClient } from '../agent/llm-client.js';
import { patternMiner } from './pattern-miner.js';

interface CheckpointRow {
  chat_jid: string;
  last_analyzed_log_id: number;
  unprocessed_count: number;
  updated_at: number;
}

interface ChatLogRow {
  id: number;
  sender_name: string | null;
  sender_jid: string;
  message_text: string | null;
  content_type: string;
  timestamp: number;
}

export class BatchLearner {
  public readonly BATCH_SIZE = 8;
  private processingChats = new Set<string>();

  /**
   * Fast, non-blocking counter increment on each exchange.
   * Does NOT make any LLM calls on single messages.
   * Triggers a single compressed learning call once 8 exchanges have accumulated.
   */
  public async recordExchange(chatJid: string, senderJid: string): Promise<void> {
    try {
      const now = Date.now();
      await db.prepare(`
        INSERT INTO learning_checkpoints (chat_jid, last_analyzed_log_id, unprocessed_count, updated_at)
        VALUES (?, 0, 1, ?)
        ON CONFLICT(chat_jid) DO UPDATE SET
          unprocessed_count = unprocessed_count + 1,
          updated_at = excluded.updated_at
      `).run(chatJid, now);

      const row = await db.prepare(`
        SELECT unprocessed_count FROM learning_checkpoints WHERE chat_jid = ?
      `).get(chatJid) as { unprocessed_count: number } | undefined;

      const count = row?.unprocessed_count ?? 0;

      // When threshold of 8 exchanges is reached, run batch analysis after a 10s chat cooldown
      if (count >= this.BATCH_SIZE && !this.processingChats.has(chatJid)) {
        setTimeout(() => {
          this.processBatch(chatJid, senderJid).catch((err) => {
            console.error(`[BatchLearner] ⚠️ Batch learning error for ${chatJid}:`, err?.message || err);
          });
        }, 10_000);
      }
    } catch (err: any) {
      console.error('[BatchLearner] Error recording exchange:', err?.message || err);
    }
  }

  /**
   * Compresses exchanges into 3 high-value bullet points of learned behavioral data
   * in a single batched API call.
   */
  public async processBatch(chatJid: string, senderJid: string): Promise<boolean> {
    if (this.processingChats.has(chatJid)) return false;
    this.processingChats.add(chatJid);

    try {
      const checkpoint = await db.prepare(`
        SELECT last_analyzed_log_id, unprocessed_count FROM learning_checkpoints
        WHERE chat_jid = ?
      `).get(chatJid) as CheckpointRow | undefined;

      const lastId = checkpoint?.last_analyzed_log_id ?? 0;

      // Fetch the last 25 clean non-noise messages in chronological order since last analysis
      const logs = await db.prepare(`
        SELECT id, sender_name, sender_jid, message_text, content_type, timestamp
        FROM chat_logs
        WHERE chat_jid = ? AND id > ? AND is_noise = 0
        ORDER BY id ASC LIMIT 25
      `).all(chatJid, lastId) as unknown as ChatLogRow[];

      if (logs.length < 5) {
        // Not enough clean data yet to extract meaningful patterns
        return false;
      }

      // Build clean dialogue transcript
      const transcriptLines: string[] = [];
      let maxLogId = lastId;

      for (const log of logs) {
        if (log.id > maxLogId) maxLogId = log.id;
        const sender = log.sender_name || (log.sender_jid === 'bot' ? 'Forgelabs assistant' : 'User');
        const text = log.message_text ? log.message_text.trim() : '';
        if (text && !text.startsWith('[') && text.length >= 2) {
          transcriptLines.push(`${sender}: ${text}`);
        }
      }

      if (transcriptLines.length < 4) return false;

      const transcript = transcriptLines.join('\n');
      console.log(`[BatchLearner] 🧠 Processing batch of ${logs.length} exchanges for ${chatJid}...`);

      const systemPrompt =
        'You are an ML behavioral analysis engine for an intelligent WhatsApp assistant.\n' +
        'Analyze the following transcript of chat exchanges.\n' +
        'Extract exactly 3 concise, high-value bullet points of learned behavioral data about the user or group.\n' +
        'Focus on: communication tone preferences (casual, slang, formal), recurring interests or projects, emoji usage patterns (favorite emojis, reaction vibes), and response style.\n' +
        'Strictly format output as 3 bullet points starting with "- ":\n' +
        '- [Point 1]\n' +
        '- [Point 2]\n' +
        '- [Point 3]';

      let response: any;
      try {
        // Distill learned behaviors using multi-key Groq round-robin pool
        response = await llmClient.chatCompletion({
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: `Chat Transcript:\n${transcript}` },
          ],
          temperature: 0.3,
          max_tokens: 350,
        });
      } catch (err: any) {
        console.warn(`[BatchLearner] Skipping batch: LLM completion failed:`, err?.message || err);
        return false;
      }

      const content = response.choices[0]?.message?.content || '';
      const bulletPoints = this.parseBulletPoints(content);

      if (bulletPoints.length > 0) {
        const now = Date.now();
        const insertBehaviorStmt = db.prepare(`
          INSERT INTO learned_behaviors (chat_jid, sender_jid, behavior_bullet, created_at)
          VALUES (?, ?, ?, ?)
        `);

        const isGroup = chatJid.endsWith('@g.us');
        const insertUserFactStmt = db.prepare(`
          INSERT OR REPLACE INTO user_facts (user_jid, fact, category, updated_at)
          VALUES (?, ?, 'behavior', ?)
        `);

        const insertGroupFactStmt = db.prepare(`
          INSERT OR REPLACE INTO group_facts (group_jid, topic, summary, updated_at)
          VALUES (?, ?, ?, ?)
        `);

        for (const point of bulletPoints.slice(0, 3)) {
          await insertBehaviorStmt.run(chatJid, senderJid, point, now);
          if (!isGroup) {
            await insertUserFactStmt.run(senderJid, point, now);
          } else {
            await insertGroupFactStmt.run(chatJid, `Behavior: ${point.slice(0, 30)}`, point, now);
          }
        }

        console.log(
          `[BatchLearner] ✅ Successfully extracted and saved ${bulletPoints.length} learned behaviors for ${chatJid}:`,
          bulletPoints
        );
      }

      // Periodically update the chat style profile (SQLite-only, zero LLM)
      await patternMiner.updateChatStyleProfile(chatJid);

      // Advance checkpoint and reset unprocessed count
      await db.prepare(`
        UPDATE learning_checkpoints
        SET last_analyzed_log_id = ?, unprocessed_count = 0, updated_at = ?
        WHERE chat_jid = ?
      `).run(maxLogId, Date.now(), chatJid);

      return true;
    } catch (err: any) {
      console.warn(`[BatchLearner] ⚠️ Batch learning skipped or throttled: ${err?.message || err}`);
      return false;
    } finally {
      this.processingChats.delete(chatJid);
    }
  }

  /**
   * Retrieves the latest learned behaviors for a chat to inject into the persona prompt.
   */
  public async getLearnedBehaviors(chatJid: string, limit = 5): Promise<string[]> {
    try {
      const rows = await db.prepare(`
        SELECT behavior_bullet FROM learned_behaviors
        WHERE chat_jid = ?
        ORDER BY id DESC LIMIT ?
      `).all(chatJid, limit) as unknown as Array<{ behavior_bullet: string }>;

      return rows.map((r) => r.behavior_bullet);
    } catch {
      return [];
    }
  }

  private parseBulletPoints(text: string): string[] {
    return text
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => line.replace(/^[-*•\d.)\]\s]+/, '').trim())
      .filter((line) => line.length > 5 && !line.toLowerCase().startsWith('here are') && !line.toLowerCase().startsWith('point '));
  }
}

export const batchLearner = new BatchLearner();
