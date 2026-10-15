import { IPlugin, BotTool, ExecutionContext, ToolResult } from '../types.js';

export class ImageGenPlugin implements IPlugin {
  name = 'ImageGenerator';
  version = '1.0.0';
  description = 'Generates high-resolution images from natural language prompts using state-of-the-art diffusion models';

  tools: BotTool[] = [
    {
      name: 'generate_image',
      description: 'Generates a vivid image or visual artwork from a descriptive prompt and sends it directly to the WhatsApp chat.',
      parameters: {
        type: 'object',
        properties: {
          prompt: {
            type: 'string',
            description: 'Detailed visual prompt describing the subject, style, lighting, and composition.',
          },
          caption: {
            type: 'string',
            description: 'Optional witty or descriptive caption to accompany the image in the WhatsApp message.',
          },
        },
        required: ['prompt'],
      },
      execute: async (args: { prompt: string; caption?: string }, ctx: ExecutionContext): Promise<ToolResult> => {
        try {
          console.log(`[ImageGen] Generating image for prompt: "${args.prompt}"`);

          // Fetch from high-quality Flux endpoint via Pollinations (fast, reliable, no key bottleneck)
          const encodedPrompt = encodeURIComponent(args.prompt);
          const imageUrl = `https://image.pollinations.ai/prompt/${encodedPrompt}?model=flux&width=1024&height=1024&nologo=true`;

          const res = await fetch(imageUrl);
          if (!res.ok) {
            return { success: false, message: `Image generation failed with HTTP ${res.status}` };
          }

          const arrayBuffer = await res.arrayBuffer();
          const buffer = Buffer.from(arrayBuffer);

          await ctx.sendImage(buffer, args.caption || `🎨 "${args.prompt}"`);

          return {
            success: true,
            message: 'Image successfully generated and delivered to the user on WhatsApp.',
          };
        } catch (err: any) {
          return { success: false, message: `Image generation error: ${err.message}` };
        }
      },
    },
  ];
}

export const imageGenPlugin = new ImageGenPlugin();
