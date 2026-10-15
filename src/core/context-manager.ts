import { db } from '../memory/db.js';
import { config } from '../config/env.js';
import { groq } from '../agent/groq.js';
import { buildSystemPrompt } from '../agent/prompt.js';
import { userProfileManager } from '../memory/user-profiles.js';

export interface ManagedContextResult {
  messages: any[];
  tokenBudgetUsed: number;
}

export class ContextManager {
  private readonly TOTAL_CONTEXT_BUDGET = 6000;
  private readonly RAW_HISTORY_MIN_MESSAGES = 8;
  private activeSummarizations = new Set<string>();

  /**
   * Estimates token count for text using the ~chars/4 heuristic
   * with adjustments for code syntax, punctuation, emojis, and newlines.
   */
  public estimateTokens(text: string): number {
    if (!text || text.length === 0) return 0;

    // Base estimation: ~4 characters per token
    let tokens = Math.ceil(text.length / 4);

    // Emoji adjustment: extended pictographic characters consume 2-3 tokens each in BPE
    const emojis = text.match(/\p{Extended_Pictographic}/gu);
    if (emojis) {
      tokens += emojis.length * 2;
    }

    // Code and special symbol adjustment
    const codeSymbols = text.match(/[{}[\]()<>=;:/*+\\|`~^$%&#@]/g);
    if (codeSymbols) {
      tokens += Math.ceil(codeSymbols.length * 0.4);
    }

    // Line breaks adjustment
    const newlines = text.match(/\n/g);
    if (newlines) {
      tokens += newlines.length;
    }

    return Math.max(1, tokens);
  }

  /**
   * Estimates tokens for an individual chat message, including formatting overhead.
   */
  public estimateMessageTokens(message: { role: string; content?: string }): number {
    // 4 tokens standard ChatML overhead per message (<|im_start|>role\ncontent<|im_end|>\n)
    return 4 + this.estimateTokens(message.content || '');
  }

  /**
   * Assembles the full message array for Groq LLM within a 6000-token budget:
   * 1. System prompt (with persona, tools, style rules)
   * 2. User profile context (cross-chat persistent memory & preferences)
   * 3. Summarized older history (from conversation_summaries)
   * 4. Recent raw chat history (sliding window keeping at least the latest 8 messages)
   * 5. Current user prompt
   */
  public buildManagedContext(
    chatJid: string,
    userJid: string,
    isGroup: boolean,
    currentPrompt: string
  ): ManagedContextResult {
    // 1. Check if background summarization is needed (> 50 messages since last summary)
    this.checkAndTriggerAutoSummary(chatJid);

    // 2. Build full system prompt + cross-chat user profile context
    let systemPromptText = buildSystemPrompt(userJid, chatJid, isGroup, currentPrompt);
    const profileSummary = userProfileManager.getProfileSummaryForPrompt(userJid);
    if (profileSummary) {
      systemPromptText += `\n\n# User Profile Context (Cross-Chat Persistent Memory):\n${profileSummary}\n`;
    }

    const systemPromptMessage = { role: 'system', content: systemPromptText };
    const currentPromptMessage = { role: 'user', content: currentPrompt };

    const systemTokens = this.estimateMessageTokens(systemPromptMessage);
    const currentPromptTokens = this.estimateMessageTokens(currentPromptMessage);

    let remainingBudget = this.TOTAL_CONTEXT_BUDGET - systemTokens - currentPromptTokens;
    if (remainingBudget < 200) {
      // Fallback if system prompt is unusually large: ensure minimum room for messages
      remainingBudget = 200;
    }

    // 3. Summarized older history from conversation_summaries table
    let summaryMessage: { role: string; content: string } | null = null;
    let latestSummaryTimestamp = 0;

    try {
      const summaryRow = db.prepare(`
        SELECT summary, to_timestamp FROM conversation_summaries
        WHERE chat_jid = ?
        ORDER BY to_timestamp DESC LIMIT 1
      `).get(chatJid) as { summary: string; to_timestamp: number } | undefined;

      if (summaryRow && summaryRow.summary) {
        latestSummaryTimestamp = summaryRow.to_timestamp;
        const summaryContent = `[Earlier Conversation Summary for this chat]:\n${summaryRow.summary.trim()}`;
        const summaryTokens = this.estimateMessageTokens({ role: 'system', content: summaryContent });

        // Only include summary if it leaves adequate budget for recent raw history
        if (summaryTokens <= remainingBudget - 250) {
          summaryMessage = { role: 'system', content: summaryContent };
          remainingBudget -= summaryTokens;
        }
      }
    } catch (err) {
      console.error('[ContextManager] Error fetching conversation summary:', err);
    }

    // 4. Recent raw chat history (sliding window)
    const rawMessages: Array<{ role: string; content: string }> = [];

    try {
      // Fetch up to 25 recent chat logs
      const rawRows = db.prepare(`
        SELECT sender_name, message_text, content_type, timestamp, sender_jid
        FROM chat_logs
        WHERE chat_jid = ?
        ORDER BY id DESC LIMIT 25
      `).all(chatJid) as Array<{
        sender_name: string | null;
        message_text: string | null;
        content_type: string;
        timestamp: number;
        sender_jid: string;
      }>;

      // Filter out duplicate if the active prompt was already logged immediately prior
      let candidateRows = rawRows;
      if (candidateRows.length > 0 && candidateRows[0].message_text) {
        const firstText = candidateRows[0].message_text.trim();
        const cleanPrompt = currentPrompt.trim();
        // Check if first row matches either raw text or "Sender: raw text"
        if (
          (firstText === cleanPrompt || cleanPrompt.endsWith(firstText) || currentPrompt.includes(firstText)) &&
          Date.now() - candidateRows[0].timestamp < 30000
        ) {
          candidateRows = candidateRows.slice(1);
        }
      }

      // Convert to chronological order (oldest to newest)
      const chronological = candidateRows.reverse();

      // Collect raw messages working backwards from newest to preserve recent context
      const selectedChronological: Array<{ role: string; content: string }> = [];
      const reversedCandidates = [...chronological].reverse();

      for (let i = 0; i < reversedCandidates.length; i++) {
        const row = reversedCandidates[i];
        const isBot =
          row.sender_name === config.bot.name ||
          row.sender_name === 'Forgelabs assistant' ||
          row.sender_name === 'Forgelabs Assistant' ||
          row.sender_name === 'Nova' ||
          row.sender_jid === 'bot' ||
          (row.sender_jid && row.sender_jid.startsWith('2349014896714'));
        const role = isBot ? 'assistant' : 'user';
        let body = row.message_text ? row.message_text.trim() : `[${row.content_type}]`;

        // If it's a bot message, don't prefix with "Nova: ", just output the message body
        // If it's a user message, prefix with sender name for group clarity
        const content = isBot ? body : `${row.sender_name || 'User'}: ${body}`;
        let tokens = this.estimateMessageTokens({ role, content });

        if (tokens > remainingBudget) {
          if (i < this.RAW_HISTORY_MIN_MESSAGES && remainingBudget > 30) {
            const maxChars = Math.max(50, (remainingBudget - 10) * 4);
            body = body.slice(0, maxChars) + '... [truncated]';
            const truncatedContent = isBot ? body : `${row.sender_name || 'User'}: ${body}`;
            tokens = this.estimateMessageTokens({ role, content: truncatedContent });
            remainingBudget -= tokens;
            selectedChronological.unshift({ role, content: truncatedContent });
          }
          continue;
        }

        remainingBudget -= tokens;
        selectedChronological.unshift({ role, content });
      }

      for (const msg of selectedChronological) {
        rawMessages.push(msg);
      }
    } catch (err) {
      console.error('[ContextManager] Error retrieving raw chat history:', err);
    }

    // 5. Assemble final message array
    const messages: Array<{ role: string; content: string }> = [];
    messages.push(systemPromptMessage);

    if (summaryMessage) {
      messages.push(summaryMessage);
    }

    for (const raw of rawMessages) {
      messages.push(raw);
    }

    messages.push(currentPromptMessage);

    // Calculate total token budget used
    let tokenBudgetUsed = 0;
    for (const m of messages) {
      tokenBudgetUsed += this.estimateMessageTokens(m);
    }

    return {
      messages,
      tokenBudgetUsed,
    };
  }

  /**
   * Checks if unsummarized messages exceed 50, and triggers `summarizeAndArchive` in background.
   */
  private checkAndTriggerAutoSummary(chatJid: string): void {
    try {
      const latestSummary = db.prepare(`
        SELECT to_timestamp FROM conversation_summaries
        WHERE chat_jid = ?
        ORDER BY to_timestamp DESC LIMIT 1
      `).get(chatJid) as { to_timestamp: number } | undefined;

      const lastTimestamp = latestSummary?.to_timestamp ?? 0;

      const countRow = db.prepare(`
        SELECT COUNT(*) as count FROM chat_logs
        WHERE chat_jid = ? AND timestamp > ?
      `).get(chatJid, lastTimestamp) as { count: number } | undefined;

      const unsummarizedCount = countRow?.count ?? 0;

      if (unsummarizedCount > 50 && !this.activeSummarizations.has(chatJid)) {
        // Run in background without awaiting to avoid latency on user message
        this.summarizeAndArchive(chatJid).catch((err) =>
          console.error(`[ContextManager] Auto-summarization failed for ${chatJid}:`, err)
        );
      }
    } catch (err) {
      console.error('[ContextManager] Error in checkAndTriggerAutoSummary:', err);
    }
  }

  /**
   * When chat_logs for a chatJid exceed 50 messages since last summary,
   * generates a compact summary using Groq and stores it in conversation_summaries.
   * Always keeps the most recent 8 messages as raw history and compresses everything older.
   */
  public async summarizeAndArchive(chatJid: string): Promise<string | null> {
    if (!chatJid || this.activeSummarizations.has(chatJid)) {
      return null;
    }

    if (!config.groq.apiKey) {
      console.warn('[ContextManager] Skipping summarization: GROQ_API_KEY is not configured.');
      return null;
    }

    this.activeSummarizations.add(chatJid);

    try {
      // 1. Determine boundary timestamp of last summary
      const latestSummary = db.prepare(`
        SELECT to_timestamp, summary FROM conversation_summaries
        WHERE chat_jid = ?
        ORDER BY to_timestamp DESC LIMIT 1
      `).get(chatJid) as { to_timestamp: number; summary: string } | undefined;

      const lastTimestamp = latestSummary?.to_timestamp ?? 0;

      // 2. Fetch all unsummarized messages in chronological order
      const rows = db.prepare(`
        SELECT id, sender_name, message_text, content_type, timestamp
        FROM chat_logs
        WHERE chat_jid = ? AND timestamp > ?
        ORDER BY timestamp ASC
      `).all(chatJid, lastTimestamp) as Array<{
        id: number;
        sender_name: string | null;
        message_text: string | null;
        content_type: string;
        timestamp: number;
      }>;

      // Must exceed 50 messages since last summary
      if (rows.length <= 50) {
        return null;
      }

      // Always keep the most recent 8 messages as raw history and compress everything older
      const messagesToCompress = rows.slice(0, rows.length - this.RAW_HISTORY_MIN_MESSAGES);
      if (messagesToCompress.length === 0) {
        return null;
      }

      const fromTimestamp = messagesToCompress[0].timestamp;
      const toTimestamp = messagesToCompress[messagesToCompress.length - 1].timestamp;
      const messagesCovered = messagesToCompress.length;

      // Build transcript for LLM summarization
      const transcript = messagesToCompress
        .map((m) => {
          const sender = m.sender_name || 'User';
          const text = m.message_text ? m.message_text.trim() : `[${m.content_type}]`;
          return `${sender}: ${text}`;
        })
        .filter((line) => line.trim().length > 0)
        .join('\n');

      const systemPrompt =
        'You are a high-density conversation archivist for an intelligent WhatsApp bot. ' +
        'Summarize the following chat transcript into a compact, coherent factual summary. ' +
        'Retain: user names, decisions, topics discussed, agreed actions, user preferences, and key context. ' +
        'Omit greetings, repetitive banter, and pleasantries. Keep the summary under 160 words.';

      const userContent = latestSummary?.summary
        ? `Earlier conversation summary:\n${latestSummary.summary}\n\nNew conversation to merge into summary:\n${transcript}`
        : `Conversation transcript:\n${transcript}`;

      console.log(
        `[ContextManager] Summarizing ${messagesCovered} messages for chat ${chatJid}...`
      );

      const response = await groq.chat.completions.create({
        model: config.groq.model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userContent },
        ],
        temperature: 0.2,
        max_completion_tokens: 300,
      });

      const summaryText = response.choices[0]?.message?.content?.trim();
      if (!summaryText) {
        console.warn(`[ContextManager] Summarizer returned empty response for chat ${chatJid}.`);
        return null;
      }

      // 3. Store summary in conversation_summaries table
      db.prepare(`
        INSERT INTO conversation_summaries (
          chat_jid, summary, messages_covered, from_timestamp, to_timestamp, created_at
        )
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(chatJid, summaryText, messagesCovered, fromTimestamp, toTimestamp, Date.now());

      console.log(
        `[ContextManager] Successfully archived summary for chat ${chatJid} (${messagesCovered} messages compressed).`
      );

      return summaryText;
    } catch (err) {
      console.error(`[ContextManager] Error summarizing chat ${chatJid}:`, err);
      return null;
    } finally {
      this.activeSummarizations.delete(chatJid);
    }
  }
}

export const contextManager = new ContextManager();
