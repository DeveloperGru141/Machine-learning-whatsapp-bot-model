import type { WASocket, proto } from '@whiskeysockets/baileys';
import fs from 'fs';
import { antiBanEngine } from '../security/anti-ban.js';
import { chatLogger } from '../memory/chat-logger.js';
import { config } from '../config/env.js';
import { db } from '../memory/db.js';

let activeSocketGetter: (() => WASocket | null) | null = null;
export function setActiveSocketGetter(getter: () => WASocket | null) {
  activeSocketGetter = getter;
}

export class OutboundSender {
  private static dispatchedIds: Set<string> = new Set();

  public static isDispatchedId(id?: string | null): boolean {
    return id ? this.dispatchedIds.has(id) : false;
  }

  public static recordDispatchedId(id?: string | null): void {
    if (!id) return;
    this.dispatchedIds.add(id);
    if (this.dispatchedIds.size > 2000) {
      const first = this.dispatchedIds.keys().next().value;
      if (first) this.dispatchedIds.delete(first);
    }
  }

  /**
   * Verifies outbound safety with the Anti-Ban Engine before dispatching.
   */
  private static checkSafety(chatJid: string, quoted?: proto.IWebMessageInfo, isOwnerCommand?: boolean, isProactiveCheckIn?: boolean): boolean {
    const isGroup = chatJid.endsWith('@g.us');
    const check = antiBanEngine.canSendOutbound({
      chatJid,
      isGroup,
      isReplyToInbound: Boolean(quoted),
      isGroupMention: Boolean(quoted),
      isOwnerCommand,
      isProactiveCheckIn,
    });

    if (!check.allowed) {
      console.warn(`[OutboundSender] 🛡️ Discarded outbound to ${chatJid}: ${check.reason}`);
      return false;
    }
    return true;
  }

  /**
   * Linked IDs (@lid) and messages with @lid remoteJid do NOT support stanza quoting
   * in WhatsApp multi-device 1-on-1 direct chats. In group chats (@g.us), multi-device handles
   * participant quoting natively.
   */
  private static sanitizeQuoted(chatJid: string, quoted?: proto.IWebMessageInfo): proto.IWebMessageInfo | undefined {
    if (!quoted) return undefined;
    if (
      chatJid.endsWith('@lid') ||
      quoted.key?.remoteJid?.endsWith('@lid')
    ) {
      return undefined;
    }
    return quoted;
  }

  /**
   * Resolves @lid JIDs to canonical phone number JIDs (@s.whatsapp.net) whenever known
   * so messages appear reliably in the recipient's primary mobile WhatsApp chat thread.
   */
  public static resolveDeliveryJid(chatJid: string): string {
    if (!chatJid || !chatJid.endsWith('@lid')) {
      return chatJid;
    }

    const cleanLid = chatJid.split('@')[0].split(':')[0];

    // If this is the bot's own self-chat / Message Yourself LID (83954564632610),
    // KEEP IT as 83954564632610@lid so it delivers straight to "Message Yourself" on the bot's phone!
    if (cleanLid === '83954564632610') {
      return chatJid;
    }

    // 1. Owner Ademola check (102409552584830@lid -> 2348108574293@s.whatsapp.net)
    if (
      cleanLid === '102409552584830' ||
      config.bot.owners.some((o: string) => o.includes(cleanLid))
    ) {
      return '2348108574293@s.whatsapp.net';
    }

    // 2. Check contacts table for mapped phone number
    try {
      const contact = db
        .prepare(`SELECT phone_number FROM contacts WHERE jid = ? OR phone_number = ? LIMIT 1`)
        .get(chatJid, cleanLid) as { phone_number: string } | undefined;
      if (
        contact?.phone_number &&
        !contact.phone_number.startsWith('10') &&
        contact.phone_number.length >= 7 &&
        contact.phone_number.length <= 14
      ) {
        return `${contact.phone_number}@s.whatsapp.net`;
      }
    } catch {}

    return chatJid;
  }

