import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { createRequire } from 'node:module';
import { IPlugin, BotTool, ExecutionContext, ToolResult } from '../types.js';
import { config } from '../../config/env.js';
import { assertPublicHttpUrl, fetchPublicHttpUrl, readLimitedResponse } from '../../security/url-policy.js';
const require = createRequire(import.meta.url);

let ffmpegPath: string = '';
try {
  ffmpegPath = require('ffmpeg-static') || '';
} catch {}

const execFileAsync = promisify(execFile);

function getSafeTempVideoFile(candidate: string, tempDir: string, filePrefix: string): string | null {
  const resolvedPath = path.resolve(candidate);
  const relativePath = path.relative(path.resolve(tempDir), resolvedPath);
  if (relativePath === '' || relativePath === '..' || relativePath.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relativePath) || !path.basename(resolvedPath).startsWith(filePrefix)) {
    return null;
  }
  try {
    const stat = fs.lstatSync(resolvedPath);
    if (!stat.isFile() || stat.size <= 2048 || stat.size > 60 * 1024 * 1024) return null;
    return resolvedPath;
  } catch {
    return null;
  }
}

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
    await execFileAsync('yt-dlp', ['--version'], { timeout: 1500, windowsHide: true });
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

        let parsed: URL;
        try {
          parsed = new URL(rawUrl);
          if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
            return {
              success: false,
              message: 'Invalid video URL. Only HTTP and HTTPS links are supported.',
            };
          }
        } catch {
          return { success: false, message: 'Invalid URL provided.' };
        }

        const supportedDomains = ['instagram.com', 'tiktok.com', 'youtube.com', 'youtu.be', 'twitter.com', 'x.com', 'facebook.com', 'fb.watch'];
        const requestHost = parsed.hostname.toLowerCase();
        if (!supportedDomains.some((domain) => requestHost === domain || requestHost.endsWith(`.${domain}`))) {
          return { success: false, message: 'That video platform is not supported. Use a public Instagram, TikTok, YouTube, X/Twitter, or Facebook link.' };
        }
        try {
          await assertPublicHttpUrl(parsed);
        } catch (err: any) {
          return { success: false, message: `Video URL rejected: ${err.message}` };
        }

        const sanitizedUrl = parsed.href;
        const tempDir = config.paths.temp;
        if (!fs.existsSync(tempDir)) {
          fs.mkdirSync(tempDir, { recursive: true });
        }

        const fileId = crypto.randomBytes(6).toString('hex');
        const targetFilePath = path.join(tempDir, `vid_${fileId}.mp4`);
        const cleanupTempVideoFiles = (): void => {
          try {
            for (const name of fs.readdirSync(tempDir)) {
              if (!name.startsWith(`vid_${fileId}`)) continue;
              const fullPath = path.join(tempDir, name);
              try {
                if (fs.lstatSync(fullPath).isFile()) fs.unlinkSync(fullPath);
              } catch {}
            }
          } catch {}
        };

        let downloadedPath: string | null = null;
        let videoTitle: string | undefined = undefined;
        let isPrivateDetected = false;

        const checkPrivateError = (errStr: string) => {
          const lower = (errStr || '').toLowerCase();
          if (
            lower.includes('private') ||
            lower.includes('login') ||
            lower.includes('auth') ||
            lower.includes('sign in') ||
            lower.includes('restricted') ||
            lower.includes('cookie') ||
            lower.includes('permission')
          ) {
            isPrivateDetected = true;
          }
        };

        const isIg = /instagram\.com/i.test(sanitizedUrl);
        const isTiktok = /tiktok\.com/i.test(sanitizedUrl);
        const isFb = /facebook\.com|fb\.watch/i.test(sanitizedUrl);
        const platformLabel = isIg ? 'Instagram reel' : isTiktok ? 'TikTok' : isFb ? 'Facebook video' : 'video';

        // Strategy 1: Dedicated platform resolver in rahad-all-downloader-v2
        if (!downloadedPath && alldlInstance) {
          try {
            let platformResolver: any = null;
            if (isIg && typeof alldlInstance.insta === 'function') platformResolver = alldlInstance.insta;
            else if (isTiktok && typeof alldlInstance.tiktok === 'function') platformResolver = alldlInstance.tiktok;
            else if (isFb && typeof alldlInstance.fb === 'function') platformResolver = alldlInstance.fb;

            if (platformResolver) {
              console.log(`[VideoDownloader] Strategy 1: Attempting dedicated platform resolver for ${platformLabel}...`);
              const res = await platformResolver(sanitizedUrl);
              const directUrl = res?.data?.videoUrl || res?.data?.url || res?.videoUrl || res?.url;
              if (directUrl && typeof directUrl === 'string' && directUrl.startsWith('http')) {
                const resp = await fetchPublicHttpUrl(directUrl, {
                  headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                  },
                });
                if (resp.ok) {
                  const buffer = await readLimitedResponse(resp, 60 * 1024 * 1024);
                  if (buffer.byteLength > 2048) {
                    fs.writeFileSync(targetFilePath, buffer);
                    downloadedPath = targetFilePath;
                    videoTitle = res?.data?.title || res?.title;
                    console.log(`[VideoDownloader] Strategy 1 (platform resolver) succeeded (${buffer.byteLength} bytes)`);
                  }
                }
              }
            }
          } catch (err: any) {
            checkPrivateError(err?.message || '');
            console.warn('[VideoDownloader] Strategy 1 failed:', err.message);
          }
        }

        // Strategy 2: rahad-all-downloader-v2 direct download (Node-native for Instagram, TikTok, FB, etc.)
        if (!downloadedPath && alldlInstance && typeof alldlInstance.download === 'function') {
          try {
            console.log('[VideoDownloader] Strategy 2: Attempting alldl.download...');
            const dlResult = await alldlInstance.download(sanitizedUrl, targetFilePath, { quality: 'medium' });
            if (dlResult && dlResult.path) {
              const safePath = getSafeTempVideoFile(dlResult.path, tempDir, `vid_${fileId}`);
              if (safePath) {
                downloadedPath = safePath;
                videoTitle = dlResult.title;
                console.log(`[VideoDownloader] Strategy 2 succeeded: ${downloadedPath} (${fs.statSync(safePath).size} bytes)`);
              }
            } else {
              downloadedPath = getSafeTempVideoFile(targetFilePath, tempDir, `vid_${fileId}`);
            }
          } catch (err: any) {
            checkPrivateError(err?.message || '');
            console.warn('[VideoDownloader] Strategy 2 failed:', err.message);
          }
        }

        // Strategy 3: rahad-all-downloader-v2 general resolve URL + fetch stream
        if (!downloadedPath && alldlInstance && typeof alldlInstance === 'function') {
          try {
            console.log('[VideoDownloader] Strategy 3: Attempting alldl resolve...');
            const resolved = await alldlInstance(sanitizedUrl);
            const directVideoUrl = resolved?.data?.videoUrl || resolved?.data?.url || resolved?.videoUrl;
            if (directVideoUrl && typeof directVideoUrl === 'string' && directVideoUrl.startsWith('http')) {
              console.log(`[VideoDownloader] Resolved direct video URL: ${directVideoUrl.slice(0, 80)}...`);
              const resp = await fetchPublicHttpUrl(directVideoUrl, {
                headers: {
                  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                  ...(resolved?.data?.headers || {}),
                },
              });
              if (resp.ok) {
                const buffer = await readLimitedResponse(resp, 60 * 1024 * 1024);
                if (buffer.byteLength > 2048) {
                  fs.writeFileSync(targetFilePath, buffer);
                  downloadedPath = targetFilePath;
                  videoTitle = resolved?.data?.title || resolved?.title;
                  console.log(`[VideoDownloader] Strategy 3 succeeded (${buffer.byteLength} bytes)`);
                }
              }
            }
          } catch (err: any) {
            checkPrivateError(err?.message || '');
            console.warn('[VideoDownloader] Strategy 3 failed:', err.message);
          }
        }

        // Strategy 4: Dedicated TikTok fallback (TikWM API)
        if (!downloadedPath && isTiktok) {
          try {
            console.log('[VideoDownloader] Strategy 4: TikWM fallback for TikTok...');
            const tikwmRes = await fetch(`https://www.tikwm.com/api/?url=${encodeURIComponent(sanitizedUrl)}`, {
              headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
              },
            });
            if (tikwmRes.ok) {
              const data = (await tikwmRes.json()) as any;
              const playUrl = data?.data?.play || data?.data?.wmplay;
              if (playUrl) {
                const vidRes = await fetchPublicHttpUrl(playUrl);
                if (vidRes.ok) {
                  const buffer = await readLimitedResponse(vidRes, 60 * 1024 * 1024);
                  if (buffer.byteLength > 2048) {
                    fs.writeFileSync(targetFilePath, buffer);
                    downloadedPath = targetFilePath;
                    videoTitle = data?.data?.title;
                    console.log(`[VideoDownloader] TikWM fallback succeeded (${buffer.byteLength} bytes)`);
                  }
                }
              } else if (data?.msg && /private|hidden/i.test(data.msg)) {
                isPrivateDetected = true;
              }
            }
          } catch (err: any) {
            checkPrivateError(err?.message || '');
            console.warn('[VideoDownloader] Strategy 4 (TikWM) failed:', err.message);
          }
        }

        // Strategy 5: yt-dlp fallback (if executable is installed in environment)
        if (!downloadedPath) {
          try {
            console.log('[VideoDownloader] Strategy 5: Checking yt-dlp availability...');
            const isInstalled = await checkYtDlp();
            if (isInstalled) {
              console.log('[VideoDownloader] Strategy 5: Attempting yt-dlp download...');
              const outputPattern = path.join(tempDir, `vid_${fileId}.%(ext)s`);
              const downloaderArgs = [
                ...(ffmpegPath ? ['--ffmpeg-location', ffmpegPath] : []),
                '-f', 'best/bestvideo+bestaudio',
                '--recode-video', 'mp4',
                '--max-filesize', '60M',
                '--no-playlist',
                '-o', outputPattern,
                sanitizedUrl,
              ];
              await execFileAsync('yt-dlp', downloaderArgs, { timeout: 25_000, windowsHide: true });
              const files = fs.readdirSync(tempDir).filter((f) => f.startsWith(`vid_${fileId}`));
              if (files.length > 0) {
                const p = getSafeTempVideoFile(path.join(tempDir, files[0]), tempDir, `vid_${fileId}`);
                if (p) {
                  downloadedPath = p;
                  console.log(`[VideoDownloader] Strategy 5 (yt-dlp) succeeded: ${p}`);
                }
              }
            } else {
              console.log('[VideoDownloader] Strategy 5 skipped: yt-dlp not present in runtime.');
            }
          } catch (err: any) {
            checkPrivateError(err?.message || '');
            console.warn('[VideoDownloader] Strategy 5 failed:', err.message);
          }
        }

        // Verify result
        downloadedPath = downloadedPath
          ? getSafeTempVideoFile(downloadedPath, tempDir, `vid_${fileId}`)
          : null;
        if (!downloadedPath) {
          cleanupTempVideoFiles();
          if (isPrivateDetected) {
            return {
              success: false,
              message: `🔒 That ${platformLabel} is from a private account or locked behind login! Because it's private, external downloaders cannot bypass Instagram/TikTok's privacy wall without account credentials. Try sending a public video link instead make I run am sharp sharp! 🤝`,
            };
          }

          return {
            success: false,
            message: `Omo chief, that ${platformLabel} link don cast or the post dey private/deleted. Double check the link make we try again! 😂`,
          };
        }

        const stat = fs.statSync(downloadedPath);
        // WhatsApp max size check (60MB)
        if (stat.size > 60 * 1024 * 1024) {
          cleanupTempVideoFiles();
          return {
            success: false,
            message: `Omo the video heavy gan (pass 60MB)! WhatsApp no go allow me send file wey big pass 60MB. Try find shorter clip make we run am! 😅`,
          };
        }

        try {
          const videoBuffer = fs.readFileSync(downloadedPath);
          const finalCaption = args.caption || videoTitle || undefined;
          await ctx.sendVideo(videoBuffer, finalCaption);
        } finally {
          cleanupTempVideoFiles();
        }

        return {
          success: true,
          message: 'Social media video downloaded and sent successfully to WhatsApp!',
        };
      },
    },
  ];
}

export const videoDownloaderPlugin = new VideoDownloaderPlugin();
