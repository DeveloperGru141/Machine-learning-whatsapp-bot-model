import { groq } from '../agent/groq.js';
import { config } from '../config/env.js';

export async function analyzeImageBuffer(
  imageBuffer: Buffer,
  prompt?: string
): Promise<string | null> {
  const base64Data = imageBuffer.toString('base64');
  const userQuestion =
    prompt?.trim() ||
    'Describe this image clearly, reading any text, documents, or details present.';

  // 1. Primary Engine: Gemini 2.5 Flash Vision if GEMINI_API_KEY is available
  const geminiKey = config.gemini.apiKey || process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  if (geminiKey) {
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${geminiKey}`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [
            {
              parts: [
                { text: userQuestion },
                { inlineData: { mimeType: 'image/jpeg', data: base64Data } },
              ],
            },
          ],
        }),
      });
      if (res.ok) {
        const data = (await res.json()) as any;
        const text = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
        if (text) {
          console.log(`[Vision] Read image via Gemini Vision (${text.length} chars)`);
          return text;
        }
      }
    } catch (err: any) {
      console.warn('[Vision] Gemini Vision fallback triggered:', err.message);
    }
  }

  // 2. Groq Vision Models (Qwen 3.8 27B multimodal + Llama 4 fallbacks)
  if (!config.groq.apiKey) {
    console.warn('[Vision] GROQ_API_KEY is not configured');
    return null;
  }

  const visionModels = [
    'qwen/qwen3.8-27b',
    'meta-llama/llama-4-scout-17b-16e-instruct',
    'meta-llama/llama-4-maverick-17b-128e-instruct',
  ];

  for (const model of visionModels) {
    try {
      const response = await groq.chat.completions.create({
        model,
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
        temperature: 0.5,
        reasoning_effort: 'low',
      } as any);

      const description = response.choices[0]?.message?.content?.trim() || null;
      if (description) {
        console.log(`[Vision] Read image successfully via ${model} (${description.length} chars)`);
        return description;
      }
    } catch (err: any) {
      console.warn(`[Vision] Model ${model} unavailable (${err.message})`);
    }
  }

  return null;
}

