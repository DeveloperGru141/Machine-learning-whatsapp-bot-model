import type { WASocket, proto } from '@whiskeysockets/baileys';
import { db } from '../memory/db.js';
import { config } from '../config/env.js';

export interface OutboundCheckParams {
  chatJid: string;
  isGroup?: boolean;
  isReplyToInbound?: boolean;
  isGroupMention?: boolean;
  isBotAddedToGroup?: boolean;
  isOwnerCommand?: boolean;
  isProactiveCheckIn?: boolean;
}

export interface AntiBanDispatchItem {
  id: string;
  chatJid: string;
  execute: () => Promise<any>;
  resolve: (value: any) => void;
  reject: (reason?: any) => void;
  enqueuedAt: number;
}

/**
 * Standard Polished Bot Welcome Messages
 */
export const BOT_WELCOME_MESSAGE =
  "Hi! I'm Forgelabs, a WhatsApp chat bot created by Ademola, and I'm at your service! How can I help you today?";

export const BOT_GROUP_INTRO =
  "Hi everyone! I'm Forgelabs, a WhatsApp chat bot created by Ademola, and I'm at your service! Tag me with @Forgelabs whenever you need quick answers, live web searches, or reminders.";

function isLivetestRunner(): boolean {
  return process.argv.some((arg) => arg.includes('livetest')) || process.env.NODE_ENV === 'test' || Boolean(process.env.LIVETEST_RUNNER);
}

/**
 * AntiBanEngine:
 * 1. Simulates human reading and typing delays with natural jitter.
 * 2. Enforces strict inbound-only messaging (zero cold outreach).
 * 3. Enforces group mention/tag-only rules.
 * 4. Paces outbound messages via a global velocity limiter and per-chat cooldown.
 */
export class AntiBanEngine {
  // Global outbound pacing queue
  private dispatchQueue: AntiBanDispatchItem[] = [];
  private isProcessingQueue = false;

  // Rate limiting & cooldown tracking
  private lastDispatchTimes: Map<string, number> = new Map(); // chatJid -> timestamp
  private recentGlobalDispatches: number[] = []; // timestamps of recent dispatches within 60s
  private readonly maxGlobalPerMinute = 25; // Safe human cap: max 25 messages/min across all chats
  private readonly minPerChatCooldownMs = 400; // Ultra-snappy 400ms cooldown between messages to the same chat
  private readonly minGlobalGapMs = 250; // 0.25s minimum gap between consecutive dispatches

  /**
   * Calculates an authentic human reading delay proportional to the length of the message
   * sent by the user (~1.2s - 2.5s for groups, ~700ms - 1.8s for DMs).
   */
  public calculateReadingDelay(incomingTextLength: number = 0, isGroup: boolean = false): number {
    if (isLivetestRunner()) return 10;

    const cleanLen = Math.max(1, Math.min(incomingTextLength || 20, 150));
    // Groups: Realistic human reading pause so group replies feel like an active human member
    const baseMs = isGroup ? 1200 : 700;
    const perCharMs = isGroup ? 6 : 4;
    const rawDelay = baseMs + cleanLen * perCharMs;
    const jitter = Math.floor(Math.random() * (isGroup ? 300 : 200));
    const maxCap = isGroup ? 2500 : 1800;
    return Math.min(maxCap, rawDelay + jitter);
  }

  /**
   * Calculates realistic human typing delay based on BOTH how long the user's message was
   * and how long the bot's reply is (~8-14ms per character).
   */
  public calculateTypingDelay(
    responseTextLength: number = 0,
    incomingTextLength: number = 0,
    isGroup: boolean = false
  ): number {
    if (isLivetestRunner()) return 20;

    const replyLen = Math.max(10, Math.min(responseTextLength || 40, 150));
    const userLen = Math.max(0, Math.min(incomingTextLength || 20, 100));

    // Groups: Realistic human typing presence (1.8s - 3.8s)
    const baseMs = isGroup ? 1500 : 1000;
    const replyTypingMs = replyLen * (isGroup ? 10 : 8);
    const userComprehensionMs = userLen * (isGroup ? 3 : 2);
    const rawTotal = baseMs + replyTypingMs + userComprehensionMs;

    // Add +/- 10% natural human rhythm variance
    const varianceFactor = 0.9 + Math.random() * 0.2;
    const computed = Math.floor(rawTotal * varianceFactor);

    const minFloor = isGroup ? 1800 : 1200;
    const maxCeiling = isGroup ? 3800 : 2800;
    return Math.max(minFloor, Math.min(maxCeiling, computed));
  }

