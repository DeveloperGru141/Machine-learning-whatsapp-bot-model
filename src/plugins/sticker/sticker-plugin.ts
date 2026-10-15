import fs from 'fs';
import path from 'path';
import sharp from 'sharp';
import crypto from 'crypto';
import { downloadMediaMessage } from '@whiskeysockets/baileys';
import { IPlugin, BotTool, ExecutionContext, ToolResult } from '../types.js';
import { config } from '../../config/env.js';
import { db } from '../../memory/db.js';
import { memoryService } from '../../memory/memory-service.js';

export class StickerPlugin implements IPlugin {
  name = 'StickerEngine';
  version = '1.1.0';
  description = 'Autonomous sticker engine: indexes catalog, harvests new stickers across chats, creates stickers from images, and contextually dispatches stickers based on chat sentiment';

  async onLoad(): Promise<void> {
    await this.indexLocalStickers();
  }

  public async indexLocalStickers(): Promise<void> {
    const stickerDir = config.paths.stickers;
    if (!fs.existsSync(stickerDir)) {
      fs.mkdirSync(stickerDir, { recursive: true });
    }

    const files = fs.readdirSync(stickerDir).filter((f) => f.endsWith('.webp'));
    const insertStmt = db.prepare(`
      INSERT INTO sticker_catalog (filename, vibe_tags, description, learned_triggers, added_at)
      VALUES (?, ?, ?, '[]', ?)
      ON CONFLICT(filename) DO NOTHING
    `);

    for (const file of files) {
      const baseName = path.basename(file, '.webp').replace(/[-_]/g, ' ');
      insertStmt.run(file, baseName, `Local sticker: ${baseName}`, Date.now());
    }

    console.log(`[StickerEngine] Indexed ${files.length} stickers from ${stickerDir}`);
  }

  /**
   * Harvests an incoming sticker from any human chat into the local catalog
   * so the bot's sticker vocabulary expands organically over time!
   */
  public async harvestIncomingSticker(rawMsg: any): Promise<string | null> {
    try {
      if (!rawMsg.message?.stickerMessage) return null;

      const buffer = (await downloadMediaMessage(rawMsg, 'buffer', {})) as Buffer;
      if (!buffer || buffer.length === 0) return null;

      const hash = crypto.createHash('md5').update(buffer).digest('hex').slice(0, 12);
      const filename = `harvested_${hash}.webp`;
      const fullPath = path.join(config.paths.stickers, filename);

      if (!fs.existsSync(fullPath)) {
        fs.writeFileSync(fullPath, buffer);
        db.prepare(`
          INSERT INTO sticker_catalog (filename, vibe_tags, description, learned_triggers, added_at)
          VALUES (?, 'harvested, expressive, reaction', 'Auto-harvested chat sticker', '[]', ?)
          ON CONFLICT(filename) DO NOTHING
        `).run(filename, Date.now());
      }

      return filename;
    } catch {
      return null;
    }
  }

  tools: BotTool[] = [
    {
      name: 'send_sticker',
      description: 'Sends a sticker from the bot WhatsApp sticker directory matching a requested mood, reaction, emotion, or learned chat pattern.',
      parameters: {
        type: 'object',
        properties: {
          emotion_or_vibe: {
            type: 'string',
            description: 'The emotion or vibe to convey (e.g. laugh, celebratory, facepalm, agree, confused, roast, shock, greeting).',
          },
          reason: {
            type: 'string',
            description: 'Short reasoning why sending a sticker fits this conversational moment.',
          },
        },
        required: ['emotion_or_vibe'],
      },
      execute: async (args: { emotion_or_vibe: string; reason?: string }, ctx: ExecutionContext): Promise<ToolResult> => {
        const match = memoryService.findStickerByVibe(args.emotion_or_vibe);
        if (!match) {
          return {
            success: false,
            message: `No sticker found in the local catalog matching vibe "${args.emotion_or_vibe}". Please reply with text instead.`,
          };
        }

        const fullPath = path.join(config.paths.stickers, match.filename);
        if (!fs.existsSync(fullPath)) {
          return {
            success: false,
            message: `Sticker file ${match.filename} is missing on disk.`,
          };
        }

        try {
          await ctx.sendSticker(fullPath);
          return {
            success: true,
            message: `Sticker [${match.filename}] successfully sent to chat for mood "${args.emotion_or_vibe}".`,
          };
        } catch (err: any) {
          return {
            success: false,
            message: `Failed to send sticker: ${err.message}`,
          };
        }
      },
    },
    {
      name: 'create_sticker',
      description: 'Converts an attached image or quoted image into a WhatsApp sticker and adds it to the bot local sticker catalog.',
      parameters: {
        type: 'object',
        properties: {
          vibe_tags: {
            type: 'string',
            description: 'Optional comma-separated tags or mood describing this sticker (e.g. "funny, laughing, cat").',
          },
        },
      },
      execute: async (args: { vibe_tags?: string }, ctx: ExecutionContext): Promise<ToolResult> => {
        try {
          const raw = ctx.rawMessage;
          const contextInfo =
            raw.message?.extendedTextMessage?.contextInfo ||
            raw.message?.imageMessage?.contextInfo;

          let targetMessage: any = null;

          // Check if quoting an image/sticker message
          if (contextInfo?.quotedMessage?.imageMessage) {
            targetMessage = {
              key: {
                remoteJid: ctx.chatJid,
                id: contextInfo.stanzaId,
                participant: contextInfo.participant,
              },
              message: contextInfo.quotedMessage,
            };
          } else if (raw.message?.imageMessage) {
            // Check if current message is an image
            targetMessage = raw;
          }

          if (!targetMessage) {
            return {
              success: false,
              message: 'No image found. Please reply directly to an image or send an image with your request to create a sticker.',
            };
          }

          // Download image media from WhatsApp
          const rawBuffer = (await downloadMediaMessage(targetMessage, 'buffer', {})) as Buffer;

          // Convert to 512x512 WebP sticker format using sharp
          const stickerBuffer = await sharp(rawBuffer)
            .resize(512, 512, {
              fit: 'contain',
              background: { r: 0, g: 0, b: 0, alpha: 0 },
            })
            .webp({ quality: 80 })
            .toBuffer();

          // Save to local sticker repository
          const hash = crypto.createHash('md5').update(stickerBuffer).digest('hex').slice(0, 10);
          const filename = `custom_${hash}.webp`;
          const filePath = path.join(config.paths.stickers, filename);
          fs.writeFileSync(filePath, stickerBuffer);

          // Index in database
          const tags = args.vibe_tags || 'custom, user_created';
          db.prepare(`
            INSERT INTO sticker_catalog (filename, vibe_tags, description, learned_triggers, added_at)
            VALUES (?, ?, 'User-created custom sticker', '[]', ?)
            ON CONFLICT(filename) DO NOTHING
          `).run(filename, tags, Date.now());

          // Send the sticker back to the user
          await ctx.sendSticker(stickerBuffer);

          return {
            success: true,
            message: `Sticker successfully created, saved as ${filename}, and delivered to chat!`,
          };
        } catch (err: any) {
          console.error('[StickerEngine] Error creating sticker:', err);
          return { success: false, message: `Failed to create sticker: ${err.message}` };
        }
      },
    },
  ];
}

export const stickerPlugin = new StickerPlugin();
