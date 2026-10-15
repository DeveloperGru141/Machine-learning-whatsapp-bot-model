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
        styleGuidance = `Chat Vibe: Fast-paced & short. Keep your replies concise (1-2 sentences), vibrant, and punchy.`;
      } else if (profile.formality_style === 'sticker_heavy') {
        styleGuidance = `Chat Vibe: Highly visual and expressive. Sticker usage is frequent. Don't hesitate to use the \`send_sticker\` tool to react to jokes, banter, or greetings.`;
      } else if (profile.formality_style === 'detailed') {
        styleGuidance = `Chat Vibe: In-depth and thoughtful. Elaborate clearly when explaining concepts.`;
      } else {
        styleGuidance = `Chat Vibe: Natural, relaxed WhatsApp banter. Blend humor and helpfulness.`;
      }
    } else {
      styleGuidance = `Chat Vibe: Natural, engaging, and friendly WhatsApp chat style.`;
    }

    // 2. Fetch top learned dialogue exemplars across the database
    const exemplars = db.prepare(`
      SELECT context_text, response_text, response_type
      FROM dialogue_exemplars
      WHERE chat_jid = ? OR 1=1
      ORDER BY quality_score DESC, RANDOM()
      LIMIT 3
    `).all(chatJid) as unknown as Array<{ context_text: string; response_text: string; response_type: string }>;

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
