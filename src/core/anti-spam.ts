import { config } from '../config/env.js';
import { userProfileManager } from '../memory/user-profiles.js';

export interface UserSpamStats {
  count: number;
  firstSeen: number;
  warnings: number;
  lastText?: string;
  repeatCount?: number;
}

export class AntiSpamFilter {
  // In-memory frequency tracking: Map<userJid, { count, firstSeen, warnings }>
  private userStats: Map<string, UserSpamStats> = new Map();
  // Warnings tracker map per user
  private warnings: Map<string, number> = new Map();
  private cleanupInterval: NodeJS.Timeout | null = null;

  constructor() {
    // Start cleanup interval every 60 seconds to reset stale counters
    this.cleanupInterval = setInterval(() => {
      this.cleanupOldCounters();
    }, 60000);

    if (this.cleanupInterval.unref) {
      this.cleanupInterval.unref();
    }
  }

  /**
   * Helper to verify if the bot itself has admin rights in a WhatsApp group
   */
  private async isBotAdmin(sock: any, groupJid: string): Promise<boolean> {
    if (!groupJid.endsWith('@g.us') || !sock?.groupMetadata) return false;
    try {
      const meta = await sock.groupMetadata(groupJid);
      const botNumber = (sock.user?.id || '').split(':')[0] + '@s.whatsapp.net';
      const botParticipant = meta.participants?.find(
        (p: any) => p.id === sock.user?.id || p.id === botNumber
      );
      return botParticipant?.admin === 'admin' || botParticipant?.admin === 'superadmin';
    } catch {
      return false;
    }
  }

  /**
   * Checks if message text matches common flooding/spam patterns:
   * - All caps messages over 50 characters
   * - Repeated characters (10+ in a row)
   * - Forwarded message chains
   */
  public isFloodingText(text: string): boolean {
    if (!text) return false;

    // 1. All caps messages over 50 chars
    if (text.length > 50) {
      const letters = text.replace(/[^a-zA-Z]/g, '');
      if (letters.length >= 20 && letters === letters.toUpperCase()) {
        return true;
      }
    }

    // 2. Repeated characters (e.g. 'aaaaaaa' 10+ times)
    if (/(.)\1{9,}/.test(text)) {
      return true;
    }

    // 3. Forwarded message chains (indicators)
    const forwardChainRegex = /(forwarded as received|forward this to|send this to \d+|share with \d+|share to \d+|forward to \d+|forwarded message|pass this on|fwd:)/i;
    if (forwardChainRegex.test(text)) {
      return true;
    }

    return false;
  }

