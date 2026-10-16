import type { proto } from '@whiskeysockets/baileys';
import { unwrapMessage } from './normalizer.js';

export interface TriggerCheckResult {
  shouldRespond: boolean;
  cleanedText: string;
}

export function shouldRespondToMessage(
  msg: proto.IWebMessageInfo,
  botJid: string,
  rawText: string,
  botLid?: string
): TriggerCheckResult {
  // Never respond to our own outbound messages
  if (msg.key.fromMe) {
    return { shouldRespond: false, cleanedText: rawText };
  }

  const isGroup = msg.key.remoteJid?.endsWith('@g.us') || false;

  // Direct Messages (DMs): Always respond
  if (!isGroup) {
    return { shouldRespond: true, cleanedText: rawText.trim() };
  }

  // Normalize bot identifiers across standard phone number and LID formats
  const cleanPhoneId = (botJid || '').split(':')[0].split('@')[0];
  const cleanLidId = (botLid || '').split(':')[0].split('@')[0];

  const botPhoneStandard = cleanPhoneId ? `${cleanPhoneId}@s.whatsapp.net` : '';
  const botPhoneLid = cleanPhoneId ? `${cleanPhoneId}@lid` : '';
  const botLidStandard = cleanLidId ? `${cleanLidId}@lid` : '';

  const isBotMatch = (jid?: string | null): boolean => {
    if (!jid) return false;
    const cleanTarget = jid.split(':')[0];
    const targetId = cleanTarget.split('@')[0];

    if (botJid && cleanTarget === botJid.split(':')[0]) return true;
    if (botLid && cleanTarget === botLid.split(':')[0]) return true;
    if (botPhoneStandard && cleanTarget === botPhoneStandard) return true;
    if (botPhoneLid && cleanTarget === botPhoneLid) return true;
    if (botLidStandard && cleanTarget === botLidStandard) return true;

    if (cleanPhoneId && (targetId === cleanPhoneId || cleanTarget.startsWith(`${cleanPhoneId}@`))) return true;
    if (cleanLidId && (targetId === cleanLidId || cleanTarget.startsWith(`${cleanLidId}@`))) return true;

    return false;
  };

  // Unwrap any ephemeral / viewOnce / documentWithCaption wrapper so group mentions & quotes work in all group types
  const m: any = unwrapMessage(msg.message) || msg.message;

  // Check 1: Was the bot @mentioned?
  const contextInfo =
    m?.extendedTextMessage?.contextInfo ||
    m?.imageMessage?.contextInfo ||
    m?.videoMessage?.contextInfo ||
    m?.documentMessage?.contextInfo ||
    m?.audioMessage?.contextInfo ||
    m?.stickerMessage?.contextInfo ||
    msg.message?.extendedTextMessage?.contextInfo ||
    msg.message?.imageMessage?.contextInfo ||
    msg.message?.videoMessage?.contextInfo;

  const mentionedJidList: string[] = contextInfo?.mentionedJid || [];
  const isMentioned = mentionedJidList.some((jid: string) => isBotMatch(jid));

  // Check 2: Was a message sent by the bot quoted / replied to?
  const quotedParticipant = contextInfo?.participant;
  const isQuoted = isBotMatch(quotedParticipant);

  if (isMentioned || isQuoted) {
    // Remove the @bot mention tag from the text for cleaner LLM reasoning
    let cleaned = rawText;
    for (const jid of mentionedJidList) {
      const num = jid.split('@')[0];
      cleaned = cleaned.replace(new RegExp(`@${num}`, 'g'), '').trim();
    }
    return { shouldRespond: true, cleanedText: cleaned };
  }

  // In groups, if neither tagged nor quoted, do not reply (passive observation only)
  return { shouldRespond: false, cleanedText: rawText };
}
