import { IPlugin, BotTool, ExecutionContext, ToolResult } from '../types.js';
import { config } from '../../config/env.js';

export class ImageGenPlugin implements IPlugin {
  name = 'ImageGenerator';
  version = '2.1.0';
  description = 'Generates realistic, artistic, and conceptual images using the open-source FLUX.1-Krea-dev model via Hugging Face inference.';

  tools: BotTool[] = [
    {
      name: 'generate_image',
      description:
        'Generates an image from a descriptive text prompt using open-source FLUX.1-Krea-dev (via Hugging Face with fal-ai inference) and delivers the photo directly to WhatsApp. Use whenever someone asks to draw, generate, create, show, or make a picture or image.',
      parameters: {
        type: 'object',
        properties: {
          prompt: {
            type: 'string',
            description: 'Detailed prompt describing the image to generate in English.',
          },
          caption: {
            type: 'string',
            description: 'Optional witty caption for the picture in chat.',
          },
        },
        required: ['prompt'],
      },
      execute: async (
        args: { prompt: string; caption?: string },
        ctx: ExecutionContext
      ): Promise<ToolResult> => {
        const prompt = (args.prompt || '').trim();
        if (!prompt) {
          return { success: false, message: 'Please provide a prompt describing the image you want to generate.' };
        }

        console.log(`[ImageGen] 🎨 Generating image for prompt: "${prompt}" using FLUX.1-Krea-dev...`);

        const hfToken = config.huggingface.apiKey;

        // Hugging Face Inference Router with provider="fal-ai" and model="black-forest-labs/FLUX.1-Krea-dev"
        try {
          const endpoint = 'https://router.huggingface.co/fal-ai/fal-ai/flux/krea';
          const hfRes = await fetch(endpoint, {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${hfToken}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ prompt }),
          });

          if (hfRes.ok) {
            const data = (await hfRes.json()) as any;
            const imageUrl = data?.images?.[0]?.url;
            if (imageUrl) {
              console.log(`[ImageGen] FLUX.1-Krea-dev generated image URL: ${imageUrl.slice(0, 60)}...`);
              const imgFetch = await fetch(imageUrl);
              if (imgFetch.ok) {
                const arrayBuf = await imgFetch.arrayBuffer();
                const buffer = Buffer.from(arrayBuf);
                await ctx.sendImage(buffer, args.caption || `🎨 ${prompt}`);
                return {
                  success: true,
                  message: 'Image generated successfully with FLUX.1-Krea-dev and sent to WhatsApp!',
                };
              }
            }
          } else {
            const errData = await hfRes.text();
            console.warn(`[ImageGen] Hugging Face router returned ${hfRes.status}:`, errData.slice(0, 160));
            if (hfRes.status === 402 || errData.includes('credits')) {
              return {
                success: false,
                message:
                  'Omo chief, your Hugging Face / fal-ai credits don exhaust (402 Payment Required)! Top up your Hugging Face pre-paid credits or PRO subscription make FLUX.1-Krea-dev fit cook fresh images sharp sharp! 🎨',
              };
            }
          }
        } catch (hfErr: any) {
          console.warn('[ImageGen] Hugging Face FLUX.1-Krea-dev request failed:', hfErr.message);
        }

        return {
          success: false,
          message:
            'Could not generate image at this moment. Please verify your Hugging Face Inference credits or try again shortly.',
        };
      },
    },
  ];
}

export const imageGenPlugin = new ImageGenPlugin();
