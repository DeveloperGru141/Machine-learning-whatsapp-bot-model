import { exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { IPlugin, BotTool, ExecutionContext, ToolResult } from '../types.js';
import { config } from '../../config/env.js';

let ffmpegPath: string = '';
try {
  ffmpegPath = require('ffmpeg-static') || '';
} catch {}

const execAsync = promisify(exec);

// Pure Node.js downloader engine (works seamlessly on Render/Docker/Linux/Windows)
let alldlInstance: any = null;
try {
  const rahad = require('rahad-all-downloader-v2');
  alldlInstance = rahad.alldl || rahad;
  if (alldlInstance && typeof alldlInstance.setTimeout === 'function') {
    alldlInstance.setTimeout(25000);
  }
} catch (e) {
  console.warn('[VideoDownloader] rahad-all-downloader-v2 initialization warning:', e);
}

let hasYtDlpCache: boolean | null = null;
async function checkYtDlp(): Promise<boolean> {
  if (hasYtDlpCache !== null) return hasYtDlpCache;
  try {
    await execAsync('yt-dlp --version', { timeout: 1500 });
    hasYtDlpCache = true;
  } catch {
    hasYtDlpCache = false;
  }
  return hasYtDlpCache;
}

export class VideoDownloaderPlugin implements IPlugin {
  name = 'VideoDownloader';
  version = '2.0.0';
  description = 'Downloads social media videos from Instagram Reels, TikTok, YouTube Shorts, Twitter/X, and Facebook';

  tools: BotTool[] = [
    {
      name: 'download_video',
      description: 'Downloads a video from a social media link (Instagram, TikTok, YouTube Shorts, Twitter/X, Facebook) and sends it as a playable WhatsApp video.',
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
        const rawUrl = (args.url || '').trim();
        console.log(`[VideoDownloader] Request to download: ${rawUrl}`);

        try {
          const parsed = new URL(rawUrl);
          if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
            return {
              success: false,
              message: 'Invalid video URL. Only HTTP and HTTPS links are supported.',
            };
          }
        } catch {
          return { success: false, message: 'Invalid URL provided.' };
        }

        const sanitizedUrl = rawUrl.replace(/["']/g, '');
        const tempDir = config.paths.temp;
        if (!fs.existsSync(tempDir)) {
          fs.mkdirSync(tempDir, { recursive: true });
        }

        const fileId = crypto.randomBytes(6).toString('hex');
        const targetFilePath = path.join(tempDir, `vid_${fileId}.mp4`);

        let downloadedPath: string | null = null;
        let videoTitle: string | undefined = undefined;

        // Strategy 1: rahad-all-downloader-v2 direct download (Node-native for Instagram, TikTok, FB, etc.)
        if (alldlInstance && typeof alldlInstance.download === 'function') {
          try {
            console.log('[VideoDownloader] Strategy 1: Attempting alldl.download...');
            const dlResult = await alldlInstance.download(sanitizedUrl, targetFilePath, { quality: 'medium' });
            if (dlResult && dlResult.path && fs.existsSync(dlResult.path)) {
              const stat = fs.statSync(dlResult.path);
              if (stat.size > 2048) {
                downloadedPath = dlResult.path;
                videoTitle = dlResult.title;
                console.log(`[VideoDownloader] Strategy 1 succeeded: ${downloadedPath} (${stat.size} bytes)`);
              }
            } else if (fs.existsSync(targetFilePath) && fs.statSync(targetFilePath).size > 2048) {
              downloadedPath = targetFilePath;
            }
          } catch (err: any) {
            console.warn('[VideoDownloader] Strategy 1 failed:', err.message);
          }
        }

        // Strategy 2: rahad-all-downloader-v2 resolve URL + fetch stream
        if (!downloadedPath && alldlInstance && typeof alldlInstance === 'function') {
          try {
            console.log('[VideoDownloader] Strategy 2: Attempting alldl resolve...');
            const resolved = await alldlInstance(sanitizedUrl);
            const directVideoUrl = resolved?.data?.videoUrl || resolved?.data?.url || resolved?.videoUrl;
            if (directVideoUrl && typeof directVideoUrl === 'string' && directVideoUrl.startsWith('http')) {
              console.log(`[VideoDownloader] Resolved direct video URL: ${directVideoUrl.slice(0, 80)}...`);
              const resp = await fetch(directVideoUrl, {
                headers: {
                  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                  ...(resolved?.data?.headers || {}),
                },
              });
              if (resp.ok) {
                const arrayBuffer = await resp.arrayBuffer();
                if (arrayBuffer.byteLength > 2048) {
                  fs.writeFileSync(targetFilePath, Buffer.from(arrayBuffer));
                  downloadedPath = targetFilePath;
                  videoTitle = resolved?.data?.title || resolved?.title;
                  console.log(`[VideoDownloader] Strategy 2 succeeded (${arrayBuffer.byteLength} bytes)`);
                }
              }
            }
          } catch (err: any) {
            console.warn('[VideoDownloader] Strategy 2 failed:', err.message);
          }
        }

        // Strategy 3: Dedicated TikTok fallback (TikWM API)
        if (!downloadedPath && /tiktok\.com/i.test(sanitizedUrl)) {
          try {
            console.log('[VideoDownloader] Strategy 3: TikWM fallback for TikTok...');
            const tikwmRes = await fetch(`https://www.tikwm.com/api/?url=${encodeURIComponent(sanitizedUrl)}`, {
              headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
              },
            });
            if (tikwmRes.ok) {
              const data = (await tikwmRes.json()) as any;
              const playUrl = data?.data?.play || data?.data?.wmplay;
              if (playUrl) {
                const vidRes = await fetch(playUrl);
                if (vidRes.ok) {
                  const buf = await vidRes.arrayBuffer();
                  if (buf.byteLength > 2048) {
                    fs.writeFileSync(targetFilePath, Buffer.from(buf));
                    downloadedPath = targetFilePath;
                    videoTitle = data?.data?.title;
                    console.log(`[VideoDownloader] TikWM fallback succeeded (${buf.byteLength} bytes)`);
                  }
                }
              }
            }
          } catch (err: any) {
            console.warn('[VideoDownloader] Strategy 3 (TikWM) failed:', err.message);
          }
        }

        // Strategy 4: yt-dlp fallback (if executable is installed in environment)
        if (!downloadedPath) {
          try {
            console.log('[VideoDownloader] Strategy 4: Checking yt-dlp availability...');
            const isInstalled = await checkYtDlp();
            if (isInstalled) {
              console.log('[VideoDownloader] Strategy 4: Attempting yt-dlp download...');
              const outputPattern = path.join(tempDir, `vid_${fileId}.%(ext)s`);
              const ffArg = ffmpegPath ? `--ffmpeg-location "${ffmpegPath}"` : '';
              const cmd = `yt-dlp ${ffArg} -f "best/bestvideo+bestaudio" --recode-video mp4 --max-filesize 60M --no-playlist -o "${outputPattern}" "${sanitizedUrl}"`;
              await execAsync(cmd, { timeout: 25_000 });
              const files = fs.readdirSync(tempDir).filter((f) => f.startsWith(`vid_${fileId}`));
              if (files.length > 0) {
                const p = path.join(tempDir, files[0]);
                if (fs.statSync(p).size > 2048) {
                  downloadedPath = p;
                  console.log(`[VideoDownloader] Strategy 4 (yt-dlp) succeeded: ${p}`);
                }
              }
            } else {
              console.log('[VideoDownloader] Strategy 4 skipped: yt-dlp not present in runtime.');
            }
          } catch (err: any) {
            console.warn('[VideoDownloader] Strategy 4 failed:', err.message);
          }
        }

        // Verify result
        if (!downloadedPath || !fs.existsSync(downloadedPath)) {
          const isIg = /instagram\.com/i.test(sanitizedUrl);
          const isTiktok = /tiktok\.com/i.test(sanitizedUrl);
          const platformLabel = isIg ? 'Instagram reel' : isTiktok ? 'TikTok' : 'video';
          return {
            success: false,
            message: `Omo chief, that ${platformLabel} link don cast or the post dey private/deleted. Double check the link make we try again! 😂`,
          };
        }

        const stat = fs.statSync(downloadedPath);
        // WhatsApp max size check (60MB)
        if (stat.size > 60 * 1024 * 1024) {
          try {
            fs.unlinkSync(downloadedPath);
          } catch {}
          return {
            success: false,
            message: `Omo the video heavy gan (pass 60MB)! WhatsApp no go allow me send file wey big pass 60MB. Try find shorter clip make we run am! 😅`,
          };
        }

        const videoBuffer = fs.readFileSync(downloadedPath);
        const finalCaption = args.caption || videoTitle || undefined;
        await ctx.sendVideo(videoBuffer, finalCaption);

        // Cleanup
        try {
          fs.unlinkSync(downloadedPath);
        } catch {}

        return {
          success: true,
          message: 'Social media video downloaded and sent successfully to WhatsApp!',
        };
      },
    },
  ];
}

export const videoDownloaderPlugin = new VideoDownloaderPlugin();
