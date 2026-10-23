import type { WASocket } from '@whiskeysockets/baileys';
import { restrictionGuard } from '../../security/restriction-guard.js';
import { IPlugin, BotTool, ExecutionContext, ToolResult } from '../types.js';
import { db, logAutonomousAction } from '../../memory/db.js';
import { OutboundSender } from '../../core/sender.js';
import { antiBanEngine } from '../../security/anti-ban.js';
import { llmClient } from '../../agent/llm-client.js';
import { config } from '../../config/env.js';
import { styleAdapter } from '../../learning/style-adapter.js';
import { userProfileManager } from '../../memory/user-profiles.js';
import { sanitizeAssistantResponse } from '../../agent/harness.js';

let activeEngagementSocket: WASocket | null = null;

export function setEngagementSocket(sock: WASocket | null): void {
  activeEngagementSocket = sock;
  engagementPlugin.setSocket(sock);
}

export interface EligibleTarget {
  chatJid: string;
  targetType: 'contact' | 'group';
  targetName: string;
  lastMessageText: string;
  lastMessageTimestamp: number;
  recentHistory: Array<{ senderName: string; senderJid: string; text: string; timestamp: number }>;
}

export interface ProactiveCheckInRecord {
  id: number;
  chat_jid: string;
  target_type: string;
  last_context_snippet: string | null;
  message_sent: string;
  timestamp: number;
}

export function isQuietHours(): boolean {
  if (process.env.NODE_ENV === 'test' || Boolean(process.env.LIVETEST_RUNNER)) {
    return false;
  }
  const hour = new Date().getHours();
  // Quiet hours: 11:30 PM (23:00) to 7:30 AM (07:00)
  return hour >= 23 || hour < 7;
}

export class EngagementPlugin implements IPlugin {
  name = 'Engagement';
  version = '1.0.0';
  description = 'Autonomous, context-aware check-ins and dropped-topic reminders for contacts and groups';

  private sock: WASocket | null = null;
  private loopInterval: NodeJS.Timeout | null = null;
  private isProcessing = false;

  public setSocket(sock: WASocket | null): void {
    this.sock = sock;
  }

  public async onLoad(): Promise<void> {
    console.log('[EngagementPlugin] Initializing proactive engagement scheduler (every 60 mins)...');

    if (this.loopInterval) {
      clearInterval(this.loopInterval);
    }

    // Runs periodic evaluation every 60 minutes
    this.loopInterval = setInterval(async () => {
      await this.runAutonomousCheckInCycle();
    }, 60 * 60 * 1000);

    if (this.loopInterval.unref) {
      this.loopInterval.unref();
    }
  }

  public async onUnload(): Promise<void> {
    if (this.loopInterval) {
      clearInterval(this.loopInterval);
      this.loopInterval = null;
      console.log('[EngagementPlugin] Stopped proactive engagement scheduler.');
    }
  }

