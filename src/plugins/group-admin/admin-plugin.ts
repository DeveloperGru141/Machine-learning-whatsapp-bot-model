import { IPlugin, BotTool, ExecutionContext, ToolResult } from '../types.js';
import { config } from '../../config/env.js';
import { userProfileManager } from '../../memory/user-profiles.js';
import { chatLogger } from '../../memory/chat-logger.js';
import { contactService } from '../../memory/contact-service.js';
import { logAutonomousAction } from '../../memory/db.js';

export class GroupAdminPlugin implements IPlugin {
  name = 'GroupAdminSuite';
  version = '1.0.0';
  description = 'Group moderation and administration suite active when the bot is an admin in a WhatsApp group';

  /**
   * Helper to verify if the bot itself has admin rights in the group
   */
  private async isBotAdmin(sock: any, groupJid: string): Promise<boolean> {
    try {
      const meta = await sock.groupMetadata(groupJid);
      const botNumber = sock.user?.id ? `${sock.user.id.split(':')[0].split('@')[0]}@s.whatsapp.net` : '';
      const botLid = sock.user?.lid ? `${sock.user.lid.split(':')[0].split('@')[0]}@lid` : '';
      const botParticipant = meta.participants.find((p: any) => {
        const pId = p.id ? `${p.id.split(':')[0].split('@')[0]}@${p.id.split('@')[1] || 's.whatsapp.net'}` : '';
        const pLid = p.lid ? `${p.lid.split(':')[0].split('@')[0]}@lid` : '';
        return (
          p.id === sock.user?.id ||
          (botNumber && pId === botNumber) ||
          (botLid && (pId === botLid || pLid === botLid))
        );
      });
      return botParticipant?.admin === 'admin' || botParticipant?.admin === 'superadmin';
    } catch {
      return false;
    }
  }

