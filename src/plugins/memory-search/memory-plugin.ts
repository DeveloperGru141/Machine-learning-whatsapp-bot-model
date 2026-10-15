import { IPlugin, BotTool, ExecutionContext, ToolResult } from '../types.js';
import { memoryService } from '../../memory/memory-service.js';

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
        if (args.isForGroup && ctx.isGroup) {
          memoryService.saveGroupFact(ctx.chatJid, args.fact, args.fact);
        } else {
          memoryService.saveUserFact(ctx.senderJid, args.fact, args.category || 'general');
        }

        return {
          success: true,
          message: `Fact successfully saved to long-term memory: "${args.fact}"`,
        };
      },
    },
  ];
}

export const memoryPlugin = new MemoryPlugin();
