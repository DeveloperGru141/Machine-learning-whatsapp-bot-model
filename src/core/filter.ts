import type { proto } from '@whiskeysockets/baileys';
import { unwrapMessage } from './normalizer.js';
import { config } from '../config/env.js';
import { db } from '../memory/db.js';

export interface TriggerCheckResult {
  shouldRespond: boolean;
  cleanedText: string;
  isOpportunisticChipIn?: boolean;
}

interface GroupChipInState {
  lastSpokeTimestamp: number;
  messageCountSinceSpoke: number;
}

const groupChipInStates = new Map<string, GroupChipInState>();

/**
 * Resets the group chip-in tracker whenever the bot speaks in a group
 */
export function recordGroupInteraction(groupJid: string): void {
  const state = groupChipInStates.get(groupJid) || {
    lastSpokeTimestamp: 0,
    messageCountSinceSpoke: 0,
  };
  state.lastSpokeTimestamp = Date.now();
  state.messageCountSinceSpoke = 0;
  groupChipInStates.set(groupJid, state);
}

export function shouldRespondToMessage(
  msg: proto.IWebMessageInfo,
  botJid: string,
  rawText: string,
  botLid?: string
): TriggerCheckResult {
  const isGroup = msg.key.remoteJid?.endsWith('@g.us') || false;

  // Never respond to our own outbound messages UNLESS it is "Message Yourself" (owner testing the bot on the bot's phone)
  const cleanRemote = (msg.key.remoteJid || '').split('@')[0].split(':')[0];
  const botOwnDigits = (botJid || '').split('@')[0].split(':')[0] || '2347058967815';
  const cleanLidId = (botLid || '').split(':')[0].split('@')[0];
  const pairingDigits = (config.bot.pairingPhoneNumber || '').replace(/[^0-9]/g, '');

  const isSelfChatJid = (jid?: string | null): boolean => {
    if (!jid) return false;
    const clean = jid.split('@')[0].split(':')[0];
    return (
      clean === botOwnDigits ||
      clean === '2347058967815' ||
      clean === '83954564632610' ||
      (Boolean(cleanLidId) && clean === cleanLidId) ||
      (Boolean(pairingDigits) && clean === pairingDigits)
    );
  };

  const destJid = (msg.message as any)?.deviceSentMessage?.destinationJid;
  const isMessageToSelf =
    Boolean(msg.key.fromMe) &&
    !isGroup &&
    isSelfChatJid(msg.key.remoteJid) &&
    (!destJid || isSelfChatJid(destJid));

  if (msg.key.fromMe && !isMessageToSelf) {
    return { shouldRespond: false, cleanedText: rawText };
  }

  const groupJid = msg.key.remoteJid || '';

  // Direct Messages (DMs): Always respond
  if (!isGroup) {
    return { shouldRespond: true, cleanedText: rawText.trim() };
  }

  if (isGroup && !groupChipInStates.has(groupJid)) {
    groupChipInStates.set(groupJid, {
      lastSpokeTimestamp: Date.now() - 3 * 60 * 1000,
      messageCountSinceSpoke: 0,
    });
  }

  // Normalize bot identifiers across standard phone number and LID formats
  const cleanPhoneId = (botJid || '').split(':')[0].split('@')[0];

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

  // Check 1: Was the bot @mentioned via WhatsApp protocol contextInfo?
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
  let isQuoted = isBotMatch(quotedParticipant);

  // Check 2b: Was the quoted stanza ID a message dispatched by the bot?
  if (!isQuoted && contextInfo?.stanzaId) {
    try {
      const found = db
        .prepare(`SELECT 1 FROM chat_logs WHERE message_id = ? AND sender_jid = 'bot' LIMIT 1`)
        .get(contextInfo.stanzaId);
      if (found) {
        isQuoted = true;
      }
    } catch {}
  }

  // Check 2c: In groups, if someone replies with a sticker right after the bot spoke (<90s), match their energy!
  const isSticker = Boolean(m?.stickerMessage || msg.message?.stickerMessage);
  if (isSticker && isGroup && !isQuoted) {
    try {
      const lastBotMsg = db
        .prepare(`SELECT timestamp FROM chat_logs WHERE chat_jid = ? AND sender_jid = 'bot' ORDER BY id DESC LIMIT 1`)
        .get(groupJid) as { timestamp: number } | undefined;
      if (lastBotMsg && Date.now() - Number(lastBotMsg.timestamp) < 90_000) {
        console.log(`[Filter] 🎯 Sticker reply detected following recent bot message in group ${groupJid}`);
        recordGroupInteraction(groupJid);
        return { shouldRespond: true, cleanedText: '' };
      }
    } catch {}
  }

  // Check 3: Was the bot called by name or phone number in text?
  const textLower = (rawText || '').toLowerCase().trim();
  const botConfigName = (config.bot.name || 'forgelabs').toLowerCase();
  const cleanPhoneDigits = cleanPhoneId || '2347058967815';
  const cleanLidDigits = cleanLidId || '83954564632610';

  const textTriggerRegex = new RegExp(
    `(^|\\s|@)(${botConfigName}|forgelabs|assistant|bot|${cleanPhoneDigits}|${pairingDigits || '07058967815'}|${cleanLidDigits})\\b`,
    'i'
  );
  const isNameCalled = textTriggerRegex.test(textLower);

  // Check 3b: Explicit bot command (e.g. .status, !ping, .help, /ask, .meme, .rvo)
  const trimmed = (rawText || '').trim();
  const isExplicitCommand = /^[!/.#$][a-zA-Z0-9_-]{2,}/.test(trimmed);

  if (isMentioned || isQuoted || isNameCalled || isExplicitCommand) {
    if (isGroup) {
      recordGroupInteraction(groupJid);
    }
    // Remove the @bot mention tag and name callout from the text for cleaner LLM reasoning
    let cleaned = rawText;
    for (const jid of mentionedJidList) {
      const num = jid.split('@')[0];
      cleaned = cleaned.replace(new RegExp(`@${num}`, 'g'), '').trim();
    }
    cleaned = cleaned
      .replace(new RegExp(`^@?(${botConfigName}|forgelabs|bot)[:,-]?\\s*`, 'i'), '')
      .replace(new RegExp(`@(${botConfigName}|forgelabs|bot|${cleanPhoneDigits}|${pairingDigits}|${cleanLidDigits})`, 'gi'), '')
      .trim();

    return { shouldRespond: true, cleanedText: cleaned || rawText.trim() };
  }

  // In groups: Opportunistic conversation chip-in once in a while even when not directly called
  if (isGroup) {
    const state = groupChipInStates.get(groupJid)!;
    state.messageCountSinceSpoke++;

    const now = Date.now();
    const timeSinceLastSpokeMs = now - state.lastSpokeTimestamp;
    const cooldownMs = 4 * 60 * 1000; // Minimum 4 minutes cooldown between unsolicited chip-ins
    const minMessages = 6; // At least 6 messages sent in the group since last interaction

    const trimmed = (rawText || '').trim();
    const isCommand = /^[!/.#$]/.test(trimmed);
    const isUrl = /^https?:\/\//i.test(trimmed);
    const isLengthOk = trimmed.length >= 14 && trimmed.length <= 400;

    const conversationalRegex =
      /[?]|(\b(who|wetin|why|how|anyone|somebody|what do you think|opinion|crypto|btc|eth|tech|ai|coding|code|bug|job|remote|lagos|nigeria|chelsea|arsenal|man utd|football|ball|food|rice|jollof|price|dollar|naira|election|music|burna|wizkid|davido|asake|wahala|gist|omo)\b)/i;

    const isEngaging = conversationalRegex.test(trimmed);

    if (
      timeSinceLastSpokeMs >= cooldownMs &&
      state.messageCountSinceSpoke >= minMessages &&
      isLengthOk &&
      !isCommand &&
      !isUrl &&
      isEngaging
    ) {
      // Probabilistic trigger for natural human cadence (35% chance when criteria are met)
      if (Math.random() < 0.35) {
        console.log(`[Filter] 💡 Opportunistic group conversation chip-in triggered for ${groupJid}: "${trimmed.slice(0, 50)}..."`);
        recordGroupInteraction(groupJid);
        return {
          shouldRespond: true,
          cleanedText: trimmed,
          isOpportunisticChipIn: true,
        };
      }
    }
  }

  // In groups, if conditions not met, do not reply (passive observation only)
  return { shouldRespond: false, cleanedText: rawText };
}