  /**
   * Helper to verify if the requesting user is an admin or bot owner
   */
  private async isUserAdmin(sock: any, groupJid: string, senderJid: string): Promise<boolean> {
    if (userProfileManager.isOwner(senderJid)) return true;

    try {
      const meta = await sock.groupMetadata(groupJid);
      const normSender = `${senderJid.split(':')[0].split('@')[0]}@${senderJid.split('@')[1] || 's.whatsapp.net'}`;
      const user = meta.participants.find((p: any) => {
        const pId = p.id ? `${p.id.split(':')[0].split('@')[0]}@${p.id.split('@')[1] || 's.whatsapp.net'}` : '';
        const pLid = p.lid ? `${p.lid.split(':')[0].split('@')[0]}@lid` : '';
        return p.id === senderJid || pId === normSender || pLid === normSender;
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
   */
  private async resolveTargetUser(
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

    // If a name or keyword was given, match against group participants
    try {
      const meta = await sock.groupMetadata(groupJid);
      if (cleanInput) {
        const lower = cleanInput.toLowerCase().replace(/^@/, '');
        for (const p of meta.participants) {
          const num = p.id ? p.id.split('@')[0].split(':')[0].replace(/[^0-9]/g, '') : '';
          const saved = contactService.getContact(num || p.id);
          const name = (saved?.custom_name || saved?.display_name || '').toLowerCase();
          if (name.includes(lower) || num.includes(lower)) {
            return { jid: p.id, cleanNumber: num };
          }
        }
      }
    } catch {}

    return {
      error: 'Please tag the member (@user), reply to their message, or state their phone number or contact name so I know who you mean.',
    };
  }

  /**
   * Passive Anti-Link moderation: Deletes unauthorized WhatsApp group invite links sent by non-admins
   */
  public async handleAntiLink(sock: any, msg: any, chatJid: string, senderJid: string, text: string): Promise<boolean> {
    if (!chatJid.endsWith('@g.us')) return false;

    const linkRegex = /chat\.whatsapp\.com\/[0-9A-Za-z]{20,24}/i;
    if (!linkRegex.test(text)) return false;

    const botIsAdmin = await this.isBotAdmin(sock, chatJid);
    if (!botIsAdmin) return false;

    const userIsAdmin = await this.isUserAdmin(sock, chatJid, senderJid);
    if (userIsAdmin) return false; // Allow admins to post links

    try {
      const rawUser = senderJid.split('@')[0].split(':')[0];
      const isLid = senderJid.endsWith('@lid') || rawUser.length > 13;
      const userTag = isLid ? 'Member' : `@${rawUser}`;
      await sock.sendMessage(chatJid, {
        text: `⚠️ ${userTag}, group invite links are not permitted here!`,
        mentions: [senderJid],
      });
      logAutonomousAction('anti_link_moderation', chatJid, senderJid, 'Autonomously deleted unauthorized group invite link');
      return true;
    } catch (err: any) {
      console.error('[GroupAdmin] Failed to delete link:', err.message);
      return false;
    }
  }

  tools: BotTool[] = [
    {
      name: 'list_joined_groups',
      description: 'Lists all WhatsApp groups that the bot is currently a member of, along with their names and member counts. Use whenever someone asks what groups you are in, which group you dey, or asks for a list of groups.',
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
          const formatted = list
            .map((g, i) => `${i + 1}. *${g.subject}* (${g.participants?.length || 0} members)`)
            .join('\n');
          return {
            success: true,
            message: `👥 *I dey inside ${list.length} group(s):*\n\n${formatted}`,
            data: list.map((g) => ({ id: g.id, subject: g.subject, memberCount: g.participants?.length || 0 })),
          };
        } catch (err: any) {
          return { success: false, message: `Failed to fetch groups: ${err.message}` };
        }
      },
    },
    {
      name: 'tag_all',
      description: 'Mentions/tags every member in the group with an announcement or summary.',
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
          return { success: false, message: 'Only group admins or bot owners can use @everyone / tag_all.' };
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
      description: 'Removes/kicks a member from the group. The member can be specified by contact name, phone number, @tag, or by replying to/quoting their message.',
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
      execute: async (args: { target?: string; phone_number?: string; reason?: string }, ctx: ExecutionContext): Promise<ToolResult> => {
        if (!ctx.isGroup) {
          return { success: false, message: 'This tool is only available in groups.' };
        }

        const botIsAdmin = await this.isBotAdmin(ctx.sock, ctx.chatJid);
        if (!botIsAdmin) {
          return { success: false, message: 'Action failed: I must be granted admin privileges in this group to remove members.' };
        }

        const senderIsAdmin = await this.isUserAdmin(ctx.sock, ctx.chatJid, ctx.senderJid);
        if (!senderIsAdmin) {
          return { success: false, message: 'Permission denied: Only group admins can request to remove members.' };
        }

        const resolved = await this.resolveTargetUser(ctx.sock, ctx.chatJid, args.target || args.phone_number, ctx.rawMessage);
        if (resolved.error || !resolved.jid) {
          return { success: false, message: resolved.error || 'Could not identify which member to remove.' };
        }

        try {
          await ctx.sock.groupParticipantsUpdate(ctx.chatJid, [resolved.jid], 'remove');
          const isLid = resolved.cleanNumber && resolved.cleanNumber.length > 13;
          const displayLabel = isLid ? 'The specified member' : `@${resolved.cleanNumber}`;
          return {
            success: true,
            message: `${displayLabel} has been removed from the group. ${args.reason ? `Reason: ${args.reason}` : ''}`,
          };
        } catch (err: any) {
          return { success: false, message: `Failed to remove user: ${err.message}` };
        }
      },
    },
    {
      name: 'set_group_mode',
      description: 'Locks or unlocks the group chat (announcement mode: only admins can message vs all members). Requires bot admin.',
      parameters: {
        type: 'object',
        properties: {
          mode: {
            type: 'string',
            enum: ['announcement', 'not_announcement'],
            description: '"announcement" to mute members (admin only), "not_announcement" to open group for everyone.',
          },
        },
        required: ['mode'],
      },
      execute: async (args: { mode: 'announcement' | 'not_announcement' }, ctx: ExecutionContext): Promise<ToolResult> => {
        if (!ctx.isGroup) {
          return { success: false, message: 'This tool is only available in groups.' };
        }

        const botIsAdmin = await this.isBotAdmin(ctx.sock, ctx.chatJid);
        if (!botIsAdmin) {
          return { success: false, message: 'I need to be made an admin in this group to change group settings.' };
        }

        const senderIsAdmin = await this.isUserAdmin(ctx.sock, ctx.chatJid, ctx.senderJid);
        if (!senderIsAdmin) {
          return { success: false, message: 'Only group admins can change the group chat mode.' };
        }

        try {
          await ctx.sock.groupSettingUpdate(ctx.chatJid, args.mode);
          return {
            success: true,
            message: `Group setting successfully updated to: ${args.mode === 'announcement' ? 'Only Admins can send messages' : 'All members can send messages'}.`,
          };
        } catch (err: any) {
          return { success: false, message: `Failed to update group setting: ${err.message}` };
        }
      },
    },
    {
      name: 'promote_member',
      description: 'Promotes a group member to admin status. The member can be specified by contact name, phone number, @tag, or by replying to/quoting their message.',
      parameters: {
        type: 'object',
        properties: {
          target: {
            type: 'string',
            description: 'Phone number, contact name, or @tag of the user to promote to admin.',
          },
        },
      },
      execute: async (args: { target?: string; phone_number?: string }, ctx: ExecutionContext): Promise<ToolResult> => {
        if (!ctx.isGroup) return { success: false, message: 'This tool is only available in groups.' };
        const botIsAdmin = await this.isBotAdmin(ctx.sock, ctx.chatJid);
        if (!botIsAdmin) return { success: false, message: 'Action failed: I must be made an admin in this group first.' };
        const senderIsAdmin = await this.isUserAdmin(ctx.sock, ctx.chatJid, ctx.senderJid);
        if (!senderIsAdmin) return { success: false, message: 'Permission denied: Only group admins can promote members.' };

        const resolved = await this.resolveTargetUser(ctx.sock, ctx.chatJid, args.target || args.phone_number, ctx.rawMessage);
        if (resolved.error || !resolved.jid) {
          return { success: false, message: resolved.error || 'Could not identify which member to promote.' };
        }

        try {
          await ctx.sock.groupParticipantsUpdate(ctx.chatJid, [resolved.jid], 'promote');
          const isLid = resolved.cleanNumber && resolved.cleanNumber.length > 13;
          const displayLabel = isLid ? 'The member' : `@${resolved.cleanNumber}`;
          return { success: true, message: `${displayLabel} has been successfully promoted to group admin.` };
        } catch (err: any) {
          return { success: false, message: `Failed to promote user: ${err.message}` };
        }
      },
    },
    {
      name: 'demote_member',
      description: 'Demotes a group admin back to regular member. The admin can be specified by contact name, phone number, @tag, or by replying to/quoting their message.',
      parameters: {
        type: 'object',
        properties: {
          target: {
            type: 'string',
            description: 'Phone number, contact name, or @tag of the admin to demote.',
          },
        },
      },
      execute: async (args: { target?: string; phone_number?: string }, ctx: ExecutionContext): Promise<ToolResult> => {
        if (!ctx.isGroup) return { success: false, message: 'This tool is only available in groups.' };
        const botIsAdmin = await this.isBotAdmin(ctx.sock, ctx.chatJid);
        if (!botIsAdmin) return { success: false, message: 'Action failed: I must be made an admin in this group first.' };
        const senderIsAdmin = await this.isUserAdmin(ctx.sock, ctx.chatJid, ctx.senderJid);
        if (!senderIsAdmin) return { success: false, message: 'Permission denied: Only group admins can demote admins.' };

        const resolved = await this.resolveTargetUser(ctx.sock, ctx.chatJid, args.target || args.phone_number, ctx.rawMessage);
        if (resolved.error || !resolved.jid) {
          return { success: false, message: resolved.error || 'Could not identify which admin to demote.' };
        }

        try {
          await ctx.sock.groupParticipantsUpdate(ctx.chatJid, [resolved.jid], 'demote');
          const isLid = resolved.cleanNumber && resolved.cleanNumber.length > 13;
          const displayLabel = isLid ? 'The admin' : `@${resolved.cleanNumber}`;
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
        if (!botIsAdmin) return { success: false, message: 'Action failed: I must be made an admin in this group to change the group name.' };
        const senderIsAdmin = await this.isUserAdmin(ctx.sock, ctx.chatJid, ctx.senderJid);
        if (!senderIsAdmin) return { success: false, message: 'Permission denied: Only group admins can change the group name.' };

        try {
          await ctx.sock.groupUpdateSubject(ctx.chatJid, args.subject.trim());
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
        if (!botIsAdmin) return { success: false, message: 'Action failed: I must be made an admin in this group to update description.' };
        const senderIsAdmin = await this.isUserAdmin(ctx.sock, ctx.chatJid, ctx.senderJid);
        if (!senderIsAdmin) return { success: false, message: 'Permission denied: Only group admins can change group description.' };

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
        if (!botIsAdmin) return { success: false, message: 'Action failed: I must be made an admin in this group to retrieve invite link.' };

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
        if (!botIsAdmin) return { success: false, message: 'Action failed: I must be made an admin in this group to revoke invite link.' };
        const senderIsAdmin = await this.isUserAdmin(ctx.sock, ctx.chatJid, ctx.senderJid);
        if (!senderIsAdmin) return { success: false, message: 'Permission denied: Only group admins can revoke invite links.' };

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
      name: 'join_group',
      description: 'Joins a WhatsApp group using an invite link or invite code (e.g., https://chat.whatsapp.com/ABC123xyz or ABC123xyz). Can be called in DMs or groups whenever someone shares a group invite link.',
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
              message: 'Invalid group invite link or code. Please provide a valid WhatsApp group link (https://chat.whatsapp.com/...).',
            };
          }

          // Fetch group info first to verify link and get group subject
          let groupInfo: any = null;
          try {
            groupInfo = await ctx.sock.groupGetInviteInfo(inviteCode);
          } catch (err: any) {
            const errMsg = String(err?.message || err);
            if (errMsg.includes('404') || errMsg.includes('gone') || errMsg.includes('not-authorized')) {
              return { success: false, message: 'Could not access the group: The invite link has expired or was revoked.' };
            }
          }

          // Accept invite and join
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

          logAutonomousAction('joined_group', groupJid || 'group', ctx.senderJid, `Joined group "${groupTitle}" via invite link`);

          // Send a warm greeting into the newly joined group
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
  ];
}

export const groupAdminPlugin = new GroupAdminPlugin();
