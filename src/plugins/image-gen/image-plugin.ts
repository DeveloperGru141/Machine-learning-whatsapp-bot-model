import { IPlugin, BotTool } from '../types.js';

/**
 * Image Generation feature deactivated per user request.
 */
export class ImageGenPlugin implements IPlugin {
  name = 'ImageGenerator';
  version = '2.0.0';
  description = 'Deactivated';
  tools: BotTool[] = [];
}

export const imageGenPlugin = new ImageGenPlugin();
