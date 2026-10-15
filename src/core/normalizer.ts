import type { proto } from '@whiskeysockets/baileys';

export interface NormalizedMessage {
  chatJid: string;
  senderJid: string;
  senderName: string;
  isGroup: boolean;
  text: string;
  contentType: 'text' | 'sticker' | 'image' | 'audio' | 'document' | 'video';
  stickerFilename?: string;
  raw: proto.IWebMessageInfo;
}

export function normalizeMessage(msg: proto.IWebMessageInfo): NormalizedMessage | null {
  if (!msg.message || !msg.key.remoteJid) return null;

  const chatJid = msg.key.remoteJid;
  const isGroup = chatJid.endsWith('@g.us');
  const senderJid = isGroup ? (msg.key.participant || chatJid) : chatJid;
  const senderName = msg.pushName || senderJid.split('@')[0];

  let text = '';
  let contentType: 'text' | 'sticker' | 'image' | 'audio' | 'document' | 'video' = 'text';

  const m = msg.message;
  if (m.conversation) {
    text = m.conversation;
  } else if (m.extendedTextMessage?.text) {
    text = m.extendedTextMessage.text;
  } else if (m.imageMessage?.caption) {
    text = m.imageMessage.caption;
    contentType = 'image';
  } else if (m.imageMessage) {
    contentType = 'image';
  } else if (m.stickerMessage) {
    contentType = 'sticker';
  } else if (m.audioMessage) {
    contentType = 'audio';
  } else if (m.videoMessage?.caption) {
    text = m.videoMessage.caption;
    contentType = 'video';
  } else if (m.videoMessage) {
    contentType = 'video';
  } else if (m.documentMessage?.caption) {
    text = m.documentMessage.caption;
    contentType = 'document';
  } else if (m.documentMessage) {
    text = m.documentMessage.fileName || '[Document]';
    contentType = 'document';
  } else if (m.documentWithCaptionMessage?.message?.documentMessage?.caption) {
    text = m.documentWithCaptionMessage.message.documentMessage.caption;
    contentType = 'document';
  } else if (m.documentWithCaptionMessage?.message?.documentMessage) {
    text = m.documentWithCaptionMessage.message.documentMessage.fileName || '[Document]';
    contentType = 'document';
  }

  return {
    chatJid,
    senderJid,
    senderName,
    isGroup,
    text,
    contentType,
    raw: msg,
  };
}
