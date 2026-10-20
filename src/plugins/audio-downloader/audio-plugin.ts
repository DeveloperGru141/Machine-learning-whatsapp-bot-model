import { IPlugin, BotTool, ExecutionContext, ToolResult } from '../types.js';
import { transcodeToOggOpus, synthesizeVoiceNote } from '../../core/tts.js';

export class AudioDownloaderPlugin implements IPlugin {
  name = 'AudioDownloader';
  version = '2.0.0';
  description = 'Downloads audio files and synthesizes natural human-like voice notes using ElevenLabs Neural TTS';

  tools: BotTool[] = [
    {
      name: 'send_voice_note',
      description:
        'Synthesizes and sends a warm, natural, human-like voice note (audio message) in authentic Nigerian English/Pidgin directly to the WhatsApp chat using ElevenLabs Neural TTS. Use whenever someone asks for a voice note, asks you to speak, say something with voice, send a vn, or when a voice note reply is appropriate.',
      parameters: {
        type: 'object',
        properties: {
          message: {
            type: 'string',
            description: 'The natural spoken message in English/Nigerian Pidgin to synthesize and send as a WhatsApp voice note.',
          },
        },
        required: ['message'],
      },
      execute: async (args: { message: string }, ctx: ExecutionContext): Promise<ToolResult> => {
        try {
          const rawMessage = (args.message || '').trim();
          if (!rawMessage) {
            return { success: false, message: 'Please provide the message text to speak in the voice note.' };
          }

          console.log(`[AudioPlugin] 🎙️ Synthesizing voice note: "${rawMessage.slice(0, 60)}..."`);
          const audioBuffer = await synthesizeVoiceNote(rawMessage);
          if (!audioBuffer) {
            return {
              success: false,
              message: 'Failed to synthesize voice note audio. Please try again shortly.',
            };
          }

          await ctx.sendAudio(audioBuffer, true);
          return {
            success: true,
            message: 'Voice note synthesized with ElevenLabs and sent successfully to WhatsApp!',
          };
        } catch (err: any) {
          console.error('[AudioPlugin] Voice note error:', err);
          return { success: false, message: `Failed to send voice note: ${err.message}` };
        }
      },
    },
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
