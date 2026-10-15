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
        'Synthesizes and sends a realistic spoken voice note (audio message) to the chat using text-to-speech. ' +
        'Use this whenever the user asks for a voice note, audio message, asks you to speak or say something out loud, or requests audio narration.',
      parameters: {
        type: 'object',
        properties: {
          text: {
            type: 'string',
            description:
              'The exact spoken monologue or message to synthesize into the voice note. Keep it natural, conversational, fluent, and without markdown asterisks or bullet points.',
          },
          voice: {
            type: 'string',
            description:
              'Optional voice model. Defaults to en-US-ChristopherNeural (natural conversational male) or en-US-EmmaMultilingualNeural.',
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