  /**
   * Evaluates an incoming message for spam and applies the escalation ladder if violated.
   */
  public async checkMessage(
    senderJid: string,
    chatJid: string,
    text: string,
    sock: any,
    msg: any
  ): Promise<{ isSpam: boolean; action: 'none' | 'warn' | 'mute' | 'kick' }> {
    // Ignore outbound messages from the bot itself
    if (msg?.key?.fromMe) {
      return { isSpam: false, action: 'none' };
    }

    // Exempt bot owners from spam filters
    const rawNumber = senderJid.split('@')[0].split(':')[0];
    if (userProfileManager.isOwner(senderJid) || config.bot.owners.includes(rawNumber)) {
      return { isSpam: false, action: 'none' };
    }

    const now = Date.now();
    let stats = this.userStats.get(senderJid);
    const existingWarnings = this.warnings.get(senderJid) || 0;

    if (!stats) {
      stats = {
        count: 0,
        firstSeen: now,
        warnings: existingWarnings,
        lastText: '',
        repeatCount: 0,
      };
      this.userStats.set(senderJid, stats);
    }

    // 1. Rate check: >10 messages in 30 seconds from same user = spam
    if (now - stats.firstSeen > 30000) {
      stats.firstSeen = now;
      stats.count = 1;
    } else {
      stats.count += 1;
    }
    const isRateSpam = stats.count > 10;

    // 2. Repetition check: Same exact text 5+ times in a row = spam
    const trimmed = (text || '').trim();
    if (trimmed && trimmed === stats.lastText) {
      stats.repeatCount = (stats.repeatCount || 1) + 1;
    } else {
      stats.lastText = trimmed;
      stats.repeatCount = 1;
    }
    const isRepeatSpam = (stats.repeatCount || 0) >= 5;

    // 3. Flooding pattern check
    const isFlooding = this.isFloodingText(trimmed);

    const isSpam = isRateSpam || isRepeatSpam || isFlooding;

    if (!isSpam) {
      return { isSpam: false, action: 'none' };
    }

    // Escalation ladder handling
    stats.warnings += 1;
    const offenses = stats.warnings;
    this.warnings.set(senderJid, offenses);

    let action: 'none' | 'warn' | 'mute' | 'kick' = 'warn';

    const isLid = senderJid.endsWith('@lid') || rawNumber.length > 13;
    const targetTag = isLid ? 'Member' : `@${rawNumber}`;

    if (offenses === 1) {
      // 1st offense: warn (send warning message mentioning user)
      action = 'warn';
      const warningMsg = `⚠️ ${targetTag}, spam activity detected. Please avoid rapid messages, flooding, or repetitive spam. (Warning 1/3)`;
      try {
        await sock.sendMessage(chatJid, {
          text: warningMsg,
          mentions: [senderJid],
        });
        console.log(`[AntiSpam] Sent 1st warning to ${targetTag} in ${chatJid}`);
      } catch (err: any) {
        console.error(`[AntiSpam] Error sending 1st warning to ${targetTag}:`, err?.message || err);
      }
    } else if (offenses === 2) {
      // 2nd offense: warn + temporary mute concept (just send stronger warning)
      action = 'mute';
      const muteMsg = `🚨 ${targetTag}, this is your second warning (2/3)! You are being placed on temporary mute. Continued spam will result in being kicked from the group.`;
      try {
        await sock.sendMessage(chatJid, {
          text: muteMsg,
          mentions: [senderJid],
        });
        console.log(`[AntiSpam] Sent 2nd warning (mute) to ${targetTag} in ${chatJid}`);
      } catch (err: any) {
        console.error(`[AntiSpam] Error sending 2nd warning to ${targetTag}:`, err?.message || err);
      }
    } else {
      // 3rd offense: attempt kick if bot is admin
      action = 'kick';
      const isGroup = chatJid.endsWith('@g.us');
      if (isGroup) {
        const botAdmin = await this.isBotAdmin(sock, chatJid);
        if (botAdmin) {
          try {
            await sock.groupParticipantsUpdate(chatJid, [senderJid], 'remove');
            await sock.sendMessage(chatJid, {
              text: `🚫 ${targetTag} has been removed from the group for repeated spam violations (3/3 warnings).`,
              mentions: [senderJid],
            });
            console.log(`[AntiSpam] Successfully kicked ${targetTag} from ${chatJid}`);
          } catch (err: any) {
            console.error(`[AntiSpam] Failed to kick ${targetTag}:`, err?.message || err);
            await sock.sendMessage(chatJid, {
              text: `🚨 ${targetTag} reached 3/3 spam warnings, but I encountered an error removing them. Group admins please inspect!`,
              mentions: [senderJid],
            });
          }
        } else {
          await sock.sendMessage(chatJid, {
            text: `🚨 ${targetTag} reached 3/3 spam warnings! I cannot remove them because I am not an admin in this group.`,
            mentions: [senderJid],
          });
          console.log(`[AntiSpam] Cannot kick ${targetTag}: bot is not admin in ${chatJid}`);
        }
      } else {
        // Direct messages
        await sock.sendMessage(chatJid, {
          text: `🚫 You have accumulated 3/3 spam warnings. Further messages will be ignored.`,
        });
      }
    }

    return { isSpam: true, action };
  }

  /**
   * Resets rate counters for a specific user
   */
  public resetUserCounter(senderJid: string): void {
    const stats = this.userStats.get(senderJid);
    if (stats) {
      stats.count = 0;
      stats.firstSeen = Date.now();
      stats.repeatCount = 0;
      stats.lastText = '';
    }
  }

  /**
   * Periodic cleanup running every 60 seconds to reset old counters
   */
  private cleanupOldCounters(): void {
    const now = Date.now();
    for (const [jid, stats] of this.userStats.entries()) {
      // Remove inactive users after 15 minutes to prevent memory leak
      if (now - stats.firstSeen > 900000) {
        this.userStats.delete(jid);
        continue;
      }
      if (stats.count > 0 && now - stats.firstSeen > 60000) {
        stats.count = 0;
        stats.repeatCount = 0;
        stats.lastText = '';
      }
    }
  }

  /**
   * Cleanup timer hook for graceful shutdown or testing
   */
  public stop(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
  }
}

export const antiSpamFilter = new AntiSpamFilter();
