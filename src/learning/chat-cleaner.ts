import { db } from '../memory/db.js';
import { sensitiveDataFilter } from '../security/sensitive-data-filter.js';

export class ChatCleaner {
  // 1. OTP, 2FA, and Verification Code patterns
  private otpRegex =
    /\b(otp|verification code|security code|login code|confirmation code|authorization code|use code|sms code|secret code|your pin is|one-time password)\b/i;
  private loneDigitsCodeRegex = /^\s*(?:code[:\s]*)?\d{4,8}\s*$/i;
  private brandedOtpRegex =
    /(?:your\s+)?(whatsapp|uber|bolt|google|facebook|instagram|microsoft|apple|binance|opay|palmpay|kuda|gtbank|access|zenith|firstbank)\s+(?:verification\s+)?code\s+is\s*[:\s]*\d{4,8}/i;

  // 2. Banking, financial credit/debit alerts
  private financialAlertRegex =
    /\b(acct:\s*\d{3,}|credit alert|debit alert|acct no:?\s*\d+|transfer of\s*(?:ngn|usd|eur|gbp|₦|\$)|available bal(?:ance)?|ledger bal(?:ance)?)\b/i;

  // 3. Automated bot commands from third-party bots or prefix spam
  private botCommandRegex = /^[!./#$](?:menu|help|start|play|ping|tagall|kick|sticker|admin|delete|speed|info|status|song|video|rank|level|ban)\b/i;

  // 4. WhatsApp automated system messages and placeholders
  private systemMessageRegex =
    /\b(messages and calls are end-to-end encrypted|you deleted this message|this message was deleted|missed (?:voice|video|group) call|waiting for this message\. this may take a while|view once (?:photo|video)|live location ended)\b/i;

  // 5. Chain broadcast spam & giveaway scam patterns
  private chainSpamRegex =
    /\b(forward this to\s*\d+|share (?:this )?to\s*\d+\s*(?:groups|people|friends)|click (?:here|this link) to (?:win|claim|get free)|airtime giveaway|free data bonus|congratulations you won)\b/i;

  // 6. Promotional / lone URL spam
  private loneUrlRegex = /^(?:https?:\/\/[^\s]+)$/i;

  /**
   * Evaluates if a given incoming message is noise (OTP, bot command, system alert, chain spam, or empty gibberish).
   */
  public isNoise(text?: string | null, contentType?: string): boolean {
    if (!text || typeof text !== 'string') {
      // Empty text or media without caption is noise for NLP training
      return true;
    }

    const clean = this.sanitizeText(text);

    // Too short or pure whitespace
    if (clean.length < 2) return true;

    // Pure punctuation or non-alphanumeric symbols (e.g. "...", "???", "---")
    if (!/[a-zA-Z0-9\u00C0-\u024F\u1E00-\u1EFF]/.test(clean)) {
      return true;
    }

    // Repetitive character mash (e.g. "aaaaaaa", "kkkkkkkk", "........")
    if (/^(.)\1{5,}$/i.test(clean)) {
      return true;
    }

    // Exclude any messages containing sensitive data, credentials, banking info, or secrets
    if (sensitiveDataFilter.shouldExcludeFromTraining(clean)) {
      return true;
    }

    // OTP and verification codes
    if (this.loneDigitsCodeRegex.test(clean) || this.otpRegex.test(clean) || this.brandedOtpRegex.test(clean)) {
      return true;
    }

    // Bank transaction notifications
    if (this.financialAlertRegex.test(clean)) {
      return true;
    }

    // Third-party bot commands
    if (this.botCommandRegex.test(clean)) {
      return true;
    }

    // System status text
    if (this.systemMessageRegex.test(clean)) {
      return true;
    }

    // Chain broadcast spam
    if (this.chainSpamRegex.test(clean)) {
      return true;
    }

    // Standalone spam URLs
    if (this.loneUrlRegex.test(clean)) {
      return true;
    }

    // Media placeholders without substantive text
    if (
      contentType &&
      contentType !== 'text' &&
      /^(?:\[(?:image|video|audio|document|sticker)\]|null|undefined)$/i.test(clean)
    ) {
      return true;
    }

    return false;
  }

  /**
   * Strips zero-width unicode characters, collapses excess whitespace, and normalizes text.
   */
  public sanitizeText(text: string): string {
    return text
      .replace(/[\u200B-\u200D\uFEFF]/g, '') // remove invisible zero-width chars
      .replace(/\r\n/g, '\n')
      .replace(/[ \t]+/g, ' ')
      .trim();
  }

  /**
   * One-time or periodic scan over existing rows in chat_logs to flag noisy rows.
   */
  public cleanExistingLogs(): { totalScanned: number; flaggedNoise: number } {
    try {
      const rows = db.prepare(`
        SELECT id, message_text, content_type
        FROM chat_logs
        WHERE is_noise = 0 AND message_text IS NOT NULL
      `).all() as Array<{ id: number; message_text: string; content_type: string }>;

      let flagged = 0;
      const updateStmt = db.prepare(`UPDATE chat_logs SET is_noise = 1 WHERE id = ?`);

      for (const row of rows) {
        if (this.isNoise(row.message_text, row.content_type)) {
          updateStmt.run(row.id);
          flagged++;
        }
      }

      console.log(`[ChatCleaner] 🧹 Cleaned chat_logs: scanned ${rows.length} rows, flagged ${flagged} noisy rows.`);
      return { totalScanned: rows.length, flaggedNoise: flagged };
    } catch (err: any) {
      console.warn('[ChatCleaner] Error cleaning existing logs:', err?.message || err);
      return { totalScanned: 0, flaggedNoise: 0 };
    }
  }
}

export const chatCleaner = new ChatCleaner();
