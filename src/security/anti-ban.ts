import type { WASocket } from '@whiskeysockets/baileys';
import { AsyncLocalStorage } from 'node:async_hooks';
import { db } from '../memory/db.js';
import { config } from '../config/env.js';

const DM_INBOUND_RECENCY_MS = 30 * 24 * 60 * 60 * 1000;

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
  "Hello! I am Forgelabs Assistant, an intelligent WhatsApp chat assistant created by Ademola. I dey here to run things sharp sharp for you—feel free to ask me anything or give me tasks, no wahala! 🤝";

export const BOT_GROUP_INTRO =
  "Hello everyone! I am Forgelabs Assistant, an intelligent WhatsApp assistant created by Ademola. I dey here with full energy to help the group—just tag me with @Forgelabs whenever you need quick answers, live web searches, reminders, or media downloads! 🔥";

function isLivetestRunner(): boolean {
  return (
    process.argv.some((arg) => arg.includes('livetest') || arg.includes('test_') || arg.includes('test.')) ||
    process.env.NODE_ENV === 'test' ||
    Boolean(process.env.LIVETEST_RUNNER)
  );
}

/**
 * AntiBanEngine:
 * 1. Allows direct messages only to owners or people who recently messaged the bot.
 * 2. Enforces group mention/tag-only rules for OutboundSender messages.
 * 3. Applies one bounded outbound queue and rate limit to both helper and direct socket sends.
 */
export class AntiBanEngine {
  // Global outbound pacing queue
  private dispatchQueue: AntiBanDispatchItem[] = [];
  private isProcessingQueue = false;
  private readonly dispatchContext = new AsyncLocalStorage<boolean>();
  private readonly maxPendingDispatches = 100;

  // Rate limiting & cooldown tracking
  private lastDispatchTimes: Map<string, number> = new Map(); // chatJid -> timestamp
  private recentGlobalDispatches: number[] = []; // timestamps of recent dispatches within 60s
  private readonly maxGlobalPerMinute = 10; // Maximum outbound content sends across all chats
  private readonly minPerChatCooldownMs = 5_000;
  private readonly minGlobalGapMs = 1_500;
  private readonly globalGapJitterMs = 1_000;

  /** Applies a short response delay before processing an incoming message. */
  public calculateReadingDelay(incomingTextLength: number = 0, isGroup: boolean = false, isOwner: boolean = false): number {
    if (isLivetestRunner() || isOwner) return 10;
    if (!isGroup) return 50;

    const cleanLen = Math.max(1, Math.min(incomingTextLength || 20, 100));
    const baseMs = 250;
    const perCharMs = 2;
    const rawDelay = baseMs + cleanLen * perCharMs;
    return Math.min(600, rawDelay);
  }

  /** Calculates a bounded presence duration for an active response. */
  public calculateTypingDelay(
    responseTextLength: number = 0,
    isGroup: boolean = false,
    isOwner: boolean = false
  ): number {
    if (isLivetestRunner()) return 20;

    // Owner gets immediate, ultra-responsive execution
    if (isOwner) {
      return 200 + Math.floor(Math.random() * 200);
    }

    if (!isGroup) {
      const baseMs = 700;
      const replyTypingMs = Math.min(800, Math.floor(responseTextLength * 1.5));
      const jitter = Math.floor(Math.random() * 200 - 100);
      return Math.max(700, Math.min(1800, baseMs + replyTypingMs + jitter));
    }

    const baseMs = 1200;
    const replyTypingMs = Math.min(1500, Math.floor(responseTextLength * 2.0));
    const jitter = Math.floor(Math.random() * 300 - 150);
    return Math.max(1200, Math.min(3000, baseMs + replyTypingMs + jitter));
  }

