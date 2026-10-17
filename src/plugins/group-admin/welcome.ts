import type { WASocket } from '@whiskeysockets/baileys';
import { chatLogger } from '../../memory/chat-logger.js';
import { BOT_GROUP_INTRO } from '../../security/anti-ban.js';

/**
 * Registers a listener on the Baileys socket for group participant updates.
 * Strictly adheres to Anti-Ban Policy:
 * - Introduces the bot ONCE when the bot itself is added to a group.
 * - Does NOT cold-message or welcome external participants joining groups
 *   (bot only responds when messaged or explicitly tagged).
 *
 * @param sock Active Baileys WhatsApp socket instance
 */
export function setupGroupWelcome(sock: WASocket): void {
  sock.ev.on('group-participants.update', async (update) => {
    try {
      const groupJid = update.id;
      const botId = sock.user?.id || '';
      const botNumber = botId.split(':')[0] + '@s.whatsapp.net';
      const botLid = sock.user?.lid || '';
      const botLidNormalized = botLid ? botLid.split(':')[0] + '@lid' : '';

      const isBotTargeted = (p: string) =>
        p === botNumber ||
        (botId && p === botId) ||
        (botLid && p === botLid) ||
        (botLidNormalized && p === botLidNormalized);

      // 1. When the bot is added to a group, send the introduction
      if (update.action === 'add') {
        const isBotAdded = update.participants.some(isBotTargeted);
        if (isBotAdded) {
          console.log(`[GroupWelcome] 🚀 Bot added to group ${groupJid}! Introducing self with polished welcome message...`);
          await sock.sendMessage(groupJid, { text: BOT_GROUP_INTRO });
          chatLogger.logOutboundMessage(groupJid, BOT_GROUP_INTRO);
        }
      }

      // 2. When the bot is promoted to Admin, announce elevated admin privileges
      if (update.action === 'promote') {
        const isBotPromoted = update.participants.some(isBotTargeted);
        if (isBotPromoted) {
          console.log(`[GroupWelcome] 🛡️ Bot PROMOTED to Admin in group ${groupJid}! Elevated admin capabilities activated.`);
          const adminNotice =
            '🛡️ *Elevated Group Admin Privileges Active!*\n\n' +
            'Thanks for making me an admin in this group! I can now help you moderate spam invite links, remove bad actors, lock/unlock the group, update group info, and tag members.\n\n' +
            'Tag me with *@Forgelabs* anytime you need admin actions sorted.';
          await sock.sendMessage(groupJid, { text: adminNotice });
          chatLogger.logOutboundMessage(groupJid, adminNotice);
        }
      }
    } catch (err: any) {
      console.error('[GroupWelcome] Error in group-participants.update handler:', err?.message || err);
    }
  });

  console.log('[GroupWelcome] Group welcome event listener registered.');
}