  /**
   * Central Outbound Guardrail: Sanitizes all outbound text and media captions against:
   * 1. WhatsApp internal IDs (WID/wa.id/JID/LID/groups/newsletters)
   * 2. Raw 14-16 digit numbers or @lid mentions
   * 3. Leaked sticker text, filenames (STK-...), and bracket markdown [Sticker...]
   * 4. Auto-attributed creator phone numbers
   */
  public static sanitizeOutboundText(text: string): string {
    if (!text) return '';
    let cleaned = text;

    // 1. Scrub internal WhatsApp JIDs and domains
    cleaned = cleaned
      .replace(/\b[a-zA-Z0-9._%+-]+@(?:s\.whatsapp\.net|lid|g\.us|broadcast|newsletter)\b/gi, '')
      .replace(/(?:https?:\/\/)?(?:wa\.me|wa\.id)\/[+\d]+/gi, '')
      .replace(/\(?\b(?:wa\.id|wa_id|wid|jid|lid)[:=\s]*\+?\d+\)?/gi, '')
      .replace(/\b(?:wa\.id|wa_id|wid)\b/gi, '');

    // 2. Scrub raw WhatsApp LIDs (14-16 digits)
    cleaned = cleaned
      .replace(/@\d{14,16}\b/g, 'my guy')
      .replace(/\b\d{14,16}\b/g, '')
      .replace(/\b\d{7,13}@(?:s\.whatsapp\.net|lid)\b/gi, '');

    // 3. Scrub leaked internal sticker text / filenames / markdown
    cleaned = cleaned
      .replace(/\[(?:Sticker Reply|Auto-Sticker|Sticker)[^\]]*\](?:\s*\([^)]*\))?/gi, '')
      .replace(/\[?STK-\d{8}-WA\d+\.webp\]?/gi, '')
      .replace(/!\[[^\]]*\]\([^)]+\)/gi, '')
      .replace(/\[[^\]]*\.webp\]/gi, '');

    // 4. Scrub auto-attributed creator phone numbers
    cleaned = cleaned
      .replace(/\s*\(\+?2348108574293\)/g, '')
      .replace(/\s*\(08108574293\)/g, '')
      .replace(/\s*—\s*Sent on behalf of Ademola(?:\s*\(08108574293\))?\s*(?:via Forgelabs)?/gi, '');

    // 5. Clean empty parentheses and normalize spacing
    cleaned = cleaned.replace(/\(\s*\)/g, '').replace(/[ \t]+/g, ' ').trim();
    return cleaned;
  }

  public static async replyText(
    sock: WASocket,
    chatJid: string,
    text: string,
    quoted?: proto.IWebMessageInfo,
    isOwnerCommand?: boolean,
    isProactiveCheckIn?: boolean,
    mentions?: string[]
  ): Promise<any> {
    const targetJid = this.resolveDeliveryJid(chatJid);

    if (!this.checkSafety(targetJid, quoted, isOwnerCommand, isProactiveCheckIn)) return null;

    const cleanText = this.sanitizeOutboundText(text);
    if (!cleanText || !cleanText.trim()) {
      console.warn(`[OutboundSender] 🛡️ Suppressed empty or fully redacted message to ${targetJid}`);
      return null;
    }

    const safeQuoted = this.sanitizeQuoted(targetJid, quoted);

    return antiBanEngine.scheduleDispatch(targetJid, async () => {
      let currentSock = sock || activeSocketGetter?.();
      try {
        const payload: any = { text: cleanText };
        if (mentions && mentions.length > 0) {
          payload.mentions = mentions;
        }
        const result = await currentSock.sendMessage(targetJid, payload, { quoted: safeQuoted });
        this.recordDispatchedId(result?.key?.id);
        chatLogger.logOutboundMessage(targetJid, cleanText);
        console.log(`[OutboundSender] 📤 Dispatched message to ${targetJid} (id: ${result?.key?.id}): "${cleanText.slice(0, 50)}..."`);
        return result;
      } catch (err: any) {
        if (targetJid !== chatJid) {
          console.warn(`[OutboundSender] Send to resolved JID ${targetJid} failed (${err.message}), retrying original ${chatJid}...`);
          try {
            const payload: any = { text: cleanText };
            if (mentions && mentions.length > 0) {
              payload.mentions = mentions;
            }
            const result = await currentSock.sendMessage(chatJid, payload);
            this.recordDispatchedId(result?.key?.id);
            chatLogger.logOutboundMessage(chatJid, cleanText);
            console.log(`[OutboundSender] 📤 Dispatched fallback message to ${chatJid} (id: ${result?.key?.id}): "${cleanText.slice(0, 50)}..."`);
            return result;
          } catch (innerErr: any) {
            err = innerErr;
          }
        }
        if (safeQuoted) {
          console.warn(`[OutboundSender] Reply with quoted failed (${err.message}), retrying direct text...`);
          try {
            const payload: any = { text: cleanText };
            if (mentions && mentions.length > 0) {
              payload.mentions = mentions;
            }
            const result = await currentSock.sendMessage(targetJid, payload);
            this.recordDispatchedId(result?.key?.id);
            chatLogger.logOutboundMessage(targetJid, cleanText);
            return result;
          } catch (innerErr: any) {
            err = innerErr;
          }
        }

        // Self-Healing Outbound: If connection was dropped/closed, wait for socket to reconnect and retry once!
        const isSocketDrop =
          err.message?.includes('Closed') ||
          err.message?.includes('Terminated') ||
          err.message?.includes('1006') ||
          err.message?.includes('ECONNRESET');

        if (isSocketDrop && activeSocketGetter) {
          console.warn(`[OutboundSender] Socket disconnected while sending to ${chatJid}. Waiting 1.2s for reconnect before retry...`);
          await new Promise((r) => setTimeout(r, 1200));
          const freshSock = activeSocketGetter();
          if (freshSock && (freshSock as any).ws?.isOpen) {
            console.log(`[OutboundSender] 🔄 Retrying outbound to ${chatJid} via fresh reconnected socket...`);
            const retryResult = await freshSock.sendMessage(chatJid, { text: cleanText });
            chatLogger.logOutboundMessage(chatJid, cleanText);
            return retryResult;
          }
        }
        throw err;
      }
    });
  }

  public static async sendSticker(
    sock: WASocket,
    chatJid: string,
    bufferOrPath: Buffer | string,
    quoted?: proto.IWebMessageInfo,
    mentions?: string[]
  ): Promise<any> {
    if (!this.checkSafety(chatJid, quoted)) return null;

    const safeQuoted = this.sanitizeQuoted(chatJid, quoted);
    const buffer = typeof bufferOrPath === 'string'
      ? fs.readFileSync(bufferOrPath)
      : bufferOrPath;

    return antiBanEngine.scheduleDispatch(chatJid, async () => {
      let currentSock = sock || activeSocketGetter?.();
      if (!currentSock) {
        console.warn(`[OutboundSender] No active socket to send sticker to ${chatJid}`);
        return null;
      }
      const payload: any = { sticker: buffer };
      if (mentions && mentions.length > 0) {
        payload.mentions = mentions;
      }
      try {
        const res = await currentSock.sendMessage(
          chatJid,
          payload,
          safeQuoted ? { quoted: safeQuoted } : undefined
        );
        this.recordDispatchedId(res?.key?.id);
        return res;
      } catch (err: any) {
        console.warn(`[OutboundSender] sendSticker with quoted failed (${err.message}), retrying directly with mentions...`);
        try {
          const res = await currentSock.sendMessage(chatJid, payload);
          this.recordDispatchedId(res?.key?.id);
          return res;
        } catch (retryErr: any) {
          console.error(`[OutboundSender] Failed to send sticker directly to ${chatJid}:`, retryErr.message);
          throw retryErr;
        }
      }
    });
  }

  public static async sendImage(
    sock: WASocket,
    chatJid: string,
    bufferOrUrl: Buffer | string,
    caption?: string,
    quoted?: proto.IWebMessageInfo
  ): Promise<any> {
    if (!this.checkSafety(chatJid, quoted)) return null;

    const safeQuoted = this.sanitizeQuoted(chatJid, quoted);
    const content = Buffer.isBuffer(bufferOrUrl)
      ? bufferOrUrl
      : { url: bufferOrUrl };
    const cleanCaption = caption ? this.sanitizeOutboundText(caption) : undefined;

    return antiBanEngine.scheduleDispatch(chatJid, async () => {
      try {
        const res = await sock.sendMessage(
          chatJid,
          { image: content, caption: cleanCaption },
          { quoted: safeQuoted }
        );
        this.recordDispatchedId(res?.key?.id);
        return res;
      } catch (err: any) {
        if (safeQuoted) {
          console.warn(`[OutboundSender] sendImage with quoted failed (${err.message}), retrying directly...`);
          const res = await sock.sendMessage(chatJid, { image: content, caption: cleanCaption });
          this.recordDispatchedId(res?.key?.id);
          return res;
        }
        throw err;
      }
    });
  }

  public static async sendAudio(
    sock: WASocket,
    chatJid: string,
    bufferOrUrl: Buffer | string,
    isVoiceNote: boolean = false,
    quoted?: proto.IWebMessageInfo
  ): Promise<any> {
    if (!this.checkSafety(chatJid, quoted)) return null;

    const safeQuoted = this.sanitizeQuoted(chatJid, quoted);
    const content = Buffer.isBuffer(bufferOrUrl)
      ? bufferOrUrl
      : { url: bufferOrUrl };

    let mimetype = isVoiceNote ? 'audio/ogg; codecs=opus' : 'audio/mpeg';
    if (Buffer.isBuffer(bufferOrUrl) && bufferOrUrl.length >= 4) {
      const magic = bufferOrUrl.subarray(0, 4).toString('ascii');
      if (magic === 'OggS') {
        mimetype = 'audio/ogg; codecs=opus';
      } else if (bufferOrUrl.length >= 12 && bufferOrUrl.subarray(4, 8).toString('ascii') === 'ftyp') {
        mimetype = 'audio/mp4';
      } else if (magic.startsWith('ID3') || bufferOrUrl[0] === 0xff) {
        mimetype = 'audio/mpeg';
      }
    }

    return antiBanEngine.scheduleDispatch(chatJid, async () => {
      try {
        const res = await sock.sendMessage(
          chatJid,
          {
            audio: content,
            mimetype,
            ptt: isVoiceNote,
          },
          { quoted: safeQuoted }
        );
        this.recordDispatchedId(res?.key?.id);
        return res;
      } catch (err: any) {
        if (safeQuoted) {
          console.warn(`[OutboundSender] sendAudio with quoted failed (${err.message}), retrying directly...`);
          const res = await sock.sendMessage(chatJid, {
            audio: content,
            mimetype,
            ptt: isVoiceNote,
          });
          this.recordDispatchedId(res?.key?.id);
          return res;
        }
        throw err;
      }
    });
  }

  public static async sendVideo(
    sock: WASocket,
    chatJid: string,
    bufferOrUrl: Buffer | string,
    caption?: string,
    quoted?: proto.IWebMessageInfo
  ): Promise<any> {
    if (!this.checkSafety(chatJid, quoted)) return null;

    const safeQuoted = this.sanitizeQuoted(chatJid, quoted);
    const content = Buffer.isBuffer(bufferOrUrl)
      ? bufferOrUrl
      : { url: bufferOrUrl };
    const cleanCaption = caption ? this.sanitizeOutboundText(caption) : undefined;

    return antiBanEngine.scheduleDispatch(chatJid, async () => {
      try {
        return await sock.sendMessage(
          chatJid,
          {
            video: content,
            caption: cleanCaption,
            mimetype: 'video/mp4',
          },
          { quoted: safeQuoted }
        );
      } catch (err: any) {
        if (safeQuoted) {
          console.warn(`[OutboundSender] sendVideo with quoted failed (${err.message}), retrying directly...`);
          return await sock.sendMessage(chatJid, {
            video: content,
            caption: cleanCaption,
            mimetype: 'video/mp4',
          });
        }
        throw err;
      }
    });
  }

  public static async sendContact(
    sock: WASocket,
    chatJid: string,
    displayName: string,
    phoneNumber: string,
    quoted?: proto.IWebMessageInfo
  ): Promise<any> {
    if (!this.checkSafety(chatJid, quoted)) return null;

    const safeQuoted = this.sanitizeQuoted(chatJid, quoted);
    const cleanNumber = phoneNumber.replace(/[^0-9]/g, '');
    const vcard =
      'BEGIN:VCARD\n' +
      'VERSION:3.0\n' +
      `FN:${displayName}\n` +
      `TEL;type=CELL;type=VOICE;waid=${cleanNumber}:+${cleanNumber}\n` +
      'END:VCARD';

    return antiBanEngine.scheduleDispatch(chatJid, async () => {
      return await sock.sendMessage(
        chatJid,
        {
          contacts: {
            displayName,
            contacts: [{ vcard }],
          },
        },
        { quoted: safeQuoted }
      );
    });
  }

  public static async sendPoll(
    sock: WASocket,
    chatJid: string,
    question: string,
    options: string[],
    selectableCount: number = 1,
    quoted?: proto.IWebMessageInfo
  ): Promise<any> {
    if (!this.checkSafety(chatJid, quoted)) return null;

    const safeQuoted = this.sanitizeQuoted(chatJid, quoted);
    const cleanOptions = (options || []).map((o) => String(o).trim()).filter(Boolean);
    if (cleanOptions.length < 2) {
      throw new Error('A WhatsApp poll requires at least 2 options.');
    }

    const currentSock = activeSocketGetter?.() || sock;
    return antiBanEngine.scheduleDispatch(chatJid, async () => {
      const res = await currentSock.sendMessage(
        chatJid,
        {
          poll: {
            name: question.trim(),
            values: cleanOptions,
            selectableCount: Math.min(cleanOptions.length, Math.max(1, selectableCount || 1)),
          },
        },
        safeQuoted ? { quoted: safeQuoted } : undefined
      );
      this.recordDispatchedId(res?.key?.id);
      chatLogger.logOutboundMessage(chatJid, `[Poll] ${question} (Options: ${cleanOptions.join(', ')})`);
      return res;
    });
  }
}
