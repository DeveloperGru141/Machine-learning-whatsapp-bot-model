import fs from 'fs';
import path from 'path';
import type { WASocket } from '@whiskeysockets/baileys';
import { IPlugin, BotTool, ExecutionContext, ToolResult } from '../types.js';
import {
  getLatestViewOnceMessages,
  markViewOnceRetrieved,
  ViewOnceRecord,
} from '../../memory/db.js';
import { userProfileManager } from '../../memory/user-profiles.js';

let activeSocket: WASocket | null = null;

export function setViewOnceSocket(sock: WASocket): void {
  activeSocket = sock;
}

/**
 * Delivers a captured View-Once media message (image, video, or audio) directly to the owner.
 */
export async function deliverViewOnceMediaToOwner(
  sock: WASocket,
  ownerJid: string,
  record: ViewOnceRecord,
  quoted?: any
): Promise<boolean> {
  if (!fs.existsSync(record.file_path)) {
    await sock.sendMessage(
      ownerJid,
      { text: `⚠️ View-once media file not found on disk: ${record.file_path}` },
      quoted ? { quoted } : undefined
    );
    return false;
  }

  const fileBuffer = fs.readFileSync(record.file_path);
  const timeStr = new Date(record.timestamp).toLocaleString('en-US', { timeZone: 'Africa/Lagos' });
  const senderDisplay = record.sender_name || 'Contact';
  const chatDisplay = record.chat_name || (record.is_group ? 'Group Chat' : 'Direct Message');
  const caption =
    `👁️ *VIEW-ONCE MEDIA RECOVERED*\n` +
    `👤 *From:* ${senderDisplay}\n` +
    `📍 *Origin:* ${chatDisplay}\n` +
    `📅 *Captured At:* ${timeStr} WAT\n` +
    `📦 *Media:* ${record.media_type.toUpperCase()} (${Math.round(record.file_size / 1024)} KB)\n` +
    (record.caption ? `💬 *Original Caption:* ${record.caption}\n` : '') +
    `\n— *Forgelabs Vault* 🛡️`;

  try {
    if (record.media_type === 'video') {
      await sock.sendMessage(ownerJid, {
        video: fileBuffer,
        caption,
        mimetype: 'video/mp4',
      });
    } else if (record.media_type === 'audio') {
      await sock.sendMessage(ownerJid, {
        audio: fileBuffer,
        mimetype: 'audio/ogg; codecs=opus',
        ptt: true,
      });
      await sock.sendMessage(ownerJid, { text: caption });
    } else {
      await sock.sendMessage(ownerJid, {
        image: fileBuffer,
        caption,
      });
    }

    markViewOnceRetrieved(record.id);
    return true;
  } catch (err: any) {
    console.error(`[ViewOnce] Failed to deliver media to owner:`, err.message);
    await sock.sendMessage(ownerJid, {
      text: `❌ Error sending recovered view-once media: ${err.message}`,
    });
    return false;
  }
}

/**
 * Tool: retrieve_view_once
 */
