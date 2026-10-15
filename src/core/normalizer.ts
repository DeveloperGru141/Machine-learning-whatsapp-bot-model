import { extractMessageContent, type proto } from '@whiskeysockets/baileys';

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

/**
 * Recursively unwraps WhatsApp message wrappers (ephemeral, viewOnce, documentWithCaption, etc.)
 */
function unwrapMessage(msg: proto.IMessage | undefined | null): proto.IMessage | undefined | null {
  if (!msg) return null;
  let m: any = extractMessageContent(msg) || msg;

  // Recursively peel wrappers
  while (
    m?.ephemeralMessage?.message ||
    m?.viewOnceMessage?.message ||
    m?.viewOnceMessageV2?.message ||
    m?.documentWithCaptionMessage?.message ||
    m?.protocolMessage?.editedMessage
  ) {
    const next =
      m.ephemeralMessage?.message ||
      m.viewOnceMessage?.message ||
      m.viewOnceMessageV2?.message ||
      m.documentWithCaptionMessage?.message ||
      m.protocolMessage?.editedMessage;
    m = extractMessageContent(next) || next;
  }

  return m;
}

export function normalizeMessage(msg: proto.IWebMessageInfo): NormalizedMessage | null {
  if (!msg.message || !msg.key.remoteJid) return null;

  const chatJid = msg.key.remoteJid;
  const isGroup = chatJid.endsWith('@g.us');
  const senderJid = isGroup ? (msg.key.participant || chatJid) : chatJid;
  const senderName = msg.pushName || senderJid.split('@')[0];

  let text = '';
  let contentType: 'text' | 'sticker' | 'image' | 'audio' | 'document' | 'video' = 'text';

  const m: any = unwrapMessage(msg.message);
  if (!m) return null;

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
  } else if (m.interactiveResponseMessage?.body?.text) {
    text = m.interactiveResponseMessage.body.text;
  } else if (m.buttonsResponseMessage?.selectedButtonId) {
    text = m.buttonsResponseMessage.selectedButtonId;
  } else if (m.templateButtonReplyMessage?.selectedId) {
    text = m.templateButtonReplyMessage.selectedId;
  }

  return {
    chatJid,
    senderJid,
    senderName,
    isGroup,
    text: text.trim(),
    contentType,
    raw: msg,
  };
}
