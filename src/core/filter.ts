import type { proto } from '@whiskeysockets/baileys';

export interface TriggerCheckResult {
  shouldRespond: boolean;
  cleanedText: string;
}

export function shouldRespondToMessage(
  msg: proto.IWebMessageInfo,
  botJid: string,
  rawText: string
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

  // Normalize bot JID without device suffix (e.g. 12345678@s.whatsapp.net)
  const botNumber = botJid.split(':')[0] + '@s.whatsapp.net';

  // Check 1: Was the bot @mentioned?
  const contextInfo =
    msg.message?.extendedTextMessage?.contextInfo ||
    msg.message?.imageMessage?.contextInfo ||
    msg.message?.videoMessage?.contextInfo;

  const mentionedJidList = contextInfo?.mentionedJid || [];
  const isMentioned = mentionedJidList.some(
    (jid) => jid === botJid || jid === botNumber
  );

  // Check 2: Was a message sent by the bot quoted / replied to?
  const quotedParticipant = contextInfo?.participant;
  const isQuoted =
    quotedParticipant &&
    (quotedParticipant === botJid || quotedParticipant === botNumber);

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
