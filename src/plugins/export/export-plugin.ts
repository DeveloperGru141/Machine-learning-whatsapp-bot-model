import fs from 'fs';
import path from 'path';
import { IPlugin, BotTool, ExecutionContext, ToolResult } from '../types.js';
import { db } from '../../memory/db.js';
import { config } from '../../config/env.js';

interface ChatLogRow {
  id: number;
  chat_jid: string;
  sender_jid: string;
  sender_name: string | null;
  is_group: number;
  content_type: string;
  message_text: string | null;
  sticker_filename: string | null;
  timestamp: number;
}

export const exportChatTool: BotTool = {
  name: 'export_chat',
  description:
    'Exports the recent message history of the current chat as a formatted text (.txt) or structured JSON (.json) document and sends it directly to the chat.',
  parameters: {
    type: 'object',
    properties: {
      format: {
        type: 'string',
        enum: ['txt', 'json'],
        description: 'Export format: "txt" for a readable conversation log, or "json" for full structured metadata. Defaults to "txt".',
      },
      limit: {
        type: 'number',
        description: 'Maximum number of recent messages to export. Defaults to 100 (max: 1000).',
      },
    },
  },
  execute: async (
    args: { format?: 'txt' | 'json'; limit?: number },
    ctx: ExecutionContext
  ): Promise<ToolResult> => {
    const format = args.format === 'json' ? 'json' : 'txt';
    const limit = Math.min(Math.max(Number(args.limit) || 100, 1), 1000);

    try {
      // 1. Query the recent chat_logs for the current chatJid ordered by timestamp
      const rows = db
        .prepare(`
          SELECT id, chat_jid, sender_jid, sender_name, is_group, content_type, message_text, sticker_filename, timestamp
          FROM (
            SELECT id, chat_jid, sender_jid, sender_name, is_group, content_type, message_text, sticker_filename, timestamp
            FROM chat_logs
            WHERE chat_jid = ?
            ORDER BY timestamp DESC
            LIMIT ?
          )
          ORDER BY timestamp ASC
        `)
        .all(ctx.chatJid, limit) as unknown as ChatLogRow[];

      if (rows.length === 0) {
        return {
          success: false,
          message: 'No recorded chat messages found in history for this chat to export.',
        };
      }

      // 2. Format content
      let fileContent: string;
      const fileName = format === 'json' ? 'chat_export.json' : 'chat_export.txt';
      const mimetype = format === 'json' ? 'application/json' : 'text/plain';

      if (format === 'json') {
        fileContent = JSON.stringify(
          {
            chatJid: ctx.chatJid,
            exportedAt: new Date().toISOString(),
            totalMessages: rows.length,
            messages: rows,
          },
          null,
          2
        );
      } else {
        const header = [
          `============================================================`,
          `Chat History Export for: ${ctx.chatJid}`,
          `Exported At: ${new Date().toISOString().replace('T', ' ').slice(0, 19)} UTC`,
          `Total Messages: ${rows.length}`,
          `============================================================\n`,
        ].join('\n');

        const messageLines = rows.map((row) => {
          const time = new Date(row.timestamp).toISOString().replace('T', ' ').slice(0, 19);
          const author = row.sender_name || row.sender_jid.split('@')[0];
          let body = row.message_text || '';

          if (row.content_type === 'sticker') {
            body = `[Sticker: ${row.sticker_filename || 'sticker'}]`;
          } else if (row.content_type === 'image') {
            body = row.message_text ? `[Image: ${row.message_text}]` : '[Image]';
          } else if (row.content_type === 'audio') {
            body = row.message_text ? `[Audio/VoiceNote: ${row.message_text}]` : '[Audio/VoiceNote]';
          }

          return `[${time}] ${author}: ${body}`;
        });

        fileContent = header + messageLines.join('\n');
      }

      // 3. Write to temporary file in config.paths.temp
      const tempDir = config.paths.temp;
      if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir, { recursive: true });
      }

      const tempFilePath = path.join(tempDir, `export_${Date.now()}_${fileName}`);
      fs.writeFileSync(tempFilePath, fileContent, 'utf-8');

      // 4. Read buffer and dispatch document via WhatsApp socket
      const buffer = fs.readFileSync(tempFilePath);

      try {
        await ctx.sock.sendMessage(ctx.chatJid, {
          document: buffer,
          mimetype,
          fileName,
        });
        console.log(`[ConversationExport] Exported ${rows.length} messages to ${ctx.chatJid} as ${fileName}`);
      } finally {
        // 5. Clean up temporary file
        if (fs.existsSync(tempFilePath)) {
          try {
            fs.unlinkSync(tempFilePath);
          } catch (cleanErr) {
            console.warn('[ConversationExport] Failed to delete temp file:', cleanErr);
          }
        }
      }

      return {
        success: true,
        message: `Successfully exported ${rows.length} messages and dispatched document "${fileName}".`,
        data: {
          count: rows.length,
          format,
          fileName,
        },
      };
    } catch (err: any) {
      console.error('[ConversationExport] Error generating export:', err);
      return {
        success: false,
        message: `Failed to export conversation: ${err.message}`,
      };
    }
  },
};

export class ConversationExportPlugin implements IPlugin {
  name = 'ConversationExport';
  version = '1.0.0';
  description = 'Exports chat history as formatted text or structured JSON document files.';
  tools: BotTool[] = [exportChatTool];
}

export const conversationExportPlugin = new ConversationExportPlugin();
