import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'node:url';
import type { WAMessage } from '@whiskeysockets/baileys';
import { db } from '../../memory/db.js';
import { classifyStickerVibe } from '../../core/vision.js';
import { downloadMediaMessageBounded } from '../../security/media-limits.js';

export type StickerVibe =
  | 'humor'
  | 'celebration'
  | 'agreement'
  | 'shock'
  | 'teasing'
  | 'cool'
  | 'confusion'
  | 'facepalm'
  | 'salute'
  | 'general';

export interface StickerMatch {
  filename: string;
  absolutePath: string;
  vibe: StickerVibe;
  confidence: number;
}

const STICKER_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../assets/stickers');

/**
 * Intelligent Pattern Recognition Dictionary:
 * Maps conversational intent, slang, emojis, and phrasing to sticker vibes.
 */
const VIBE_PATTERNS: Record<StickerVibe, RegExp> = {
  humor: /(?:\b(?:lol|lmao|lmfao|rofl|haha|hahaha|hehe|kikiki|lwkmd|dead|die|funny|joke|banter|cracking)\b|😂|🤣|💀|😭)/i,
  celebration: /(?:\b(?:congrats|congratulations|win|won|victory|celebrate|happy|success|party|hurray|cheers|fire|lit|blessed)\b|🎉|🎊|🔥|✨|🥂)/i,
  agreement: /(?:\b(?:facts|true|correct|valid|spot on|no cap|agreed|exactly|100|sure|definitely|thumbsup|sabiman|you sabi)\b|👍|🤝|💯|✔️)/i,
  shock: /(?:\b(?:what|wtf|omg|wow|shock|shocked|impossible|no way|really|screaming|eyes|mindblown|unbelievable|e shock me|o ga o|chinedu)\b|😲|😱|🤯|👀)/i,
  teasing: /(?:\b(?:side eye|sideeye|smirk|werey|mumu|ode|clown|fool|shakara|yarn|dey play|play|tease|teasing)\b|😏|🤡|👀|😜|🤪)/i,
  cool: /(?:\b(?:cool|smooth|swag|boss|odogwu|chief|senior man|soft|chill|relaxed|easy)\b|😎|🕶️|🤙)/i,
  confusion: /(?:\b(?:huh|what do you mean|confused|confusion|dont understand|how come|why|question|scratch head|thinking|hmm)\b|🤔|🤨|❓)/i,
  facepalm: /(?:\b(?:facepalm|smh|sigh|tired|exhausted|frustrated|give up|god forbid|why me)\b|🤦|🤦‍♂️|🤦‍♀️|😩|😮‍💨)/i,
  salute: /(?:\b(?:respect|salute|solid|loyal|loyalty|twale|baba|honor|bow|cap)\b|🫡|🙌|🙏)/i,
  general: /.*/i,
};

class StickerEngine {
  private indexedStickers: Array<{ filename: string; absolutePath: string; vibe: StickerVibe }> = [];
  private isInitialized = false;