  /**
   * Simulates active human presence: sends 'composing' (or 'recording'), waits a realistic
   * human typing duration proportional to message length (with a mid-sentence thinking pause
   * on longer messages), then sends 'paused'.
   */
  public async simulateTypingPresence(
    sock: WASocket,
    chatJid: string,
    responseText: string,
    isVoiceNote: boolean = false,
    incomingTextLength: number = 0,
    isGroup: boolean = false
  ): Promise<void> {
    if (!sock) return;

    const presenceType = isVoiceNote ? 'recording' : 'composing';
    // WhatsApp protocol only accepts presence updates for standard phone JIDs (@s.whatsapp.net) and groups (@g.us).
    // Sending presence to linked/privacy IDs (@lid) triggers server 428 Precondition Required / Connection Terminated!
    const canSendPresence = !chatJid.endsWith('@lid') && !chatJid.endsWith('@broadcast');

    const delay = isVoiceNote
      ? isLivetestRunner()
        ? 50
        : Math.min(9000, Math.max(2800, Math.floor(responseText.length * 48 + incomingTextLength * 15)))
      : this.calculateTypingDelay(responseText.length, incomingTextLength, isGroup || chatJid.endsWith('@g.us'));

    console.log(
      `[AntiBan] ⏳ Simulating human ${isVoiceNote ? 'recording' : 'typing'} (${delay}ms, userMsg=${incomingTextLength}c, reply=${responseText.length}c) to ${chatJid}...`
    );

    if (canSendPresence) {
      try {
        await sock.sendPresenceUpdate(presenceType, chatJid);
      } catch {}
    }

    // For longer typing durations (> 3.8s) outside tests, simulate a natural brief pause mid-typing like a real human thinking
    if (!isLivetestRunner() && !isVoiceNote && delay > 3800 && canSendPresence) {
      const firstLeg = Math.floor(delay * 0.58);
      const pauseDuration = Math.floor(250 + Math.random() * 250);
      const secondLeg = Math.max(500, delay - firstLeg - pauseDuration);

      await new Promise((r) => setTimeout(r, firstLeg));
      try {
        await sock.sendPresenceUpdate('paused', chatJid);
      } catch {}
      await new Promise((r) => setTimeout(r, pauseDuration));
      try {
        await sock.sendPresenceUpdate(presenceType, chatJid);
      } catch {}
      await new Promise((r) => setTimeout(r, secondLeg));
    } else {
      await new Promise((r) => setTimeout(r, delay));
    }

    if (canSendPresence) {
      try {
        await sock.sendPresenceUpdate('paused', chatJid);
      } catch {}
    }
  }

  /**
   * Simulates human reading delay proportional to the user's message length before the bot starts typing.
   */
  public async simulateReadingDelay(incomingTextLength: number = 0, isGroup: boolean = false): Promise<void> {
    const delay = this.calculateReadingDelay(incomingTextLength, isGroup);
    console.log(
      `[AntiBan] 👀 Simulating human reading time (${delay}ms for ${incomingTextLength} chars, group=${isGroup})...`
    );
    await new Promise((r) => setTimeout(r, delay));
  }

  /**
   * Strict Outbound Gatekeeper:
   * Confirms whether an outbound message is legally permissible per Anti-Ban policy.
   * - In DMs: The user MUST have texted the bot first (inbound in chat_logs) or be an owner.
   * - In Groups: The bot MUST be tagged/mentioned or quoted, or this is the bot's own join intro.
   */
  public canSendOutbound(params: OutboundCheckParams, enforcePolicy: boolean = false): { allowed: boolean; reason?: string } {
    const { chatJid, isGroup, isReplyToInbound, isGroupMention, isBotAddedToGroup, isOwnerCommand } = params;

    // Fast-path ONLY for synthetic livetest suite (unless explicit enforcement is requested)
    if (!enforcePolicy && isLivetestRunner()) {
      return { allowed: true };
    }

    // 1. Group Chat Evaluation
    const isGroupChat = isGroup ?? chatJid.endsWith('@g.us');
    if (isGroupChat) {
      if (isBotAddedToGroup) {
        return { allowed: true }; // Permitted one-time self-introduction when bot is added
      }
      if (isGroupMention) {
        return { allowed: true }; // Permitted reply to an @mention or quote
      }
      if (params.isProactiveCheckIn) {
        // Allowed if bot is member and has logged history in this group
        try {
          const hasHistory = db.prepare(`SELECT 1 FROM chat_logs WHERE chat_jid = ? LIMIT 1`).get(chatJid);
          if (hasHistory) {
            return { allowed: true };
          }
        } catch {}
      }
      return {
        allowed: false,
        reason: `Anti-Ban Policy: Bot cannot message group ${chatJid} unless explicitly @mentioned, quoted, or verified proactive check-in.`,
      };
    }

    // 2. Direct Message (DM) Evaluation
    // Superuser / Bot Owners are always permitted
    const rawDigits = chatJid.split('@')[0].split(':')[0];
    if (config.bot.owners.includes(rawDigits) || config.bot.owners.includes(chatJid) || isOwnerCommand) {
      return { allowed: true };
    }

    // If this is an immediate reactive reply to an inbound message from this user
    if (isReplyToInbound) {
      return { allowed: true };
    }

    // Otherwise, check SQLite chat_logs: Has this user ever initiated an inbound message?
    try {
      const inboundRecord = db
        .prepare(`SELECT 1 FROM chat_logs WHERE chat_jid = ? AND sender_jid != 'bot' LIMIT 1`)
        .get(chatJid);

      if (inboundRecord) {
        return { allowed: true };
      }
    } catch (err: any) {
      console.warn(`[AntiBan] Error querying chat_logs:`, err.message);
    }

    return {
      allowed: false,
      reason: `Anti-Ban Policy: Cold messaging blocked. Recipient (${chatJid}) has not initiated a conversation with the bot first.`,
    };
  }