  /**
   * Scans for contacts or groups eligible for a proactive check-in.
   */
  public findEligibleTargets(options?: {
    forceType?: 'contact' | 'group';
    specificJid?: string;
    bypassCooldown?: boolean;
    bypassSilence?: boolean;
  }): EligibleTarget[] {
    const isTest = process.env.NODE_ENV === 'test' || Boolean(process.env.LIVETEST_RUNNER);
    const now = Date.now();
    const targets: EligibleTarget[] = [];

    // Cooldown thresholds (production vs test)
    const contactMinSilenceMs = isTest || options?.bypassSilence ? 0 : 6 * 3600 * 1000; // 6 hours
    const contactMaxSilenceMs = isTest || options?.bypassSilence ? Infinity : 14 * 24 * 3600 * 1000; // 14 days
    const contactCooldownMs = isTest || options?.bypassCooldown ? 0 : 48 * 3600 * 1000; // 48 hours

    const groupMinSilenceMs = isTest || options?.bypassSilence ? 0 : 3 * 3600 * 1000; // 3 hours
    const groupMaxSilenceMs = isTest || options?.bypassSilence ? Infinity : 7 * 24 * 3600 * 1000; // 7 days
    const groupCooldownMs = isTest || options?.bypassCooldown ? 0 : 24 * 3600 * 1000; // 24 hours

    // 1. Evaluate Direct Message (DM) Contacts
    if (!options?.forceType || options.forceType === 'contact') {
      try {
        const candidateRows = options?.specificJid
          ? [{ chat_jid: options.specificJid }]
          : (db.prepare(`
              SELECT DISTINCT chat_jid
              FROM chat_logs
              WHERE is_group = 0
                AND chat_jid NOT LIKE '%@g.us'
                AND chat_jid NOT LIKE '%@broadcast'
                AND chat_jid NOT LIKE 'status@%'
            `).all() as Array<{ chat_jid: string }>);

        for (const row of candidateRows) {
          const chatJid = row.chat_jid;
          if (chatJid.endsWith('@g.us')) continue;

          // Strict Anti-Ban: Contact must have sent at least one inbound message to the bot
          const inboundCheck = db.prepare(`
            SELECT 1 FROM chat_logs WHERE chat_jid = ? AND sender_jid != 'bot' LIMIT 1
          `).get(chatJid);

          if (!inboundCheck) {
            continue; // Strictly skip cold contacts
          }

          // Fetch the latest message and timestamp
          const latest = db.prepare(`
            SELECT sender_name, sender_jid, message_text, timestamp
            FROM chat_logs
            WHERE chat_jid = ? AND message_text IS NOT NULL AND message_text != ''
            ORDER BY timestamp DESC
            LIMIT 1
          `).get(chatJid) as { sender_name: string; sender_jid: string; message_text: string; timestamp: number } | undefined;

          if (!latest) continue;

          const silenceDuration = now - latest.timestamp;
          if (silenceDuration < contactMinSilenceMs || silenceDuration > contactMaxSilenceMs) {
            continue;
          }

          // Check last proactive check-in cooldown
          const lastCheckIn = db.prepare(`
            SELECT timestamp FROM proactive_checkins
            WHERE chat_jid = ?
            ORDER BY timestamp DESC
            LIMIT 1
          `).get(chatJid) as { timestamp: number } | undefined;

          if (lastCheckIn && (now - lastCheckIn.timestamp < contactCooldownMs)) {
            continue;
          }

          // Retrieve last 5 messages for context
          const historyRows = db.prepare(`
            SELECT sender_name, sender_jid, message_text, timestamp
            FROM chat_logs
            WHERE chat_jid = ? AND message_text IS NOT NULL AND message_text != ''
            ORDER BY timestamp DESC
            LIMIT 6
          `).all(chatJid) as Array<{ sender_name: string; sender_jid: string; message_text: string; timestamp: number }>;

          const recentHistory = historyRows.reverse().map(h => ({
            senderName: h.sender_name || (h.sender_jid === 'bot' ? 'Forgelabs' : 'User'),
            senderJid: h.sender_jid,
            text: h.message_text,
            timestamp: h.timestamp,
          }));

          targets.push({
            chatJid,
            targetType: 'contact',
            targetName: latest.sender_name || chatJid.split('@')[0],
            lastMessageText: latest.message_text,
            lastMessageTimestamp: latest.timestamp,
            recentHistory,
          });
        }
      } catch (err: any) {
        console.warn('[EngagementPlugin] Error evaluating DM contacts:', err.message);
      }
    }

    // 2. Evaluate Group Chats
    if (!options?.forceType || options.forceType === 'group') {
      try {
        const candidateGroups = options?.specificJid
          ? [{ chat_jid: options.specificJid }]
          : (db.prepare(`
              SELECT DISTINCT chat_jid
              FROM chat_logs
              WHERE is_group = 1 OR chat_jid LIKE '%@g.us'
            `).all() as Array<{ chat_jid: string }>);

        for (const row of candidateGroups) {
          const chatJid = row.chat_jid;
          if (!chatJid.endsWith('@g.us')) continue;

          // Must have at least 2 logged messages
          const countRow = db.prepare(`
            SELECT COUNT(*) as count FROM chat_logs WHERE chat_jid = ?
          `).get(chatJid) as { count: number } | undefined;

          if (!countRow || countRow.count < 2) continue;

          // Fetch latest message
          const latest = db.prepare(`
            SELECT sender_name, sender_jid, message_text, timestamp
            FROM chat_logs
            WHERE chat_jid = ? AND message_text IS NOT NULL AND message_text != ''
            ORDER BY timestamp DESC
            LIMIT 1
          `).get(chatJid) as { sender_name: string; sender_jid: string; message_text: string; timestamp: number } | undefined;

          if (!latest) continue;

          const silenceDuration = now - latest.timestamp;
          if (silenceDuration < groupMinSilenceMs || silenceDuration > groupMaxSilenceMs) {
            continue;
          }

          // Check last proactive check-in cooldown
          const lastCheckIn = db.prepare(`
            SELECT timestamp FROM proactive_checkins
            WHERE chat_jid = ?
            ORDER BY timestamp DESC
            LIMIT 1
          `).get(chatJid) as { timestamp: number } | undefined;

          if (lastCheckIn && (now - lastCheckIn.timestamp < groupCooldownMs)) {
            continue;
          }

          // Retrieve last 8 messages for context
          const historyRows = db.prepare(`
            SELECT sender_name, sender_jid, message_text, timestamp
            FROM chat_logs
            WHERE chat_jid = ? AND message_text IS NOT NULL AND message_text != ''
            ORDER BY timestamp DESC
            LIMIT 8
          `).all(chatJid) as Array<{ sender_name: string; sender_jid: string; message_text: string; timestamp: number }>;

          const recentHistory = historyRows.reverse().map(h => ({
            senderName: h.sender_name || (h.sender_jid === 'bot' ? 'Forgelabs' : 'Member'),
            senderJid: h.sender_jid,
            text: h.message_text,
            timestamp: h.timestamp,
          }));

          targets.push({
            chatJid,
            targetType: 'group',
            targetName: 'Group',
            lastMessageText: latest.message_text,
            lastMessageTimestamp: latest.timestamp,
            recentHistory,
          });
        }
      } catch (err: any) {
        console.warn('[EngagementPlugin] Error evaluating groups:', err.message);
      }
    }

    return targets;
  }