  /**
   * Shows composing/recording presence while a response is being prepared.
   */
  public async simulateTypingPresence(
    sock: WASocket,
    chatJid: string,
    responseText: string,
    isVoiceNote: boolean = false,
    incomingTextLength: number = 0,
    isGroup: boolean = false,
    isOwner: boolean = false
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
      : this.calculateTypingDelay(responseText.length, isGroup || chatJid.endsWith('@g.us'), isOwner);

    console.log(
      `[AntiBan] ⏳ Simulating human ${isVoiceNote ? 'recording' : 'typing'} (${delay}ms, userMsg=${incomingTextLength}c, reply=${responseText.length}c, owner=${isOwner}) to ${chatJid}...`
    );

    if (canSendPresence) {
      try {
        await sock.sendPresenceUpdate(presenceType, chatJid);
      } catch {}
    }

    if (!isLivetestRunner() && !isVoiceNote && delay >= 4000 && canSendPresence) {
      const halfDelay = Math.floor(delay / 2);
      await new Promise((r) => setTimeout(r, halfDelay));
      try {
        await sock.sendPresenceUpdate(presenceType, chatJid);
      } catch {}
      await new Promise((r) => setTimeout(r, delay - halfDelay));
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
   * Starts an active typing heartbeat ('composing') so users and groups immediately see
   * that the bot is alive and crafting their response. Re-broadcasts every 3.5s to keep
   * WhatsApp's typing bubble active until the reply is delivered.
   */
  public startTypingHeartbeat(sock: WASocket | null | undefined, chatJid: string): () => void {
    if (!sock || chatJid.endsWith('@lid') || chatJid.endsWith('@broadcast')) {
      return () => {};
    }

    let isStopped = false;
    const sendComposing = () => {
      if (isStopped) return;
      try {
        sock.sendPresenceUpdate('composing', chatJid).catch(() => {});
      } catch {}
    };

    // Send initial composing bubble immediately
    sendComposing();

    // WhatsApp composing presence expires after ~5s, so refresh every 3.5s
    const timer = setInterval(sendComposing, 3500);

    return () => {
      if (isStopped) return;
      isStopped = true;
      clearInterval(timer);
      try {
        sock.sendPresenceUpdate('paused', chatJid).catch(() => {});
      } catch {}
    };
  }

  /**
   * Simulates human reading delay proportional to the user's message length before the bot starts typing.
   */
  public async simulateReadingDelay(incomingTextLength: number = 0, isGroup: boolean = false, isOwner: boolean = false): Promise<void> {
    const delay = this.calculateReadingDelay(incomingTextLength, isGroup, isOwner);
    console.log(
      `[AntiBan] 👀 Simulating human reading time (${delay}ms for ${incomingTextLength} chars, group=${isGroup}, owner=${isOwner})...`
    );
    await new Promise((r) => setTimeout(r, delay));
  }

  /**
   * Strict Outbound Gatekeeper:
   * Confirms whether an outbound message is permitted by the bot's contact and group policy.
   * - In DMs: The user MUST have texted the bot first (inbound in chat_logs) or be an owner.
   * - In Groups: The bot MUST be tagged/mentioned or quoted, or this is the bot's own join intro.
   */
  public async canSendOutbound(params: OutboundCheckParams, enforcePolicy: boolean = false): Promise<{ allowed: boolean; reason?: string }> {
    const { chatJid, isGroup, isGroupMention, isBotAddedToGroup } = params;

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
      return {
        allowed: false,
        reason: `Anti-Ban Policy: Bot cannot message group ${chatJid} unless explicitly @mentioned, quoted, or added to the group.`,
      };
    }

    // 2. Direct Message (DM) Evaluation
    // Superuser / Bot Owners / Self-chat are always permitted
    const rawDigits = chatJid.split('@')[0].split(':')[0];
    const ownerDigits = config.bot.owners
      .map((owner: string) => owner.split('@')[0].split(':')[0].replace(/\D/g, ''))
      .filter(Boolean);
    const pairingDigits = (config.bot.pairingPhoneNumber || '').replace(/\D/g, '');
    const isOwner =
      config.bot.owners.includes(chatJid) ||
      ownerDigits.includes(rawDigits) ||
      (Boolean(pairingDigits) && rawDigits === pairingDigits);

    if (isOwner) {
      return { allowed: true };
    }

    // A caller-supplied reply flag or owner-command flag must not authorize a cold DM.
    // Verify an actual recent inbound message in the exact conversation before allowing any send.
    try {
      const inboundRecord = await db.prepare(
        `SELECT MAX(timestamp) AS last_inbound_at
         FROM chat_logs
         WHERE chat_jid = ? AND is_group = 0 AND sender_jid != 'bot'`
      ).get(chatJid) as { last_inbound_at: number | null } | undefined;
      const lastInboundAt = Number(inboundRecord?.last_inbound_at || 0);
      if (lastInboundAt > 0 && Date.now() - lastInboundAt <= DM_INBOUND_RECENCY_MS) {
        return { allowed: true };
      }
    } catch (err: any) {
      console.warn(`[AntiBan] Error querying chat_logs:`, err.message);
    }

    return {
      allowed: false,
      reason: `Anti-Ban Policy: Direct messages are limited to owners and contacts who messaged the bot within the last 30 days (${chatJid}).`,
    };
  }

  /**
   * Paces outbound message execution through an asynchronous queue.
   * Enforces a rolling global cap, a per-chat cooldown, and a bounded scheduling spread.
   */
  public async scheduleDispatch<T>(chatJid: string, dispatchFn: () => Promise<T>): Promise<T> {
    if (isLivetestRunner()) {
      return dispatchFn();
    }

    // A patched WASocket routes direct sends through this queue too. Re-entering from a queued
    // OutboundSender call must dispatch directly to avoid queueing behind and awaiting itself.
    if (this.dispatchContext.getStore()) {
      return dispatchFn();
    }

    return new Promise<T>((resolve, reject) => {
      if (this.dispatchQueue.length >= this.maxPendingDispatches) {
        reject(new Error(`Anti-Ban outbound queue is full (${this.maxPendingDispatches} pending messages).`));
        return;
      }
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

        // 1. Enforce a rolling global outbound cap.
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

        // Count attempts as well as successes so a failed send cannot trigger an immediate retry burst.
        const dispatchTime = Date.now();
        this.lastDispatchTimes.set(item.chatJid, dispatchTime);
        this.recentGlobalDispatches.push(dispatchTime);

        try {
          const result = await this.dispatchContext.run(true, item.execute);
          item.resolve(result);
        } catch (err) {
          item.reject(err);
        }

        // 4. Keep a minimum gap between sends to reduce bursts.
        const gap = this.minGlobalGapMs + Math.floor(Math.random() * this.globalGapJitterMs);
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
