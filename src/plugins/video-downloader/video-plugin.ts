import { exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { IPlugin, BotTool, ExecutionContext, ToolResult } from '../types.js';
import { config } from '../../config/env.js';

const execAsync = promisify(exec);

export class VideoDownloaderPlugin implements IPlugin {
  name = 'VideoDownloader';
  version = '1.0.0';
  description = 'Downloads social media videos from Instagram, TikTok, YouTube Shorts, Twitter/X, and Facebook';

  tools: BotTool[] = [
    {
      name: 'download_video',
      description: 'Downloads a video from a social media link (TikTok, Instagram, YouTube, Twitter/X, Facebook) and sends it as a playable WhatsApp video.',
      parameters: {
        type: 'object',
        properties: {
          url: {
            type: 'string',
            description: 'The URL to the social media video or reel.',
          },
          caption: {
            type: 'string',
            description: 'Optional caption or title for the video in chat.',
          },
        },
        required: ['url'],
      },
      execute: async (args: { url: string; caption?: string }, ctx: ExecutionContext): Promise<ToolResult> => {
        try {
          console.log(`[VideoDownloader] Downloading social video from: ${args.url}`);
          const tempDir = config.paths.temp;
          if (!fs.existsSync(tempDir)) {
            fs.mkdirSync(tempDir, { recursive: true });
          }

          const fileId = crypto.randomBytes(6).toString('hex');
          const outputPattern = path.join(tempDir, `vid_${fileId}.%(ext)s`);

          // Download using yt-dlp with max 60MB limit for WhatsApp compatibility
          const cmd = `python -m yt_dlp -f "best[ext=mp4][filesize<60M]/best[filesize<60M]/best" --no-playlist -o "${outputPattern}" "${args.url}"`;
          
          await execAsync(cmd);

          // Find the generated file
          const files = fs.readdirSync(tempDir).filter((f) => f.startsWith(`vid_${fileId}`));
          if (files.length === 0) {
            return {
              success: false,
              message: 'Failed to download video. The video may be private or exceeds WhatsApp size limits.',
            };
          }

          const videoPath = path.join(tempDir, files[0]);
          const videoBuffer = fs.readFileSync(videoPath);

          await ctx.sendVideo(videoBuffer, args.caption || '🎬 Here is your video!');

          // Cleanup temp file
          try {
            fs.unlinkSync(videoPath);
          } catch {}

          return {
            success: true,
            message: 'Social media video downloaded and sent successfully to WhatsApp!',
          };
        } catch (err: any) {
          console.error('[VideoDownloader] Download error:', err.message);
          return {
            success: false,
            message: `Could not download video: ${err.message}`,
          };
        }
      },
    },
  ];
}

export const videoDownloaderPlugin = new VideoDownloaderPlugin();
