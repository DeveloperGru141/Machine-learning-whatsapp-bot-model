import { IPlugin, BotTool, ExecutionContext, ToolResult } from '../types.js';
import { config } from '../../config/env.js';
import { userProfileManager } from '../../memory/user-profiles.js';
import { chatLogger } from '../../memory/chat-logger.js';

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
      // Delete the spam link
      await sock.sendMessage(chatJid, { delete: msg.key });
      await sock.sendMessage(chatJid, {
        text: `⚠️ @${senderJid.split('@')[0]}, group invite links are not permitted here!`,
        mentions: [senderJid],
      });
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
          const header = `📢 *GROUP ANNOUNCEMENT*\n\n${args.announcement}\n\n`;
          const mentionTags = mentions.map((m: any) => `@${m.split('@')[0]}`).join(' ');
          const fullText = header + mentionTags;

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
      description: 'Removes/kicks a specified member from the group. Requires the bot to be an admin.',
      parameters: {
        type: 'object',
        properties: {
          phone_number: {
            type: 'string',
            description: 'Phone number or JID of the user to remove (e.g. "2348012345678").',
          },
          reason: {
            type: 'string',
            description: 'Reason for removal.',
          },
        },
        required: ['phone_number'],
      },
      execute: async (args: { phone_number: string; reason?: string }, ctx: ExecutionContext): Promise<ToolResult> => {
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

        const cleanNumber = args.phone_number.split('@')[0].split(':')[0].replace(/[^0-9]/g, '');
        const targetJid = args.phone_number.endsWith('@lid')
          ? `${cleanNumber}@lid`
          : `${cleanNumber}@s.whatsapp.net`;

        try {
          await ctx.sock.groupParticipantsUpdate(ctx.chatJid, [targetJid], 'remove');
          return {
            success: true,
            message: `User @${cleanNumber} has been removed from the group. ${args.reason ? `Reason: ${args.reason}` : ''}`,
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
      description: 'Promotes a group member to admin status. Requires the bot to be an admin in the group, and requester must be admin/owner.',
      parameters: {
        type: 'object',
        properties: {
          phone_number: {
            type: 'string',
            description: 'Phone number or JID of the user to promote to admin.',
          },
        },
        required: ['phone_number'],
      },
      execute: async (args: { phone_number: string }, ctx: ExecutionContext): Promise<ToolResult> => {
        if (!ctx.isGroup) return { success: false, message: 'This tool is only available in groups.' };
        const botIsAdmin = await this.isBotAdmin(ctx.sock, ctx.chatJid);
        if (!botIsAdmin) return { success: false, message: 'Action failed: I must be made an admin in this group first.' };
        const senderIsAdmin = await this.isUserAdmin(ctx.sock, ctx.chatJid, ctx.senderJid);
        if (!senderIsAdmin) return { success: false, message: 'Permission denied: Only group admins can promote members.' };

        const cleanNumber = args.phone_number.split('@')[0].split(':')[0].replace(/[^0-9]/g, '');
        const targetJid = args.phone_number.endsWith('@lid') ? `${cleanNumber}@lid` : `${cleanNumber}@s.whatsapp.net`;
        try {
          await ctx.sock.groupParticipantsUpdate(ctx.chatJid, [targetJid], 'promote');
          return { success: true, message: `User @${cleanNumber} has been successfully promoted to group admin.` };
        } catch (err: any) {
          return { success: false, message: `Failed to promote user: ${err.message}` };
        }
      },
    },
    {
      name: 'demote_member',
      description: 'Demotes a group admin back to regular member. Requires the bot to be an admin in the group, and requester must be admin/owner.',
      parameters: {
        type: 'object',
        properties: {
          phone_number: {
            type: 'string',
            description: 'Phone number or JID of the admin to demote.',
          },
        },
        required: ['phone_number'],
      },
      execute: async (args: { phone_number: string }, ctx: ExecutionContext): Promise<ToolResult> => {
        if (!ctx.isGroup) return { success: false, message: 'This tool is only available in groups.' };
        const botIsAdmin = await this.isBotAdmin(ctx.sock, ctx.chatJid);
        if (!botIsAdmin) return { success: false, message: 'Action failed: I must be made an admin in this group first.' };
        const senderIsAdmin = await this.isUserAdmin(ctx.sock, ctx.chatJid, ctx.senderJid);
        if (!senderIsAdmin) return { success: false, message: 'Permission denied: Only group admins can demote admins.' };

        const cleanNumber = args.phone_number.split('@')[0].split(':')[0].replace(/[^0-9]/g, '');
        const targetJid = args.phone_number.endsWith('@lid') ? `${cleanNumber}@lid` : `${cleanNumber}@s.whatsapp.net`;
        try {
          await ctx.sock.groupParticipantsUpdate(ctx.chatJid, [targetJid], 'demote');
          return { success: true, message: `Admin @${cleanNumber} has been demoted to a regular member.` };
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
  ];
}

export const groupAdminPlugin = new GroupAdminPlugin();