  public initialize(): void {
    if (this.isInitialized) return;

    try {
      if (!fs.existsSync(STICKER_DIR)) {
        console.warn(`[StickerEngine] Sticker directory not found at: ${STICKER_DIR}`);
        return;
      }

      const files = fs.readdirSync(STICKER_DIR).filter((f) => {
        if (!f.toLowerCase().endsWith('.webp')) return false;
        try {
          return fs.statSync(path.join(STICKER_DIR, f)).size >= 2000;
        } catch {
          return false;
        }
      });
      console.log(`[StickerEngine] 🎨 Scanning ${files.length} stickers from assets/stickers...`);

      const vibes: StickerVibe[] = [
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

      this.indexedStickers = files.map((filename, idx) => {
        const lower = filename.toLowerCase();
        let assignedVibe: StickerVibe = 'general';

        if (lower.includes('laugh') || lower.includes('funny') || lower.includes('joke')) {
          assignedVibe = 'humor';
        } else if (lower.includes('celebrat') || lower.includes('win') || lower.includes('fire')) {
          assignedVibe = 'celebration';
        } else if (lower.includes('agree') || lower.includes('thumbs') || lower.includes('yes')) {
          assignedVibe = 'agreement';
        } else if (lower.includes('shock') || lower.includes('wow') || lower.includes('eyes')) {
          assignedVibe = 'shock';
        } else if (lower.includes('smirk') || lower.includes('side') || lower.includes('werey')) {
          assignedVibe = 'teasing';
        } else if (lower.includes('cool') || lower.includes('boss') || lower.includes('shades')) {
          assignedVibe = 'cool';
        } else if (lower.includes('think') || lower.includes('confus')) {
          assignedVibe = 'confusion';
        } else if (lower.includes('facepalm') || lower.includes('tired')) {
          assignedVibe = 'facepalm';
        } else {
          // Evenly distribute indexed WA stickers across vibe categories so every mood has a rich palette
          assignedVibe = vibes[idx % vibes.length];
        }

        return {
          filename,
          absolutePath: path.join(STICKER_DIR, filename),
          vibe: assignedVibe,
        };
      });

      this.isInitialized = true;
      console.log(`[StickerEngine] ✅ Successfully indexed ${this.indexedStickers.length} stickers across vibes.`);
    } catch (err: any) {
      console.error('[StickerEngine] Error indexing stickers:', err.message);
    }
  }

  /**
   * Evaluates message text and conversation history to determine the dominant emotional vibe.
   */
  public detectVibeFromText(text: string): { vibe: StickerVibe; confidence: number } {
    const clean = (text || '').trim();
    if (!clean) return { vibe: 'general', confidence: 0.1 };

    // Check high priority vibes first
    const priorities: StickerVibe[] = [
      'humor',
      'celebration',
      'shock',
      'teasing',
      'agreement',
      'salute',
      'confusion',
      'facepalm',
      'cool',
    ];

    for (const v of priorities) {
      const pattern = VIBE_PATTERNS[v];
      if (pattern && pattern.test(clean)) {
        return { vibe: v, confidence: 0.85 };
      }
    }

    return { vibe: 'general', confidence: 0.4 };
  }

  /**
   * Retrieves the best sticker match for an active conversation turn.
   */
  public getMatchingSticker(
    conversationText: string,
    requestedVibe?: StickerVibe | string
  ): StickerMatch | null {
    this.initialize();
    if (this.indexedStickers.length === 0) return null;

    let targetVibe: StickerVibe = 'general';
    let confidence = 0.5;

    if (requestedVibe && VIBE_PATTERNS[requestedVibe as StickerVibe]) {
      targetVibe = requestedVibe as StickerVibe;
      confidence = 0.95;
    } else {
      const detected = this.detectVibeFromText(conversationText);
      targetVibe = detected.vibe;
      confidence = detected.confidence;
    }

    // Filter by matching vibe
    let candidates = this.indexedStickers.filter((s) => s.vibe === targetVibe);
    if (candidates.length === 0) {
      candidates = this.indexedStickers;
    }

    const selected = candidates[Math.floor(Math.random() * candidates.length)];
    return {
      filename: selected.filename,
      absolutePath: selected.absolutePath,
      vibe: selected.vibe,
      confidence,
    };
  }

  /**
   * Decides whether the conversation pattern warrants an automated sticker response.
   * - Triggered on heavy laughter (lwkmd, lol, 💀, 😂), celebratory hype, or witty Nigerian banter.
   */
  public shouldTriggerAutonomousSticker(incomingText: string, _chatJid: string): boolean {
    const clean = (incomingText || '').toLowerCase().trim();
    if (clean.length < 2) return false;

    // Direct laughing outbursts
    const isHeavyLaugh = /\b(lol|lmao|lmfao|rofl|hahaha|lwkmd|dead|💀|😂|🤣)\b/i.test(clean);
    // Hype and excitement
    const isHype = /\b(lets go|congrats|fire|lit|blessed|celebrate|odogwu|🎉|🔥|✨)\b/i.test(clean);
    // Spot on agreement
    const isFacts = /\b(facts|no cap|valid|spot on|you sabi|correct|true talk|💯|👍)\b/i.test(clean);

    if (isHeavyLaugh || isHype || isFacts) {
      // 30% chance in active chats to keep it spontaneous, natural, and never spammy
      return Math.random() < 0.35;
    }

    return false;
  }

  /**
   * Parses an incoming WhatsApp sticker (visual content analysis + chat pattern context)
   * and selects a matching sticker from the catalog with the exact same emotional vibe.
   */
  public async getStickerForIncomingSticker(
    msg: WAMessage,
    chatJid: string
  ): Promise<StickerMatch | null> {
    this.initialize();
    if (this.indexedStickers.length === 0) return null;

    // 1. Gather recent conversation context from chat_logs
    let contextText = '';
    try {
      const recentRows = await db
        .prepare(`
          SELECT message_text FROM chat_logs 
          WHERE chat_jid = ? AND message_text IS NOT NULL AND message_text != ''
          ORDER BY id DESC LIMIT 4
        `)
        .all(chatJid) as Array<{ message_text: string }>;
      contextText = recentRows.map((r) => r.message_text).join(' ');
    } catch {}

    // 2. Check if sticker quotes a message
    const quotedText =
      (msg.message?.stickerMessage?.contextInfo?.quotedMessage as any)?.conversation ||
      (msg.message?.stickerMessage?.contextInfo?.quotedMessage as any)?.extendedTextMessage?.text ||
      '';
    if (quotedText) {
      contextText = `${quotedText} ${contextText}`;
    }

    // 3. Multimodal vision parsing of the sticker image
    let detectedVibe: StickerVibe | null = null;
    try {
      const buffer = await downloadMediaMessageBounded(msg, 2 * 1024 * 1024);
      if (buffer && buffer.length > 0) {
        const visionResult = await classifyStickerVibe(buffer, contextText);
        if (visionResult) {
          detectedVibe = visionResult as StickerVibe;
          console.log(`[StickerEngine] 🎯 Classified incoming sticker vibe via Vision: "${detectedVibe}"`);
        }
      }
    } catch (err: any) {
      console.warn('[StickerEngine] Vision classification note:', err.message);
    }

    // 4. Fallback to conversation context analysis if vision was inconclusive
    if (!detectedVibe) {
      const textVibe = this.detectVibeFromText(contextText);
      detectedVibe = textVibe.vibe !== 'general' ? textVibe.vibe : null;
      if (detectedVibe) {
        console.log(`[StickerEngine] 💬 Detected sticker vibe from conversation context: "${detectedVibe}"`);
      }
    }

    // 5. Default fallback to high-energy friendly reaction (humor, cool, or agreement)
    if (!detectedVibe) {
      const friendlyVibes: StickerVibe[] = ['humor', 'agreement', 'cool', 'teasing'];
      detectedVibe = friendlyVibes[Math.floor(Math.random() * friendlyVibes.length)];
      console.log(`[StickerEngine] 🎲 Selected friendly fallback vibe: "${detectedVibe}"`);
    }

    // 6. Select matching sticker from our 550+ sticker catalog
    return this.getMatchingSticker(contextText, detectedVibe);
  }
}

export const stickerEngine = new StickerEngine();
