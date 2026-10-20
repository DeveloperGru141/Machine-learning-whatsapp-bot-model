import type { WASocket, proto } from '@whiskeysockets/baileys';
import fs from 'fs';
import { antiBanEngine } from '../security/anti-ban.js';
import { chatLogger } from '../memory/chat-logger.js';

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
   * Linked IDs (@lid) and messages with @lid remoteJid/participant do NOT support stanza quoting
   * in WhatsApp multi-device. Passing quoted causes WhatsApp server to terminate the connection (428 Connection Terminated).
   */
  private static sanitizeQuoted(chatJid: string, quoted?: proto.IWebMessageInfo): proto.IWebMessageInfo | undefined {
    if (!quoted) return undefined;
    if (
      chatJid.endsWith('@lid') ||
      quoted.key?.remoteJid?.endsWith('@lid') ||
      quoted.key?.participant?.endsWith('@lid')
    ) {
      return undefined;
    }
    return quoted;
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
    if (!this.checkSafety(chatJid, quoted, isOwnerCommand, isProactiveCheckIn)) return null;

    const safeQuoted = this.sanitizeQuoted(chatJid, quoted);

    return antiBanEngine.scheduleDispatch(chatJid, async () => {
      let currentSock = sock || activeSocketGetter?.();
      try {
        const payload: any = { text };
        if (mentions && mentions.length > 0) {
          payload.mentions = mentions;
        }
        const result = await currentSock.sendMessage(chatJid, payload, { quoted: safeQuoted });
        this.recordDispatchedId(result?.key?.id);
        chatLogger.logOutboundMessage(chatJid, text);
        return result;
      } catch (err: any) {
        if (safeQuoted) {
          console.warn(`[OutboundSender] Reply with quoted failed (${err.message}), retrying direct text...`);
          try {
            const payload: any = { text };
            if (mentions && mentions.length > 0) {
              payload.mentions = mentions;
            }
            const result = await currentSock.sendMessage(chatJid, payload);
            this.recordDispatchedId(result?.key?.id);
            chatLogger.logOutboundMessage(chatJid, text);
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
            const retryResult = await freshSock.sendMessage(chatJid, { text });
            chatLogger.logOutboundMessage(chatJid, text);
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
    quoted?: proto.IWebMessageInfo
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
      try {
        const res = await currentSock.sendMessage(
          chatJid,
          { sticker: buffer },
          safeQuoted ? { quoted: safeQuoted } : undefined
        );
        this.recordDispatchedId(res?.key?.id);
        return res;
      } catch (err: any) {
        console.warn(`[OutboundSender] sendSticker with quoted failed (${err.message}), retrying directly...`);
        try {
          const res = await currentSock.sendMessage(chatJid, { sticker: buffer });
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

    return antiBanEngine.scheduleDispatch(chatJid, async () => {
      try {
        const res = await sock.sendMessage(
          chatJid,
          { image: content, caption },
          { quoted: safeQuoted }
        );
        this.recordDispatchedId(res?.key?.id);
        return res;
      } catch (err: any) {
        if (safeQuoted) {
          console.warn(`[OutboundSender] sendImage with quoted failed (${err.message}), retrying directly...`);
          const res = await sock.sendMessage(chatJid, { image: content, caption });
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

    return antiBanEngine.scheduleDispatch(chatJid, async () => {
      try {
        return await sock.sendMessage(
          chatJid,
          {
            video: content,
            caption,
            mimetype: 'video/mp4',
          },
          { quoted: safeQuoted }
        );
      } catch (err: any) {
        if (safeQuoted) {
          console.warn(`[OutboundSender] sendVideo with quoted failed (${err.message}), retrying directly...`);
          return await sock.sendMessage(chatJid, {
            video: content,
            caption,
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
}
