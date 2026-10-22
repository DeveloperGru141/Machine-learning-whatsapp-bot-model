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

  // Groq Vision Models (Qwen 3.8 27B multimodal + Llama 4 fallbacks)
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

/**
 * Multimodal Sticker Classifier:
 * Analyzes the visual content of a WhatsApp sticker (.webp) and classifies its emotional tone and vibe.
 */
export async function classifyStickerVibe(
  stickerBuffer: Buffer,
  contextHint?: string
): Promise<string | null> {
  const base64Data = stickerBuffer.toString('base64');
  const userPrompt = `You are an AI analyzing a WhatsApp sticker to identify its emotional tone and vibe in a chat conversation.
Context of conversation: "${contextHint || 'None'}".

Determine which vibe category this sticker best matches:
- humor (funny, laughing, joke, meme, giggling, smiling, lol)
- celebration (congratulations, party, fire, win, hype, dancing)
- agreement (thumbs up, facts, handshake, nod, correct, 100)
- shock (surprised, jaw dropped, wide eyes, screaming, mind blown)
- teasing (smirk, side-eye, playful clown, teasing, wink)
- cool (sunglasses, boss, swag, chill, smooth, odogwu)
- confusion (thinking, puzzled, question mark, scratching head, huh)
- facepalm (exhausted, smh, frustrated, facepalm, sigh, tired)
- salute (respect, loyalty, bow, praying hands, twale)

Return ONLY the single category name in lowercase (e.g. "humor", "agreement", "shock", "cool", "celebration", "teasing", "facepalm", "salute", "confusion"). Do not include punctuation or explanation.`;

  if (!config.groq.apiKey) {
    return null;
  }

  const visionModels = ['qwen/qwen3.8-27b', 'meta-llama/llama-4-scout-17b-16e-instruct'];
  for (const model of visionModels) {
    try {
      const response = await groq.chat.completions.create({
        model,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: userPrompt },
              {
                type: 'image_url',
                image_url: {
                  url: `data:image/webp;base64,${base64Data}`,
                },
              },
            ],
          },
        ],
        max_completion_tokens: 50,
        temperature: 0.2,
      } as any);

      const text = response.choices[0]?.message?.content?.toLowerCase().trim();
      if (text) {
        const validVibes = [
          'humor',
          'celebration',
          'agreement',
          'shock',
          'teasing',
          'cool',
          'confusion',
          'facepalm',
          'salute',
        ];
        const matched = validVibes.find((v) => text.includes(v));
        if (matched) {
          console.log(`[Vision] 🎯 Classified sticker vibe via Groq (${model}): "${matched}"`);
          return matched;
        }
      }
    } catch {}
  }

  return null;
}
