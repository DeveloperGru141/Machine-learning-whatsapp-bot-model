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

              console.warn('[ImageGen] ⚠️ Google image generation failed or quota reached.');
            } catch (bananaErr: any) {
              console.warn(`[ImageGen] Google engine error: ${bananaErr.message}`);
            }
          }

          // 2. High-Resolution FLUX Engine via Hugging Face Inference API
          const hfToken = config.huggingface?.apiKey || process.env.HF_TOKEN || process.env.HUGGINGFACE_API_KEY;
          if (hfToken) {
            console.log('[ImageGen] 🚀 Generating via HuggingFace FLUX.1 engine...');
            const hfModels = [
              'black-forest-labs/FLUX.1-schnell',
              'black-forest-labs/FLUX.1-dev',
              'stabilityai/stable-diffusion-xl-base-1.0',
            ];

            for (const hfModel of hfModels) {
              try {
                const res = await fetch(`https://router.huggingface.co/hf-inference/models/${hfModel}`, {
                  method: 'POST',
                  headers: {
                    'Authorization': `Bearer ${hfToken}`,
                    'Content-Type': 'application/json',
                  },
                  body: JSON.stringify({
                    inputs: args.prompt,
                  }),
                  signal: AbortSignal.timeout(35000),
                });

                if (res.ok) {
                  const arrayBuffer = await res.arrayBuffer();
                  const buffer = Buffer.from(arrayBuffer);
                  if (buffer.length > 5000) {
                    const caption = args.caption || `🎨 "${args.prompt}" (${hfModel.split('/')[1]})`;
                    await ctx.sendImage(buffer, caption);
                    console.log(`[ImageGen] ✅ HuggingFace ${hfModel} image successfully delivered (${buffer.length} bytes).`);
                    return {
                      success: true,
                      message: `Image generated via ${hfModel.split('/')[1]} and sent to WhatsApp chat.`,
                    };
                  }
                } else {
                  const errText = await res.text();
                  console.warn(`[ImageGen] HuggingFace ${hfModel} returned ${res.status}: ${errText.slice(0, 120)}`);
                }
              } catch (hfErr: any) {
                console.warn(`[ImageGen] HuggingFace error on ${hfModel}: ${hfErr.message}`);
              }
            }
          }

          return {
            success: false,
            message:
              'Image generation could not be completed: Google AI Studio requires billing enabled for image generation (free tier limit is 0), or provide a valid HF_TOKEN in your environment for FLUX. Pollinations AI has been deactivated.',
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
