import type { WASocket } from '@whiskeysockets/baileys';
import { chatLogger } from '../../memory/chat-logger.js';
import { BOT_GROUP_INTRO } from '../../security/anti-ban.js';
import { upsertKnownGroup, setGroupAdminStatus } from '../../memory/db.js';

/**
 * Registers a listener on the Baileys socket for group participant updates.
 * Strictly adheres to Anti-Ban Policy:
 * - Introduces the bot ONCE when the bot itself is added to a group.
 * - Synchronizes elevated admin privileges in database when promoted/demoted.
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

      const isBotTargeted = (participant: (typeof update.participants)[number]) => {
        const p = participant.id;
        return p === botNumber ||
          (botId && p === botId) ||
          (botLid && p === botLid) ||
          (botLidNormalized && p === botLidNormalized);
      };

      // 1. When the bot is added to a group, send the introduction and sync group in database
      if (update.action === 'add') {
        const isBotAdded = update.participants.some(isBotTargeted);
        if (isBotAdded) {
          console.log(`[GroupWelcome] 🚀 Bot added to group ${groupJid}! Introducing self with polished welcome message...`);
          let groupTitle = 'the group';
          let memberCount = 0;
          let isAdmin = false;
          try {
            const meta = await sock.groupMetadata(groupJid);
            groupTitle = meta.subject || groupTitle;
            memberCount = meta.participants?.length || 0;
            isAdmin = meta.participants?.some(
              (p: any) => isBotTargeted(p.id) && (p.admin === 'admin' || p.admin === 'superadmin')
            ) || false;
          } catch {}

          await upsertKnownGroup(groupJid, groupTitle, memberCount, isAdmin);
          await sock.sendMessage(groupJid, { text: BOT_GROUP_INTRO });
          await chatLogger.logOutboundMessage(groupJid, BOT_GROUP_INTRO);
        }
      }

      // 2. When the bot is promoted to Admin, announce elevated admin privileges & persist status
      if (update.action === 'promote') {
        const isBotPromoted = update.participants.some(isBotTargeted);
        if (isBotPromoted) {
          console.log(`[GroupWelcome] 🛡️ Bot PROMOTED to Admin in group ${groupJid}! Elevated admin capabilities activated.`);

          let groupTitle = 'this group';
          let memberCount = 0;
          try {
            const meta = await sock.groupMetadata(groupJid);
            groupTitle = meta.subject || groupTitle;
            memberCount = meta.participants?.length || 0;
            await upsertKnownGroup(groupJid, groupTitle, memberCount, true);
          } catch {
            await setGroupAdminStatus(groupJid, true);
          }

          const adminNotice =
            '🛡️ *Elevated Group Admin Privileges Active!*\n\n' +
            `Thank you for making me an admin in *${groupTitle}*! I now have full elevated admin capabilities:\n\n` +
            '• 🚫 *Remove bad actors & spammers* (`kick_member`)\n' +
            '• ➕ *Add new participants* (`add_member`)\n' +
            '• 🗑️ *Delete spam or offensive messages for everyone* (`delete_group_message`)\n' +
            '• 🔒 *Lock or unlock group chat* (`set_group_mode` - announcement mode)\n' +
            '• ⚙️ *Lock group settings* (`set_group_mode` - admin-only edits)\n' +
            '• 🛡️ *Promote & demote group admins* (`promote_member`, `demote_member`)\n' +
            '• 🏷️ *Update group name & description* (`set_group_subject`, `set_group_description`)\n' +
            '• 🔗 *Retrieve or reset invite link* (`get_group_invite_link`, `revoke_group_invite_link`)\n' +
            '• ⏳ *Configure disappearing messages* (`set_disappearing_messages`)\n' +
            '• 📋 *Approve/reject pending join requests* (`approve_join_request`, `reject_join_request`)\n' +
            '• 📢 *Tag all members with announcements* (`tag_all`)\n\n' +
            'Tag me with *@Forgelabs* anytime you need an admin action handled sharp sharp! 🫡';

          await sock.sendMessage(groupJid, { text: adminNotice });
          await chatLogger.logOutboundMessage(groupJid, adminNotice);
        }
      }

      // 3. When the bot is demoted, update database record
      if (update.action === 'demote') {
        const isBotDemoted = update.participants.some(isBotTargeted);
        if (isBotDemoted) {
          console.log(`[GroupWelcome] ℹ️ Bot DEMOTED from admin in group ${groupJid}.`);
          await setGroupAdminStatus(groupJid, false);
        }
      }
    } catch (err: any) {
      console.error('[GroupWelcome] Error in group-participants.update handler:', err?.message || err);
    }
  });

  console.log('[GroupWelcome] Group welcome event listener registered.');
}
