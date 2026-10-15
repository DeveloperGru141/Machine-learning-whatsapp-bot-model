import { IPlugin, BotTool, ExecutionContext, ToolResult } from '../types.js';
import { synthesizeVoiceNote } from '../../core/tts.js';

export class VoiceNotePlugin implements IPlugin {
  name = 'VoiceNotePlugin';
  version = '1.0.0';
  description = 'Synthesizes realistic human speech and sends WhatsApp voice notes (Push-To-Talk)';

  tools: BotTool[] = [
    {
      name: 'send_voice_note',
      description:
        'Synthesizes and sends a realistic, expressive spoken voice note (audio message) to the chat. ' +
        'Use this whenever the user asks for a voice note, asks you to talk or speak, or requests audio responses. ' +
        'CRITICAL: Write the monologue like a real human sending a casual voice note on WhatsApp! Include natural conversational flow, laughter (haha), natural pauses (commas and ellipses...), and authentic emotion. NEVER recite a bulleted list of features.',
      parameters: {
        type: 'object',
        properties: {
          text: {
            type: 'string',
            description:
              'The spoken speech script for the voice note. Must sound like a genuine friend speaking on WhatsApp with emotion and rhythm. Avoid asterisks, hashtags, or robotic jargon.',
          },
          voice: {
            type: 'string',
            description:
              'Optional voice model. Choices: "en-NG-AbeoNeural" (warm Nigerian male, default), "en-US-BrianMultilingualNeural" (expressive US conversational male), "en-NG-EzinneNeural" (Nigerian female), or "en-US-AvaMultilingualNeural" (expressive US female).',
          },
        },
        required: ['text'],
      },
      execute: async (args: { text: string; voice?: string }, ctx: ExecutionContext): Promise<ToolResult> => {
        try {
          if (!args.text || args.text.trim().length === 0) {
            return {
              success: false,
              message: 'No text provided to synthesize into speech.',
            };
          }

          console.log(`[VoiceNotePlugin] Synthesizing voice note for ${ctx.senderName} (${args.text.length} chars)...`);
          const audioBuffer = await synthesizeVoiceNote(args.text, args.voice);

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
