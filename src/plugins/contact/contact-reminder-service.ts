import { WASocket } from '@whiskeysockets/baileys';
import { restrictionGuard } from '../../security/restriction-guard.js';
import { db, recordContactReminderSent, recordContactReminderFailed, isContactAlreadyReminded, getContactReminderStats } from '../../memory/db.js';
import { contactService } from '../../memory/contact-service.js';
import { OutboundSender } from '../../core/sender.js';
import { antiBanEngine } from '../../security/anti-ban.js';
import { config } from '../../config/env.js';

export interface EligibleContact {
  jid: string;
  phoneNumber: string;
  displayName: string;
  firstName: string;
  isWarm: boolean; // Has prior inbound messages in chat_logs
}

export interface CampaignConfig {
  batchSize?: number;
  delayMinSec?: number;
  delayMaxSec?: number;
  onlyInteracted?: boolean;
  dryRun?: boolean;
}

export interface CampaignStatus {
  isRunning: boolean;
  isPaused: boolean;
  totalEligible: number;
  totalSentHistory: number;
  currentBatchSent: number;
  currentBatchGoal: number;
  lastRecipient?: string;
  lastSentAt?: number;
  nextScheduledInSec?: number;
}

/**
 * 10 High-Entropy, Natural, Non-Spam Message Templates.
 * Diverse phrasing, tone, and formatting prevents automated WhatsApp hash/spam tripwires.
 */
const REMINDER_TEMPLATES: Array<(name: string, botNumber: string) => string> = [
  // 1. Warm & Friendly with Name
  (name, num) =>
    `Hey ${name}! 👋 It's Forgelabs Assistant here. Quick heads up—could you kindly save my number (${num}) to your phone contacts? WhatsApp only displays status updates to mutual contacts, and I'd love for you to see our daily tech tips, motivational quotes, and updates! Drop your preferred name too so I make sure you're saved properly in my book ✨`,

  // 2. Short, Polite & Cheerful
  (name, _num) =>
    `Hello ${name} 😊 Hope your day is going smoothly! Just a quick polite reminder to save this number as **Forgelabs Assistant** so my daily WhatsApp status posts show up on your feed. Wishing you a super productive and blessed day ahead! 🙏`,

  // 3. Natural Pidgin / Street-Smart Vibe
  (name, _num) =>
    `Boss ${name}, how far now! 🤝 Na Forgelabs Assistant be this. Abeg kindly save my number so you fit dey view our daily motivational quotes, AI tips, and memes for WhatsApp status. If you never tell me your preferred name before, drop am make I save yours well well! 🚀`,

  // 4. Value-Focused (Tech & Motivation)
  (name, num) =>
    `Hi ${name} 💡 Forgelabs Assistant here (${num}). Reaching out with a quick note to save this contact! I share daily productivity hacks, tech updates, and morning quotes on WhatsApp status that I think you'll find helpful. Hope you have an awesome week! ✨`,

  // 5. Respectful & Thoughtful Check-in
  (name, num) =>
    `Good day ${name}! 🌟 Hope all is great with you. Reaching out with a gentle note to save my number (${num}) in your address book so our status stories don't pass you by. Really appreciate having you connected! Have a wonderful day ahead 🤝`,

  // 6. Casual & Welcoming
  (name, _num) =>
    `Hey ${name} 🙌 Just checking in from Forgelabs Assistant! Make sure you have this contact saved so WhatsApp shows you my daily status posts and fun tech highlights. Feel free to text me anytime you need quick info or tasks done! 💫`,

  // 7. Morning & Growth Energy
  (name, num) =>
    `Hello there ${name}! 🚀 Forgelabs Assistant checking in. Please take a second to save this number (${num}) so WhatsApp gives you access to our daily inspiring quotes and smart AI tips on status. Keep winning today! 🎯`,

  // 8. Contact Exchange & Name Confirmation
  (name, _num) =>
    `Hi ${name} ✨ Just a quick one from Forgelabs Assistant! Please save my number so you can view my daily status updates. Also, reply with your preferred name so I can ensure your contact card is completely up to date on my end too 🙏`,

  // 9. Friendly Professional Note
  (name, num) =>
    `Hello ${name}! 👋 Quick reminder to save this line (${num}) as **Forgelabs Assistant**. WhatsApp status visibility requires mutual contact saving, and I share daily tech insights and motivational boosts every morning. Have a productive day! 🌟`,

  // 10. Warm & Grateful Note
  (name, _num) =>
    `Hey ${name} 😊 Hope you're having a wonderful week! Just a brief reminder to save my number so our daily status posts stay visible on your WhatsApp feed. Thank you for connecting with Forgelabs Assistant! 🙌`,
];

