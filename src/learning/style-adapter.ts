import { db } from '../memory/db.js';

export interface StyleAdapterContext {
  styleGuidance: string;
  fewShotExemplars: Array<{ context: string; response: string; type: string }>;
}

export class StyleAdapter {
  public getStyleContext(chatJid: string): StyleAdapterContext {
    // 1. Fetch learned profile for this chat
    const profile = db.prepare(`
      SELECT sticker_ratio, avg_length, formality_style
      FROM chat_style_profiles
      WHERE chat_jid = ?
    `).get(chatJid) as unknown as { sticker_ratio: number; avg_length: number; formality_style: string } | undefined;

    let styleGuidance = '';
    if (profile) {
      if (profile.formality_style === 'short_punchy') {
        styleGuidance = `Chat Vibe: Fast-paced & direct. Keep replies short (1-2 sentences), natural, zero fluff, NO emoji spam.`;
      } else if (profile.formality_style === 'detailed') {
        styleGuidance = `Chat Vibe: Thoughtful and clear. Explain concepts simply without robotic jargon, NO emoji spam.`;
      } else {
        styleGuidance = `Chat Vibe: Natural, relaxed WhatsApp banter. Authentic friend vibe, sharp, witty, NO emoji spam (0 to 1 emoji max).`;
      }
    } else {
      styleGuidance = `Chat Vibe: Authentic WhatsApp user cadence. Short, sharp, friendly, zero AI clichés, NO emoji spam.`;
    }

    // 2. Fetch top learned dialogue exemplars across the database (text-only, human-like)
    const exemplars = db.prepare(`
      SELECT context_text, response_text, response_type
      FROM dialogue_exemplars
      WHERE response_type != 'sticker' AND response_text IS NOT NULL AND response_text != ''
      ORDER BY quality_score DESC, RANDOM()
      LIMIT 6
    `).all() as unknown as Array<{ context_text: string; response_text: string; response_type: string }>;

    const formattedExemplars = exemplars.map((e) => ({
      context: e.context_text,
      response: e.response_text,
      type: e.response_type,
    }));

    return {
      styleGuidance,
      fewShotExemplars: formattedExemplars,
    };
  }
}

export const styleAdapter = new StyleAdapter();
