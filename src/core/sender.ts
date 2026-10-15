import type { WASocket, proto } from '@whiskeysockets/baileys';
import fs from 'fs';

export class OutboundSender {
  public static async replyText(
    sock: WASocket,
    chatJid: string,
    text: string,
    quoted?: proto.IWebMessageInfo
  ): Promise<any> {
    return await sock.sendMessage(chatJid, { text }, { quoted });
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

    return await sock.sendMessage(
      chatJid,
      { image: content, caption },
      { quoted }
    );
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

    return await sock.sendMessage(
      chatJid,
      {
        audio: content,
        mimetype: isVoiceNote ? 'audio/ogg; codecs=opus' : 'audio/mp4',
        ptt: isVoiceNote,
      },
      { quoted }
    );
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

    return await sock.sendMessage(
      chatJid,
      {
        video: content,
        caption,
        mimetype: 'video/mp4',
      },
      { quoted }
    );
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