export class ContactReminderService {
  private isRunning = false;
  private isPaused = false;
  private currentBatchSent = 0;
  private currentBatchGoal = 20;
  private lastRecipientName = '';
  private lastSentTimestamp = 0;
  private nextRunTimeout: NodeJS.Timeout | null = null;
  private nextScheduledAt = 0;

  /**
   * Retrieves all unique eligible contacts from both the contacts address book and chat_logs.
   * Filters out groups, broadcasts, owner numbers, bot's own number, and previously messaged contacts.
   */
  public getEligibleContacts(onlyInteracted = false): EligibleContact[] {
    const botPhone = config.bot.pairingPhoneNumber?.replace(/\D/g, '') || '2347058967815';
    const ownerPhones = ['2348108574293', '2349014896714'];

    const eligibleMap = new Map<string, EligibleContact>();

    // 1. Gather all contacts with chat history in chat_logs (Warm contacts)
    try {
      const chatRows = db.prepare(`
        SELECT chat_jid, sender_name,
               SUM(CASE WHEN sender_jid != 'bot' THEN 1 ELSE 0 END) as inbound_count
        FROM chat_logs
        WHERE is_group = 0
          AND chat_jid NOT LIKE '%@g.us'
          AND chat_jid NOT LIKE '%broadcast%'
          AND chat_jid NOT LIKE '%newsletter%'
        GROUP BY chat_jid
        HAVING inbound_count > 0
        ORDER BY MAX(timestamp) DESC
      `).all() as Array<{ chat_jid: string; sender_name: string | null; inbound_count: number }>;

      for (const row of chatRows) {
        const phone = contactService.extractPhoneNumber(row.chat_jid);
        if (!phone || phone.length < 7 || phone === botPhone || ownerPhones.includes(phone)) {
          continue;
        }

        const normalizedJid = `${phone}@s.whatsapp.net`;
        if (isContactAlreadyReminded(normalizedJid) || isContactAlreadyReminded(phone)) {
          continue;
        }

        const saved = contactService.getContact(phone);
        const rawName = saved?.custom_name || saved?.display_name || row.sender_name || '';
        const firstName = contactService.extractFriendlyFirstName(rawName) || 'Friend';

        eligibleMap.set(phone, {
          jid: normalizedJid,
          phoneNumber: phone,
          displayName: rawName || `+${phone}`,
          firstName,
          isWarm: true,
        });
      }
    } catch (err: any) {
      console.warn('[ContactReminderService] Error scanning chat_logs for warm contacts:', err.message);
    }

    // 2. If not restricted to interacted-only, gather all address book contacts from `contacts` table
    if (!onlyInteracted) {
      try {
        const contactRows = db.prepare(`
          SELECT phone_number, jid, display_name, custom_name
          FROM contacts
          WHERE jid NOT LIKE '%@g.us'
            AND jid NOT LIKE '%broadcast%'
        `).all() as Array<{ phone_number: string; jid: string; display_name: string; custom_name: string | null }>;

        for (const row of contactRows) {
          const phone = contactService.extractPhoneNumber(row.phone_number || row.jid);
          if (!phone || phone.length < 7 || phone === botPhone || ownerPhones.includes(phone)) {
            continue;
          }

          if (eligibleMap.has(phone)) {
            continue; // Already included as warm contact
          }

          const normalizedJid = `${phone}@s.whatsapp.net`;
          if (isContactAlreadyReminded(normalizedJid) || isContactAlreadyReminded(phone)) {
            continue;
          }

          const rawName = row.custom_name || row.display_name || '';
          const firstName = contactService.extractFriendlyFirstName(rawName) || 'Friend';

          eligibleMap.set(phone, {
            jid: normalizedJid,
            phoneNumber: phone,
            displayName: rawName || `+${phone}`,
            firstName,
            isWarm: false,
          });
        }
      } catch (err: any) {
        console.warn('[ContactReminderService] Error scanning contacts table:', err.message);
      }
    }

    // Return as array: Warm contacts first for maximum anti-ban safety, then others
    return Array.from(eligibleMap.values()).sort((a, b) => (b.isWarm ? 1 : 0) - (a.isWarm ? 1 : 0));
  }

