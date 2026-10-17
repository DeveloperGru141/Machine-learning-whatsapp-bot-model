import { IPlugin, BotTool, ExecutionContext, ToolResult } from '../types.js';
import { synthesizeVoiceNote } from '../../core/tts.js';
import { antiBanEngine } from '../../security/anti-ban.js';

export class VoiceNotePlugin implements IPlugin {
  name = 'VoiceNotePlugin';
  version = '1.1.0';
  description = 'Synthesizes realistic Nigerian Pidgin & conversational speech and sends WhatsApp voice notes (Push-To-Talk)';

  tools: BotTool[] = [
    {
      name: 'send_voice_note',
      description:
        'Synthesizes and sends a realistic, expressive Nigerian Pidgin / Naija spoken voice note (audio message) to the chat. ' +
        'Use this whenever the user asks for a voice note, asks you to talk or speak, or requests audio responses. ' +
        'CRITICAL: Write the spoken script like a real Nigerian friend recording a lively voice note on WhatsApp! Blend natural Naija Pidgin ("Omo see ehn", "my guy", "how far na", "wetin dey sup", "no wahala abeg", "sabi", "sharp sharp"), warm laughter ("haha"), and natural pauses (commas). NEVER sound like a generic AI announcer or recite bullet points.',
      parameters: {
        type: 'object',
        properties: {
          text: {
            type: 'string',
            description:
              'The spoken speech script for the voice note in natural Nigerian Pidgin / Naija conversational cadence. Must sound like a genuine friend talking on WhatsApp with warmth and personality.',
          },
          voice: {
            type: 'string',
            description:
              'Optional voice model. Choices: "en-NG-AbeoNeural" (warm Nigerian male, default), "en-NG-EzinneNeural" (expressive Nigerian female), "en-US-BrianMultilingualNeural" (US male), or "en-US-AvaMultilingualNeural" (US female).',
          },
        },
        required: ['text'],
      },
      execute: async (args: { text: string; voice?: string }, ctx: ExecutionContext): Promise<ToolResult> => {
        try {
          const scriptText = (args?.text || (args as any)?.message || (args as any)?.content || '').trim();
          if (!scriptText) {
            return {
              success: false,
              message: 'No text provided to synthesize into speech.',
            };
          }

          console.log(`[VoiceNotePlugin] Synthesizing Pidgin/Naija voice note for ${ctx.senderName} (${scriptText.length} chars)...`);
          await antiBanEngine.simulateTypingPresence(ctx.sock, ctx.chatJid, scriptText, true, scriptText.length, ctx.isGroup);
          const audioBuffer = await synthesizeVoiceNote(scriptText, args.voice);

          if (!audioBuffer || audioBuffer.length === 0) {
            return {
              success: false,
              message: 'TTS engine failed to produce audio buffer.',
            };
          }

          console.log(`[VoiceNotePlugin] Dispatching voice note (${audioBuffer.length} bytes) to ${ctx.chatJid}...`);
          await ctx.sendAudio(audioBuffer, true);

          return {
            success: true,
            message: 'Voice note synthesized and sent to the chat as a playable voice message.',
          };
        } catch (err: any) {
          console.error('[VoiceNotePlugin] Error synthesizing voice note:', err.message || err);
          return {
            success: false,
            message: `Voice note synthesis failed: ${err.message}`,
          };
        }
      },
    },
  ];
}

export const voiceNotePlugin = new VoiceNotePlugin();
