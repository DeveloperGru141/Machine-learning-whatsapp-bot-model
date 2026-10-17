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
  public recordExchange(chatJid: string, senderJid: string): void {
    try {
      const now = Date.now();
      db.prepare(`
        INSERT INTO learning_checkpoints (chat_jid, last_analyzed_log_id, unprocessed_count, updated_at)
        VALUES (?, 0, 1, ?)
        ON CONFLICT(chat_jid) DO UPDATE SET
          unprocessed_count = unprocessed_count + 1,
          updated_at = excluded.updated_at
      `).run(chatJid, now);

      const row = db.prepare(`
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
   * Compresses 20 exchanges into 3 high-value bullet points of learned behavioral data
   * in a single batched API call to respect free-tier cooldowns.
   */
  public async processBatch(chatJid: string, senderJid: string): Promise<boolean> {
    if (this.processingChats.has(chatJid)) return false;
    this.processingChats.add(chatJid);

    try {
      const checkpoint = db.prepare(`
        SELECT last_analyzed_log_id, unprocessed_count FROM learning_checkpoints
        WHERE chat_jid = ?
      `).get(chatJid) as CheckpointRow | undefined;

      const lastId = checkpoint?.last_analyzed_log_id ?? 0;

      // Fetch the last 20 messages in chronological order since last analysis
      const logs = db.prepare(`
        SELECT id, sender_name, sender_jid, message_text, content_type, timestamp
        FROM chat_logs
        WHERE chat_jid = ? AND id > ?
        ORDER BY id ASC LIMIT 25
      `).all(chatJid, lastId) as unknown as ChatLogRow[];

      if (logs.length < 5) {
        // Not enough data yet to extract meaningful patterns
        return false;
      }

      // Build clean dialogue transcript
      const transcriptLines: string[] = [];
      let maxLogId = lastId;

      for (const log of logs) {
        if (log.id > maxLogId) maxLogId = log.id;
        const sender = log.sender_name || (log.sender_jid === 'bot' ? 'Forgelabs assistant' : 'User');
        const text = log.message_text ? log.message_text.trim() : `[${log.content_type}]`;
        if (text) {
          transcriptLines.push(`${sender}: ${text}`);
        }
      }

      if (transcriptLines.length < 5) return false;

      const transcript = transcriptLines.join('\n');
      console.log(`[BatchLearner] 🧠 Processing batch of ${logs.length} exchanges for ${chatJid}...`);

      const systemPrompt =
        'You are an ML behavioral analysis engine for an intelligent WhatsApp assistant.\n' +
        'Analyze the following transcript of chat exchanges.\n' +
        'Extract exactly 3 concise, high-value bullet points of learned behavioral data about the user or group.\n' +
        'Focus on: communication tone preferences (casual, slang, formal), recurring interests or projects, and response style.\n' +
        'Strictly format output as 3 bullet points starting with "- ":\n' +
        '- [Point 1]\n' +
        '- [Point 2]\n' +
        '- [Point 3]';

      let response: any;
      try {
        // Try Gemini free tier first
        response = await llmClient.callGeminiInternal({
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: `Chat Transcript:\n${transcript}` },
          ],
          temperature: 0.3,
        });
      } catch (gemErr) {
        // Fallback to Groq using fast lightweight llama-3.1-8b-instant so learning never stops
        try {
          response = await llmClient.callGroqInternal({
            messages: [
              { role: 'system', content: systemPrompt },
              { role: 'user', content: `Chat Transcript:\n${transcript}` },
            ],
            model: 'llama-3.1-8b-instant',
            temperature: 0.3,
            max_tokens: 150,
          });
        } catch (groqErr) {
          console.warn(`[BatchLearner] Skipping batch: both Gemini and Groq fallback failed:`, (groqErr as any)?.message || groqErr);
          return false;
        }
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
          insertBehaviorStmt.run(chatJid, senderJid, point, now);
          if (!isGroup) {
            insertUserFactStmt.run(senderJid, point, now);
          } else {
            insertGroupFactStmt.run(chatJid, `Behavior: ${point.slice(0, 30)}`, point, now);
          }
        }

        console.log(
          `[BatchLearner] ✅ Successfully extracted and saved ${bulletPoints.length} learned behaviors for ${chatJid}:`,
          bulletPoints
        );
      }

      // Periodically update the chat style profile (SQLite-only, zero LLM)
      patternMiner.updateChatStyleProfile(chatJid);

      // Advance checkpoint and reset unprocessed count
      db.prepare(`
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
  public getLearnedBehaviors(chatJid: string, limit = 5): string[] {
    try {
      const rows = db.prepare(`
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