  /**
   * Generates a personalized message for a contact using pseudorandom multi-template selection.
   */
  public renderMessage(contact: EligibleContact, templateIndex?: number): { message: string; templateIndex: number } {
    const idx =
      typeof templateIndex === 'number' && templateIndex >= 0 && templateIndex < REMINDER_TEMPLATES.length
        ? templateIndex
        : Math.floor(Math.random() * REMINDER_TEMPLATES.length);

    const botFormattedNumber = '+234 705 896 7815';
    const templateFn = REMINDER_TEMPLATES[idx];
    const message = templateFn(contact.firstName, botFormattedNumber);

    return { message, templateIndex: idx };
  }

  /**
   * Previews the next contacts in line with their personalized rendered messages without sending.
   */
  public preview(count = 5, onlyInteracted = false): Array<{
    phoneNumber: string;
    displayName: string;
    firstName: string;
    isWarm: boolean;
    templateIndex: number;
    sampleMessage: string;
  }> {
    const eligible = this.getEligibleContacts(onlyInteracted).slice(0, count);
    return eligible.map((c, i) => {
      const templateIdx = i % REMINDER_TEMPLATES.length;
      const { message } = this.renderMessage(c, templateIdx);
      return {
        phoneNumber: c.phoneNumber,
        displayName: c.displayName,
        firstName: c.firstName,
        isWarm: c.isWarm,
        templateIndex: templateIdx,
        sampleMessage: message,
      };
    });
  }

  /**
   * Returns current live status of the reminder runner.
   */
  public getStatus(): CampaignStatus {
    const stats = getContactReminderStats();
    const eligible = this.getEligibleContacts(false);
    const now = Date.now();
    const nextInSec = this.nextScheduledAt > now ? Math.round((this.nextScheduledAt - now) / 1000) : 0;

    return {
      isRunning: this.isRunning,
      isPaused: this.isPaused,
      totalEligible: eligible.length,
      totalSentHistory: stats.totalReminded,
      currentBatchSent: this.currentBatchSent,
      currentBatchGoal: this.currentBatchGoal,
      lastRecipient: this.lastRecipientName || undefined,
      lastSentAt: this.lastSentTimestamp || stats.latestSentAt || undefined,
      nextScheduledInSec: nextInSec > 0 ? nextInSec : undefined,
    };
  }

  /**
   * Pauses an active reminder campaign.
   */
  public pause(): { success: boolean; message: string } {
    if (!this.isRunning) {
      return { success: false, message: 'No contact reminder campaign is currently active.' };
    }
    this.isPaused = true;
    this.isRunning = false;
    if (this.nextRunTimeout) {
      clearTimeout(this.nextRunTimeout);
      this.nextRunTimeout = null;
    }
    return {
      success: true,
      message: `⏸️ Contact reminder campaign paused. Sent ${this.currentBatchSent} messages in this batch.`,
    };
  }

  /**
   * Starts or resumes a safe, human-paced, anti-ban contact reminder loop.
   */
  public async start(
    sock: WASocket,
    opts: CampaignConfig = {}
  ): Promise<{ success: boolean; message: string; data?: any }> {
    if (this.isRunning) {
      return {
        success: false,
        message: 'A contact reminder campaign is already running in the background. Use get_contact_save_reminder_status to inspect progress.',
      };
    }

    const batchSize = Math.max(1, Math.min(opts.batchSize || 20, 50));
    const delayMinSec = Math.max(25, opts.delayMinSec || 35);
    const delayMaxSec = Math.max(delayMinSec + 5, opts.delayMaxSec || 75);
    const onlyInteracted = Boolean(opts.onlyInteracted);
    const dryRun = Boolean(opts.dryRun);

    const eligible = this.getEligibleContacts(onlyInteracted);
    if (eligible.length === 0) {
      return {
        success: true,
        message: 'All eligible contacts have already received the contact save reminder! Zero pending contacts left to message.',
      };
    }

    if (dryRun) {
      const previewList = this.preview(Math.min(batchSize, 5), onlyInteracted);
      return {
        success: true,
        message: `[DRY RUN] Found ${eligible.length} eligible contacts. Safe pacing configured at ${delayMinSec}-${delayMaxSec}s between dispatches. Previewed ${previewList.length} recipients without sending.`,
        data: {
          totalEligible: eligible.length,
          preview: previewList,
        },
      };
    }

    this.isRunning = true;
    this.isPaused = false;
    this.currentBatchSent = 0;
    this.currentBatchGoal = Math.min(batchSize, eligible.length);

    console.log(`[ContactReminderService] 🚀 Starting safe contact save reminder campaign: Goal = ${this.currentBatchGoal} contacts, Safe Pacing = ${delayMinSec}-${delayMaxSec}s`);

    // Run first step asynchronously in background so tool returns immediately to user
    this.scheduleNextStep(sock, delayMinSec, delayMaxSec, onlyInteracted, true);

    return {
      success: true,
      message: `🚀 Contact save reminder campaign initiated safely in background!
- Eligible Contacts: ${eligible.length}
- Target Batch: ${this.currentBatchGoal} contacts
- Safe Anti-Ban Pacing: ${delayMinSec}s - ${delayMaxSec}s random delay between messages
- First message dispatching in 3 seconds...`,
      data: {
        totalEligible: eligible.length,
        batchGoal: this.currentBatchGoal,
        delayRange: `${delayMinSec}-${delayMaxSec}s`,
      },
    };
  }

