import type { proto } from '@whiskeysockets/baileys';

export interface NormalizedMessage {
  chatJid: string;
  senderJid: string;
  senderName: string;
  isGroup: boolean;
  text: string;
  contentType: 'text' | 'sticker' | 'image' | 'audio';
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
  let contentType: 'text' | 'sticker' | 'image' | 'audio' = 'text';

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
