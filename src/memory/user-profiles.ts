import { db } from './db.js';
import { config, normalizePhoneNumber } from '../config/env.js';

export interface UserProfile {
  user_jid: string;
  display_name: string | null;
  preferred_language: string;
  language_source?: string;
  personality_notes: string;
  first_seen: number;
  last_seen: number;
  total_messages: number;
  is_owner: number;
}

export class UserProfileManager {
  constructor() {
    this.seedOwners();
  }

  /**
   * Seeds configured bot owners into user_profiles and contacts with Ademola identity.
   */
  public async seedOwners(): Promise<void> {
    const now = Date.now();
    for (const rawOwner of config.bot.owners) {
      if (!rawOwner) continue;
      const normDigits = normalizePhoneNumber(rawOwner);
      const jid = rawOwner.endsWith('@lid') ? rawOwner : `${normDigits}@s.whatsapp.net`;
      // A LID is not enough to infer a phone number. Seed its owner profile, but only
      // create an address-book phone record when this configured identifier has one.
      const ownerPhone = jid.endsWith('@lid') ? '' : normDigits;
      try {
        await db.prepare(`
          INSERT INTO user_profiles (user_jid, display_name, preferred_language, personality_notes, first_seen, last_seen, total_messages, is_owner)
          VALUES (?, 'Ademola', 'en', 'Creator and Owner of Forgelabs Assistant', ?, ?, 0, 1)
          ON CONFLICT(user_jid) DO UPDATE SET is_owner = 1, display_name = 'Ademola'
        `).run(jid, now, now);

        if (ownerPhone) {
          await db.prepare(`
            INSERT INTO contacts (phone_number, jid, display_name, custom_name, notes, tags, is_auto_saved, is_introduced, created_at, updated_at)
            VALUES (?, ?, 'Ademola', 'Ademola', 'Creator and Owner of Forgelabs Assistant', 'owner,creator', 0, 1, ?, ?)
            ON CONFLICT(jid) DO UPDATE SET phone_number = excluded.phone_number, display_name = 'Ademola', custom_name = 'Ademola', notes = 'Creator and Owner of Forgelabs Assistant'
          `).run(ownerPhone, jid, now, now);
        }
      } catch (err: any) {
        // Safe ignore
      }
    }

    // Ensure key saved contacts like Micah (+2349126433601) are always seeded on cloud deployments
    try {
      await db.prepare(`
        INSERT INTO contacts (phone_number, jid, display_name, custom_name, notes, tags, is_auto_saved, is_introduced, created_at, updated_at)
        VALUES ('2349126433601', '2349126433601@s.whatsapp.net', 'Micah', 'Micah', 'Ademola colleague & friend', '[]', 0, 1, ?, ?)
        ON CONFLICT(jid) DO UPDATE SET phone_number = '2349126433601', custom_name = COALESCE(contacts.custom_name, 'Micah')
      `).run(now, now);
    } catch {}
  }

  /**
   * Determines if a user is an authorized bot owner from configured WhatsApp identifiers.
   * Display names and persisted profile flags are not identity proofs.
   */
  public isOwner(userJid: string, _senderName?: string): boolean {
    if (!userJid) return false;

    const normalizedDigits = normalizePhoneNumber(userJid);
    const normalizedJid = userJid.endsWith('@lid')
      ? `${userJid.split('@')[0].split(':')[0]}@lid`
      : `${normalizedDigits}@s.whatsapp.net`;
    const digitsOnly = userJid.split('@')[0].split(':')[0].replace(/[^0-9]/g, '');

    // Only configured WhatsApp identifiers grant owner privileges. Historical database
    // flags may have been set from untrusted display names and must not authorize access.
    if (config.bot.owners && Array.isArray(config.bot.owners)) {
      const isConfigOwner = config.bot.owners.some((owner) => {
        if (!owner) return false;
        const cleanOwner = owner.trim();
        if (cleanOwner === userJid || cleanOwner === normalizedJid) return true;
        const ownerNorm = normalizePhoneNumber(cleanOwner);
        const ownerDigits = cleanOwner.replace(/[^0-9]/g, '');
        return Boolean(
          (ownerNorm && normalizedDigits && ownerNorm === normalizedDigits) ||
          (ownerDigits && digitsOnly && ownerDigits === digitsOnly)
        );
      });
      if (isConfigOwner) return true;
    }

    return false;
  }

