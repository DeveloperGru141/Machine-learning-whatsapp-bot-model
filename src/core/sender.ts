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
}
