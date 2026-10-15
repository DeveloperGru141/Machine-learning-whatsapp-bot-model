import { groq } from '../agent/groq.js';
import { config } from '../config/env.js';

export async function analyzeImageBuffer(
  imageBuffer: Buffer,
  prompt?: string
): Promise<string | null> {
  if (!config.groq.apiKey) {
    console.warn('[Vision] GROQ_API_KEY is not configured');
    return null;
  }

  try {
    const base64Data = imageBuffer.toString('base64');
    const userQuestion = prompt?.trim() || 'Describe this image clearly, reading any text, documents, or details present.';

    const response = await groq.chat.completions.create({
      model: 'llama-3.2-11b-vision-preview',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: userQuestion },
            {
              type: 'image_url',
              image_url: {
                url: `data:image/jpeg;base64,${base64Data}`,
              },
            },
          ],
        },
      ],
      max_completion_tokens: 1024,
      temperature: 0.7,
    });

    const description = response.choices[0]?.message?.content?.trim() || null;
    if (description) {
      console.log(`[Vision] Read image successfully (${description.length} chars)`);
    }
    return description;
  } catch (err: any) {
    console.error('[Vision] Failed to analyze image with Groq Vision:', err.message);
    return null;
  }
}