  /**
   * Internal loop step: Picks the next uncontacted contact, simulates human typing, dispatches message, and schedules the next step.
   */
  private scheduleNextStep(
    sock: WASocket,
    delayMinSec: number,
    delayMaxSec: number,
    onlyInteracted: boolean,
    isImmediate = false
  ): void {
    if (!this.isRunning || this.isPaused) return;

    if (this.currentBatchSent >= this.currentBatchGoal) {
      console.log(`[ContactReminderService] 🏁 Batch complete! Successfully sent ${this.currentBatchSent} reminders.`);
      this.isRunning = false;
      return;
    }

    const waitMs = isImmediate ? 3000 : Math.floor((delayMinSec + Math.random() * (delayMaxSec - delayMinSec)) * 1000);
    this.nextScheduledAt = Date.now() + waitMs;

    this.nextRunTimeout = setTimeout(async () => {
      if (!this.isRunning || this.isPaused) return;

      // Account restricted by WhatsApp: hold the campaign (no sends, no failures recorded) and re-check later.
      if (restrictionGuard.isActive()) {
        restrictionGuard.logSkip('contact reminder campaign step');
        this.scheduleNextStep(sock, delayMinSec, delayMaxSec, onlyInteracted, false);
        return;
      }

      try {
        const eligible = this.getEligibleContacts(onlyInteracted);
        if (eligible.length === 0) {
          console.log('[ContactReminderService] 🏁 No more eligible contacts remaining. Campaign complete!');
          this.isRunning = false;
          return;
        }

        const nextContact = eligible[0];
        const { message, templateIndex } = this.renderMessage(nextContact);

        console.log(`[ContactReminderService] 📨 Dispatching reminder ${this.currentBatchSent + 1}/${this.currentBatchGoal} to ${nextContact.displayName} (+${nextContact.phoneNumber})...`);

        // Anti-ban human typing simulation (3.5s - 5.5s)
        try {
          await antiBanEngine.simulateTypingPresence(sock, nextContact.jid, message, false, 0, false);
        } catch {}

        // Send via OutboundSender with isOwnerCommand = true to authorize dispatch
        const sent = await OutboundSender.replyText(sock, nextContact.jid, message, undefined, true);

        if (sent) {
          recordContactReminderSent(nextContact.jid, nextContact.phoneNumber, nextContact.displayName, templateIndex, message);
          this.currentBatchSent++;
          this.lastRecipientName = `${nextContact.displayName} (+${nextContact.phoneNumber})`;
          this.lastSentTimestamp = Date.now();
          console.log(`[ContactReminderService] ✅ Sent reminder to ${nextContact.displayName} (+${nextContact.phoneNumber}) [Batch: ${this.currentBatchSent}/${this.currentBatchGoal}]`);
        } else if (restrictionGuard.isActive()) {
          // The account may have become restricted after this campaign step began. Keep the
          // contact eligible and let the next scheduled step check standing again.
          restrictionGuard.logSkip('contact reminder dispatch');
        } else {
          recordContactReminderFailed(nextContact.jid, nextContact.phoneNumber, nextContact.displayName, 'Socket dispatch returned null');
          console.warn(`[ContactReminderService] ⚠️ Failed sending to ${nextContact.displayName} (+${nextContact.phoneNumber})`);
        }
      } catch (err: any) {
        console.error('[ContactReminderService] Error during dispatch step:', err.message);
      }

      // Schedule next contact with safe human delay
      this.scheduleNextStep(sock, delayMinSec, delayMaxSec, onlyInteracted, false);
    }, waitMs);
  }
}

export const contactReminderService = new ContactReminderService();
