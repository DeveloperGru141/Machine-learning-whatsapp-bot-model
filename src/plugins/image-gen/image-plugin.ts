import { IPlugin, BotTool, ExecutionContext, ToolResult } from '../types.js';
import { config } from '../../config/env.js';

export class ImageGenPlugin implements IPlugin {
  name = 'ImageGenerator';
  version = '2.0.0';
  description = 'Generates top-tier high-resolution images & typography using Nano Banana (Google Imagen 3) with FLUX fallback';

  tools: BotTool[] = [
    {
      name: 'generate_image',
      description:
        'Generates a vivid, top-tier image or visual artwork from a descriptive prompt and sends it directly to the WhatsApp chat. ' +
        'Powered by Nano Banana (Google Imagen 3) for industry-leading text rendering and photorealism.',
      parameters: {
        type: 'object',
        properties: {
          prompt: {
            type: 'string',
            description:
              'Detailed visual prompt describing the subject, text/typography in quotes (if any), artistic style, lighting, and composition.',
          },
          caption: {
            type: 'string',
            description: 'Optional witty or descriptive caption to accompany the image in the WhatsApp message.',
          },
          aspectRatio: {
            type: 'string',
            enum: ['1:1', '3:4', '4:3', '9:16', '16:9'],
            description: 'Aspect ratio of the generated image. Defaults to "1:1" (square).',
          },
        },
        required: ['prompt'],
      },
      execute: async (
        args: { prompt: string; caption?: string; aspectRatio?: string },
        ctx: ExecutionContext
      ): Promise<ToolResult> => {
        try {
          console.log(`[ImageGen] 🎨 Image generation request: "${args.prompt}"`);

          const geminiApiKey = config.gemini.apiKey || process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
          const ratio = args.aspectRatio || '1:1';

          // 1. Primary Engine: Nano Banana (Google Imagen 3)
          if (geminiApiKey) {
            console.log('[ImageGen] 🍌 Generating via Nano Banana (Google Imagen 3)...');
            try {
              const url = `https://generativelanguage.googleapis.com/v1beta/models/imagen-3.0-generate-002:predict?key=${geminiApiKey}`;
              const response = await fetch(url, {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                  instances: [{ prompt: args.prompt }],
                  parameters: {
                    sampleCount: 1,
                    aspectRatio: ratio,
                    outputMimeType: 'image/jpeg',
                  },
                }),
              });

              if (response.ok) {
                const data = (await response.json()) as any;
                const base64Data = data.predictions?.[0]?.bytesBase64Encoded;

                if (base64Data) {
                  const imageBuffer = Buffer.from(base64Data, 'base64');
                  const caption = args.caption || `🎨 "${args.prompt}"`;
                  await ctx.sendImage(imageBuffer, caption);

                  console.log(`[ImageGen] ✅ Nano Banana image successfully generated (${imageBuffer.length} bytes) and sent!`);
                  return {
                    success: true,
                    message: 'Top-tier image generated via Nano Banana (Google Imagen 3) and sent to chat.',
                  };
                }
              } else {
                const errText = await response.text();
                console.warn(`[ImageGen] Nano Banana API returned HTTP ${response.status}: ${errText.slice(0, 150)}. Falling back to secondary engine...`);
              }
            } catch (bananaErr: any) {
              console.warn(`[ImageGen] Nano Banana error: ${bananaErr.message}. Falling back...`);
            }
          } else {
            console.log('[ImageGen] Note: GEMINI_API_KEY not configured. Using high-definition FLUX engine (add GEMINI_API_KEY in .env for Nano Banana).');
          }

          // 2. Secondary Engine: Enhanced High-Resolution FLUX.1
          console.log('[ImageGen] Generating via enhanced FLUX.1 engine...');
          const enhancedPrompt = encodeURIComponent(`${args.prompt}, 8k uhd, photorealistic, highly detailed, masterwork`);
          const fluxUrl = `https://image.pollinations.ai/prompt/${enhancedPrompt}?model=flux&width=1024&height=1024&nologo=true&seed=${Math.floor(Math.random() * 1000000)}`;

          const res = await fetch(fluxUrl);
          if (!res.ok) {
            return {
              success: false,
              message: `Image generation failed with HTTP ${res.status}. Please check your prompt or configure GEMINI_API_KEY for Nano Banana.`,
            };
          }

          const arrayBuffer = await res.arrayBuffer();
          const buffer = Buffer.from(arrayBuffer);

          const caption = args.caption || `🎨 "${args.prompt}"`;
          await ctx.sendImage(buffer, caption);

          console.log(`[ImageGen] ✅ FLUX image successfully delivered (${buffer.length} bytes).`);
          return {
            success: true,
            message: 'Image generated and delivered successfully to WhatsApp chat.',
          };
        } catch (err: any) {
          console.error('[ImageGen] Critical error:', err.message);
          return {
            success: false,
            message: `Image generation error: ${err.message}`,
          };
        }
      },
    },
  ];
}

export const imageGenPlugin = new ImageGenPlugin();
