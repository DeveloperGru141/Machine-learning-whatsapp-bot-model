import { IPlugin, BotTool, ExecutionContext, ToolResult } from '../types.js';
import { memoryService } from '../../memory/memory-service.js';
import { db, getRecentAutonomousActions, findKnownGroup } from '../../memory/db.js';
import { userProfileManager } from '../../memory/user-profiles.js';
import { vectorStore } from '../../learning/vector-store.js';

export class MemoryPlugin implements IPlugin {
  name = 'MemoryRecall';
  version = '1.0.0';
  description = 'Allows the agent to search past chat logs, recall conversations, and persist new user or group knowledge';

  tools: BotTool[] = [
    {
      name: 'search_memory',
      description: 'Searches the database of past conversations, messages, and facts discussed previously in this chat.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Keywords, topic, or question to search the chat history for.',
          },
        },
        required: ['query'],
      },
      execute: async (args: { query: string }, ctx: ExecutionContext): Promise<ToolResult> => {
        const matches = memoryService.searchChatLogs(args.query, ctx.chatJid);
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
          memoryService.saveGroupFact(ctx.chatJid, args.fact.trim(), args.fact.trim());
        } else {
          memoryService.saveUserFact(ctx.senderJid, args.fact.trim(), args.category || 'general');
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
        'Provides situational awareness of what the bot has been doing across all WhatsApp chats and groups: recent conversations, group interactions, admin moderation, and dispatched actions. Use when the owner or user asks what you have been doing across chats, which groups you are in, or what happened recently.',
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
        const isOwner = userProfileManager.isOwner(_ctx.senderJid);

        try {
          const limit = Math.min(Math.max(Number(args.limit) || 20, 5), 50);

          // 1. Fetch recent exchanges across chats
          const logs = db.prepare(`
            SELECT chat_jid, sender_name, sender_jid, message_text, is_group, timestamp
            FROM chat_logs
            WHERE message_text NOT LIKE 'network slow small%'
              AND message_text NOT LIKE 'Take a breather small%'
            ORDER BY id DESC LIMIT ?
          `).all(limit) as Array<{
            chat_jid: string;
            sender_name: string | null;
            sender_jid: string;
            message_text: string | null;
            is_group: number;
            timestamp: number;
          }>;

          if (logs.length === 0) {
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
              const grp = findKnownGroup(l.chat_jid);
              const subject = grp?.subject || 'WhatsApp Group';
              const existing = groupsActive.get(l.chat_jid) || { count: 0, subject, lastText: text, lastTime: time };
              existing.count++;
              groupsActive.set(l.chat_jid, existing);
            } else {
              const name = isOwner
                ? (l.sender_name || (l.sender_jid === 'bot' ? 'Assistant' : 'Contact'))
                : 'Community User';
              const existing = dmsActive.get(l.chat_jid) || { count: 0, name, lastText: text, lastTime: time };
              existing.count++;
              dmsActive.set(l.chat_jid, existing);
            }
          }

          const groupSummaries: string[] = [];
          for (const [_jid, data] of groupsActive.entries()) {
            const textSnippet = isOwner ? `: "${data.lastText}"` : '';
            groupSummaries.push(`- Group "${data.subject}": ${data.count} recent message(s)${textSnippet}`);
          }

          const dmSummaries: string[] = [];
          for (const [_jid, data] of dmsActive.entries()) {
            const textSnippet = isOwner ? `: "${data.lastText}"` : '';
            dmSummaries.push(`- Direct Chat (${data.name}): ${data.count} recent message(s)${textSnippet}`);
          }

          const totalMessages = logs.length;
          const report =
            `📊 *Recent Cross-Chat Awareness Summary:*\n` +
            `• Evaluated last ${totalMessages} messages across ${groupsActive.size} group(s) and ${dmsActive.size} direct chat(s).\n\n` +
            (groupSummaries.length > 0 ? `*Group Activity:*\n${groupSummaries.join('\n')}\n\n` : '') +
            (dmSummaries.length > 0 ? `*Direct Message Activity:*\n${dmSummaries.join('\n')}` : '');

          return {
            success: true,
            message: report.trim(),
            data: { totalMessages, groupsCount: groupsActive.size, dmsCount: dmsActive.size },
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
            rows = db.prepare(`
              SELECT sender_name, sender_jid, message_text, timestamp
              FROM chat_logs
              WHERE chat_jid = ? AND message_text IS NOT NULL
                AND (LOWER(sender_name) LIKE ? OR sender_jid LIKE ?)
                AND message_text NOT LIKE 'network slow small%'
              ORDER BY id DESC LIMIT ?
            `).all(ctx.chatJid, `%${cleanSender}%`, `%${cleanSender}%`, limit) as any;
          } else {
            rows = db.prepare(`
              SELECT sender_name, sender_jid, message_text, timestamp
              FROM chat_logs
              WHERE chat_jid = ? AND message_text IS NOT NULL
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
        'Lists autonomous actions and self-directed functions the bot executed on its own without being commanded (unreplied DM check-ins, auto-moderation of spam links, passive contact indexing, continuous pattern learning, and scheduled broadcasts). Use when the owner asks what you do on your own or asks about your sentience/autonomy.',
      parameters: {
        type: 'object',
        properties: {},
      },
      execute: async (_args: {}, _ctx: ExecutionContext): Promise<ToolResult> => {
        try {
          const recent = getRecentAutonomousActions(10);
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
            (lines.length > 0 ? `*Recent Self-Directed Events:*\n${lines.join('\n')}\n\n` : '') +
            `*Active Autonomous Capabilities:*\n` +
            `1. *Anti-Spam & Anti-Link Shield*: Autonomously deletes unauthorized group invite links and spam bursts without waiting for admin command.\n` +
            `2. *Continuous Pattern Mining*: Passively learns speaking styles, slang, and formality metrics every 8 exchanges.\n` +
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
        'Uses local semantic vector search to recall past group jokes, funny quotes, inside jokes, roasts, and memorable banter from this group or across WhatsApp groups.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Topic, inside joke, nickname, quote, or phrase to search past banter vectors for.',
          },
          all_groups: {
            type: 'boolean',
            description: 'If true, searches banter across all known WhatsApp groups; otherwise searches this group only.',
          },
        },
        required: ['query'],
      },
      execute: async (args: { query: string; all_groups?: boolean }, ctx: ExecutionContext): Promise<ToolResult> => {
        try {
          const targetChat = args.all_groups ? undefined : ctx.isGroup ? ctx.chatJid : undefined;
          const results = vectorStore.searchBanter(args.query, targetChat, 4);

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
