import dns from 'node:dns';
import fs from 'fs';
import { Client } from '@gradio/client';
import { IPlugin, BotTool, ExecutionContext, ToolResult } from '../types.js';
import { config } from '../../config/env.js';

// Ensure IPv4 first to prevent DNS/TLS timeouts on Windows and regional ISPs
try {
  dns.setDefaultResultOrder('ipv4first');
} catch {}

export class ImageGenPlugin implements IPlugin {
  name = 'ImageGenerator';
  version = '2.2.0';
  description = 'Generates realistic, artistic, and conceptual images using free open-source FLUX.1 models hosted on Hugging Face Spaces.';

  tools: BotTool[] = [
    {
      name: 'generate_image',
      description:
        'Generates an image from a descriptive text prompt using free open-source FLUX.1 (via Hugging Face) and delivers the photo directly to WhatsApp. Use whenever someone asks to draw, generate, create, show, or make a picture or image.',
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

        console.log(`[ImageGen] 🎨 Generating free image for prompt: "${prompt}" using open-source FLUX.1 on Hugging Face...`);

        const hfToken = config.huggingface.apiKey;

        // Candidate Hugging Face ZeroGPU Spaces running official FLUX.1 models (100% free, zero paid credits needed)
        const CANDIDATE_SPACES = [
          'black-forest-labs/FLUX.1-schnell',
          'black-forest-labs/FLUX.1-dev',
        ];

        for (const spaceId of CANDIDATE_SPACES) {
          try {
            console.log(`[ImageGen] Connecting to free Hugging Face Space "${spaceId}"...`);
            const client = await Client.connect(spaceId, {
              token: hfToken as any,
            });

            console.log(`[ImageGen] Requesting inference from ${spaceId}...`);
            const result: any = await client.predict('/infer', {
              prompt,
              seed: 0,
              randomize_seed: true,
              width: 512,
              height: 512,
              num_inference_steps: 4,
            });

            const fileData = result?.data?.[0];
            let imageBuffer: Buffer | null = null;

            if (fileData) {
              const fileUrl = typeof fileData === 'string' ? fileData : fileData?.url;
              const localPath = typeof fileData === 'object' ? fileData?.path : undefined;

              if (fileUrl && (fileUrl.startsWith('http://') || fileUrl.startsWith('https://'))) {
                console.log(`[ImageGen] Fetching generated image from Space URL: ${fileUrl.slice(0, 60)}...`);
                const imgRes = await fetch(fileUrl);
                if (imgRes.ok) {
                  const arr = await imgRes.arrayBuffer();
                  imageBuffer = Buffer.from(arr);
                }
              } else if (localPath && fs.existsSync(localPath)) {
                imageBuffer = fs.readFileSync(localPath);
              }
            }

            if (imageBuffer && imageBuffer.length > 0) {
              console.log(`[ImageGen] ✅ Image generated successfully (${imageBuffer.length} bytes)! Sending to WhatsApp...`);
              await ctx.sendImage(imageBuffer, args.caption || `🎨 ${prompt}`);
              return {
                success: true,
                message: `Image generated successfully using open-source FLUX.1 on Hugging Face and sent to WhatsApp!`,
                data: { prompt, space: spaceId, sizeBytes: imageBuffer.length },
              };
            }
          } catch (spaceErr: any) {
            console.warn(`[ImageGen] Free Space "${spaceId}" inference failed:`, spaceErr.message || spaceErr);
          }
        }

        return {
          success: false,
          message:
            'Could not generate image at this moment. Hugging Face free GPU spaces are currently high in demand. Please try again in a few moments.',
        };
      },
    },
  ];
}

export const imageGenPlugin = new ImageGenPlugin();
