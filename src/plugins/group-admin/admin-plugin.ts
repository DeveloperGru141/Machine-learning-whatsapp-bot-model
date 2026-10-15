import { IPlugin, BotTool, ExecutionContext, ToolResult } from '../types.js';
import { config } from '../../config/env.js';

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
      const botNumber = (sock.user?.id || '').split(':')[0] + '@s.whatsapp.net';
      const botParticipant = meta.participants.find(
        (p: any) => p.id === sock.user?.id || p.id === botNumber
      );
      return botParticipant?.admin === 'admin' || botParticipant?.admin === 'superadmin';
    } catch {
      return false;
    }
  }

  /**
   * Helper to verify if the requesting user is an admin or bot owner
   */
  private async isUserAdmin(sock: any, groupJid: string, senderJid: string): Promise<boolean> {
    const rawNumber = senderJid.split('@')[0];
    if (config.bot.owners.includes(rawNumber)) return true;

    try {
      const meta = await sock.groupMetadata(groupJid);
      const user = meta.participants.find((p: any) => p.id === senderJid);
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

          await ctx.sock.sendMessage(ctx.chatJid, {
            text: header + mentionTags,
            mentions,
          });

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

        const cleanNumber = args.phone_number.replace(/[^0-9]/g, '');
        const targetJid = cleanNumber.includes('@') ? cleanNumber : `${cleanNumber}@s.whatsapp.net`;

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
  ];
}

export const groupAdminPlugin = new GroupAdminPlugin();
