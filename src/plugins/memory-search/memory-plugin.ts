import { IPlugin, BotTool, ExecutionContext, ToolResult } from '../types.js';
import { memoryService } from '../../memory/memory-service.js';
import { db, findKnownGroup } from '../../memory/db.js';
import { vectorStore } from '../../learning/vector-store.js';

async function getMemoryChatScope(senderJid: string, currentChatJid: string, isGroup: boolean, includeOtherChats: boolean): Promise<string[]> {
  if (isGroup || !includeOtherChats) return [currentChatJid];
  return await memoryService.getChatsForParticipant(senderJid, currentChatJid);
}

export class MemoryPlugin implements IPlugin {
  name = 'MemoryRecall';
  version = '1.0.0';
  description = 'Allows the agent to search past chat logs, recall conversations, and persist new user or group knowledge';

  tools: BotTool[] = [
    {
      name: 'search_memory',
      description: 'Searches past messages in this chat. In a private chat, set all_chats=true to also search other chats and groups where you participated. In a group, searches are limited to that group so private or other group conversations are not disclosed to its members.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Keywords, topic, or question to search the chat history for.',
          },
          all_chats: {
            type: 'boolean',
            description: 'Also search other chats and groups where you have participated.',
          },
        },
        required: ['query'],
      },
      execute: async (args: { query: string; all_chats?: boolean }, ctx: ExecutionContext): Promise<ToolResult> => {
        const chatJids = await getMemoryChatScope(ctx.senderJid, ctx.chatJid, ctx.isGroup, Boolean(args.all_chats));
        const matches = await memoryService.searchChatLogs(args.query, chatJids);
        if (matches.length === 0) {
          return {
            success: true,
            message: `No past conversation logs found matching "${args.query}".`,
            data: [],
          };
        }

        const summary = matches.map((m) => `${m.sender_name}: ${m.message_text}`).join('\n');
        return {
          success: true,
          message: `Found ${matches.length} relevant historical messages:\n${summary}`,
          data: matches,
        };
      },
    },
    {
      name: 'remember_fact',
      description: 'Records a permanent fact about the user or group into long-term memory (e.g. user preferences, personal details, project details).',
      parameters: {
        type: 'object',
        properties: {
          fact: {
            type: 'string',
            description: 'The specific fact learned (e.g. "User loves football and supports Arsenal").',
          },
          category: {
            type: 'string',
            description: 'Category of fact: "interest", "preference", "identity", or "general".',
          },
          isForGroup: {
            type: 'boolean',
            description: 'Whether this fact applies to the group culture/rules rather than the individual user.',
          },
        },
        required: ['fact'],
      },
      execute: async (args: { fact: string; category?: string; isForGroup?: boolean }, ctx: ExecutionContext): Promise<ToolResult> => {
        if (!args.fact || typeof args.fact !== 'string' || args.fact.trim().length === 0) {
          return {
            success: false,
            message: 'No valid fact provided to remember.',
          };
        }

        if (args.isForGroup && ctx.isGroup) {
          await memoryService.saveGroupFact(ctx.chatJid, args.fact.trim(), args.fact.trim());
        } else {
          await memoryService.saveUserFact(ctx.senderJid, args.fact.trim(), args.category || 'general');
        }

        return {
          success: true,
          message: `Fact successfully saved to long-term memory: "${args.fact}"`,
        };
      },
    },
    {
      name: 'get_cross_chat_activity',
      description:
        'In a private chat, recalls recent activity and completed bot actions in this chat and other chats or groups where you have participated. In a group, it only reports activity from that group.',
      parameters: {
        type: 'object',
        properties: {
          limit: {
            type: 'number',
            description: 'Number of recent conversation events to review (default: 20).',
          },
        },
      },
      execute: async (args: { limit?: number }, _ctx: ExecutionContext): Promise<ToolResult> => {
        try {
          const limit = Math.min(Math.max(Number(args.limit) || 20, 5), 50);
          const chatJids = await getMemoryChatScope(_ctx.senderJid, _ctx.chatJid, _ctx.isGroup, true);
          const chatPlaceholders = chatJids.map(() => '?').join(', ');

          // Only include chats where the requester has participated.
          const logs = await db.prepare(`
            SELECT chat_jid, sender_name, sender_jid, message_text, is_group, timestamp
            FROM chat_logs
            WHERE chat_jid IN (${chatPlaceholders})
              AND COALESCE(is_noise, 0) = 0
              AND message_text NOT LIKE 'network slow small%'
              AND message_text NOT LIKE 'Take a breather small%'
              AND LOWER(message_text) NOT LIKE '%<think%'
              AND LOWER(message_text) NOT LIKE '%<analysis%'
              AND LOWER(message_text) NOT LIKE '%<reasoning%'
              AND LOWER(message_text) NOT LIKE '%<tool_call%'
            ORDER BY id DESC LIMIT ?
          `).all(...chatJids, limit) as Array<{
            chat_jid: string;
            sender_name: string | null;
            sender_jid: string;
            message_text: string | null;
            is_group: number;
            timestamp: number;
          }>;
          const recentActions = await db.prepare(`
            SELECT id, action_type, target_chat, target_name, summary, timestamp
            FROM autonomous_actions
            WHERE target_chat IN (${chatPlaceholders})
            ORDER BY id DESC LIMIT 5
          `).all(...chatJids) as Array<{
            id: number; action_type: string; target_chat: string; target_name: string; summary: string; timestamp: number;
          }>;

          if (logs.length === 0 && recentActions.length === 0) {
            return {
              success: true,
              message: 'No recent activity recorded yet in memory logs.',
              data: { summary: 'No activity yet' },
            };
          }

          // Group by conversation
          const groupsActive = new Map<string, { count: number; subject: string; lastText: string; lastTime: number }>();
          const dmsActive = new Map<string, { count: number; name: string; lastText: string; lastTime: number }>();

          for (const l of logs) {
            const time = l.timestamp;
            const text = (l.message_text || '').replace(/\n+/g, ' ').slice(0, 80);
            if (l.is_group) {
              const grp = await findKnownGroup(l.chat_jid);
              const subject = grp?.subject || 'WhatsApp Group';
              const existing = groupsActive.get(l.chat_jid) || { count: 0, subject, lastText: text, lastTime: time };
              existing.count++;
              groupsActive.set(l.chat_jid, existing);
            } else {
              const name = l.sender_name || (l.sender_jid === 'bot' ? 'Assistant' : 'Contact');
              const existing = dmsActive.get(l.chat_jid) || { count: 0, name, lastText: text, lastTime: time };
              existing.count++;
              dmsActive.set(l.chat_jid, existing);
            }
          }

          const groupSummaries: string[] = [];
          for (const [_jid, data] of groupsActive.entries()) {
            groupSummaries.push(`- Group "${data.subject}": ${data.count} recent message(s): "${data.lastText}"`);
          }

          const dmSummaries: string[] = [];
          for (const [_jid, data] of dmsActive.entries()) {
            dmSummaries.push(`- Direct Chat (${data.name}): ${data.count} recent message(s): "${data.lastText}"`);
          }

          const totalMessages = logs.length;
          const actionSummary = recentActions.length > 0
            ? `*Recent Bot Actions:*\n${recentActions.map((a) => `- ${a.action_type}: ${a.summary} (${a.target_name || 'System'})`).join('\n')}`
            : '';
          const report =
            `📊 *Recent Cross-Chat Awareness Summary:*\n` +
            `• Evaluated last ${totalMessages} messages across ${groupsActive.size} group(s) and ${dmsActive.size} direct chat(s).\n\n` +
            (groupSummaries.length > 0 ? `*Group Activity:*\n${groupSummaries.join('\n')}\n\n` : '') +
            (dmSummaries.length > 0 ? `*Direct Message Activity:*\n${dmSummaries.join('\n')}\n\n` : '') +
            actionSummary;

          return {
            success: true,
            message: report.trim(),
            data: { totalMessages, groupsCount: groupsActive.size, dmsCount: dmsActive.size, recentActions },
          };
        } catch (err: any) {
          return { success: false, message: `Failed to compile cross-chat activity: ${err.message}` };
        }
      },
    },
    {
      name: 'get_earlier_chat_history',
      description:
        'Retrieves what has been said in this group or chat earlier on. Use whenever asked "what was said earlier?", "what were they talking about?", "summarize what was said earlier today", or for a recap of earlier messages in this chat section.',
      parameters: {
        type: 'object',
        properties: {
          limit: {
            type: 'number',
            description: 'Number of earlier messages to retrieve (default: 20, max: 50).',
          },
          sender: {
            type: 'string',
            description: 'Optional name or handle of a specific member whose earlier statements to check.',
          },
        },
      },
      execute: async (args: { limit?: number; sender?: string }, ctx: ExecutionContext): Promise<ToolResult> => {
        try {
          const limit = Math.min(Math.max(Number(args.limit) || 20, 5), 50);
          let rows: Array<{ sender_name: string | null; sender_jid: string; message_text: string | null; timestamp: number }>;

          if (args.sender && args.sender.trim()) {
            const cleanSender = args.sender.trim().toLowerCase();
            rows = await db.prepare(`
              SELECT sender_name, sender_jid, message_text, timestamp
              FROM chat_logs
              WHERE chat_jid = ? AND message_text IS NOT NULL
                AND COALESCE(is_noise, 0) = 0
                AND LOWER(message_text) NOT LIKE '%<think%'
                AND LOWER(message_text) NOT LIKE '%<analysis%'
                AND LOWER(message_text) NOT LIKE '%<reasoning%'
                AND LOWER(message_text) NOT LIKE '%<tool_call%'
                AND (LOWER(sender_name) LIKE ? OR sender_jid LIKE ?)
                AND message_text NOT LIKE 'network slow small%'
              ORDER BY id DESC LIMIT ?
            `).all(ctx.chatJid, `%${cleanSender}%`, `%${cleanSender}%`, limit) as any;
          } else {
            rows = await db.prepare(`
              SELECT sender_name, sender_jid, message_text, timestamp
              FROM chat_logs
              WHERE chat_jid = ? AND message_text IS NOT NULL
                AND COALESCE(is_noise, 0) = 0
                AND LOWER(message_text) NOT LIKE '%<think%'
                AND LOWER(message_text) NOT LIKE '%<analysis%'
                AND LOWER(message_text) NOT LIKE '%<reasoning%'
                AND LOWER(message_text) NOT LIKE '%<tool_call%'
                AND message_text NOT LIKE 'network slow small%'
              ORDER BY id DESC LIMIT ?
            `).all(ctx.chatJid, limit) as any;
          }

          if (!rows || rows.length === 0) {
            return {
              success: true,
              message: 'No earlier messages recorded for this chat yet.',
              data: [],
            };
          }

          const chronological = [...rows].reverse();
          const lines = chronological.map((r) => {
            const diffMs = Math.max(0, Date.now() - r.timestamp);
            const mins = Math.floor(diffMs / 60000);
            const timeAgo = mins < 1 ? 'just now' : mins < 60 ? `${mins}m ago` : `${Math.floor(mins / 60)}h ago`;
            const isBot = r.sender_jid === 'bot';
            const speaker = isBot ? 'Forgelabs' : (r.sender_name || 'Member');
            return `• [${speaker}] (${timeAgo}): "${r.message_text}"`;
          });

          return {
            success: true,
            message: `📜 *Earlier Discussion in This Chat (${lines.length} messages):*\n\n${lines.join('\n')}`,
            data: chronological,
          };
        } catch (err: any) {
          return { success: false, message: `Failed to retrieve earlier chat history: ${err.message}` };
        }
      },
    },
    {
      name: 'list_autonomous_actions',
      description:
        'In a private chat, lists recent autonomous events and tool actions in this chat and other chats or groups where you have participated. In a group, lists activity only from that group.',
      parameters: {
        type: 'object',
        properties: {},
      },
      execute: async (_args: {}, _ctx: ExecutionContext): Promise<ToolResult> => {
        try {
          const chatJids = await getMemoryChatScope(_ctx.senderJid, _ctx.chatJid, _ctx.isGroup, true);
          const recent = await db.prepare(`
            SELECT id, action_type, target_chat, target_name, summary, timestamp
            FROM autonomous_actions
            WHERE target_chat IN (${chatJids.map(() => '?').join(', ')})
            ORDER BY id DESC LIMIT 10
          `).all(...chatJids) as Array<{
            id: number; action_type: string; target_chat: string; target_name: string; summary: string; timestamp: number;
          }>;
          const lines: string[] = [];

          if (recent.length > 0) {
            for (const a of recent) {
              const timeStr = new Date(a.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
              lines.push(`• [${timeStr}] *${a.action_type}*: ${a.summary} (${a.target_name || 'System'})`);
            }
          }

          // Add standing autonomous capabilities summary
          const standingCapabilities =
            `🤖 *Autonomous Functions Active in Bot Runtime:*\n\n` +
            (lines.length > 0 ? `*Recent Bot Events and Tool Actions:*\n${lines.join('\n')}\n\n` : '') +
            `*Active Autonomous Capabilities:*\n` +
            `1. *Anti-Spam & Anti-Link Shield*: Autonomously deletes unauthorized group invite links and spam bursts without waiting for admin command.\n` +
            `2. *Conversation Adaptation*: Uses local chat context and language preferences; live training exports require explicit participant consent.\n` +
            `3. *Passive Contact Indexing*: Automatically captures and indexes new contacts and numbers into SQLite.\n` +
            `4. *Unreplied Message Watchdog*: Periodically scans for genuine unreplied DMs from contacts and prepares replies.\n` +
            `5. *Scheduled Morning Broadcasts & Status*: Posts daily motivational/tech insights to WhatsApp Status and registered groups.`;

          return {
            success: true,
            message: standingCapabilities,
            data: { recentActions: recent },
          };
        } catch (err: any) {
          return { success: false, message: `Failed to retrieve autonomous actions: ${err.message}` };
        }
      },
    },
    {
      name: 'search_group_banter',
      description:
        'Uses local semantic vector search to recall past group jokes and banter from this group or, when requested in a private chat, other groups where you have participated.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Topic, inside joke, nickname, quote, or phrase to search past banter vectors for.',
          },
          all_groups: {
            type: 'boolean',
            description: 'If true, searches this group and other groups where you have participated.',
          },
        },
        required: ['query'],
      },
      execute: async (args: { query: string; all_groups?: boolean }, ctx: ExecutionContext): Promise<ToolResult> => {
        try {
          const groupJids = ctx.isGroup
            ? [ctx.chatJid]
            : args.all_groups
              ? (await memoryService.getChatsForParticipant(ctx.senderJid, ctx.chatJid)).filter((jid) => jid.endsWith('@g.us'))
              : [];
          const targetChat: string | string[] = groupJids.length === 1 ? groupJids[0] : groupJids;
          const results = await vectorStore.searchBanter(args.query, targetChat, 4);

          if (results.length === 0) {
            return {
              success: true,
              message: `No past group banter found matching "${args.query}".`,
              data: [],
            };
          }

          const formatted = results
            .map(
              (r, idx) =>
                `${idx + 1}. [${r.senderName}] (${r.timeAgoStr}): "${r.messageText}"${
                  r.contextText ? ` (Context: "${r.contextText}")` : ''
                }`
            )
            .join('\n');

          return {
            success: true,
            message: `Found ${results.length} memorable banter moments from group history:\n${formatted}`,
            data: results,
          };
        } catch (err: any) {
          return {
            success: false,
            message: `Error searching group banter vectors: ${err.message}`,
          };
        }
      },
    },
  ];
}

export const memoryPlugin = new MemoryPlugin();
