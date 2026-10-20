import fs from 'fs';
import { IPlugin, BotTool, ExecutionContext, ToolResult } from '../types.js';
import { stickerEngine, StickerVibe } from './sticker-engine.js';
import { OutboundSender } from '../../core/sender.js';
import { chatLogger } from '../../memory/chat-logger.js';

export class StickerPlugin implements IPlugin {
  name = 'StickerEngine';
  version = '1.0.0';
  description = 'Intelligent pattern-based sticker engine that selects and sends stickers matching the active conversation mood';

  public async onLoad(): Promise<void> {
    stickerEngine.initialize();
  }

  tools: BotTool[] = [
    {
      name: 'send_contextual_sticker',
      description:
        'Sends a sticker from the 550+ sticker catalog matching the emotional vibe and pattern of the active conversation (humor/laughter, celebration, agreement/facts, shock, teasing/banter, cool, salute, or facepalm).',
      parameters: {
        type: 'object',
        properties: {
          vibe: {
            type: 'string',
            enum: [
              'humor',
              'celebration',
              'agreement',
              'shock',
              'teasing',
              'cool',
              'confusion',
              'facepalm',
              'salute',
              'general',
            ],
            description:
              'Optional emotional vibe to match: "humor" (laughter/jokes), "celebration" (fire/hype/wins), "agreement" (facts/thumbsup/100), "shock" (surprise/mindblown), "teasing" (playful shade/sideeye), "cool" (swag/boss), "salute" (respect/twale), "confusion" (hmm/question). If omitted, auto-detected from conversation context.',
          },
        },
      },
      execute: async (
        args: { vibe?: string },
        ctx: ExecutionContext
      ): Promise<ToolResult> => {
        try {
          const match = stickerEngine.getMatchingSticker(
            ctx.rawMessage?.message?.conversation || '',
            args.vibe as StickerVibe
          );

          if (!match || !fs.existsSync(match.absolutePath)) {
            return { success: false, message: 'Could not find a matching sticker for this mood.' };
          }

          if (ctx.sendSticker) {
            await ctx.sendSticker(match.absolutePath);
          } else if (ctx.sock) {
            await OutboundSender.sendSticker(ctx.sock, ctx.chatJid, match.absolutePath, ctx.rawMessage);
          }

          chatLogger.logOutboundMessage(ctx.chatJid, `[Sticker: ${match.filename}] (${match.vibe})`);

          return {
            success: true,
            message: `Sent sticker [${match.filename}] matching the vibe "${match.vibe}"!`,
            data: { filename: match.filename, vibe: match.vibe },
          };
        } catch (err: any) {
          return { success: false, message: `Failed to send sticker: ${err.message}` };
        }
      },
    },
  ];
}

export const stickerPlugin = new StickerPlugin();
