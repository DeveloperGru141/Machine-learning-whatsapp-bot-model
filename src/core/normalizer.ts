import { extractMessageContent, type WAMessage, type proto } from '@whiskeysockets/baileys';

export interface NormalizedMessage {
  chatJid: string;
  replyChatJid: string;
  senderJid: string;
  senderName: string;
  isGroup: boolean;
  text: string;
  contentType: 'text' | 'sticker' | 'image' | 'audio' | 'document' | 'video';
  stickerFilename?: string;
  raw: WAMessage;
}

/**
 * Recursively unwraps WhatsApp message wrappers (ephemeral, viewOnce, documentWithCaption, etc.)
 */
export function unwrapMessage(msg: proto.IMessage | undefined | null): proto.IMessage | undefined | null {
  if (!msg) return null;
  let m: any = extractMessageContent(msg) || msg;

  // Recursively peel wrappers
  while (
    m?.ephemeralMessage?.message ||
    m?.viewOnceMessage?.message ||
    m?.viewOnceMessageV2?.message ||
    m?.viewOnceMessageV2Extension?.message ||
    m?.documentWithCaptionMessage?.message ||
    m?.protocolMessage?.editedMessage
  ) {
    const next =
      m.ephemeralMessage?.message ||
      m.viewOnceMessage?.message ||
      m.viewOnceMessageV2?.message ||
      m.viewOnceMessageV2Extension?.message ||
      m.documentWithCaptionMessage?.message ||
      m.protocolMessage?.editedMessage;
    m = extractMessageContent(next) || next;
  }

  return m;
}

export function normalizeMessage(msg: WAMessage): NormalizedMessage | null {
  if (!msg.message || !msg.key.remoteJid) return null;

  const chatJid = msg.key.remoteJid;
  const isGroup = chatJid.endsWith('@g.us');
  // Prefer the phone-number address for outbound replies to LID DMs when available.
  const replyChatJid = !isGroup && chatJid.endsWith('@lid') && msg.key.remoteJidAlt?.endsWith('@s.whatsapp.net')
    ? msg.key.remoteJidAlt
    : chatJid;
  const senderJid = isGroup ? (msg.key.participant || chatJid) : chatJid;
  const rawId = senderJid.split('@')[0].split(':')[0];
  const isLid = senderJid.endsWith('@lid') || rawId.length > 13;
  const fallbackName = isLid ? (isGroup ? 'Member' : 'Friend') : rawId;
  const senderName = (msg.pushName && msg.pushName.trim()) ? msg.pushName.trim() : fallbackName;

  let text = '';
  let contentType: 'text' | 'sticker' | 'image' | 'audio' | 'document' | 'video' = 'text';

  const m: any = unwrapMessage(msg.message);
  if (!m) return null;

  // Ignore reactions, protocol updates, polls without text, and status broadcasts
  if (m.reactionMessage || m.protocolMessage || m.pollUpdateMessage) {
    return null;
  }

  let hasContent = false;

  if (m.conversation) {
    text = m.conversation;
    hasContent = true;
  } else if (m.extendedTextMessage?.text) {
    text = m.extendedTextMessage.text;
    hasContent = true;
  } else if (m.imageMessage?.caption) {
    text = m.imageMessage.caption;
    contentType = 'image';
    hasContent = true;
  } else if (m.imageMessage) {
    contentType = 'image';
    hasContent = true;
  } else if (m.stickerMessage) {
    contentType = 'sticker';
    hasContent = true;
  } else if (m.audioMessage) {
    contentType = 'audio';
    hasContent = true;
  } else if (m.videoMessage?.caption) {
    text = m.videoMessage.caption;
    contentType = 'video';
    hasContent = true;
  } else if (m.videoMessage) {
    contentType = 'video';
    hasContent = true;
  } else if (m.documentMessage?.caption) {
    text = m.documentMessage.caption;
    contentType = 'document';
    hasContent = true;
  } else if (m.documentMessage) {
    text = m.documentMessage.fileName || '[Document]';
    contentType = 'document';
    hasContent = true;
  } else if (m.interactiveResponseMessage?.body?.text) {
    text = m.interactiveResponseMessage.body.text;
    hasContent = true;
  } else if (m.buttonsResponseMessage?.selectedButtonId) {
    text = m.buttonsResponseMessage.selectedButtonId;
    hasContent = true;
  } else if (m.templateButtonReplyMessage?.selectedId) {
    text = m.templateButtonReplyMessage.selectedId;
    hasContent = true;
  } else if (m.contactMessage?.displayName) {
    text = `[Contact: ${m.contactMessage.displayName}]`;
    hasContent = true;
  } else if (m.locationMessage) {
    text = `[Location: ${m.locationMessage.name || m.locationMessage.address || 'Shared Location'}]`;
    hasContent = true;
  }

  if (!hasContent) {
    return null;
  }

  return {
    chatJid,
    replyChatJid,
    senderJid,
    senderName,
    isGroup,
    text: text.trim(),
    contentType,
    raw: msg,
  };
}