const retrieveViewOnceTool: BotTool = {
  name: 'retrieve_view_once',
  description:
    'Retrieves a captured WhatsApp View-Once media message (image, video, or voice note) and delivers it directly to the bot owner in their private DM. Strictly accessible only by the bot owner in a 1-on-1 private chat.',
  parameters: {
    type: 'object',
    properties: {
      index: {
        type: 'number',
        description: 'Which view-once message to retrieve (1 for most recent, 2 for second most recent, etc.). Default is 1.',
      },
      query: {
        type: 'string',
        description: 'Optional filter by sender name, chat name, or caption keyword (e.g. "Sarah", "Kelvin", "party").',
      },
    },
  },
  execute: async (args: { index?: number; query?: string }, ctx: ExecutionContext): Promise<ToolResult> => {
    const isOwner = userProfileManager.isOwner(ctx.senderJid, ctx.senderName);
    if (!isOwner) {
      return {
        success: false,
        message: 'Permission denied: View-once message retrieval is strictly restricted to the verified bot owner.',
      };
    }

    if (ctx.isGroup) {
      return {
        success: false,
        message: 'Security policy: View-once messages can NEVER be retrieved in public group chats. Please request this in our 1-on-1 private DM.',
      };
    }

    const sock = activeSocket || ctx.sock;
    if (!sock) {
      return {
        success: false,
        message: 'WhatsApp connection socket is currently unavailable.',
      };
    }

    const records = getLatestViewOnceMessages(10, args.query);
    if (records.length === 0) {
      return {
        success: false,
        message: args.query
          ? `No captured view-once messages matching "${args.query}" were found in the vault.`
          : 'No captured view-once messages exist in the vault yet.',
      };
    }

    const targetIdx = Math.max(0, (args.index || 1) - 1);
    const selected = records[targetIdx] || records[0];

    const ownerJid = ctx.chatJid;
    const delivered = await deliverViewOnceMediaToOwner(sock, ownerJid, selected);

    if (delivered) {
      return {
        success: true,
        message: `Successfully sent view-once ${selected.media_type} from ${selected.sender_name || 'contact'} to your DM.`,
        data: {
          delivered: true,
          messageId: selected.message_id,
          sender: selected.sender_name || 'Contact',
          chat: selected.chat_name || (selected.is_group ? 'Group Chat' : 'Direct Message'),
          mediaType: selected.media_type,
          timestamp: new Date(selected.timestamp).toISOString(),
          totalAvailable: records.length,
          caption: selected.caption,
        },
      };
    } else {
      return {
        success: false,
        message: 'Failed to dispatch the view-once media file to your DM.',
      };
    }
  },
};

/**
 * Tool: list_view_once
 */
const listViewOnceTool: BotTool = {
  name: 'list_view_once',
  description:
    'Lists the most recently captured View-Once media messages with sender names, originating chats, media types, and timestamps. Strictly accessible only by the bot owner in private DM.',
  parameters: {
    type: 'object',
    properties: {
      limit: {
        type: 'number',
        description: 'Number of recent view-once records to inspect (default 5).',
      },
      query: {
        type: 'string',
        description: 'Optional filter by sender name, chat name, or caption keyword.',
      },
    },
  },
  execute: async (args: { limit?: number; query?: string }, ctx: ExecutionContext): Promise<ToolResult> => {
    const isOwner = userProfileManager.isOwner(ctx.senderJid, ctx.senderName);
    if (!isOwner) {
      return {
        success: false,
        message: 'Permission denied: View-once message inspection is restricted to the bot owner.',
      };
    }

    if (ctx.isGroup) {
      return {
        success: false,
        message: 'Security policy: View-once messages cannot be listed in public groups. Please query in private DM.',
      };
    }

    const records = getLatestViewOnceMessages(args.limit || 5, args.query);
    if (records.length === 0) {
      return {
        success: true,
        message: 'The View-Once vault is currently empty.',
        data: {
          count: 0,
        },
      };
    }

    const list = records.map((r, idx) => ({
      index: idx + 1,
      id: r.id,
      sender: r.sender_name || 'Contact',
      chat: r.chat_name || (r.is_group ? 'Group Chat' : 'Direct Message'),
      mediaType: r.media_type,
      sizeKB: Math.round(r.file_size / 1024),
      time: new Date(r.timestamp).toLocaleString('en-US', { timeZone: 'Africa/Lagos' }),
      caption: r.caption || 'None',
      timesRetrieved: r.retrieved_count,
    }));

    return {
      success: true,
      message: `Found ${list.length} captured view-once items.`,
      data: {
        count: list.length,
        records: list,
      },
    };
  },
};

export const viewOncePlugin: IPlugin = {
  name: 'ViewOnceVault',
  version: '1.0.0',
  description: 'Anti-ViewOnce interceptor and media retrieval vault for the bot owner',
  tools: [retrieveViewOnceTool, listViewOnceTool],
  onLoad: async () => {
    const dir = path.resolve('data/view_once');
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  },
};
