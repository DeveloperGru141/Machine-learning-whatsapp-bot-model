import { db } from '../memory/db.js';

export interface StyleAdapterContext {
  styleGuidance: string;
  fewShotExemplars: Array<{ context: string; response: string; type: string }>;
}

export class StyleAdapter {
  /**
   * Detects the underlying intent or vibe of an incoming user message
   * to select the most relevant few-shot training exemplars for the prompt.
   */
  private detectIntentVibe(text?: string): string | null {
    if (!text) return null;
    const lower = text.toLowerCase().trim();

    if (/\b(ademola|creator|developer|who built|who made|who coded|who owns|who created|who trained|who programmed|who runs|who is behind)\b/i.test(lower)) {
      return 'creator';
    }
    if (/\b(who are you|what are you|your name|forgelabs|nova|are you nova|are you chatgpt|what is this bot|what can you do)\b/i.test(lower)) {
      return 'identity';
    }
    if (/^(hi|hello|hey|yo|sup|good morning|gm|good afternoon|good evening|howdy)\b/i.test(lower)) {
      return 'greeting';
    }
    if (/\b(btc|bitcoin|eth|sol|price|crypto|stock|market)\b/i.test(lower)) {
      return 'crypto';
    }
    if (/\b(how far|wetin|omo|abeg|dey craze|whine|stress|fr|lol|lmao|hehe|fire|no cap)\b/i.test(lower)) {
      return 'slang';
    }
    if (/\b(download|video|audio|remind|reminder|pdf|doc|document|summarize|read|vcf|contact|voice note|voicenote|vn|speak|say|tts)\b/i.test(lower)) {
      return 'tools';
    }
    return null;
  }

  public getStyleContext(chatJid: string, incomingText?: string): StyleAdapterContext {
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

    // 2. Fetch targeted few-shot exemplars: Match user intent first, then backfill general exemplars
    const targetVibe = this.detectIntentVibe(incomingText);
    const exemplars: Array<{ context_text: string; response_text: string; response_type: string }> = [];

    if (targetVibe) {
      const targeted = db.prepare(`
        SELECT context_text, response_text, response_type
        FROM dialogue_exemplars
        WHERE response_type != 'sticker' AND response_text IS NOT NULL AND response_text != ''
          AND vibe_classification = ?
        ORDER BY quality_score DESC, RANDOM()
        LIMIT 3
      `).all(targetVibe) as Array<{ context_text: string; response_text: string; response_type: string }>;

      exemplars.push(...targeted);
    }

    const remainingSlots = 6 - exemplars.length;
    if (remainingSlots > 0) {
      const existingContexts = new Set(exemplars.map((e) => e.context_text));
      const general = db.prepare(`
        SELECT context_text, response_text, response_type
        FROM dialogue_exemplars
        WHERE response_type != 'sticker' AND response_text IS NOT NULL AND response_text != ''
          ${targetVibe ? 'AND vibe_classification != ?' : ''}
        ORDER BY quality_score DESC, RANDOM()
        LIMIT ?
      `).all(...(targetVibe ? [targetVibe, remainingSlots + 2] : [remainingSlots + 2])) as Array<{ context_text: string; response_text: string; response_type: string }>;

      for (const g of general) {
        if (!existingContexts.has(g.context_text) && exemplars.length < 6) {
          exemplars.push(g);
          existingContexts.add(g.context_text);
        }
      }
    }

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
