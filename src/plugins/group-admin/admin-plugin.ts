import { IPlugin, BotTool, ExecutionContext, ToolResult } from '../types.js';
import { config } from '../../config/env.js';
import { userProfileManager } from '../../memory/user-profiles.js';
import { chatLogger } from '../../memory/chat-logger.js';
import { contactService } from '../../memory/contact-service.js';
import {
  db,
  logAutonomousAction,
  upsertKnownGroup,
  findKnownGroup,
  getAllKnownGroups,
  setGroupAdminStatus,
} from '../../memory/db.js';

export class GroupAdminPlugin implements IPlugin {
  name = 'GroupAdminSuite';
  version = '2.0.0';
  description = 'Group moderation and elevated administration suite active when the bot is an admin in a WhatsApp group';

  /**
   * Helper to verify if the bot itself has admin rights in the group.
   * Also synchronizes the live admin status to the known_groups database table.
   */
  public async isBotAdmin(sock: any, groupJid: string): Promise<boolean> {
    if (!groupJid || !groupJid.endsWith('@g.us') || !sock?.groupMetadata) return false;
    try {
      const meta = await sock.groupMetadata(groupJid);
      const botId = sock.user?.id || '';
      const botRawPhone =
        contactService.extractPhoneNumber(botId) || config.bot.pairingPhoneNumber || '';
      const botNumber = botRawPhone ? `${botRawPhone}@s.whatsapp.net` : '';
      const botLid = sock.user?.lid ? `${sock.user.lid.split(':')[0].split('@')[0]}@lid` : '';

      const botParticipant = meta.participants?.find((p: any) => {
        const pId = p.id ? `${p.id.split(':')[0].split('@')[0]}@${p.id.split('@')[1] || 's.whatsapp.net'}` : '';
        const pLid = p.lid ? `${p.lid.split(':')[0].split('@')[0]}@lid` : '';
        const pPhone = contactService.extractPhoneNumber(p.id || '');
        return (
          p.id === botId ||
          (botNumber && (pId === botNumber || p.id === botNumber)) ||
          (botRawPhone && pPhone === botRawPhone) ||
          (botLid && (pId === botLid || pLid === botLid || p.id === botLid))
        );
      });

      const isAdmin = botParticipant?.admin === 'admin' || botParticipant?.admin === 'superadmin';

      // Keep known_groups database table in sync with live status
      if (meta.subject) {
        upsertKnownGroup(groupJid, meta.subject, meta.participants?.length || 0, isAdmin);
      }

      return isAdmin;
    } catch {
      const cached = findKnownGroup(groupJid);
      return Boolean(cached && cached.is_admin);
    }
  }

  /**
   * Helper to verify if the requesting user is an admin or bot owner Ademola
   */
  public async isUserAdmin(sock: any, groupJid: string, senderJid: string): Promise<boolean> {
    if (userProfileManager.isOwner(senderJid)) return true;

    try {
      const meta = await sock.groupMetadata(groupJid);
      const senderPhone = contactService.extractPhoneNumber(senderJid);
      const normSender = `${senderJid.split(':')[0].split('@')[0]}@${senderJid.split('@')[1] || 's.whatsapp.net'}`;

      const user = meta.participants?.find((p: any) => {
        const pId = p.id ? `${p.id.split(':')[0].split('@')[0]}@${p.id.split('@')[1] || 's.whatsapp.net'}` : '';
        const pLid = p.lid ? `${p.lid.split(':')[0].split('@')[0]}@lid` : '';
        const pPhone = contactService.extractPhoneNumber(p.id || '');
        return (
          p.id === senderJid ||
          pId === normSender ||
          pLid === normSender ||
          (senderPhone && pPhone === senderPhone)
        );
      });
      return user?.admin === 'admin' || user?.admin === 'superadmin';
    } catch {
      return false;
    }
  }

  /**
   * Resolves a target participant in a group from WhatsApp natural flow:
   * 1. Check if the user tagged/mentioned someone (@user) in rawMessage
   * 2. Check if the user replied to/quoted someone's message
   * 3. Check if rawTarget has phone number digits
   * 4. Check if rawTarget matches any group participant's name or saved contact name
   * 5. Check address book for external contacts (e.g. for add_member)
   */
  public async resolveTargetUser(
    sock: any,
    groupJid: string,
    rawTarget?: string,
    rawMessage?: any
  ): Promise<{ jid?: string; cleanNumber?: string; error?: string }> {
    const contextInfo =
      rawMessage?.message?.extendedTextMessage?.contextInfo ||
      rawMessage?.message?.imageMessage?.contextInfo ||
      rawMessage?.message?.videoMessage?.contextInfo;

    const quotedParticipant = contextInfo?.participant;
    const mentionedJids: string[] = contextInfo?.mentionedJid || [];

    // If target was tagged with @mention in chat
    if (mentionedJids.length > 0) {
      const jid = mentionedJids[0];
      const cleanNumber = jid.split('@')[0].split(':')[0].replace(/[^0-9]/g, '');
      return { jid, cleanNumber };
    }

    // If target was replied to / quoted
    if (quotedParticipant) {
      const cleanNumber = quotedParticipant.split('@')[0].split(':')[0].replace(/[^0-9]/g, '');
      return { jid: quotedParticipant, cleanNumber };
    }

    const cleanInput = (rawTarget || '').trim();

    // If phone number digits provided (e.g. "+23480...", "080...", "234...")
    const digitsOnly = cleanInput.replace(/[^0-9]/g, '');
    if (digitsOnly.length >= 7 && digitsOnly.length <= 15) {
      let formatted = digitsOnly;
      if (formatted.startsWith('0') && formatted.length === 11) {
        formatted = '234' + formatted.slice(1);
      }
      return { jid: `${formatted}@s.whatsapp.net`, cleanNumber: formatted };
    }

    // If a name or keyword was given, match against group participants first
    try {
      if (sock?.groupMetadata && groupJid) {
        const meta = await sock.groupMetadata(groupJid);
        if (cleanInput) {
          const lower = cleanInput.toLowerCase().replace(/^@/, '');
          for (const p of meta.participants || []) {
            const num = p.id ? p.id.split('@')[0].split(':')[0].replace(/[^0-9]/g, '') : '';
            const saved = contactService.getContact(num || p.id);
            const name = (saved?.custom_name || saved?.display_name || '').toLowerCase();
            if (name.includes(lower) || (num && num.includes(lower))) {
              return { jid: p.id, cleanNumber: num };
            }
          }
        }
      }
    } catch {}

    // Fallback: Check contact address book for external contact (e.g. for add_member)
    if (cleanInput) {
      const savedContact = contactService.getContact(cleanInput);
      if (savedContact && savedContact.phone_number) {
        return {
          jid: `${savedContact.phone_number}@s.whatsapp.net`,
          cleanNumber: savedContact.phone_number,
        };
      }
    }

    return {
      error:
        'Please tag the member (@user), reply to their message, or state their phone number or contact name so I know who you mean.',
    };
  }

