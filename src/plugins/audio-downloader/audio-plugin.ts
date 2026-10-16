import { IPlugin, BotTool, ExecutionContext, ToolResult } from '../types.js';
import { transcodeToOggOpus } from '../../core/tts.js';

export class AudioDownloaderPlugin implements IPlugin {
  name = 'AudioDownloader';
  version = '1.0.0';
  description = 'Downloads audio files, streams, or voice notes from direct URLs or media sources';

  tools: BotTool[] = [
    {
      name: 'download_audio',
      description: 'Downloads an audio file or music track from a direct link or supported media URL and sends it as a WhatsApp audio note.',
      parameters: {
        type: 'object',
        properties: {
          url: {
            type: 'string',
            description: 'Direct URL to the audio file (e.g. mp3, m4a, ogg, wav) or media link.',
          },
          asVoiceNote: {
            type: 'boolean',
            description: 'Whether to send as a WhatsApp playable voice note (PTT waveform) instead of a standard audio file. Defaults to false.',
          },
        },
        required: ['url'],
      },
      execute: async (args: { url: string; asVoiceNote?: boolean }, ctx: ExecutionContext): Promise<ToolResult> => {
        try {
          const rawUrl = (args.url || '').trim();
          let targetUrl = rawUrl;
          if (!targetUrl.startsWith('http://') && !targetUrl.startsWith('https://')) {
            targetUrl = `https://${targetUrl}`;
          }

          try {
            const parsed = new URL(targetUrl);
            if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
              return { success: false, message: 'Invalid audio URL. Only HTTP and HTTPS links are supported.' };
            }
          } catch {
            return { success: false, message: 'Invalid URL provided.' };
          }

          console.log(`[AudioDownloader] Downloading audio from: ${targetUrl}`);
          const res = await fetch(targetUrl, { signal: AbortSignal.timeout(30000) });
          if (!res.ok) {
            return {
              success: false,
              message: `Failed to download audio. Remote server returned HTTP ${res.status}`,
            };
          }

          const arrayBuffer = await res.arrayBuffer();
          let buffer: any = Buffer.from(arrayBuffer);

          if (args.asVoiceNote) {
            buffer = await transcodeToOggOpus(buffer);
          }

          await ctx.sendAudio(buffer, !!args.asVoiceNote);

          return {
            success: true,
            message: 'Audio downloaded and sent successfully to the chat.',
          };
        } catch (err: any) {
          return {
            success: false,
            message: `Audio download failed: ${err.message}`,
          };
        }
      },
    },
  ];
}

export const audioDownloaderPlugin = new AudioDownloaderPlugin();