  /**
   * Resolve an inbound WhatsApp LID only through the alias table populated from
   * WhatsApp contact synchronization, then compare its canonical JID to configured
   * owners. Names and profile flags never grant owner access.
   */
  public async isConfiguredOwnerAlias(userJid: string): Promise<boolean> {
    if (this.isOwner(userJid)) return true;
    if (!userJid || !userJid.includes('@lid')) return false;

    const normalizedLid = `${userJid.split('@')[0].split(':')[0]}@lid`;
    try {
      const alias = await db.prepare(
        'SELECT contact_jid FROM contact_jid_aliases WHERE alias_jid = ? LIMIT 1'
      ).get(normalizedLid) as { contact_jid?: string } | undefined;
      return Boolean(alias?.contact_jid && this.isOwner(alias.contact_jid));
    } catch {
      // Older databases may not have alias data yet; fail closed.
      return false;
    }
  }

  /** Persist owner profile metadata only for an identifier already configured as an owner. */
  public async markAsOwner(userJid: string): Promise<void> {
    if (!userJid) return;
    if (!this.isOwner(userJid)) {
      console.warn('[UserProfileManager] Refused to mark an unconfigured identifier as an owner.');
      return;
    }
    const now = Date.now();
    try {
      await db.prepare(`
        INSERT INTO user_profiles (user_jid, display_name, preferred_language, personality_notes, first_seen, last_seen, total_messages, is_owner)
        VALUES (?, 'Ademola', 'en', '', ?, ?, 0, 1)
        ON CONFLICT(user_jid) DO UPDATE SET is_owner = 1, display_name = 'Ademola', last_seen = excluded.last_seen
      `).run(userJid, now, now);
      console.log(`[UserProfileManager] Marked user ${userJid} as owner.`);
    } catch (err) {
      console.error(`[UserProfileManager] Failed to mark user ${userJid} as owner:`, err);
    }
  }

  /** Clear legacy owner metadata; configured owner access is controlled by BOT_OWNERS. */
  public async unmarkAsOwner(userJid: string): Promise<void> {
    if (!userJid) return;
    if (this.isOwner(userJid)) {
      console.warn('[UserProfileManager] Configured owners cannot be demoted in the profile database.');
      return;
    }
    try {
      await db.prepare(`UPDATE user_profiles SET is_owner = 0 WHERE user_jid = ?`).run(userJid);
      console.log(`[UserProfileManager] Demoted user ${userJid} to regular user.`);
    } catch (err) {
      console.error(`[UserProfileManager] Failed to unmark owner ${userJid}:`, err);
    }
  }

  /**
   * Creates or updates a user profile, updates display name if provided,
   * updates last_seen timestamp, and increments the total message count.
   */
  public async upsertProfile(userJid: string, senderName?: string): Promise<UserProfile> {
    const now = Date.now();
    const isOwnerFlag = this.isOwner(userJid, senderName) ? 1 : 0;
    const trimmed = senderName?.trim() || '';
    const isGenericOrDigits =
      !trimmed ||
      trimmed.startsWith('User +') ||
      /^\+?\d+$/.test(trimmed) ||
      ['user', 'unknown', 'friend'].includes(trimmed.toLowerCase());
    const cleanName = isOwnerFlag === 1 ? 'Ademola' : isGenericOrDigits ? null : trimmed;

    try {
      await db.prepare(`
        INSERT INTO user_profiles (
          user_jid, display_name, preferred_language, personality_notes,
          first_seen, last_seen, total_messages, is_owner
        )
        VALUES (?, ?, 'en', '', ?, ?, 1, ?)
        ON CONFLICT(user_jid) DO UPDATE SET
          display_name = CASE WHEN excluded.is_owner = 1 THEN 'Ademola' ELSE COALESCE(excluded.display_name, user_profiles.display_name) END,
          last_seen = excluded.last_seen,
          total_messages = user_profiles.total_messages + 1,
          is_owner = excluded.is_owner
      `).run(userJid, cleanName, now, now, isOwnerFlag);
    } catch (err) {
      console.error(`[UserProfileManager] Error upserting profile for ${userJid}:`, err);
    }

    return (
      (await this.getProfile(userJid)) || {
        user_jid: userJid,
        display_name: cleanName,
        preferred_language: 'en',
        personality_notes: '',
        first_seen: now,
        last_seen: now,
        total_messages: 1,
        is_owner: isOwnerFlag,
      }
    );
  }

  /**
   * Retrieves full profile for a user, or null if not yet encountered.
   */
  public async getProfile(userJid: string): Promise<UserProfile | null> {
    if (!userJid) return null;
    try {
      const row = await db.prepare(`
        SELECT user_jid, display_name, preferred_language, language_source,
               language_candidate, language_candidate_count, personality_notes,
               first_seen, last_seen, total_messages, is_owner
        FROM user_profiles
        WHERE user_jid = ?
      `).get(userJid) as UserProfile | undefined;

      return row ?? null;
    } catch (err) {
      console.error(`[UserProfileManager] Error retrieving profile for ${userJid}:`, err);
      return null;
    }
  }

