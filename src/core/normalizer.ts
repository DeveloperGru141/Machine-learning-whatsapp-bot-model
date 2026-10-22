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

export function normalizeMessage(msg: proto.IWebMessageInfo): NormalizedMessage | null {
  if (!msg.message || !msg.key.remoteJid) return null;

  let chatJid = msg.key.remoteJid;
  const isGroup = chatJid.endsWith('@g.us');
  let senderJid = isGroup ? (msg.key.participant || chatJid) : chatJid;

  // Resolve @lid to canonical phone number JID (@s.whatsapp.net) for seamless message delivery and primary device thread sync
  if (!isGroup && chatJid.endsWith('@lid')) {
    const rawId = chatJid.split('@')[0].split(':')[0];
    if (rawId === '102409552584830') {
      chatJid = '2348108574293@s.whatsapp.net';
      senderJid = '2348108574293@s.whatsapp.net';
    } else if ((msg.key as any).senderPn) {
      chatJid = (msg.key as any).senderPn;
      senderJid = (msg.key as any).senderPn;
    }
  } else if (isGroup && senderJid.endsWith('@lid')) {
    const rawId = senderJid.split('@')[0].split(':')[0];
    if (rawId === '102409552584830') {
      senderJid = '2348108574293@s.whatsapp.net';
    } else if ((msg.key as any).participantPn) {
      senderJid = (msg.key as any).participantPn;
    }
  }

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
    senderJid,
    senderName,
    isGroup,
    text: text.trim(),
    contentType,
    raw: msg,
  };
}