  /**
   * Paces outbound message execution through an asynchronous queue.
   * Enforces global speed limits, per-chat cooldowns, and randomized human jitter.
   */
  public async scheduleDispatch<T>(chatJid: string, dispatchFn: () => Promise<T>): Promise<T> {
    if (isLivetestRunner()) {
      return dispatchFn();
    }

    return new Promise<T>((resolve, reject) => {
      this.dispatchQueue.push({
        id: `${chatJid}_${Date.now()}_${Math.random()}`,
        chatJid,
        execute: dispatchFn,
        resolve,
        reject,
        enqueuedAt: Date.now(),
      });

      this.processQueue();
    });
  }

  /**
   * Internal sequential queue processor
   */
  private async processQueue(): Promise<void> {
    if (this.isProcessingQueue || this.dispatchQueue.length === 0) {
      return;
    }
    this.isProcessingQueue = true;

    try {
      while (this.dispatchQueue.length > 0) {
        const item = this.dispatchQueue[0];
        const now = Date.now();

        // 1. Enforce global velocity cap (max 15 messages in the last 60 seconds)
        this.recentGlobalDispatches = this.recentGlobalDispatches.filter((t) => now - t < 60_000);
        if (this.recentGlobalDispatches.length >= this.maxGlobalPerMinute) {
          const oldest = this.recentGlobalDispatches[0] || now;
          const waitTime = Math.max(1000, 60_000 - (now - oldest) + 200);
          console.log(`[AntiBan] 🛡️ Global velocity cap reached (${this.recentGlobalDispatches.length}/min). Backing off for ${(waitTime / 1000).toFixed(1)}s...`);
          await new Promise((r) => setTimeout(r, waitTime));
          continue;
        }

        // 2. Enforce per-chat cooldown
        const lastChatTime = this.lastDispatchTimes.get(item.chatJid) || 0;
        const chatElapsed = now - lastChatTime;
        if (chatElapsed < this.minPerChatCooldownMs) {
          const chatWait = this.minPerChatCooldownMs - chatElapsed + Math.floor(Math.random() * 400);
          await new Promise((r) => setTimeout(r, chatWait));
        }

        // 3. Dequeue and execute
        this.dispatchQueue.shift();

        try {
          const result = await item.execute();
          const dispatchTime = Date.now();
          this.lastDispatchTimes.set(item.chatJid, dispatchTime);
          this.recentGlobalDispatches.push(dispatchTime);
          item.resolve(result);
        } catch (err) {
          item.reject(err);
        }

        // 4. Subtle human-like gap before next message in queue
        const gap = this.minGlobalGapMs + Math.floor(Math.random() * 800);
        await new Promise((r) => setTimeout(r, gap));
      }
    } finally {
      this.isProcessingQueue = false;
    }
  }

  /**
   * Clean up old entries in memory
   */
  public pruneMemory(): void {
    const cutoff = Date.now() - 3600_000;
    for (const [jid, timestamp] of this.lastDispatchTimes.entries()) {
      if (timestamp < cutoff) {
        this.lastDispatchTimes.delete(jid);
      }
    }
  }
}

export const antiBanEngine = new AntiBanEngine();