  /**
   * Generates a context-rich, human-like check-in or reminder message via the LLM.
   */
  public async generateProactiveMessage(target: EligibleTarget): Promise<string> {
    const contextSnippet = target.recentHistory
      .map(m => `${m.senderName}: ${m.text}`)
      .join('\n');

    const isContact = target.targetType === 'contact';
    const isOwner = userProfileManager.isOwner(target.chatJid);
    const style = styleAdapter.getStyleContext(target.chatJid, 'check in on contact');
    const exemplarsBlock =
      style.fewShotExemplars.length > 0
        ? `\n# Fine-Tuned Dialogue Exemplars (Strictly emulate this cadence):\n` +
          style.fewShotExemplars
            .slice(0, 4)
            .map((ex) => `Context: "${ex.context}" -> Response: "${ex.response}"`)
            .join('\n')
        : '';

    const systemPrompt = `You are ${config.bot.name}, a sharp, culturally savvy real WhatsApp user created by Ademola (an aspiring ML/AI Engineer).
You are casually following up on a WhatsApp chat that went quiet or had a dropped conversation thread.
${isOwner ? 'IMPORTANT: You are messaging your Creator & Owner, ADEMOLA. Address him warmly with respect and camaraderie.' : ''}
Guidelines:
- Tone: Relaxed, authentic Nigerian WhatsApp user / friend vibe ("how far", "wetin", "omo", "fr", "bro").
- Length: 1-2 sentences maximum. Short, punchy, conversational.
- Emojis: 0 to 1 emoji maximum. NEVER spam emojis.
- STRICT RULE: NEVER sound like customer service or a corporate bot. NEVER say "How can I help you", "I hope you are doing well", "Feel free to reach out", "Let me know if you need assistance".
${isContact
  ? '- For DMs: If there was a specific previous topic/issue/plan discussed, ask how it went or drop a casual check-up (e.g. "Yo, how did that exam/code go?", "Hey, did you sort that out?"). If the previous conversation was brief or general, just say a warm, casual hi/checking in (e.g., "Yo, how far? Just checking in on you", "Hey bro, hope your day is going smooth").'
  : '- For Groups: Drop a casual reminder or follow-up regarding the previous topic discussed (e.g., "Btw guys, did anyone manage to sort that issue?", "Yo quick reminder on what we talked about earlier", "Anyone got updates on that?").'}${exemplarsBlock}`;

    const userPrompt = `Recent conversation context from this ${isContact ? 'private DM' : 'group chat'}:
${contextSnippet || '(No detailed recent history, just an earlier chat)'}

Drop a natural 1-2 sentence ${isContact ? 'check-in / hello' : 'reminder / follow-up'} now:`;

    try {
      const response = await llmClient.chatCompletion({
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ],
        temperature: 0.6,
        max_tokens: 100,
      });

      let content = response.choices[0]?.message?.content?.trim() || '';

      // Strip quotes or markdown wrappers if model enclosed them and apply training pipeline sanitizer
      content = sanitizeAssistantResponse(content.replace(/^["'`]+|["'`]+$/g, '').trim());

      // Ensure no robotic clichés sneaked in
      const lower = content.toLowerCase();
      if (
        lower.includes('how can i assist') ||
        lower.includes('feel free') ||
        lower.includes('as an ai') ||
        lower.includes('virtual assistant') ||
        content.length < 3
      ) {
        throw new Error('Generated response contained robotic clichés');
      }

      return content;
    } catch (err: any) {
      console.warn(`[EngagementPlugin] LLM generation fallback (${err.message}). Using authentic exemplar template.`);
      if (isContact) {
        const fallbacks = [
          "Yo, how far? Just checking in on you, hope your day is going smooth",
          "Hey bro, how have you been? Just checking up on you",
          "What's good? Hope everything is moving well on your side",
        ];
        return fallbacks[Math.floor(Math.random() * fallbacks.length)];
      } else {
        const fallbacks = [
          "Btw guys, just following up on our previous discussion—anyone got an update?",
          "Yo, quick reminder on what was mentioned earlier, did anyone check it out?",
          "Hey everyone, just checking in—how did that turn out?",
        ];
        return fallbacks[Math.floor(Math.random() * fallbacks.length)];
      }
    }
  }

  /**
   * Dispatches the proactive message with human presence simulation and anti-ban checks.
   */
  public async dispatchProactiveMessage(
    sock: WASocket,
    target: EligibleTarget,
    customMessage?: string
  ): Promise<{ success: boolean; messageSent?: string; reason?: string }> {
    const messageText = customMessage || (await this.generateProactiveMessage(target));

    // 1. Simulate human reading and typing presence
    await antiBanEngine.simulateTypingPresence(sock, target.chatJid, messageText, false);

    // 2. Dispatch with isProactiveCheckIn flag set to true
    const result = await OutboundSender.replyText(
      sock,
      target.chatJid,
      messageText,
      undefined,
      false,
      true // isProactiveCheckIn: true
    );

    if (!result) {
      return {
        success: false,
        reason: 'OutboundSender / AntiBanEngine discarded outbound message per policy.',
      };
    }

    // 3. Record audit trail in SQLite proactive_checkins
    const snippet = target.recentHistory.slice(-2).map(m => m.text).join(' | ');
    try {
      db.prepare(`
        INSERT INTO proactive_checkins (chat_jid, target_type, last_context_snippet, message_sent, timestamp)
        VALUES (?, ?, ?, ?, ?)
      `).run(target.chatJid, target.targetType, snippet.slice(0, 300), messageText, Date.now());
    } catch (err: any) {
      console.warn('[EngagementPlugin] Error logging proactive check-in:', err.message);
    }

    console.log(`[EngagementPlugin] 🚀 Proactive message sent to ${target.chatJid} (${target.targetType}): "${messageText}"`);

    return {
      success: true,
      messageSent: messageText,
    };
  }

  /**
   * Executes a single autonomous check-in cycle.
   */
  public async runAutonomousCheckInCycle(): Promise<{ executed: boolean; summary: string }> {
    if (this.isProcessing) {
      return { executed: false, summary: 'Engagement cycle already running.' };
    }
    if (restrictionGuard.isActive()) {
      restrictionGuard.logSkip('proactive engagement cycle');
      return { executed: false, summary: 'Account is temporarily restricted by WhatsApp; proactive check-ins are paused.' };
    }

    const socket = this.sock || activeEngagementSocket;
    if (!socket) {
      return { executed: false, summary: 'WhatsApp socket not connected.' };
    }

    if (isQuietHours()) {
      return { executed: false, summary: 'Quiet hours active (11:30 PM - 7:30 AM). Skipping check-in.' };
    }

    this.isProcessing = true;
    try {
      const eligibleTargets = this.findEligibleTargets();
      if (eligibleTargets.length === 0) {
        return { executed: false, summary: 'No eligible contacts or groups due for check-in.' };
      }

      // Organic randomness: pick 1 random target from eligible candidates
      const chosen = eligibleTargets[Math.floor(Math.random() * eligibleTargets.length)];

      const dispatchResult = await this.dispatchProactiveMessage(socket, chosen);
      if (dispatchResult.success) {
        logAutonomousAction('proactive_checkin', chosen.chatJid, chosen.targetName, `Autonomous check-in sent: "${dispatchResult.messageSent}"`);
        return {
          executed: true,
          summary: `Successfully sent proactive ${chosen.targetType} message to ${chosen.chatJid}: "${dispatchResult.messageSent}"`,
        };
      } else {
        return {
          executed: false,
          summary: `Failed to dispatch proactive message: ${dispatchResult.reason}`,
        };
      }
    } finally {
      this.isProcessing = false;
    }
  }

  public tools: BotTool[] = [
    {
      name: 'trigger_proactive_checkin',
      description:
        'Triggers an autonomous, context-aware check-in or dropped-topic reminder to an eligible contact or group.',
      parameters: {
        type: 'object',
        properties: {
          target_type: {
            type: 'string',
            enum: ['contact', 'group', 'any'],
            description: 'Whether to target a contact DM, a group chat, or pick randomly between eligible ones.',
          },
          chat_jid: {
            type: 'string',
            description: 'Optional specific WhatsApp JID to check in on (must satisfy anti-ban safety rules).',
          },
        },
      },
      execute: async (args: { target_type?: 'contact' | 'group' | 'any'; chat_jid?: string }, context: ExecutionContext): Promise<ToolResult> => {
        const forceType = args.target_type === 'any' || !args.target_type ? undefined : args.target_type;
        const targets = this.findEligibleTargets({
          forceType,
          specificJid: args.chat_jid,
          bypassSilence: true, // Manual triggers can bypass silence
          bypassCooldown: Boolean(args.chat_jid),
        });

        if (targets.length === 0) {
          return {
            success: false,
            message: args.chat_jid
              ? `Target ${args.chat_jid} is not eligible for proactive check-in (requires prior chat history and safety verification).`
              : 'No eligible contacts or groups found for proactive check-in right now.',
          };
        }

        const chosen = targets[Math.floor(Math.random() * targets.length)];
        const result = await this.dispatchProactiveMessage(context.sock, chosen);

        if (result.success) {
          return {
            success: true,
            message: `Proactive check-in delivered to ${chosen.chatJid} (${chosen.targetType}): "${result.messageSent}"`,
            data: { chatJid: chosen.chatJid, type: chosen.targetType, message: result.messageSent },
          };
        } else {
          return {
            success: false,
            message: `Could not deliver proactive check-in: ${result.reason}`,
          };
        }
      },
    },
  ];
}

export const engagementPlugin = new EngagementPlugin();
