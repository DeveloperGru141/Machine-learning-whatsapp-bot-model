import dns from 'node:dns';
import { Client } from '@gradio/client';
import { IPlugin, BotTool, ExecutionContext, ToolResult } from '../types.js';
import { config } from '../../config/env.js';
import { fetchPublicHttpUrl, readLimitedResponse } from '../../security/url-policy.js';

// Ensure IPv4 first to prevent DNS/TLS timeouts on Windows and regional ISPs
try {
  dns.setDefaultResultOrder('ipv4first');
} catch {}

/**
 * Automatically boosts prompt aesthetics and photorealism for top-tier visual outputs.
 */
function boostPromptQuality(rawPrompt: string): string {
  const p = rawPrompt.trim();
  if (/(?:8k|photorealistic|cinematic|hyperrealistic|studio lighting|octane render|masterpiece|ultra detailed|canon|nikon)/i.test(p)) {
    return p;
  }
  return `${p}, cinematic lighting, photorealistic, highly detailed, sharp focus, 8k resolution, masterpiece`;
}

export class ImageGenPlugin implements IPlugin {
  name = 'ImageGenerator';
  version = '2.3.0';
  description = 'Generates top-tier, hyper-realistic, and artistic images using state-of-the-art open-source FLUX.1 models hosted on Hugging Face Spaces.';

  tools: BotTool[] = [
    {
      name: 'generate_image',
      description:
        'Generates a stunning, high-definition image from a descriptive text prompt using the world-class open-source FLUX.1 model (by Black Forest Labs via Hugging Face) and delivers the photo directly to WhatsApp. Use whenever someone asks to draw, generate, create, show, or make a picture or image.',
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
        const rawPrompt = (args.prompt || '').trim();
        if (!rawPrompt) {
          return { success: false, message: 'Please provide a prompt describing the image you want to generate.' };
        }

        const prompt = boostPromptQuality(rawPrompt);
        console.log(`[ImageGen] 🎨 Generating top-tier image with FLUX.1 for: "${prompt.slice(0, 80)}..."`);

        const hfToken = config.huggingface.apiKey;

        // Top-tier official FLUX.1 models running on Hugging Face ZeroGPU (100% free, zero paid credits required)
        const SPACES = [
          { id: 'black-forest-labs/FLUX.1-schnell', steps: 4, width: 768, height: 768 },
          { id: 'black-forest-labs/FLUX.1-dev', steps: 25, width: 768, height: 768, guidance: 3.5 },
        ];

        for (const target of SPACES) {
          try {
            console.log(`[ImageGen] Connecting to top-tier Space "${target.id}"...`);
            const client = await Client.connect(target.id, {
              token: hfToken as any,
            });

            console.log(`[ImageGen] Requesting FLUX.1 inference (${target.width}x${target.height}, ${target.steps} steps)...`);
            const payload: any = {
              prompt,
              seed: Math.floor(Math.random() * 1000000),
              randomize_seed: true,
              width: target.width,
              height: target.height,
              num_inference_steps: target.steps,
            };
            if (target.guidance) {
              payload.guidance_scale = target.guidance;
            }

            const result: any = await client.predict('/infer', payload);
            const fileData = result?.data?.[0];
            let imageBuffer: Buffer | null = null;

            if (fileData) {
              const fileUrl = typeof fileData === 'string' ? fileData : fileData?.url;

              if (fileUrl && (fileUrl.startsWith('http://') || fileUrl.startsWith('https://'))) {
                console.log(`[ImageGen] Fetching generated FLUX.1 image: ${fileUrl.slice(0, 60)}...`);
                const imgRes = await fetchPublicHttpUrl(fileUrl, { signal: AbortSignal.timeout(15_000) });
                if (imgRes.ok) {
                  imageBuffer = await readLimitedResponse(imgRes, 20 * 1024 * 1024);
                }
              }
            }

            if (imageBuffer && imageBuffer.length > 0) {
              console.log(`[ImageGen] ✅ Top-tier FLUX.1 image generated (${imageBuffer.length} bytes)! Sending to WhatsApp...`);
              await ctx.sendImage(imageBuffer, args.caption || `🎨 ${rawPrompt}`);
              return {
                success: true,
                message: `Top-tier image generated successfully with FLUX.1 and sent to WhatsApp!`,
                data: { prompt: rawPrompt, space: target.id, sizeBytes: imageBuffer.length },
              };
            }
          } catch (spaceErr: any) {
            console.warn(`[ImageGen] Space "${target.id}" inference notice:`, spaceErr.message || spaceErr);
          }
        }

        return {
          success: false,
          message:
            'Could not generate image at this moment. The FLUX.1 GPU cluster is currently busy. Please try again shortly.',
        };
      },
    },
  ];
}

export const imageGenPlugin = new ImageGenPlugin();
