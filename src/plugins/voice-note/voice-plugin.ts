import { IPlugin, BotTool, ExecutionContext, ToolResult } from '../types.js';
import { synthesizeVoiceNote } from '../../core/tts.js';
import { antiBanEngine } from '../../security/anti-ban.js';

export class VoiceNotePlugin implements IPlugin {
  name = 'VoiceNotePlugin';
  version = '1.1.0';
  description = 'Voice notes deactivated per system configuration';

  tools: BotTool[] = [];
}

export const voiceNotePlugin = new VoiceNotePlugin();