  /**
   * Passive Anti-Link moderation: Deletes unauthorized WhatsApp group invite links sent by non-admins
   */
  public async handleAntiLink(
    sock: any,
    msg: any,
    chatJid: string,
    senderJid: string,
    text: string
  ): Promise<boolean> {
    if (!chatJid.endsWith('@g.us')) return false;

    const linkRegex = /chat\.whatsapp\.com\/[0-9A-Za-z]{20,24}/i;
    if (!linkRegex.test(text)) return false;

    const botIsAdmin = await this.isBotAdmin(sock, chatJid);
    if (!botIsAdmin) return false;

    const userIsAdmin = await this.isUserAdmin(sock, chatJid, senderJid);
    if (userIsAdmin) return false; // Allow admins to post links

    try {
      // Actually revoke / delete the unauthorized link message for everyone
      if (msg?.key) {
        try {
          await sock.sendMessage(chatJid, { delete: msg.key });
        } catch (delErr: any) {
          console.warn('[GroupAdmin] Error deleting spam link:', delErr?.message);
        }
      }

      const rawUser = senderJid.split('@')[0].split(':')[0];
      const isLid = senderJid.endsWith('@lid') || rawUser.length > 13;
      const userTag = isLid ? 'Member' : `@${rawUser}`;

      await sock.sendMessage(chatJid, {
        text: `⚠️ ${userTag}, group invite links are not permitted here! Your message has been removed.`,
        mentions: [senderJid],
      });
      logAutonomousAction(
        'anti_link_moderation',
        chatJid,
        senderJid,
        'Autonomously deleted unauthorized group invite link'
      );
      return true;
    } catch (err: any) {
      console.error('[GroupAdmin] Failed to handle unauthorized link:', err.message);
      return false;
    }
  }

