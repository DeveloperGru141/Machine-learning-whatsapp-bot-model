import type { WASocket } from '@whiskeysockets/baileys';
import { chatLogger } from '../../memory/chat-logger.js';
import { config } from '../../config/env.js';

/**
 * Registers a listener on the Baileys socket for group participant updates
 * and sends a friendly welcome message tagging new members upon joining,
 * or introduces the bot itself immediately when added to any group.
 *
 * @param sock Active Baileys WhatsApp socket instance
 */
export function setupGroupWelcome(sock: WASocket): void {
  sock.ev.on('group-participants.update', async (update) => {
    try {
      // Only fire for 'add' events, NOT 'remove' (no goodbye messages per user request)
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

        // When the bot itself is added to a group, immediately greet the group and introduce itself
        if (isBotAdded) {
          console.log(`[GroupWelcome] 🚀 Bot added to group ${groupJid}! Greet and introduce self...`);
          const groupIntro = `Hi everyone! I'm ${config.bot.name}, built by Ademola (an aspiring ML/AI Engineer). Excited to be here! Tag me with @mention or reply to my messages if you need quick answers, live web searches, video downloads, or reminders.`;

          await sock.sendMessage(groupJid, { text: groupIntro });
          chatLogger.logOutboundMessage(groupJid, groupIntro);
          continue;
        }

        const rawNumber = participant.split('@')[0];
        const welcomeText = `Welcome to the group, @${rawNumber}! Glad to have you here.`;

        await sock.sendMessage(groupJid, {
          text: welcomeText,
          mentions: [participant],
        });
        chatLogger.logOutboundMessage(groupJid, welcomeText);

        console.log(`[GroupWelcome] Welcomed @${rawNumber} to group ${groupJid}`);
      }
    } catch (err: any) {
      console.error('[GroupWelcome] Error sending welcome message:', err?.message || err);
    }
  });

  console.log('[GroupWelcome] Group welcome event listener registered.');
}
