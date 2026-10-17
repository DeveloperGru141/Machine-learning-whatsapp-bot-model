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
      // Only fire for 'add' events
      if (update.action !== 'add') return;

      const groupJid = update.id;
      const botId = sock.user?.id || '';
      const botNumber = botId.split(':')[0] + '@s.whatsapp.net';
      const botLid = sock.user?.lid || '';
      const botLidNormalized = botLid ? botLid.split(':')[0] + '@lid' : '';

      for (const participant of update.participants) {
        const isBotAdded =
          participant === botNumber ||
          (botId && participant === botId) ||
          (botLid && participant === botLid) ||
          (botLidNormalized && participant === botLidNormalized);

        // When the bot itself is added to a group, send the polished introduction
        if (isBotAdded) {
          console.log(`[GroupWelcome] 🚀 Bot added to group ${groupJid}! Introducing self with polished welcome message...`);
          await sock.sendMessage(groupJid, { text: BOT_GROUP_INTRO });
          chatLogger.logOutboundMessage(groupJid, BOT_GROUP_INTRO);
          break;
        }

        // Anti-Ban & User Policy: Do not unsolicitedly text or tag individual joining members.
        // The bot only speaks when someone explicitly texts or tags the bot.
      }
    } catch (err: any) {
      console.error('[GroupWelcome] Error in group-participants.update handler:', err?.message || err);
    }
  });

  console.log('[GroupWelcome] Group welcome event listener registered.');
}