  tools: BotTool[] = [
    {
      name: 'list_joined_groups',
      description:
        'Lists all WhatsApp groups that the bot is currently a member of, along with their names, member counts, and whether the bot has elevated admin privileges.',
      parameters: {
        type: 'object',
        properties: {},
      },
      execute: async (_args: {}, ctx: ExecutionContext): Promise<ToolResult> => {
        try {
          if (!ctx.sock?.groupFetchAllParticipating) {
            return { success: false, message: 'Socket not available to fetch groups.' };
          }
          const groups = await ctx.sock.groupFetchAllParticipating();
          const list = Object.values(groups) as any[];
          if (list.length === 0) {
            return { success: true, message: 'I am not currently in any WhatsApp groups.' };
          }

          const botId = ctx.sock.user?.id || '';
          const botPhone = contactService.extractPhoneNumber(botId) || config.bot.pairingPhoneNumber || '';
          const formatted = list
            .map((g, i) => {
              const isAdmin = g.participants?.some(
                (p: any) =>
                  (p.admin === 'admin' || p.admin === 'superadmin') &&
                  (p.id === botId || (botPhone && contactService.extractPhoneNumber(p.id) === botPhone))
              );
              return `${i + 1}. *${g.subject}* (${g.participants?.length || 0} members${isAdmin ? ' - 🛡️ Admin' : ''})`;
            })
            .join('\n');

          return {
            success: true,
            message: `👥 *I dey inside ${list.length} group(s):*\n\n${formatted}`,
            data: list.map((g) => ({
              id: g.id,
              subject: g.subject,
              memberCount: g.participants?.length || 0,
            })),
          };
        } catch (err: any) {
          return { success: false, message: `Failed to fetch groups: ${err.message}` };
        }
      },
    },
    {
      name: 'get_group_info',
      description:
        'Retrieves comprehensive metadata and settings for the current WhatsApp group (or a specified group): subject, description, creation date, total members, list of all group admins, chat permissions, and whether the bot has admin privileges.',
      parameters: {
        type: 'object',
        properties: {
          group: {
            type: 'string',
            description: 'Optional group name or JID (defaults to the current group).',
          },
        },
      },
      execute: async (args: { group?: string }, ctx: ExecutionContext): Promise<ToolResult> => {
        let targetGroupJid = ctx.chatJid;
        if (args.group && args.group.trim()) {
          const found = findKnownGroup(args.group.trim());
          if (found) {
            targetGroupJid = found.group_jid;
          }
        }

        if (!targetGroupJid || !targetGroupJid.endsWith('@g.us')) {
          return { success: false, message: 'Please specify a group or run this inside a WhatsApp group.' };
        }

        try {
          const meta = await ctx.sock.groupMetadata(targetGroupJid);
          const totalMembers = meta.participants?.length || 0;
          const admins =
            meta.participants?.filter((p: any) => p.admin === 'admin' || p.admin === 'superadmin') || [];

          const botIsAdmin = await this.isBotAdmin(ctx.sock, targetGroupJid);

          const adminListStr = admins
            .map((a: any, idx: number) => {
              const num = a.id ? a.id.split('@')[0].split(':')[0] : '';
              const saved = contactService.getContact(num || a.id);
              const name = saved?.custom_name || saved?.display_name || (num ? `+${num}` : 'Admin');
              const badge = a.admin === 'superadmin' ? '👑 Creator/Superadmin' : '🛡️ Admin';
              return `${idx + 1}. *${name}* (${badge})`;
            })
            .join('\n');

          const isAnnouncement = meta.announce ? '🔒 Only Admins can message' : '🔓 All members can message';
          const isLockedSettings = meta.restrict ? '🔒 Only Admins can edit group info' : '🔓 All members can edit group info';
          const ephemeralDuration = meta.ephemeralDuration ? `${meta.ephemeralDuration / 86400} days` : 'Off';
          const createdDate = meta.creation ? new Date(meta.creation * 1000).toLocaleDateString() : 'Unknown';

          const summary =
            `📋 *GROUP DETAILS: ${meta.subject}*\n\n` +
            `• 👥 *Total Members:* ${totalMembers}\n` +
            `• 🛡️ *Bot Admin Status:* ${botIsAdmin ? '✅ ACTIVE ADMIN (Elevated Privileges)' : '❌ Regular Member'}\n` +
            `• 📅 *Created:* ${createdDate}\n` +
            `• 💬 *Messaging Mode:* ${isAnnouncement}\n` +
            `• ⚙️ *Settings Mode:* ${isLockedSettings}\n` +
            `• ⏳ *Disappearing Messages:* ${ephemeralDuration}\n` +
            (meta.desc ? `• 📝 *Description:* ${meta.desc}\n\n` : '\n') +
            `🛡️ *Group Admins (${admins.length}):*\n${adminListStr}`;

          return {
            success: true,
            message: summary,
            data: {
              subject: meta.subject,
              groupJid: targetGroupJid,
              memberCount: totalMembers,
              botIsAdmin,
              admins: admins.map((a: any) => ({ id: a.id, role: a.admin })),
            },
          };
        } catch (err: any) {
          return { success: false, message: `Failed to retrieve group metadata: ${err?.message || err}` };
        }
      },
    },
    {
      name: 'tag_all',
      description: 'Mentions/tags every member in the group with an announcement or summary. Requires admin authorization.',
      parameters: {
        type: 'object',
        properties: {
          announcement: {
            type: 'string',
            description: 'The announcement or message to deliver to everyone.',
          },
        },
        required: ['announcement'],
      },
      execute: async (args: { announcement: string }, ctx: ExecutionContext): Promise<ToolResult> => {
        if (!ctx.isGroup) {
          return { success: false, message: 'This tool can only be used inside a WhatsApp group.' };
        }

        const isAdmin = await this.isUserAdmin(ctx.sock, ctx.chatJid, ctx.senderJid);
        if (!isAdmin) {
          return { success: false, message: 'Only group admins or bot owner Ademola can use @everyone / tag_all.' };
        }

        try {
          const meta = await ctx.sock.groupMetadata(ctx.chatJid);
          const mentions = meta.participants.map((p: any) => p.id);
          const fullText = `📢 *GROUP ANNOUNCEMENT*\n\n${args.announcement.trim()}\n\n_Attention: @everyone (${mentions.length} members)_`;

          await ctx.sock.sendMessage(ctx.chatJid, {
            text: fullText,
            mentions,
          });
          chatLogger.logOutboundMessage(ctx.chatJid, fullText);

          return { success: true, message: `Successfully tagged ${mentions.length} members with the announcement.` };
        } catch (err: any) {
          return { success: false, message: `Failed to tag members: ${err.message}` };
        }
      },
    },
    {
      name: 'kick_member',
      description:
        'Removes/kicks a member from the group. The member can be specified by contact name, phone number, @tag, or by replying to/quoting their message. Requires elevated bot admin privileges.',
      parameters: {
        type: 'object',
        properties: {
          target: {
            type: 'string',
            description: 'Phone number, contact name, or @tag of the member to remove.',
          },
          reason: {
            type: 'string',
            description: 'Reason for removal.',
          },
        },
      },
      execute: async (
        args: { target?: string; phone_number?: string; reason?: string },
        ctx: ExecutionContext
      ): Promise<ToolResult> => {
        if (!ctx.isGroup) {
          return { success: false, message: 'This tool is only available in groups.' };
        }

        const botIsAdmin = await this.isBotAdmin(ctx.sock, ctx.chatJid);
        if (!botIsAdmin) {
          return {
            success: false,
            message: 'Action failed: I must be granted admin privileges in this group to remove members.',
          };
        }

        const senderIsAdmin = await this.isUserAdmin(ctx.sock, ctx.chatJid, ctx.senderJid);
        if (!senderIsAdmin) {
          return {
            success: false,
            message: 'Permission denied: Only group admins or bot owner Ademola can request to remove members.',
          };
        }

        const resolved = await this.resolveTargetUser(
          ctx.sock,
          ctx.chatJid,
          args.target || args.phone_number,
          ctx.rawMessage
        );
        if (resolved.error || !resolved.jid) {
          return { success: false, message: resolved.error || 'Could not identify which member to remove.' };
        }

        // Safety Guardrail: Never kick creator/owner Ademola or the bot itself
        if (userProfileManager.isOwner(resolved.jid)) {
          return {
            success: false,
            message: 'Omo! I cannot kick my creator & owner Ademola from any group abeg 😂',
          };
        }

        const botId = ctx.sock?.user?.id || '';
        const botPhone = contactService.extractPhoneNumber(botId) || config.bot.pairingPhoneNumber || '';
        if (resolved.jid === botId || (botPhone && resolved.cleanNumber === botPhone)) {
          return {
            success: false,
            message: 'Why would I kick myself from the group? 😂 If you want me to leave, just ask me to leave.',
          };
        }

        try {
          await ctx.sock.groupParticipantsUpdate(ctx.chatJid, [resolved.jid], 'remove');
          const isLid = resolved.cleanNumber && resolved.cleanNumber.length > 13;
          const displayLabel = isLid ? 'The specified member' : `@${resolved.cleanNumber}`;

          logAutonomousAction(
            'kicked_member',
            ctx.chatJid,
            ctx.senderJid,
            `Removed ${resolved.jid} from group ${args.reason ? `(Reason: ${args.reason})` : ''}`
          );

          return {
            success: true,
            message: `🚫 ${displayLabel} has been removed from the group.${args.reason ? ` Reason: ${args.reason}` : ''}`,
            data: { jid: resolved.jid, cleanNumber: resolved.cleanNumber },
          };
        } catch (err: any) {
          return { success: false, message: `Failed to remove user: ${err.message}` };
        }
      },
    },
    {
      name: 'add_member',
      description:
        'Adds a new member or participant to the group using their phone number (e.g. "+234 913 191 8009", "08123456789") or contact name. Requires the bot to be an admin in the group.',
      parameters: {
        type: 'object',
        properties: {
          target: {
            type: 'string',
            description:
              'Phone number (e.g. "+234 913 191 8009", "08123456789"), contact name, or @tag of the person to add.',
          },
        },
        required: ['target'],
      },
      execute: async (
        args: { target: string; phone_number?: string },
        ctx: ExecutionContext
      ): Promise<ToolResult> => {
        if (!ctx.isGroup) {
          return { success: false, message: 'This tool is only available in WhatsApp groups.' };
        }

        const botIsAdmin = await this.isBotAdmin(ctx.sock, ctx.chatJid);
        if (!botIsAdmin) {
          return {
            success: false,
            message: 'Action failed: I must be made an admin in this group to add participants.',
          };
        }

        const senderIsAdmin = await this.isUserAdmin(ctx.sock, ctx.chatJid, ctx.senderJid);
        if (!senderIsAdmin) {
          return {
            success: false,
            message: 'Permission denied: Only group admins or bot owner Ademola can add members.',
          };
        }

        const rawTarget = (args.target || args.phone_number || '').trim();
        const resolved = await this.resolveTargetUser(ctx.sock, ctx.chatJid, rawTarget, ctx.rawMessage);
        if (resolved.error || !resolved.jid) {
          return {
            success: false,
            message:
              resolved.error ||
              `Could not find a phone number or contact for "${rawTarget}". Please state their phone number with country code.`,
          };
        }

        const targetJid = resolved.jid;
        const targetClean = resolved.cleanNumber || targetJid.split('@')[0];

        try {
          const meta = await ctx.sock.groupMetadata(ctx.chatJid);
          const alreadyInGroup = meta.participants?.some((p: any) => {
            const pNum = p.id ? p.id.split('@')[0].split(':')[0].replace(/[^0-9]/g, '') : '';
            return p.id === targetJid || (pNum && pNum === targetClean);
          });

          if (alreadyInGroup) {
            return {
              success: true,
              message: `ℹ️ Member +${targetClean} is already in this group!`,
            };
          }

          const response = await ctx.sock.groupParticipantsUpdate(ctx.chatJid, [targetJid], 'add');
          const firstResult = response?.[0];
          const status = String(firstResult?.status || '');

          if (status === '200') {
            logAutonomousAction(
              'added_member',
              ctx.chatJid,
              ctx.senderJid,
              `Added +${targetClean} to group`
            );
            return {
              success: true,
              message: `✅ Successfully added +${targetClean} to the group!`,
              data: { jid: targetJid, status },
            };
          } else if (status === '403') {
            let inviteMsg = `⚠️ Could not add +${targetClean} directly because their WhatsApp privacy settings only permit their saved contacts to add them to groups.`;
            try {
              const code = await ctx.sock.groupInviteCode(ctx.chatJid);
              if (code) {
                inviteMsg += `\n\nHere is the group invite link you can send them instead:\nhttps://chat.whatsapp.com/${code}`;
              }
            } catch {}
            return {
              success: false,
              message: inviteMsg,
              data: { jid: targetJid, status },
            };
          } else if (status === '408') {
            return {
              success: false,
              message: `⚠️ Could not add +${targetClean} because they recently left this group. They must use an invite link to rejoin.`,
              data: { jid: targetJid, status },
            };
          } else if (status === '409') {
            return {
              success: true,
              message: `ℹ️ +${targetClean} is already in the group!`,
            };
          } else {
            return {
              success: true,
              message: `Add request submitted for +${targetClean} (Status: ${status || 'Sent'}).`,
              data: { jid: targetJid, status },
            };
          }
        } catch (err: any) {
          return { success: false, message: `Failed to add member: ${err?.message || err}` };
        }
      },
    },
    {
      name: 'delete_group_message',
      description:
        'Deletes/revokes a message for everyone in the group using elevated admin privileges. Ideal for cleaning up spam, offensive messages, or rule violations. Works immediately if replying to/quoting the message, or by specifying a target user whose recent message should be deleted.',
      parameters: {
        type: 'object',
        properties: {
          target: {
            type: 'string',
            description:
              'Optional phone number, contact name, or @tag of the user whose recent message should be deleted.',
          },
          reason: {
            type: 'string',
            description: 'Optional reason for deleting the message (e.g. "spam", "inappropriate link").',
          },
        },
      },
      execute: async (
        args: { target?: string; reason?: string },
        ctx: ExecutionContext
      ): Promise<ToolResult> => {
        if (!ctx.isGroup) {
          return { success: false, message: 'This tool is only available in WhatsApp groups.' };
        }

        const botIsAdmin = await this.isBotAdmin(ctx.sock, ctx.chatJid);
        if (!botIsAdmin) {
          return {
            success: false,
            message: 'Action failed: I must be made an admin in this group to delete messages for everyone.',
          };
        }

        const senderIsAdmin = await this.isUserAdmin(ctx.sock, ctx.chatJid, ctx.senderJid);
        if (!senderIsAdmin) {
          return {
            success: false,
            message: 'Permission denied: Only group admins or bot owner Ademola can request to delete messages.',
          };
        }

        let targetId: string | undefined;
        let participantJid: string | undefined;

        // 1. Check if user quoted a message directly
        const contextInfo =
          ctx.rawMessage?.message?.extendedTextMessage?.contextInfo ||
          ctx.rawMessage?.message?.imageMessage?.contextInfo ||
          ctx.rawMessage?.message?.videoMessage?.contextInfo;

        if (contextInfo?.stanzaId) {
          targetId = contextInfo.stanzaId;
          participantJid = contextInfo.participant || ctx.senderJid;
        }

        // 2. If not quoted, look up in chat_logs
        if (!targetId) {
          let targetSenderJid: string | undefined;
          if (args.target) {
            const resolved = await this.resolveTargetUser(
              ctx.sock,
              ctx.chatJid,
              args.target,
              ctx.rawMessage
            );
            if (resolved.jid) {
              targetSenderJid = resolved.jid;
            }
          }

          const lastMsg = chatLogger.getLastMessage(ctx.chatJid, targetSenderJid);
          if (lastMsg && lastMsg.message_id) {
            targetId = lastMsg.message_id;
            participantJid = lastMsg.sender_jid;
          }
        }

        if (!targetId) {
          return {
            success: false,
            message:
              'Could not identify which message to delete. Please reply to / quote the message you want deleted, or specify the member (@user).',
          };
        }

        try {
          const keyToDelete: any = {
            remoteJid: ctx.chatJid,
            fromMe: false,
            id: targetId,
          };
          if (participantJid) {
            keyToDelete.participant = participantJid;
          }

          await ctx.sock.sendMessage(ctx.chatJid, { delete: keyToDelete });
          logAutonomousAction(
            'deleted_message',
            ctx.chatJid,
            ctx.senderJid,
            `Admin deleted message ${targetId} ${args.reason ? `(${args.reason})` : ''}`
          );

          return {
            success: true,
            message: `🗑️ Message successfully deleted for everyone in the group.${args.reason ? ` Reason: ${args.reason}` : ''}`,
            data: { messageId: targetId, participant: participantJid },
          };
        } catch (err: any) {
          return { success: false, message: `Failed to delete message: ${err?.message || err}` };
        }
      },
    },
    {
      name: 'set_group_mode',
      description:
        'Locks or unlocks the group chat (announcement mode: only admins can message vs all members) OR locks/unlocks editing group info. Requires bot admin privileges.',
      parameters: {
        type: 'object',
        properties: {
          mode: {
            type: 'string',
            enum: ['announcement', 'not_announcement', 'locked', 'unlocked'],
            description:
              '"announcement" to mute members (admin-only chat), "not_announcement" to open group for everyone, "locked" to restrict editing group info to admins only, "unlocked" to allow all members to edit group info.',
          },
        },
        required: ['mode'],
      },
      execute: async (
        args: { mode: 'announcement' | 'not_announcement' | 'locked' | 'unlocked' },
        ctx: ExecutionContext
      ): Promise<ToolResult> => {
        if (!ctx.isGroup) {
          return { success: false, message: 'This tool is only available in groups.' };
        }

        const botIsAdmin = await this.isBotAdmin(ctx.sock, ctx.chatJid);
        if (!botIsAdmin) {
          return { success: false, message: 'I need to be made an admin in this group to change group settings.' };
        }

        const senderIsAdmin = await this.isUserAdmin(ctx.sock, ctx.chatJid, ctx.senderJid);
        if (!senderIsAdmin) {
          return { success: false, message: 'Only group admins can change group settings.' };
        }

        try {
          await ctx.sock.groupSettingUpdate(ctx.chatJid, args.mode);
          let label = '';
          if (args.mode === 'announcement') {
            label = '🔒 Group locked: Only Admins can send messages.';
          } else if (args.mode === 'not_announcement') {
            label = '🔓 Group opened: All members can send messages.';
          } else if (args.mode === 'locked') {
            label = '🔒 Group info locked: Only Admins can change group title, icon, and description.';
          } else if (args.mode === 'unlocked') {
            label = '🔓 Group info unlocked: All members can edit group title, icon, and description.';
          }

          return {
            success: true,
            message: `Group setting successfully updated: ${label}`,
            data: { mode: args.mode },
          };
        } catch (err: any) {
          return { success: false, message: `Failed to update group setting: ${err.message}` };
        }
      },
    },
    {
      name: 'promote_member',
      description:
        'Promotes a group member to admin status. The member can be specified by contact name, phone number, @tag, or by replying to/quoting their message.',
      parameters: {
        type: 'object',
        properties: {
          target: {
            type: 'string',
            description: 'Phone number, contact name, or @tag of the user to promote to admin.',
          },
        },
      },
      execute: async (
        args: { target?: string; phone_number?: string },
        ctx: ExecutionContext
      ): Promise<ToolResult> => {
        if (!ctx.isGroup) return { success: false, message: 'This tool is only available in groups.' };
        const botIsAdmin = await this.isBotAdmin(ctx.sock, ctx.chatJid);
        if (!botIsAdmin) return { success: false, message: 'Action failed: I must be made an admin in this group first.' };
        const senderIsAdmin = await this.isUserAdmin(ctx.sock, ctx.chatJid, ctx.senderJid);
        if (!senderIsAdmin) return { success: false, message: 'Permission denied: Only group admins can promote members.' };

        const resolved = await this.resolveTargetUser(
          ctx.sock,
          ctx.chatJid,
          args.target || args.phone_number,
          ctx.rawMessage
        );
        if (resolved.error || !resolved.jid) {
          return { success: false, message: resolved.error || 'Could not identify which member to promote.' };
        }

        try {
          await ctx.sock.groupParticipantsUpdate(ctx.chatJid, [resolved.jid], 'promote');
          const isLid = resolved.cleanNumber && resolved.cleanNumber.length > 13;
          const displayLabel = isLid ? 'The member' : `@${resolved.cleanNumber}`;

          logAutonomousAction('promoted_admin', ctx.chatJid, ctx.senderJid, `Promoted ${resolved.jid} to admin`);

          return { success: true, message: `🛡️ ${displayLabel} has been successfully promoted to group admin.` };
        } catch (err: any) {
          return { success: false, message: `Failed to promote user: ${err.message}` };
        }
      },
    },
    {
      name: 'demote_member',
      description:
        'Demotes a group admin back to regular member. The admin can be specified by contact name, phone number, @tag, or by replying to/quoting their message.',
      parameters: {
        type: 'object',
        properties: {
          target: {
            type: 'string',
            description: 'Phone number, contact name, or @tag of the admin to demote.',
          },
        },
      },
      execute: async (
        args: { target?: string; phone_number?: string },
        ctx: ExecutionContext
      ): Promise<ToolResult> => {
        if (!ctx.isGroup) return { success: false, message: 'This tool is only available in groups.' };
        const botIsAdmin = await this.isBotAdmin(ctx.sock, ctx.chatJid);
        if (!botIsAdmin) return { success: false, message: 'Action failed: I must be made an admin in this group first.' };
        const senderIsAdmin = await this.isUserAdmin(ctx.sock, ctx.chatJid, ctx.senderJid);
        if (!senderIsAdmin) return { success: false, message: 'Permission denied: Only group admins can demote admins.' };

        const resolved = await this.resolveTargetUser(
          ctx.sock,
          ctx.chatJid,
          args.target || args.phone_number,
          ctx.rawMessage
        );
        if (resolved.error || !resolved.jid) {
          return { success: false, message: resolved.error || 'Could not identify which admin to demote.' };
        }

        // Safety Guardrail: Never demote creator Ademola
        if (userProfileManager.isOwner(resolved.jid)) {
          return {
            success: false,
            message: 'Omo, I cannot demote Ademola! He is my creator and the boss 😂',
          };
        }

        try {
          await ctx.sock.groupParticipantsUpdate(ctx.chatJid, [resolved.jid], 'demote');
          const isLid = resolved.cleanNumber && resolved.cleanNumber.length > 13;
          const displayLabel = isLid ? 'The admin' : `@${resolved.cleanNumber}`;

          logAutonomousAction('demoted_admin', ctx.chatJid, ctx.senderJid, `Demoted ${resolved.jid} to regular member`);

          return { success: true, message: `${displayLabel} has been demoted to a regular member.` };
        } catch (err: any) {
          return { success: false, message: `Failed to demote user: ${err.message}` };
        }
      },
    },
    {
      name: 'set_group_subject',
      description: 'Changes the title / name of the group. Requires the bot to be an admin in the group.',
      parameters: {
        type: 'object',
        properties: {
          subject: {
            type: 'string',
            description: 'New title/name for the group.',
          },
        },
        required: ['subject'],
      },
      execute: async (args: { subject: string }, ctx: ExecutionContext): Promise<ToolResult> => {
        if (!ctx.isGroup) return { success: false, message: 'This tool is only available in groups.' };
        const botIsAdmin = await this.isBotAdmin(ctx.sock, ctx.chatJid);
        if (!botIsAdmin)
          return { success: false, message: 'Action failed: I must be made an admin in this group to change the group name.' };
        const senderIsAdmin = await this.isUserAdmin(ctx.sock, ctx.chatJid, ctx.senderJid);
        if (!senderIsAdmin)
          return { success: false, message: 'Permission denied: Only group admins can change the group name.' };

        try {
          await ctx.sock.groupUpdateSubject(ctx.chatJid, args.subject.trim());
          upsertKnownGroup(ctx.chatJid, args.subject.trim(), 0, true);
          return { success: true, message: `Group name successfully updated to "${args.subject.trim()}".` };
        } catch (err: any) {
          return { success: false, message: `Failed to update group name: ${err.message}` };
        }
      },
    },
    {
      name: 'set_group_description',
      description: 'Changes the description of the group. Requires the bot to be an admin in the group.',
      parameters: {
        type: 'object',
        properties: {
          description: {
            type: 'string',
            description: 'New description text for the group.',
          },
        },
        required: ['description'],
      },
      execute: async (args: { description: string }, ctx: ExecutionContext): Promise<ToolResult> => {
        if (!ctx.isGroup) return { success: false, message: 'This tool is only available in groups.' };
        const botIsAdmin = await this.isBotAdmin(ctx.sock, ctx.chatJid);
        if (!botIsAdmin)
          return { success: false, message: 'Action failed: I must be made an admin in this group to update description.' };
        const senderIsAdmin = await this.isUserAdmin(ctx.sock, ctx.chatJid, ctx.senderJid);
        if (!senderIsAdmin)
          return { success: false, message: 'Permission denied: Only group admins can change group description.' };

        try {
          await ctx.sock.groupUpdateDescription(ctx.chatJid, args.description.trim());
          return { success: true, message: `Group description successfully updated.` };
        } catch (err: any) {
          return { success: false, message: `Failed to update group description: ${err.message}` };
        }
      },
    },
    {
      name: 'get_group_invite_link',
      description: 'Retrieves the official WhatsApp invite link for this group. Requires the bot to be an admin.',
      parameters: {
        type: 'object',
        properties: {},
      },
      execute: async (_args: {}, ctx: ExecutionContext): Promise<ToolResult> => {
        if (!ctx.isGroup) return { success: false, message: 'This tool is only available in groups.' };
        const botIsAdmin = await this.isBotAdmin(ctx.sock, ctx.chatJid);
        if (!botIsAdmin)
          return { success: false, message: 'Action failed: I must be made an admin in this group to retrieve invite link.' };

        try {
          const code = await ctx.sock.groupInviteCode(ctx.chatJid);
          const link = `https://chat.whatsapp.com/${code}`;
          return { success: true, message: `🔗 *Group Invite Link:*\n${link}` };
        } catch (err: any) {
          return { success: false, message: `Failed to get invite link: ${err.message}` };
        }
      },
    },
    {
      name: 'revoke_group_invite_link',
      description: 'Revokes the existing group invite link and resets it with a new code. Requires the bot to be an admin.',
      parameters: {
        type: 'object',
        properties: {},
      },
      execute: async (_args: {}, ctx: ExecutionContext): Promise<ToolResult> => {
        if (!ctx.isGroup) return { success: false, message: 'This tool is only available in groups.' };
        const botIsAdmin = await this.isBotAdmin(ctx.sock, ctx.chatJid);
        if (!botIsAdmin)
          return { success: false, message: 'Action failed: I must be made an admin in this group to revoke invite link.' };
        const senderIsAdmin = await this.isUserAdmin(ctx.sock, ctx.chatJid, ctx.senderJid);
        if (!senderIsAdmin)
          return { success: false, message: 'Permission denied: Only group admins can revoke invite links.' };

        try {
          const newCode = await ctx.sock.groupRevokeInvite(ctx.chatJid);
          const link = `https://chat.whatsapp.com/${newCode}`;
          return { success: true, message: `🔄 Previous link revoked. *New Group Invite Link:*\n${link}` };
        } catch (err: any) {
          return { success: false, message: `Failed to revoke invite link: ${err.message}` };
        }
      },
    },
    {
      name: 'set_disappearing_messages',
      description:
        'Enables, changes, or disables disappearing messages for the group (off, 24 hours, 7 days, or 90 days). Requires the bot to be an admin in the group.',
      parameters: {
        type: 'object',
        properties: {
          duration: {
            type: 'string',
            enum: ['off', '24h', '7d', '90d', '24_hours', '7_days', '90_days'],
            description: 'Duration before messages disappear: "off", "24h", "7d", or "90d".',
          },
        },
        required: ['duration'],
      },
      execute: async (args: { duration: string }, ctx: ExecutionContext): Promise<ToolResult> => {
        if (!ctx.isGroup) {
          return { success: false, message: 'This tool is only available in WhatsApp groups.' };
        }

        const botIsAdmin = await this.isBotAdmin(ctx.sock, ctx.chatJid);
        if (!botIsAdmin) {
          return {
            success: false,
            message: 'Action failed: I must be made an admin in this group to set disappearing messages.',
          };
        }

        const senderIsAdmin = await this.isUserAdmin(ctx.sock, ctx.chatJid, ctx.senderJid);
        if (!senderIsAdmin) {
          return {
            success: false,
            message: 'Permission denied: Only group admins can configure disappearing messages.',
          };
        }

        let seconds = 0;
        let label = 'Off (Messages will not disappear)';
        const d = (args.duration || '').toLowerCase();
        if (d.includes('24') || d.includes('1d') || d === '24h') {
          seconds = 86400;
          label = '24 hours';
        } else if (d.includes('7') || d.includes('1w') || d === '7d') {
          seconds = 604800;
          label = '7 days';
        } else if (d.includes('90') || d.includes('3m') || d === '90d') {
          seconds = 7776000;
          label = '90 days';
        }

        try {
          await ctx.sock.groupToggleEphemeral(ctx.chatJid, seconds);
          return {
            success: true,
            message: `⏳ Disappearing messages timer for this group has been set to: *${label}*.`,
            data: { seconds, label },
          };
        } catch (err: any) {
          return { success: false, message: `Failed to set disappearing messages: ${err?.message || err}` };
        }
      },
    },
    {
      name: 'list_join_requests',
      description:
        'Lists pending participant join requests for groups that have "Approve new participants" enabled. Requires bot admin privileges.',
      parameters: {
        type: 'object',
        properties: {},
      },
      execute: async (_args: {}, ctx: ExecutionContext): Promise<ToolResult> => {
        if (!ctx.isGroup) return { success: false, message: 'This tool is only available in WhatsApp groups.' };
        const botIsAdmin = await this.isBotAdmin(ctx.sock, ctx.chatJid);
        if (!botIsAdmin) return { success: false, message: 'Action failed: I must be made an admin in this group first.' };

        try {
          const list = await ctx.sock.groupRequestParticipantsList(ctx.chatJid);
          if (!list || list.length === 0) {
            return { success: true, message: 'No pending join requests found for this group.' };
          }

          const formatted = list
            .map((item: any, idx: number) => {
              const jid = item.jid || Object.values(item)[0] || '';
              const phone = contactService.extractPhoneNumber(jid) || jid;
              return `${idx + 1}. +${phone}`;
            })
            .join('\n');

          return {
            success: true,
            message: `📋 *Pending Join Requests (${list.length}):*\n\n${formatted}\n\nUse approve_join_request or reject_join_request to process them.`,
            data: list,
          };
        } catch (err: any) {
          return { success: false, message: `Failed to list join requests: ${err?.message || err}` };
        }
      },
    },
    {
      name: 'approve_join_request',
      description: 'Approves a pending participant join request to let them into the group. Requires bot admin privileges.',
      parameters: {
        type: 'object',
        properties: {
          target: {
            type: 'string',
            description:
              'Phone number or JID of the pending participant to approve (or "all" to approve all pending requests).',
          },
        },
        required: ['target'],
      },
      execute: async (args: { target: string }, ctx: ExecutionContext): Promise<ToolResult> => {
        if (!ctx.isGroup) return { success: false, message: 'This tool is only available in WhatsApp groups.' };
        const botIsAdmin = await this.isBotAdmin(ctx.sock, ctx.chatJid);
        if (!botIsAdmin) return { success: false, message: 'Action failed: I must be made an admin in this group first.' };
        const senderIsAdmin = await this.isUserAdmin(ctx.sock, ctx.chatJid, ctx.senderJid);
        if (!senderIsAdmin) return { success: false, message: 'Permission denied: Only group admins can approve join requests.' };

        try {
          let targets: string[] = [];
          if (args.target.toLowerCase() === 'all') {
            const list = await ctx.sock.groupRequestParticipantsList(ctx.chatJid);
            targets = (list || []).map((i: any) => i.jid || (Object.values(i)[0] as string)).filter(Boolean);
          } else {
            const digits = contactService.extractPhoneNumber(args.target);
            targets = [digits ? `${digits}@s.whatsapp.net` : args.target];
          }

          if (targets.length === 0) {
            return { success: false, message: 'No valid targets found to approve.' };
          }

          const res = await ctx.sock.groupRequestParticipantsUpdate(ctx.chatJid, targets, 'approve');
          return {
            success: true,
            message: `✅ Approved ${targets.length} join request(s).`,
            data: res,
          };
        } catch (err: any) {
          return { success: false, message: `Failed to approve join request: ${err?.message || err}` };
        }
      },
    },
    {
      name: 'reject_join_request',
      description: 'Rejects a pending participant join request. Requires bot admin privileges.',
      parameters: {
        type: 'object',
        properties: {
          target: {
            type: 'string',
            description:
              'Phone number or JID of the pending participant to reject (or "all" to reject all pending requests).',
          },
        },
        required: ['target'],
      },
      execute: async (args: { target: string }, ctx: ExecutionContext): Promise<ToolResult> => {
        if (!ctx.isGroup) return { success: false, message: 'This tool is only available in WhatsApp groups.' };
        const botIsAdmin = await this.isBotAdmin(ctx.sock, ctx.chatJid);
        if (!botIsAdmin) return { success: false, message: 'Action failed: I must be made an admin in this group first.' };
        const senderIsAdmin = await this.isUserAdmin(ctx.sock, ctx.chatJid, ctx.senderJid);
        if (!senderIsAdmin) return { success: false, message: 'Permission denied: Only group admins can reject join requests.' };

        try {
          let targets: string[] = [];
          if (args.target.toLowerCase() === 'all') {
            const list = await ctx.sock.groupRequestParticipantsList(ctx.chatJid);
            targets = (list || []).map((i: any) => i.jid || (Object.values(i)[0] as string)).filter(Boolean);
          } else {
            const digits = contactService.extractPhoneNumber(args.target);
            targets = [digits ? `${digits}@s.whatsapp.net` : args.target];
          }

          if (targets.length === 0) {
            return { success: false, message: 'No valid targets found to reject.' };
          }

          const res = await ctx.sock.groupRequestParticipantsUpdate(ctx.chatJid, targets, 'reject');
          return {
            success: true,
            message: `🚫 Rejected ${targets.length} join request(s).`,
            data: res,
          };
        } catch (err: any) {
          return { success: false, message: `Failed to reject join request: ${err?.message || err}` };
        }
      },
    },
    {
      name: 'join_group',
      description:
        'Joins a WhatsApp group using an invite link or invite code (e.g., https://chat.whatsapp.com/ABC123xyz or ABC123xyz). Can be called in DMs or groups whenever someone shares a group invite link.',
      parameters: {
        type: 'object',
        properties: {
          invite_link: {
            type: 'string',
            description: 'The WhatsApp group invite URL (https://chat.whatsapp.com/...) or the 22-character invite code.',
          },
        },
        required: ['invite_link'],
      },
      execute: async (args: { invite_link: string }, ctx: ExecutionContext): Promise<ToolResult> => {
        try {
          const raw = (args.invite_link || '').trim();
          const match = raw.match(/(?:chat\.whatsapp\.com\/)?([a-zA-Z0-9_-]{20,24})/);
          const inviteCode = match ? match[1] : raw.replace(/https?:\/\/chat\.whatsapp\.com\//, '').trim();

          if (!inviteCode || inviteCode.length < 15) {
            return {
              success: false,
              message:
                'Invalid group invite link or code. Please provide a valid WhatsApp group link (https://chat.whatsapp.com/...).',
            };
          }

          let groupInfo: any = null;
          try {
            groupInfo = await ctx.sock.groupGetInviteInfo(inviteCode);
          } catch (err: any) {
            const errMsg = String(err?.message || err);
            if (errMsg.includes('404') || errMsg.includes('gone') || errMsg.includes('not-authorized')) {
              return { success: false, message: 'Could not access the group: The invite link has expired or was revoked.' };
            }
          }

          let groupJid: string | undefined;
          try {
            groupJid = await ctx.sock.groupAcceptInvite(inviteCode);
          } catch (joinErr: any) {
            const joinMsg = String(joinErr?.message || joinErr);
            if (joinMsg.includes('409') || joinMsg.includes('already')) {
              const subject = groupInfo?.subject ? ` "${groupInfo.subject}"` : '';
              return { success: true, message: `I am already a member of this group${subject}! 🤝` };
            }
            throw joinErr;
          }

          const groupTitle = groupInfo?.subject || 'the group';

          if (groupJid) {
            upsertKnownGroup(groupJid, groupTitle, groupInfo?.size || 0, false);
          }

          logAutonomousAction(
            'joined_group',
            groupJid || 'group',
            ctx.senderJid,
            `Joined group "${groupTitle}" via invite link`
          );

          if (groupJid) {
            try {
              await ctx.sock.sendMessage(groupJid, {
                text: `👋 Hello everyone! I'm Forgelabs assistant, glad to be here with you all. Feel free to tag me if you need help with anything!`,
              });
            } catch (greetErr) {
              console.warn('[GroupAdmin] Greet error after joining group:', greetErr);
            }
          }

          const memberCount = groupInfo?.size ? ` (${groupInfo.size} members)` : '';
          return {
            success: true,
            message: `🎉 Successfully joined "${groupTitle}"${memberCount}!`,
            data: {
              groupJid,
              subject: groupTitle,
              participants: groupInfo?.size,
            },
          };
        } catch (err: any) {
          console.error('[GroupAdmin] Error joining group:', err);
          return {
            success: false,
            message: `Failed to join group: ${err?.message || 'The link may have expired or was revoked.'}`,
          };
        }
      },
    },
    {
      name: 'send_message_to_group',
      description:
        'Sends or relays a message to a WhatsApp group that the bot belongs to, or replies to a specific member inside that group. Use whenever asked to "send [msg] to [group]", "post in [group]", "reply to [person] on [group]", or "tell [group] ...".',
      parameters: {
        type: 'object',
        properties: {
          group: {
            type: 'string',
            description: 'The name or keyword of the group (e.g., "IFT Interactive Space", "IFT", or group JID).',
          },
          message: {
            type: 'string',
            description: 'The message text to send or reply with in the group.',
          },
          target_member: {
            type: 'string',
            description:
              'Optional name, push name, or handle of the group member to tag or reply to (e.g. "god\'s virtue", "David").',
          },
        },
        required: ['group', 'message'],
      },
      execute: async (
        args: { group: string; message: string; target_member?: string },
        ctx: ExecutionContext
      ): Promise<ToolResult> => {
        try {
          const rawGroup = (args.group || '').trim();
          const rawMessage = (args.message || '').trim();

          if (!rawGroup || !rawMessage) {
            return { success: false, message: 'Both group name and message content are required.' };
          }

          let targetGroupJid = '';
          let targetGroupSubject = rawGroup;

          const cached = findKnownGroup(rawGroup);
          if (cached) {
            targetGroupJid = cached.group_jid;
            targetGroupSubject = cached.subject;
          }

          if (!targetGroupJid && ctx.sock?.groupFetchAllParticipating) {
            try {
              const participating = await ctx.sock.groupFetchAllParticipating();
              const lowerSearch = rawGroup.toLowerCase();
              for (const [jid, meta] of Object.entries(participating) as [string, any][]) {
                const sub = (meta.subject || '').toLowerCase();
                if (sub.includes(lowerSearch) || lowerSearch.includes(sub)) {
                  targetGroupJid = jid;
                  targetGroupSubject = meta.subject || rawGroup;
                  upsertKnownGroup(jid, targetGroupSubject, meta.participants?.length || 0);
                  break;
                }
              }
            } catch (fetchErr) {
              console.warn('[GroupAdmin] Error fetching participating groups during send:', fetchErr);
            }
          }

          if (!targetGroupJid) {
            return {
              success: false,
              message: `Could not find a group matching "${rawGroup}" among the groups I am in. You can ask me "which groups are you in?" to see my list of groups.`,
            };
          }

          let mentions: string[] = [];
          let formattedText = rawMessage;

          if (args.target_member && args.target_member.trim()) {
            const targetName = args.target_member.trim();
            try {
              const memberRow = db.prepare(`
                SELECT sender_jid, sender_name FROM chat_logs
                WHERE chat_jid = ? AND is_group = 1 AND (LOWER(sender_name) LIKE LOWER(?) OR sender_jid LIKE ?)
                ORDER BY id DESC LIMIT 1
              `).get(targetGroupJid, `%${targetName}%`, `%${targetName}%`) as
                | { sender_jid: string; sender_name: string }
                | undefined;

              if (memberRow && memberRow.sender_jid) {
                mentions.push(memberRow.sender_jid);
                const rawSender = memberRow.sender_jid.split('@')[0].split(':')[0];
                const isLid = memberRow.sender_jid.endsWith('@lid') || rawSender.length > 13;
                const mentionTag = isLid ? `@${memberRow.sender_name || targetName}` : `@${rawSender}`;
                formattedText = `${mentionTag} ${rawMessage}`;
              } else {
                formattedText = `@${targetName} ${rawMessage}`;
              }
            } catch {}
          }

          await ctx.sock.sendMessage(targetGroupJid, {
            text: formattedText,
            mentions: mentions.length > 0 ? mentions : undefined,
          });

          chatLogger.logMessage({
            chatJid: targetGroupJid,
            senderJid: 'bot',
            senderName: config.bot.name,
            isGroup: true,
            contentType: 'text',
            messageText: formattedText,
            timestamp: Date.now(),
          });

          logAutonomousAction(
            'sent_group_message',
            targetGroupJid,
            ctx.senderJid,
            `Sent message to "${targetGroupSubject}": "${rawMessage}"`
          );

          const replyLabel = args.target_member ? ` (replying to ${args.target_member})` : '';
          return {
            success: true,
            message: `✅ Message sent to group "${targetGroupSubject}"${replyLabel}: "${rawMessage}"`,
            data: {
              groupJid: targetGroupJid,
              subject: targetGroupSubject,
              message: formattedText,
            },
          };
        } catch (err: any) {
          console.error('[GroupAdmin] Error sending message to group:', err);
          return {
            success: false,
            message: `Failed to send message to group: ${err.message}`,
          };
        }
      },
    },
  ];
}

export const groupAdminPlugin = new GroupAdminPlugin();
