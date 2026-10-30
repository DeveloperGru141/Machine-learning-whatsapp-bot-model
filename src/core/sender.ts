import type { WASocket, WAMessage } from '@whiskeysockets/baileys';
import fs from 'fs';
import { antiBanEngine } from '../security/anti-ban.js';
import { restrictionGuard } from '../security/restriction-guard.js';
import { chatLogger } from '../memory/chat-logger.js';

let activeSocketGetter: (() => WASocket | null) | null = null;
let deliveryConfirmationWaiter: ((
  msgId: string,
  recipientJid: string,
  timeoutMs?: number
) => Promise<{
  confirmed: boolean;
  status: 'DELIVERED_TO_DEVICE' | 'SENT_TO_SERVER' | 'READ' | 'DISPATCHED';
  statusLabel: string;
  statusCode: number;
}>) | null = null;
export function setActiveSocketGetter(getter: () => WASocket | null) {
  activeSocketGetter = getter;
}

export function setDeliveryConfirmationWaiter(
  waiter: typeof deliveryConfirmationWaiter
) {
  deliveryConfirmationWaiter = waiter;
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

  private static trackDeliveryConfirmation(result: any, chatJid: string): void {
    const msgId = result?.key?.id;
    const recipientType = chatJid.endsWith('@lid')
      ? 'LID'
      : chatJid.endsWith('@s.whatsapp.net')
        ? 'phone JID'
        : chatJid.endsWith('@g.us')
          ? 'group'
          : 'other';

    if (!msgId || !deliveryConfirmationWaiter) {
      console.warn('[OutboundSender] Message dispatch lacks a delivery monitor (recipient type: ' + recipientType + ').');
      return;
    }

    void deliveryConfirmationWaiter(msgId, chatJid, 30_000)
      .then((info) => {
        console.log('[OutboundSender] WhatsApp delivery status for ' + recipientType + ': ' + info.status + ' (stanza ' + msgId.slice(-8) + ').');
      })
      .catch((err: any) => {
        console.warn('[OutboundSender] Delivery receipt tracking failed: ' + (err?.message || 'unknown error'));
      });
  }

  /**
   * Verifies outbound safety with the Anti-Ban Engine before dispatching.
   */
  private static async checkSafety(
    chatJid: string,
    quoted?: WAMessage,
    isOwnerCommand?: boolean,
    isProactiveCheckIn?: boolean,
    isReply: boolean = true
  ): Promise<boolean> {
    if (restrictionGuard.blocksJid(chatJid)) {
      restrictionGuard.logSkip('outbound message');
      return false;
    }

    const isGroup = chatJid.endsWith('@g.us');
    const check = await antiBanEngine.canSendOutbound({
      chatJid,
      isGroup,
      isReplyToInbound: isReply || Boolean(quoted),
      isGroupMention: isReply || Boolean(quoted),
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
  private static sanitizeQuoted(chatJid: string, quoted?: WAMessage): WAMessage | undefined {
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
   * Central Outbound Guardrail: Sanitizes all outbound text and media captions against:
   * 1. WhatsApp internal IDs (WID/wa.id/JID/LID/groups/newsletters)
   * 2. Raw 14-16 digit numbers or @lid mentions
   * 3. Leaked sticker text, filenames (STK-...), and bracket markdown [Sticker...]
   * 4. Auto-attributed creator phone numbers
   */
  public static sanitizeOutboundText(text: string): string {
    if (!text) return '';
    let cleaned = text;

    // Never send model-internal reasoning or tool directives through any outbound path.
    cleaned = cleaned
      .replace(/<(think|thought|analysis|reasoning|scratchpad|tool_call|function)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
      .replace(/<(think|thought|analysis|reasoning|scratchpad|tool_call|function)\b[^>]*>[\s\S]*$/gi, '')
      .replace(/<\/?(?:think|thought|analysis|reasoning|scratchpad|tool_call|function)\b[^>]*>/gi, '')
      .replace(/^\s*(?:\[(?:analysis|thought|reasoning|scratchpad)\]|(?:private\s+)?(?:analysis|thought|reasoning|chain of thought|scratchpad))\s*[:：]\s*[\s\S]*?(?=\n\s*\n|\n\s*(?:final|answer)\s*[:：]|$)/i, '')
      .replace(/^\s*(?:final|answer)\s*[:：]\s*/i, '')
      .replace(/^\s*(?:let me think(?: through this)?|let['’]s (?:think|reason|analy[sz]e)|i need to (?:think|reason|analy[sz]e)|step[- ]by[- ]step reasoning)\b[^\n]*(?:\n(?!\s*$)[^\n]*)*(?=\n\s*\n|$)/i, '')
      .replace(/\b(?:reasoning_content|chain_of_thought)\s*[:=][\s\S]*$/gi, '');

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

  /** Last-line sanitizer for text fields sent through any socket/plugin path. */
  public static sanitizeOutgoingPayload(payload: any): any {
    const visibleTextKeys = new Set([
      'text', 'caption', 'conversation', 'title', 'description', 'footer', 'body',
      'header', 'contenttext', 'buttontext', 'pollname', 'name', 'values',
      'option', 'placeholder', 'subtitle',
    ]);
    const visit = (value: any, key = ''): any => {
      if (typeof value === 'string') {
        return visibleTextKeys.has(key.toLowerCase()) ? this.sanitizeOutboundText(value) : value;
      }
      if (!value || typeof value !== 'object' || Buffer.isBuffer(value) || ArrayBuffer.isView(value)) return value;
      if (Array.isArray(value)) return value.map((item) => visit(item, key));
      const result: Record<string, any> = {};
      for (const [childKey, childValue] of Object.entries(value)) {
        result[childKey] = visit(childValue, childKey);
      }
      return result;
    };
    return visit(payload);
  }

  public static async replyText(
    sock: WASocket,
    chatJid: string,
    text: string,
    quoted?: WAMessage,
    isOwnerCommand?: boolean,
    isProactiveCheckIn?: boolean,
    mentions?: string[],
    isReply: boolean = true,
    logChatJid?: string
  ): Promise<any> {
    if (!this.checkSafety(chatJid, quoted, isOwnerCommand, isProactiveCheckIn, isReply)) return null;

    const cleanText = this.sanitizeOutboundText(text);
    if (!cleanText || !cleanText.trim()) {
      console.warn(`[OutboundSender] 🛡️ Suppressed empty or fully redacted message to ${chatJid}`);
      return null;
    }

    const safeQuoted = this.sanitizeQuoted(chatJid, quoted);

    return await antiBanEngine.scheduleDispatch(chatJid, async () => {
      let currentSock = sock || activeSocketGetter?.();
      try {
        const payload: any = { text: cleanText };
        if (mentions && mentions.length > 0) {
          payload.mentions = mentions;
        }
        const result = await currentSock.sendMessage(chatJid, payload, { quoted: safeQuoted });
        this.recordDispatchedId(result?.key?.id);
        await chatLogger.logOutboundMessage(logChatJid || chatJid, cleanText, result?.key?.id);
        this.trackDeliveryConfirmation(result, chatJid);
        return result;
      } catch (err: any) {
        if (safeQuoted) {
          console.warn(`[OutboundSender] Reply with quoted failed (${err.message}), retrying direct text...`);
          try {
            const payload: any = { text: cleanText };
            if (mentions && mentions.length > 0) {
              payload.mentions = mentions;
            }
            const result = await currentSock.sendMessage(chatJid, payload);
            this.recordDispatchedId(result?.key?.id);
            await chatLogger.logOutboundMessage(logChatJid || chatJid, cleanText, result?.key?.id);
            this.trackDeliveryConfirmation(result, chatJid);
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
            this.recordDispatchedId(retryResult?.key?.id);
            await chatLogger.logOutboundMessage(logChatJid || chatJid, cleanText, retryResult?.key?.id);
            this.trackDeliveryConfirmation(retryResult, chatJid);
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
    quoted?: WAMessage,
    mentions?: string[],
    isReply: boolean = true
  ): Promise<any> {
    if (!this.checkSafety(chatJid, quoted, false, false, isReply)) return null;

    const safeQuoted = this.sanitizeQuoted(chatJid, quoted);
    const buffer = typeof bufferOrPath === 'string'
      ? fs.readFileSync(bufferOrPath)
      : bufferOrPath;

    return await antiBanEngine.scheduleDispatch(chatJid, async () => {
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
        await chatLogger.logOutboundMedia(chatJid, 'sticker', res?.key?.id);
        return res;
      } catch (err: any) {
        console.warn(`[OutboundSender] sendSticker with quoted failed (${err.message}), retrying directly with mentions...`);
        try {
          const res = await currentSock.sendMessage(chatJid, payload);
          this.recordDispatchedId(res?.key?.id);
          await chatLogger.logOutboundMedia(chatJid, 'sticker', res?.key?.id);
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
    quoted?: WAMessage,
    isReply: boolean = true
  ): Promise<any> {
    if (!this.checkSafety(chatJid, quoted, false, false, isReply)) return null;

    const safeQuoted = this.sanitizeQuoted(chatJid, quoted);
    const content = Buffer.isBuffer(bufferOrUrl)
      ? bufferOrUrl
      : { url: bufferOrUrl };
    const cleanCaption = caption ? this.sanitizeOutboundText(caption) : undefined;

    return await antiBanEngine.scheduleDispatch(chatJid, async () => {
      try {
        const res = await sock.sendMessage(
          chatJid,
          { image: content, caption: cleanCaption },
          { quoted: safeQuoted }
        );
        this.recordDispatchedId(res?.key?.id);
        await chatLogger.logOutboundMedia(chatJid, 'image', res?.key?.id);
        return res;
      } catch (err: any) {
        if (safeQuoted) {
          console.warn(`[OutboundSender] sendImage with quoted failed (${err.message}), retrying directly...`);
          const res = await sock.sendMessage(chatJid, { image: content, caption: cleanCaption });
          this.recordDispatchedId(res?.key?.id);
          await chatLogger.logOutboundMedia(chatJid, 'image', res?.key?.id);
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
    quoted?: WAMessage,
    isReply: boolean = true
  ): Promise<any> {
    if (!this.checkSafety(chatJid, quoted, false, false, isReply)) return null;

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

    return await antiBanEngine.scheduleDispatch(chatJid, async () => {
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
        await chatLogger.logOutboundMedia(chatJid, 'audio', res?.key?.id);
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
          await chatLogger.logOutboundMedia(chatJid, 'audio', res?.key?.id);
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
    quoted?: WAMessage,
    isReply: boolean = true
  ): Promise<any> {
    if (!this.checkSafety(chatJid, quoted, false, false, isReply)) return null;

    const safeQuoted = this.sanitizeQuoted(chatJid, quoted);
    const content = Buffer.isBuffer(bufferOrUrl)
      ? bufferOrUrl
      : { url: bufferOrUrl };
    const cleanCaption = caption ? this.sanitizeOutboundText(caption) : undefined;

    return await antiBanEngine.scheduleDispatch(chatJid, async () => {
      try {
        const res = await sock.sendMessage(
          chatJid,
          {
            video: content,
            caption: cleanCaption,
            mimetype: 'video/mp4',
          },
          { quoted: safeQuoted }
        );
        this.recordDispatchedId(res?.key?.id);
        await chatLogger.logOutboundMedia(chatJid, 'video', res?.key?.id);
        return res;
      } catch (err: any) {
        if (safeQuoted) {
          console.warn(`[OutboundSender] sendVideo with quoted failed (${err.message}), retrying directly...`);
          const res = await sock.sendMessage(chatJid, {
            video: content,
            caption: cleanCaption,
            mimetype: 'video/mp4',
          });
          this.recordDispatchedId(res?.key?.id);
          await chatLogger.logOutboundMedia(chatJid, 'video', res?.key?.id);
          return res;
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
    quoted?: WAMessage,
    isReply: boolean = true
  ): Promise<any> {
    if (!this.checkSafety(chatJid, quoted, false, false, isReply)) return null;

    const safeQuoted = this.sanitizeQuoted(chatJid, quoted);
    const cleanNumber = phoneNumber.replace(/[^0-9]/g, '');
    const vcard =
      'BEGIN:VCARD\n' +
      'VERSION:3.0\n' +
      `FN:${displayName}\n` +
      `TEL;type=CELL;type=VOICE;waid=${cleanNumber}:+${cleanNumber}\n` +
      'END:VCARD';

    return await antiBanEngine.scheduleDispatch(chatJid, async () => {
      const res = await sock.sendMessage(
        chatJid,
        {
          contacts: {
            displayName,
            contacts: [{ vcard }],
          },
        },
        { quoted: safeQuoted }
      );
      this.recordDispatchedId(res?.key?.id);
      await chatLogger.logOutboundMedia(chatJid, 'contact', res?.key?.id);
      return res;
    });
  }

  public static async sendPoll(
    sock: WASocket,
    chatJid: string,
    question: string,
    options: string[],
    selectableCount: number = 1,
    quoted?: WAMessage
  ): Promise<any> {
    if (!this.checkSafety(chatJid, quoted)) return null;

    const safeQuoted = this.sanitizeQuoted(chatJid, quoted);
    const cleanOptions = (options || []).map((o) => String(o).trim()).filter(Boolean);
    if (cleanOptions.length < 2) {
      throw new Error('A WhatsApp poll requires at least 2 options.');
    }

    const currentSock = activeSocketGetter?.() || sock;
    return await antiBanEngine.scheduleDispatch(chatJid, async () => {
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
      await chatLogger.logOutboundMessage(chatJid, `[Poll] ${question} (Options: ${cleanOptions.join(', ')})`, res?.key?.id);
      return res;
    });
  }
}
