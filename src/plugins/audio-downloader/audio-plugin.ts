import { IPlugin, BotTool, ExecutionContext, ToolResult } from '../types.js';
import { transcodeToOggOpus, synthesizeVoiceNote } from '../../core/tts.js';
import { analyzeVoiceNote } from '../../core/transcription.js';
import { getBotSetting, setBotSetting } from '../../memory/db.js';
import { userProfileManager } from '../../memory/user-profiles.js';
import { config } from '../../config/env.js';

export class AudioDownloaderPlugin implements IPlugin {
  name = 'AudioDownloader';
  version = '2.0.0';
  description = 'Downloads audio files and synthesizes natural human-like voice notes using ElevenLabs Neural TTS';

  tools: BotTool[] = [
    {
      name: 'send_voice_note',
      description:
        'Synthesizes and sends a warm, natural, human-like voice note (audio message) in clear, fluent, articulate English directly to the WhatsApp chat using Neural TTS. Deliver voice note messages strictly in clear, professional, natural English (NO Pidgin, no slang). Use whenever someone asks for a voice note, asks you to speak, say something with voice, send a vn, or when a voice note reply is appropriate.',
      parameters: {
        type: 'object',
        properties: {
          message: {
            type: 'string',
            description: 'The natural spoken message in clear, fluent English (NO Pidgin) to synthesize and send as a WhatsApp voice note.',
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
    {
      name: 'set_tts_voice_id',
      description:
        'Updates the active Text-to-Speech (TTS) Voice ID or provider for voice notes. Use when owner Ademola provides a cloned ElevenLabs Voice ID or switches to native Nigerian voice (e.g. "en-NG-AbeoNeural" or "edge-tts"). STRICTLY OWNER ONLY.',
      parameters: {
        type: 'object',
        properties: {
          voice_id: {
            type: 'string',
            description: 'The ElevenLabs Voice ID (e.g. "21m00Tcm4TlvDq8ikWAM") or "en-NG-AbeoNeural" / "edge-tts" for Microsoft native Nigerian voice.',
          },
          provider: {
            type: 'string',
            enum: ['elevenlabs', 'edge-tts'],
            description: 'Optional TTS provider. Defaults to elevenlabs.',
          },
        },
        required: ['voice_id'],
      },
      execute: async (args: { voice_id: string; provider?: string }, ctx: ExecutionContext): Promise<ToolResult> => {
        const isOwner = userProfileManager.isOwner(ctx.senderJid, ctx.senderName);
        if (!isOwner) {
          return { success: false, message: 'Permission denied: Only owner Ademola can change TTS voice settings.' };
        }

        const cleanVoice = args.voice_id.trim();
        const provider = args.provider || (cleanVoice.includes('en-NG') || cleanVoice === 'edge-tts' ? 'edge-tts' : 'elevenlabs');

        setBotSetting('elevenlabs_voice_id', cleanVoice);
        setBotSetting('tts_provider', provider);

        return {
          success: true,
          message: `🎙️ TTS Voice updated successfully!
- Active Voice ID: ${cleanVoice}
- Provider: ${provider}
- Next voice note will synthesize using this voice configuration!`,
          data: { voiceId: cleanVoice, provider },
        };
      },
    },
    {
      name: 'get_tts_voice_info',
      description:
        'Retrieves current TTS voice engine configuration, active voice ID, provider, and status of recorded voice cloning samples from creator Ademola.',
      parameters: {
        type: 'object',
        properties: {},
      },
      execute: async (_args: {}, _ctx: ExecutionContext): Promise<ToolResult> => {
        const activeVoice = getBotSetting('elevenlabs_voice_id', config.elevenlabs?.voiceId || 'pNInz6obpgDQGcFmaJgB');
        const activeProvider = getBotSetting('tts_provider', 'elevenlabs');
        const sampleAt = getBotSetting('ademola_voice_sample_at', '');
        const samplePath = getBotSetting('ademola_voice_sample_path', '');

        const hasSample = Boolean(sampleAt && samplePath);
        const sampleDateStr = hasSample ? new Date(parseInt(sampleAt, 10)).toLocaleString() : 'None recorded yet';

        const isDefaultAdam = activeVoice === 'pNInz6obpgDQGcFmaJgB';
        const voiceLabel = isDefaultAdam
          ? 'Adam (Default ElevenLabs American - generic pidgin)'
          : activeVoice === 'en-NG-AbeoNeural'
          ? 'Abeo (Edge-TTS Native Nigerian Male)'
          : `Custom/Cloned Voice (${activeVoice})`;

        const summary = `🎙️ *TTS Voice Engine Configuration*:
- Current Voice: ${voiceLabel}
- Voice ID: \`${activeVoice}\`
- Provider: ${activeProvider}
- Ademola Voice Sample: ${hasSample ? `Recorded on ${sampleDateStr}` : 'Send a voice note to the bot to record your sample!'}

💡 *To Clone Your Voice*:
1. Send a 1-2 minute voice note to this bot on WhatsApp speaking naturally in your Pidgin cadence.
2. The bot preserves your clean audio sample.
3. In ElevenLabs VoiceLab (Starter tier), upload the audio and clone "Ademola".
4. Set the voice ID here using: \`set_tts_voice_id(voice_id: "...")\`.`;

        return {
          success: true,
          message: summary,
          data: {
            activeVoice,
            activeProvider,
            hasSample,
            sampleDateStr,
          },
        };
      },
    },
    {
      name: 'transcribe_voice_note',
      description:
        'Transcribes and summarizes an audio file or voice note using Groq Whisper large-v3 with Nigerian English & Pidgin optimization.',
      parameters: {
        type: 'object',
        properties: {
          audio_url: {
            type: 'string',
            description: 'Optional direct URL to the audio file to transcribe.',
          },
        },
      },
      execute: async (args: { audio_url?: string }, _ctx: ExecutionContext): Promise<ToolResult> => {
        try {
          if (args.audio_url) {
            const res = await fetch(args.audio_url, { signal: AbortSignal.timeout(20000) });
            if (!res.ok) {
              return { success: false, message: `Failed to download audio from ${args.audio_url}` };
            }
            const arrayBuf = await res.arrayBuffer();
            const analysis = await analyzeVoiceNote(Buffer.from(arrayBuf));
            if (!analysis) {
              return { success: false, message: 'Could not transcribe the provided audio.' };
            }
            return {
              success: true,
              message: `🎙️ *Voice Note Transcribed:*\n"${analysis.transcript}"\n\n💡 *Summary:* ${analysis.summary}`,
              data: analysis,
            };
          }
          return {
            success: true,
            message: 'To transcribe a voice note, send the voice note directly to the chat or supply a link.',
          };
        } catch (err: any) {
          return { success: false, message: `Transcription failed: ${err.message}` };
        }
      },
    },
  ];
}

export const audioDownloaderPlugin = new AudioDownloaderPlugin();
