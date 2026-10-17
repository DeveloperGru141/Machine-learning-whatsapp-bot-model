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

          // 1. Primary Engine: Nano Banana (Google Imagen 3 / Nano Banana Pro)
          if (geminiApiKey) {
            console.log('[ImageGen] 🍌 Generating via Nano Banana (Nano Banana Pro / Gemini 3 Image)...');
            try {
              const bananaModels = [
                'gemini-2.5-flash-image',
                'gemini-3-pro-image',
                'nano-banana-pro-preview',
                'gemini-3.1-flash-image',
                'gemini-nano-banana-2.1',
                'imagen-3.0-generate-002',
              ];

              for (const model of bananaModels) {
                try {
                  // Attempt 1: generateContent with IMAGE responseModality
                  const generateContentUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${geminiApiKey}`;
                  const response = await fetch(generateContentUrl, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                      contents: [
                        {
                          parts: [
                            { text: `Generate a high quality, detailed, photorealistic image: ${args.prompt}` },
                          ],
                        },
                      ],
                      generationConfig: {
                        responseModalities: ['IMAGE'],
                      },
                    }),
                    signal: AbortSignal.timeout(25000),
                  });

                  if (response.ok) {
                    const data = (await response.json()) as any;
                    const inlinePart = data.candidates?.[0]?.content?.parts?.find((p: any) => p.inlineData);
                    const base64Data = inlinePart?.inlineData?.data;

                    if (base64Data) {
                      const imageBuffer = Buffer.from(base64Data, 'base64');
                      const caption = args.caption || `🎨 "${args.prompt}" (Google Imagen)`;
                      await ctx.sendImage(imageBuffer, caption);

                      console.log(`[ImageGen] ✅ Google Imagen (${model}) image successfully generated (${imageBuffer.length} bytes) and sent!`);
                      return {
                        success: true,
                        message: `Top-tier image generated via Google Imagen (${model}) and sent to chat.`,
                      };
                    }
                  } else {
                    const errText = await response.text();
                    if (response.status === 429) {
                      console.warn(`[ImageGen] Google ${model} returned 429 Quota Exceeded (Google AI Studio requires Pay-As-You-Go/Billing enabled for image models).`);
                    } else {
                      console.warn(`[ImageGen] Google ${model} failed (${response.status}): ${errText.slice(0, 150)}`);
                    }
                  }
                } catch (singleModelErr: any) {
                  // Try next model
                }
              }

              console.warn('[ImageGen] ⚠️ Google image quota limit reached (free tier limit is 0 for image models). Falling back to ultra-high quality FLUX Realism engine...');
            } catch (bananaErr: any) {
              console.warn(`[ImageGen] Google engine error: ${bananaErr.message}. Falling back...`);
            }
          } else {
            console.log('[ImageGen] Note: GEMINI_API_KEY not configured. Using high-resolution FLUX Realism engine.');
          }

          // 2. High-Resolution Photorealistic FLUX Realism Engine
          console.log('[ImageGen] Generating via high-resolution FLUX Realism engine with automatic prompt enhancement...');
          const enhancedPrompt = encodeURIComponent(`${args.prompt}, 8k resolution, award winning photography, ultra-detailed, photorealistic masterpiece, sharp focus, natural lighting`);

          const fallbackEngines = [
            `https://image.pollinations.ai/prompt/${enhancedPrompt}?model=flux-realism&width=1024&height=1024&nologo=true&enhance=true&private=true&seed=${Math.floor(Math.random() * 1000000)}`,
            `https://image.pollinations.ai/prompt/${enhancedPrompt}?model=flux-pro&width=1024&height=1024&nologo=true&enhance=true&private=true&seed=${Math.floor(Math.random() * 1000000)}`,
            `https://image.pollinations.ai/prompt/${enhancedPrompt}?model=flux&width=1024&height=1024&nologo=true&enhance=true&private=true&seed=${Math.floor(Math.random() * 1000000)}`,
          ];

          for (const engineUrl of fallbackEngines) {
            try {
              const res = await fetch(engineUrl, { signal: AbortSignal.timeout(25000) });
              if (res.ok) {
                const arrayBuffer = await res.arrayBuffer();
                const buffer = Buffer.from(arrayBuffer);
                if (buffer.length > 5000) {
                  const caption = args.caption || `🎨 "${args.prompt}"`;
                  await ctx.sendImage(buffer, caption);
                  console.log(`[ImageGen] ✅ FLUX Realism image successfully delivered (${buffer.length} bytes).`);
                  return {
                    success: true,
                    message: 'Image generated and delivered successfully to WhatsApp chat.',
                  };
                }
              }
            } catch (err: any) {
              console.warn(`[ImageGen] Fallback engine error: ${err.message}, trying next...`);
            }
          }

          return {
            success: false,
            message: 'Image generation failed across all available engines. Please try again with a different visual prompt.',
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