  private readonly languageNames: Record<string, string> = {
    en: 'English', pcm: 'Nigerian Pidgin', yo: 'Yoruba', ha: 'Hausa', ig: 'Igbo',
    fr: 'French', es: 'Spanish', pt: 'Portuguese', ar: 'Arabic', de: 'German', it: 'Italian',
    sw: 'Swahili', id: 'Indonesian', tr: 'Turkish', ja: 'Japanese', ko: 'Korean', zh: 'Chinese',
    ru: 'Russian', hi: 'Hindi', bn: 'Bengali', th: 'Thai', el: 'Greek', he: 'Hebrew', uk: 'Ukrainian',
  };

  /** Detect a small supported language set conservatively; short or mixed messages stay unknown. */
  public detectMessageLanguage(text: string): { code: string; label: string; confidence: number } | null {
    if (!text || text.trim().length < 8) return null;
    const value = text.toLocaleLowerCase();
    const candidates: Array<{ code: string; score: number; pattern: RegExp }> = [
      { code: 'ar', score: 1, pattern: /[\u0600-\u06ff]{3,}/g },
      { code: 'ja', score: 1, pattern: /[\u3040-\u30ff]{2,}/g },
      { code: 'ko', score: 1, pattern: /[\uac00-\ud7af]{3,}/g },
      { code: 'zh', score: 1, pattern: /[\u4e00-\u9fff]{2,}/g },
      { code: 'ru', score: 0.98, pattern: /[\u0400-\u04ff]{4,}/g },
      { code: 'hi', score: 1, pattern: /[\u0900-\u097f]{3,}/g },
      { code: 'bn', score: 1, pattern: /[\u0980-\u09ff]{3,}/g },
      { code: 'th', score: 1, pattern: /[\u0e00-\u0e7f]{3,}/g },
      { code: 'el', score: 0.98, pattern: /[\u0370-\u03ff]{4,}/g },
      { code: 'he', score: 0.98, pattern: /[\u0590-\u05ff]{3,}/g },
      { code: 'yo', score: 0.95, pattern: /\b(ẹ káàbọ|ẹ jọ̀ọ́|ọmọ|ṣé|ṣe|ọ̀rẹ́|ẹ kú|ẹ ṣé)\b/giu },
      { code: 'fr', score: 0.82, pattern: /\b(bonjour|merci|salut|pourquoi|parce que|comment|aujourd'hui|demain|beaucoup|je suis|tu es|vous êtes)\b/giu },
      { code: 'es', score: 0.82, pattern: /\b(hola|gracias|buenos días|buenas noches|por qué|porque|cómo estás|mañana|estoy|quiero)\b/giu },
      { code: 'pt', score: 0.82, pattern: /\b(olá|obrigado|obrigada|bom dia|boa noite|por favor|porque|amanhã|estou|você)\b/giu },
      { code: 'de', score: 0.82, pattern: /\b(guten morgen|guten tag|guten abend|danke|bitte|warum|ich bin|wie geht es|nicht|tschüss)\b/giu },
      { code: 'it', score: 0.82, pattern: /\b(buongiorno|buonasera|grazie|prego|perché|come stai|domani|sono|vorrei)\b/giu },
      { code: 'sw', score: 0.82, pattern: /\b(habari|asante|tafadhali|karibu|habari yako|nzuri sana|ninaomba)\b/giu },
      { code: 'id', score: 0.82, pattern: /\b(selamat pagi|terima kasih|tolong|apa kabar|bagaimana|saya ingin|besok|tidak)\b/giu },
      { code: 'tr', score: 0.88, pattern: /\b(merhaba|teşekkürler|lütfen|nasılsın|günaydın|iyi akşamlar|yarın)\b/giu },
      { code: 'ha', score: 0.82, pattern: /\b(sannu|na gode|yaya kake|yaya kike|lafiya lau|ina kwana|ina wuni)\b/giu },
      { code: 'ig', score: 0.82, pattern: /\b(nnoo|daalụ|kedụ|kedu ka|ọ dị mma|anyị|ị ga|biko)\b/giu },
      { code: 'pcm', score: 0.82, pattern: /\b(wetin|abeg|omo|dey|no wahala|how far|e go|make i|una|na so|sha|wahala| sef)\b/giu },
    ];
    const ranked = candidates
      .map((candidate) => ({ ...candidate, hits: [...value.matchAll(candidate.pattern)].length }))
      .filter((candidate) => candidate.hits > 0)
      .sort((a, b) => (b.hits * b.score) - (a.hits * a.score));
    const best = ranked[0];
    if (best) {
      const confidence = Math.min(0.99, best.score + Math.max(0, best.hits - 1) * 0.04);
      return { code: best.code, label: this.languageNames[best.code] || best.code, confidence };
    }

    // A clear English turn should override a saved non-English preference for that reply.
    const englishWords = new Set(value.match(/\b(?:the|is|are|and|you|what|how|this|that|with|for|have|your|can|will|please|from|was|were|not|but|because)\b/g) || []);
    if (text.trim().length >= 10 && englishWords.size >= 3) {
      return { code: 'en', label: 'English', confidence: 0.84 };
    }
    return null;
  }

  /** Learn explicit requests immediately and inferred preferences only after repeated clear evidence. */
  public async observeMessageLanguage(userJid: string, text: string): Promise<void> {
    if (!userJid || !text) return;
    const supportedLanguages = 'english|nigerian pidgin|pidgin|yoruba|hausa|igbo|french|spanish|portuguese|arabic|german|italian|swahili|indonesian|turkish|japanese|korean|chinese|mandarin|russian|hindi|bengali|thai|greek|hebrew|ukrainian';
    const explicit = text.match(new RegExp(`\\b(?:please\\s+)?(?:reply|respond|speak|talk|write)\\s+(?:to me\\s+)?(?:in|using)\\s+(${supportedLanguages})\\b`, 'i'))
      || text.match(new RegExp(`\\b(?:i prefer|my preferred language is|i speak)\\s+(${supportedLanguages})\\b`, 'i'));
    if (explicit) {
      const alias = explicit[1].toLowerCase();
      const code = alias.includes('pidgin') ? 'pcm' : alias === 'mandarin' ? 'zh' :
        Object.entries(this.languageNames).find(([, name]) => name.toLowerCase() === alias)?.[0];
      if (code) {
        await db.prepare(`UPDATE user_profiles SET preferred_language = ?, language_source = 'explicit', language_candidate = NULL, language_candidate_count = 0 WHERE user_jid = ?`).run(code, userJid);
        return;
      }
    }

    const detected = this.detectMessageLanguage(text);
    if (!detected || detected.confidence < 0.82) return;
    const profile = await this.getProfile(userJid);
    if (profile?.language_source === 'explicit') return;
    try {
      const nextCount = profile?.preferred_language === detected.code ? 3 : 1;
      const priorCandidate = (profile as any)?.language_candidate === detected.code
        ? Number((profile as any)?.language_candidate_count || 0)
        : 0;
      const count = nextCount === 3 ? 3 : priorCandidate + 1;
      if (count >= 3) {
        await db.prepare(`UPDATE user_profiles SET preferred_language = ?, language_source = 'inferred', language_candidate = NULL, language_candidate_count = 0 WHERE user_jid = ?`).run(detected.code, userJid);
      } else {
        await db.prepare(`UPDATE user_profiles SET language_candidate = ?, language_candidate_count = ? WHERE user_jid = ?`).run(detected.code, count, userJid);
      }
    } catch (err) {
      console.warn('[UserProfileManager] Could not persist language signal:', err);
    }
  }

  public async getLanguageInstruction(userJid: string, incomingText?: string): Promise<string> {
    const detected = incomingText ? this.detectMessageLanguage(incomingText) : null;
    const profile = await this.getProfile(userJid);
    const savedCode = profile?.preferred_language || 'en';
    const savedLabel = this.languageNames[savedCode] || savedCode;
    if (profile?.language_source === 'explicit') {
      return `The sender explicitly prefers ${savedLabel}. Reply in that language unless they explicitly ask to change languages.`;
    }
    if (detected && detected.confidence >= 0.82) {
      return `Reply in ${detected.label} for this message. Mirror the sender's language and register; keep their code-switching only when they use it.`;
    }
    if (profile?.language_source === 'inferred') {
      return `The saved language preference is ${savedLabel}. Reply primarily in that language, while following any clear language change in the latest message.`;
    }
    return 'Use the language of the latest message. If it is unclear or language-neutral, default to English.';
  }

  /**
   * Stores a preference in `user_facts` with category='preference'.
   * Synchronizes preferred_language if key corresponds to language.
   */
  public async setPreference(userJid: string, key: string, value: string): Promise<void> {
    if (!userJid || !key) return;
    const cleanKey = key.trim();
    const cleanValue = value.trim();
    const factText = `${cleanKey}: ${cleanValue}`;
    const now = Date.now();

    try {
      // Remove any prior conflicting value for the same preference key
      await db.prepare(`
        DELETE FROM user_facts
        WHERE user_jid = ? AND category = 'preference' AND (fact = ? OR fact LIKE ?)
      `).run(userJid, factText, `${cleanKey}: %`);

      // Store new preference in user_facts
      await db.prepare(`
        INSERT INTO user_facts (user_jid, fact, category, updated_at)
        VALUES (?, ?, 'preference', ?)
        ON CONFLICT(user_jid, fact) DO UPDATE SET updated_at = excluded.updated_at
      `).run(userJid, factText, now);

      // If key is language, update user_profiles table as well
      if (cleanKey.toLowerCase() === 'language' || cleanKey.toLowerCase() === 'preferred_language') {
        const alias = cleanValue.toLowerCase();
        const languageCode = alias.includes('pidgin') ? 'pcm' : alias === 'mandarin' ? 'zh' :
          Object.entries(this.languageNames).find(([code, name]) => code === alias || name.toLowerCase() === alias)?.[0] || alias;
        await db.prepare(`
          UPDATE user_profiles SET preferred_language = ?, language_source = 'explicit' WHERE user_jid = ?
        `).run(languageCode, userJid);
      }

      console.log(`[UserProfileManager] Saved preference for ${userJid}: "${factText}"`);
    } catch (err) {
      console.error(`[UserProfileManager] Error setting preference for ${userJid}:`, err);
    }
  }

  /**
   * Updates personality traits or behavioural notes for the user.
   */
  public async updatePersonalityNotes(userJid: string, notes: string): Promise<void> {
    if (!userJid) return;
    try {
      await db.prepare(`
        UPDATE user_profiles SET personality_notes = ? WHERE user_jid = ?
      `).run(notes.trim(), userJid);
    } catch (err) {
      console.error(`[UserProfileManager] Error updating personality notes for ${userJid}:`, err);
    }
  }

  /**
   * Retrieves all preference key-value pairs stored for the user.
   */
  public async getPreferences(userJid: string): Promise<Record<string, string>> {
    if (!userJid) return {};
    try {
      const rows = await db.prepare(`
        SELECT fact FROM user_facts
        WHERE user_jid = ? AND category = 'preference'
        ORDER BY updated_at ASC
      `).all(userJid) as Array<{ fact: string }>;

      const prefs: Record<string, string> = {};
      for (const r of rows) {
        const colonIdx = r.fact.indexOf(':');
        if (colonIdx !== -1) {
          const k = r.fact.slice(0, colonIdx).trim();
          const v = r.fact.slice(colonIdx + 1).trim();
          prefs[k] = v;
        }
      }
      return prefs;
    } catch {
      return {};
    }
  }

  /**
   * Generates a compact string describing the user for injection into LLM prompts.
   * Includes: name, owner status, preferences, fact count, and personality notes.
   */
  public async getProfileSummaryForPrompt(userJid: string): Promise<string> {
    if (!userJid) return '';

    try {
      const profile = await this.getProfile(userJid);
      const owner = this.isOwner(userJid);

      // Fact count from user_facts
      const factRow = await db.prepare(`
        SELECT COUNT(*) as count FROM user_facts WHERE user_jid = ?
      `).get(userJid) as { count: number } | undefined;
      const factCount = factRow?.count ?? 0;

      // Top preferences
      const prefRows = await db.prepare(`
        SELECT fact FROM user_facts
        WHERE user_jid = ? AND category = 'preference'
        ORDER BY updated_at DESC LIMIT 5
      `).all(userJid) as Array<{ fact: string }>;

      let name = profile?.display_name || 'User';
      if (name.includes('@') || /^\d{13,}$/.test(name)) {
        name = 'User';
      }
      const role = owner ? 'Bot Owner / Superuser (Elevated Privileges)' : 'User';
      const prefs = prefRows.length > 0 ? prefRows.map((p) => p.fact).join('; ') : 'None specified';
      const lang = profile?.preferred_language || 'en';
      const notes = profile?.personality_notes ? ` | Traits: ${profile.personality_notes}` : '';

      return `User: ${name} | Role: ${role} | Language: ${lang} | Known Facts: ${factCount} | Preferences: [${prefs}]${notes}`;
    } catch (err) {
      console.error(`[UserProfileManager] Error generating profile summary for ${userJid}:`, err);
      return `User: User | Role: ${this.isOwner(userJid) ? 'Owner' : 'User'}`;
    }
  }
}

export const userProfileManager = new UserProfileManager();
