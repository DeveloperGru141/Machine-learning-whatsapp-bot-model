import type { WASocket } from '@whiskeysockets/baileys';

/**
 * Registers a listener on the Baileys socket for group participant updates
 * and sends a friendly welcome message tagging new members upon joining.
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

      for (const participant of update.participants) {
        // Avoid welcoming the bot itself if it was just added to the group
        if (participant === botNumber || (botId && participant === botId)) {
          continue;
        }

        const rawNumber = participant.split('@')[0];
        const welcomeText = `Welcome to the group, @${rawNumber}! 🎉 Feel free to introduce yourself.`;

        await sock.sendMessage(groupJid, {
          text: welcomeText,
          mentions: [participant],
        });

        console.log(`[GroupWelcome] Welcomed @${rawNumber} to group ${groupJid}`);
      }
    } catch (err: any) {
      console.error('[GroupWelcome] Error sending welcome message:', err?.message || err);
    }
  });

  console.log('[GroupWelcome] Group welcome event listener registered.');
}
