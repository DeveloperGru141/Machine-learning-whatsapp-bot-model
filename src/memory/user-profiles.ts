import { db } from './db.js';
import { config, normalizePhoneNumber } from '../config/env.js';

export interface UserProfile {
  user_jid: string;
  display_name: string | null;
  preferred_language: string;
  personality_notes: string;
  first_seen: number;
  last_seen: number;
  total_messages: number;
  is_owner: number;
}

export class UserProfileManager {
  /**
   * Determines if a user is an authorized bot owner.
   * Checks database `is_owner` flag OR environment `config.bot.owners`.
   */
  public isOwner(userJid: string): boolean {
    if (!userJid) return false;

    const normalizedDigits = normalizePhoneNumber(userJid);
    const normalizedJid = userJid.endsWith('@lid')
      ? `${userJid.split('@')[0].split(':')[0]}@lid`
      : `${normalizedDigits}@s.whatsapp.net`;
    const digitsOnly = userJid.split('@')[0].split(':')[0].replace(/[^0-9]/g, '');

    // 1. Check SQLite user_profiles table
    try {
      const row = db.prepare(`
        SELECT is_owner FROM user_profiles WHERE user_jid = ? OR user_jid = ?
      `).get(userJid, normalizedJid) as { is_owner: number } | undefined;

      if (row && Number(row.is_owner) === 1) {
        return true;
      }
    } catch (err) {
      console.error('[UserProfileManager] Error querying is_owner from DB:', err);
    }

    // 2. Check config.bot.owners list
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
   * Promotes a user to bot owner in persistent storage.
   */
  public markAsOwner(userJid: string): void {
    if (!userJid) return;
    const now = Date.now();
    try {
      db.prepare(`
        INSERT INTO user_profiles (user_jid, display_name, preferred_language, personality_notes, first_seen, last_seen, total_messages, is_owner)
        VALUES (?, NULL, 'en', '', ?, ?, 0, 1)
        ON CONFLICT(user_jid) DO UPDATE SET is_owner = 1, last_seen = excluded.last_seen
      `).run(userJid, now, now);
      console.log(`[UserProfileManager] Marked user ${userJid} as owner.`);
    } catch (err) {
      console.error(`[UserProfileManager] Failed to mark user ${userJid} as owner:`, err);
    }
  }

  /**
   * Demotes an owner back to a regular user.
   */
  public unmarkAsOwner(userJid: string): void {
    if (!userJid) return;
    try {
      db.prepare(`UPDATE user_profiles SET is_owner = 0 WHERE user_jid = ?`).run(userJid);
      console.log(`[UserProfileManager] Demoted user ${userJid} to regular user.`);
    } catch (err) {
      console.error(`[UserProfileManager] Failed to unmark owner ${userJid}:`, err);
    }
  }

  /**
   * Creates or updates a user profile, updates display name if provided,
   * updates last_seen timestamp, and increments the total message count.
   */
  public upsertProfile(userJid: string, senderName?: string): UserProfile {
    const now = Date.now();
    const trimmed = senderName?.trim() || '';
    const isGenericOrDigits =
      !trimmed ||
      trimmed.startsWith('User +') ||
      /^\+?\d+$/.test(trimmed) ||
      ['user', 'unknown', 'friend'].includes(trimmed.toLowerCase());
    const cleanName = isGenericOrDigits ? null : trimmed;
    const isOwnerFlag = this.isOwner(userJid) ? 1 : 0;

    try {
      db.prepare(`
        INSERT INTO user_profiles (
          user_jid, display_name, preferred_language, personality_notes,
          first_seen, last_seen, total_messages, is_owner
        )
        VALUES (?, ?, 'en', '', ?, ?, 1, ?)
        ON CONFLICT(user_jid) DO UPDATE SET
          display_name = COALESCE(excluded.display_name, user_profiles.display_name),
          last_seen = excluded.last_seen,
          total_messages = user_profiles.total_messages + 1,
          is_owner = CASE WHEN user_profiles.is_owner = 1 THEN 1 ELSE excluded.is_owner END
      `).run(userJid, cleanName, now, now, isOwnerFlag);
    } catch (err) {
      console.error(`[UserProfileManager] Error upserting profile for ${userJid}:`, err);
    }

    return (
      this.getProfile(userJid) || {
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
  public getProfile(userJid: string): UserProfile | null {
    if (!userJid) return null;
    try {
      const row = db.prepare(`
        SELECT user_jid, display_name, preferred_language, personality_notes,
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

  /**
   * Stores a preference in `user_facts` with category='preference'.
   * Synchronizes preferred_language if key corresponds to language.
   */
  public setPreference(userJid: string, key: string, value: string): void {
    if (!userJid || !key) return;
    const cleanKey = key.trim();
    const cleanValue = value.trim();
    const factText = `${cleanKey}: ${cleanValue}`;
    const now = Date.now();

    try {
      // Remove any prior conflicting value for the same preference key
      db.prepare(`
        DELETE FROM user_facts
        WHERE user_jid = ? AND category = 'preference' AND (fact = ? OR fact LIKE ?)
      `).run(userJid, factText, `${cleanKey}: %`);

      // Store new preference in user_facts
      db.prepare(`
        INSERT INTO user_facts (user_jid, fact, category, updated_at)
        VALUES (?, ?, 'preference', ?)
        ON CONFLICT(user_jid, fact) DO UPDATE SET updated_at = excluded.updated_at
      `).run(userJid, factText, now);

      // If key is language, update user_profiles table as well
      if (cleanKey.toLowerCase() === 'language' || cleanKey.toLowerCase() === 'preferred_language') {
        db.prepare(`
          UPDATE user_profiles SET preferred_language = ? WHERE user_jid = ?
        `).run(cleanValue, userJid);
      }

      console.log(`[UserProfileManager] Saved preference for ${userJid}: "${factText}"`);
    } catch (err) {
      console.error(`[UserProfileManager] Error setting preference for ${userJid}:`, err);
    }
  }

  /**
   * Updates personality traits or behavioural notes for the user.
   */
  public updatePersonalityNotes(userJid: string, notes: string): void {
    if (!userJid) return;
    try {
      db.prepare(`
        UPDATE user_profiles SET personality_notes = ? WHERE user_jid = ?
      `).run(notes.trim(), userJid);
    } catch (err) {
      console.error(`[UserProfileManager] Error updating personality notes for ${userJid}:`, err);
    }
  }

  /**
   * Retrieves all preference key-value pairs stored for the user.
   */
  public getPreferences(userJid: string): Record<string, string> {
    if (!userJid) return {};
    try {
      const rows = db.prepare(`
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
  public getProfileSummaryForPrompt(userJid: string): string {
    if (!userJid) return '';

    try {
      const profile = this.getProfile(userJid);
      const owner = this.isOwner(userJid);

      // Fact count from user_facts
      const factRow = db.prepare(`
        SELECT COUNT(*) as count FROM user_facts WHERE user_jid = ?
      `).get(userJid) as { count: number } | undefined;
      const factCount = factRow?.count ?? 0;

      // Top preferences
      const prefRows = db.prepare(`
        SELECT fact FROM user_facts
        WHERE user_jid = ? AND category = 'preference'
        ORDER BY updated_at DESC LIMIT 5
      `).all(userJid) as Array<{ fact: string }>;

      const name = profile?.display_name || 'User';
      const role = owner ? 'Bot Owner / Superuser (Elevated Privileges)' : 'User';
      const prefs = prefRows.length > 0 ? prefRows.map((p) => p.fact).join('; ') : 'None specified';
      const lang = profile?.preferred_language || 'en';
      const notes = profile?.personality_notes ? ` | Traits: ${profile.personality_notes}` : '';

      return `User: ${name} (${userJid}) | Role: ${role} | Language: ${lang} | Known Facts: ${factCount} | Preferences: [${prefs}]${notes}`;
    } catch (err) {
      console.error(`[UserProfileManager] Error generating profile summary for ${userJid}:`, err);
      return `User: ${userJid} | Role: ${this.isOwner(userJid) ? 'Owner' : 'User'}`;
    }
  }
}

export const userProfileManager = new UserProfileManager();
