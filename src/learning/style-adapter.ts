import { db } from '../memory/db.js';
import { vectorStore } from './vector-store.js';

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
    if (/\b(who are you|what are you|your name|forgelabs|nova|are you nova|are you chatgpt|what is this bot|what can you do|who am i|what is my name|do you know me|remember me)\b/i.test(lower)) {
      return 'identity';
    }
    if (/\b(micah|david|femi|contact|contacts|address book|phone number|save contact|saved contact|my contacts|who is in your)\b/i.test(lower)) {
      return 'contacts';
    }
    if (/^(hi|hello|hey|yo|sup|good morning|gm|good afternoon|good evening|howdy)\b/i.test(lower)) {
      return 'greeting';
    }
    if (/\b(btc|bitcoin|eth|sol|price|crypto|stock|market)\b/i.test(lower)) {
      return 'crypto';
    }
    if (/\b(shadow slave|sunny|sunless|nephis|nightmare spell|guiltythree|solo leveling|jin-woo|klein moretti|omniscient reader|gojo|anime|manga|web novel|manhwa|light novel)\b/i.test(lower)) {
      return 'novel';
    }
    if (/\b(code|coding|bug|error|typescript|javascript|python|react|flutter|api|sql|database|git|github|async|promise|function|recursion|algorithm|backend|frontend|linux|docker|server|deploy|compiler|syntax)\b/i.test(lower)) {
      return 'tech';
    }
    if (/\b(what is|explain|how does|why does|how to|meaning of|tell me about|difference between|how do i|can you explain|why is|what are|breakdown)\b/i.test(lower)) {
      return 'tech';
    }
    if (/\b(thank|thanks|appreciate|good job|smart bro|well done|nice one)\b/i.test(lower)) {
      return 'appreciation';
    }
    if (/\b(gay|werey|mumu|ode|craze|fool|mad|idiot|stupid|whine|tease|ashewo|olodo|oloshi|scam)\b/i.test(lower)) {
      return 'banter';
    }
    if (/\b(how far|wetin|omo|abeg|dey craze|whine|stress|fr|lol|lmao|hehe|fire|no cap|how body|you don chop|which level|how market)\b/i.test(lower)) {
      return 'slang';
    }
    if (/\b(download|video|audio|remind|reminder|pdf|doc|document|summarize|read|vcf|voice note|voicenote|vn|speak|say|tts|scrape|link|url|website|article)\b/i.test(lower)) {
      return 'tools';
    }
    if (/\b(check in|checking in|checking up|check up|dropped|follow up|following up|saying hi|say hi|haven't heard|how have you been|how you dey|long time|quiet here|how did that go|update on)\b/i.test(lower)) {
      return 'followup';
    }
    return 'tech';
  }

  public async getStyleContext(chatJid: string, incomingText?: string): Promise<StyleAdapterContext> {
    // 1. Fetch learned profile for this chat
    const profile = await db.prepare(`
      SELECT sticker_ratio, avg_length, formality_style, top_emojis
      FROM chat_style_profiles
      WHERE chat_jid = ?
    `).get(chatJid) as unknown as { sticker_ratio: number; avg_length: number; formality_style: string; top_emojis?: string } | undefined;

    let learnedEmojis = '😂 🤝 🔥';
    if (profile?.top_emojis) {
      try {
        const parsed = JSON.parse(profile.top_emojis);
        if (Array.isArray(parsed) && parsed.length > 0) {
          learnedEmojis = parsed.join(' ');
        }
      } catch {}
    }

    let styleGuidance = '';
    if (profile) {
      if (profile.formality_style === 'short_punchy') {
        styleGuidance = `Chat Cadence: Short, snappy (1-2 sentences). Pure Nigerian WhatsApp flow, zero AI clichés. Learned Emoji Pattern: [${learnedEmojis}]. Include at least one fitting contextual emoji where natural (1-2 emojis max).`;
      } else if (profile.formality_style === 'detailed') {
        styleGuidance = `Chat Cadence: Clear and punchy. Explain simply without robotic jargon. Learned Emoji Pattern: [${learnedEmojis}]. Include at least one fitting contextual emoji where natural (1-2 emojis max).`;
      } else {
        styleGuidance = `Chat Cadence: Authentic WhatsApp banter. Sharp, witty, friendly friend vibe. Learned Emoji Pattern: [${learnedEmojis}]. Include at least one fitting contextual emoji where natural (1-2 emojis max).`;
      }
    } else {
      styleGuidance = `Chat Cadence: Natural WhatsApp peer flow. Crisp, witty, zero customer-service tropes. Learned Emoji Pattern: [${learnedEmojis}]. Include at least one fitting contextual emoji where natural (1-2 emojis max).`;
    }

    // 2. Fetch targeted few-shot exemplars: First by semantic vector similarity, then by intent vibe, then general backfill
    const targetVibe = this.detectIntentVibe(incomingText);
    const exemplars: Array<{ context_text: string; response_text: string; response_type: string }> = [];

    // Semantic Vector Matching: Pull closest dialogue pairs from training pipeline
    if (incomingText && incomingText.trim().length >= 4) {
      try {
        const queryVec = vectorStore.embed(incomingText);
        const candidates = await db.prepare(`
          SELECT context_text, response_text, response_type
          FROM dialogue_exemplars
          WHERE response_type != 'sticker' AND response_text IS NOT NULL AND response_text != ''
          ORDER BY quality_score DESC
          LIMIT 120
        `).all() as Array<{ context_text: string; response_text: string; response_type: string }>;

        const scored = candidates.map((c) => {
          const v = vectorStore.embed(c.context_text);
          let dot = 0;
          for (let i = 0; i < 256; i++) dot += queryVec[i] * v[i];
          return { ...c, score: dot };
        });

        scored.sort((a, b) => b.score - a.score);
        for (const item of scored) {
          if (item.score >= 0.20 && exemplars.length < 3) {
            exemplars.push({
              context_text: item.context_text,
              response_text: item.response_text,
              response_type: item.response_type,
            });
          }
        }
      } catch {}
    }

    if (targetVibe && exemplars.length < 3) {
      const targeted = await db.prepare(`
        SELECT context_text, response_text, response_type
        FROM dialogue_exemplars
        WHERE response_type != 'sticker' AND response_text IS NOT NULL AND response_text != ''
          AND vibe_classification = ?
        ORDER BY quality_score DESC, RANDOM()
        LIMIT 3
      `).all(targetVibe) as Array<{ context_text: string; response_text: string; response_type: string }>;

      for (const t of targeted) {
        if (!exemplars.some((e) => e.context_text === t.context_text) && exemplars.length < 3) {
          exemplars.push(t);
        }
      }

      if (targetVibe === 'banter' && targeted.length === 0) {
        exemplars.push(
          {
            context_text: "You dey gay or what?",
            response_text: "Guy rest abeg, who dey gay? Which kind yeye question be that? Dey play! 😂",
            response_type: "text",
          },
          {
            context_text: "You be mumu bot",
            response_text: "Na your papa be mumu. See this head like coconut, come dey form sharp. Wetin you want? 😂",
            response_type: "text",
          },
          {
            context_text: "Werey bot",
            response_text: "Werey dey disguise! Who leave mental hospital gate open for you? Wetin you need boss? 😂",
            response_type: "text",
          }
        );
      }
    }

    const remainingSlots = 5 - exemplars.length;
    if (remainingSlots > 0) {
      const existingContexts = new Set(exemplars.map((e) => e.context_text));
      const general = await db.prepare(`
        SELECT context_text, response_text, response_type
        FROM dialogue_exemplars
        WHERE response_type != 'sticker' AND response_text IS NOT NULL AND response_text != ''
          AND vibe_classification IN ('slang', 'casual', 'creator')
        ORDER BY quality_score DESC, RANDOM()
        LIMIT 6
      `).all() as Array<{ context_text: string; response_text: string; response_type: string }>;

      for (const g of general) {
        if (!existingContexts.has(g.context_text) && exemplars.length < 5) {
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
