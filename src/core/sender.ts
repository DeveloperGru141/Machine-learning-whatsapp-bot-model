import type { WASocket, proto } from '@whiskeysockets/baileys';
import fs from 'fs';

export class OutboundSender {
  public static async replyText(
    sock: WASocket,
    chatJid: string,
    text: string,
    quoted?: proto.IWebMessageInfo
  ): Promise<any> {
    try {
      return await sock.sendMessage(chatJid, { text }, { quoted });
    } catch (err: any) {
      if (quoted) {
        console.warn(`[OutboundSender] Reply with quoted failed (${err.message}), retrying direct text...`);
        return await sock.sendMessage(chatJid, { text });
      }
      throw err;
    }
  }

  public static async sendSticker(
    sock: WASocket,
    chatJid: string,
    bufferOrPath: Buffer | string,
    quoted?: proto.IWebMessageInfo
  ): Promise<any> {
    const buffer = typeof bufferOrPath === 'string'
      ? fs.readFileSync(bufferOrPath)
      : bufferOrPath;

    return await sock.sendMessage(
      chatJid,
      { sticker: buffer },
      { quoted }
    );
  }

  public static async sendImage(
    sock: WASocket,
    chatJid: string,
    bufferOrUrl: Buffer | string,
    caption?: string,
    quoted?: proto.IWebMessageInfo
  ): Promise<any> {
    const content = Buffer.isBuffer(bufferOrUrl)
      ? bufferOrUrl
      : { url: bufferOrUrl };

    try {
      return await sock.sendMessage(
        chatJid,
        { image: content, caption },
        { quoted }
      );
    } catch (err: any) {
      if (quoted) {
        console.warn(`[OutboundSender] sendImage with quoted failed (${err.message}), retrying directly...`);
        return await sock.sendMessage(chatJid, { image: content, caption });
      }
      throw err;
    }
  }

  public static async sendAudio(
    sock: WASocket,
    chatJid: string,
    bufferOrUrl: Buffer | string,
    isVoiceNote: boolean = false,
    quoted?: proto.IWebMessageInfo
  ): Promise<any> {
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

    try {
      return await sock.sendMessage(
        chatJid,
        {
          audio: content,
          mimetype,
          ptt: isVoiceNote,
        },
        { quoted }
      );
    } catch (err: any) {
      if (quoted) {
        console.warn(`[OutboundSender] sendAudio with quoted failed (${err.message}), retrying directly...`);
        return await sock.sendMessage(chatJid, {
          audio: content,
          mimetype,
          ptt: isVoiceNote,
        });
      }
      throw err;
    }
  }

  public static async sendVideo(
    sock: WASocket,
    chatJid: string,
    bufferOrUrl: Buffer | string,
    caption?: string,
    quoted?: proto.IWebMessageInfo
  ): Promise<any> {
    const content = Buffer.isBuffer(bufferOrUrl)
      ? bufferOrUrl
      : { url: bufferOrUrl };

    try {
      return await sock.sendMessage(
        chatJid,
        {
          video: content,
          caption,
          mimetype: 'video/mp4',
        },
        { quoted }
      );
    } catch (err: any) {
      if (quoted) {
        console.warn(`[OutboundSender] sendVideo with quoted failed (${err.message}), retrying directly...`);
        return await sock.sendMessage(chatJid, {
          video: content,
          caption,
          mimetype: 'video/mp4',
        });
      }
      throw err;
    }
  }

  public static async sendContact(
    sock: WASocket,
    chatJid: string,
    displayName: string,
    phoneNumber: string,
    quoted?: proto.IWebMessageInfo
  ): Promise<any> {
    const cleanNumber = phoneNumber.replace(/[^0-9]/g, '');
    const vcard =
      'BEGIN:VCARD\n' +
      'VERSION:3.0\n' +
      `FN:${displayName}\n` +
      `TEL;type=CELL;type=VOICE;waid=${cleanNumber}:+${cleanNumber}\n` +
      'END:VCARD';

    return await sock.sendMessage(
      chatJid,
      {
        contacts: {
          displayName,
          contacts: [{ vcard }],
        },
      },
      { quoted }
    );
  }
}

