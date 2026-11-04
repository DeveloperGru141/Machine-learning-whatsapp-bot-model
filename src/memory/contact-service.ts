import fs from 'fs';
import path from 'path';
import { db } from './db.js';
import { config, normalizePhoneNumber } from '../config/env.js';

export interface ContactRecord {
  id: number;
  phone_number: string;
  jid: string;
  display_name: string;
  custom_name: string | null;
  notes: string | null;
  tags: string;
  is_auto_saved: number;
  is_introduced: number;
  created_at: number;
  updated_at: number;
}

export interface AutoSaveResult {
  isNew: boolean;
  needsIntroduction: boolean;
  contact: ContactRecord | null;
}

export class ContactService {
  /** Persist Baileys phone-number and LID identifiers against one canonical contact. */
  public async syncWhatsAppContact(contact: {
    id?: string;
    lid?: string;
    phoneNumber?: string;
    name?: string | null;
    notify?: string | null;
  }): Promise<AutoSaveResult> {
    const displayName = contact.name || contact.notify || undefined;
    const phone = this.extractPhoneNumber(contact.phoneNumber || '') || this.extractPhoneNumber(contact.id || '');
    const canonicalJid = phone ? `${phone}@s.whatsapp.net` : '';
    if (!canonicalJid) {
      const possibleAlias = contact.lid || contact.id;
      const existing = possibleAlias ? await this.getContact(possibleAlias) : null;
      return { isNew: false, needsIntroduction: false, contact: existing };
    }

    const saved = await this.autoSaveContact(canonicalJid, displayName);
    const aliases = [contact.id, contact.lid, contact.phoneNumber]
      .filter((value): value is string => Boolean(value))
      .map((value) => this.normalizeJid(value))
      .filter((value) => value.includes('@'));
    try {
      const insertAlias = db.prepare(`
        INSERT INTO contact_jid_aliases (alias_jid, contact_jid, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(alias_jid) DO UPDATE SET contact_jid = excluded.contact_jid, updated_at = excluded.updated_at
      `);
      for (const alias of new Set([...aliases, canonicalJid])) {
        await insertAlias.run(alias, canonicalJid, Date.now());
      }
    } catch (err) {
      console.warn('[ContactService] Could not store WhatsApp contact aliases:', err);
    }
    return { ...saved, contact: (await this.getContact(canonicalJid)) || saved.contact };
  }

  /**
   * Normalizes a WhatsApp JID to remove device suffix (e.g. 23480123:1@s.whatsapp.net -> 23480123@s.whatsapp.net)
   * while preserving @lid or @s.whatsapp.net domains.
   */
  public normalizeJid(jid: string): string {
    if (!jid) return '';
    const trimmed = jid.trim();
    if (trimmed.includes('@')) {
      const [userPart, domainPart] = trimmed.split('@');
      const cleanUser = userPart.split(':')[0];
      if (domainPart === 'lid') {
        return `${cleanUser}@lid`;
      }
      const normDigits = this.extractPhoneNumber(cleanUser);
      return `${normDigits || cleanUser}@${domainPart}`;
    }
    const digits = this.extractPhoneNumber(trimmed);
    return digits ? `${digits}@s.whatsapp.net` : '';
  }

  /**
   * Extracts pure digits from a phone number or JID, delegating to normalizePhoneNumber for standard phone numbers.
   */
  public extractPhoneNumber(phoneOrJid: string): string {
    if (!phoneOrJid) return '';
    const trimmed = phoneOrJid.trim();
    if (trimmed.endsWith('@lid') || trimmed.includes('@lid')) {
      return '';
    }
    const cleanUser = trimmed.split('@')[0].split(':')[0];
    const digits = normalizePhoneNumber(cleanUser);
    // WhatsApp LIDs are 15-digit internal identifiers starting with '10' (e.g. 102409552584830)
    if (/^10\d{13,}$/.test(digits)) {
      return '';
    }
    return digits;
  }

  /**
   * Automatically syncs all saved contacts to data/contacts.vcf on disk
   */
  public async syncVcfFile(): Promise<void> {
    try {
      const { vcfContent, count } = await this.exportVcf(5000);
      if (count > 0 && vcfContent) {
        const dataDir = path.dirname(config.paths.database);
        const vcfPath = path.join(dataDir, 'contacts.vcf');
        fs.writeFileSync(vcfPath, vcfContent, 'utf-8');
      }
    } catch {
      // Non-critical background sync
    }
  }

  /**
   * Marks a contact as having received the bot's first-message self-introduction.
   */
  public async markIntroduced(jid: string): Promise<void> {
    if (!jid) return;
    const normalizedJid = this.normalizeJid(jid);
    const phoneNumber = this.extractPhoneNumber(normalizedJid);
    try {
      await db.prepare(`
        UPDATE contacts
        SET is_introduced = 1, updated_at = ?
        WHERE jid = ? OR phone_number = ?
      `).run(Date.now(), normalizedJid, phoneNumber);
    } catch (err) {
      console.error('[ContactService] Error in markIntroduced:', err);
    }
  }

  /**
   * Extracts a clean, emoji-free friendly first name from a raw pushName or display name.
   * Returns empty string if the name is a placeholder ("User +...", "user", "unknown", "friend", or raw digits).
   */
  public extractFriendlyFirstName(rawName?: string | null): string {
    if (!rawName) return '';
    // 1. Strip emojis
    const noEmojis = rawName
      .replace(/[\p{Emoji_Presentation}\p{Extended_Pictographic}\p{Emoji_Modifier}\u{FE0F}\u{200D}]/gu, '')
      .trim();

    // 2. Normalize stylized unicode (mathematical script, gothic, fullwidth, circled) to plain Latin
    const normalized = noEmojis
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[øØ]/g, 'o')
      .replace(/[^a-zA-Z0-9\s._-]/g, '')
      .trim();

    const stripped = normalized || noEmojis;
    if (
      !stripped ||
      stripped.startsWith('User +') ||
      /^\+?\d+$/.test(stripped) ||
      ['user', 'unknown', 'friend'].includes(stripped.toLowerCase())
    ) {
      return '';
    }
    const parts = stripped.split(/\s+/);
    if (/^hardez/i.test(parts[0])) {
      return 'Ademola';
    }
    if (parts.length > 1 && /^(dr|mr|mrs|ms|prof|chief|engr)\.?$/i.test(parts[0])) {
      return `${parts[0]} ${parts[1]}`;
    }
    return parts[0];
  }

  /**
   * Automatically saves or updates an incoming sender in the contact book.
   * Runs passively on all messages so the bot maintains an up-to-date address book,
   * and returns whether the contact is new and needs a first-message introduction.
   */
  public async autoSaveContact(jid: string, pushName?: string): Promise<AutoSaveResult> {
    if (!jid || jid.endsWith('@g.us') || jid.includes('status@broadcast')) {
      return { isNew: false, needsIntroduction: false, contact: null };
    }

    const normalizedJid = this.normalizeJid(jid);
    const phoneNumber = this.extractPhoneNumber(normalizedJid);
    if (!phoneNumber) {
      return { isNew: false, needsIntroduction: false, contact: null };
    }

    const now = Date.now();
    const rawTrimmed = pushName?.trim() || '';
    const isGenericOrDigits =
      !rawTrimmed ||
      rawTrimmed.startsWith('User +') ||
      /^\+?\d+$/.test(rawTrimmed) ||
      ['user', 'unknown', 'friend'].includes(rawTrimmed.toLowerCase());
    const cleanPushName = isGenericOrDigits ? `User +${phoneNumber}` : rawTrimmed;

    try {
      const existing = await db.prepare(`
        SELECT * FROM contacts WHERE jid = ? OR phone_number = ? LIMIT 1
      `).get(normalizedJid, phoneNumber) as ContactRecord | undefined;

      // Check if the bot has ever sent an outbound reply to this chat in chat_logs
      const priorBotReply = await db.prepare(`
        SELECT 1 FROM chat_logs WHERE chat_jid = ? AND sender_jid = 'bot' LIMIT 1
      `).get(normalizedJid);
      const hasBotRepliedBefore = Boolean(priorBotReply);

      if (!existing) {
        const initialIntroduced = hasBotRepliedBefore ? 1 : 0;
        await db.prepare(`
          INSERT INTO contacts (
            phone_number, jid, display_name, custom_name, notes, tags, is_auto_saved, is_introduced, created_at, updated_at
          ) VALUES (?, ?, ?, NULL, NULL, '[]', 1, ?, ?, ?)
        `).run(phoneNumber, normalizedJid, cleanPushName, initialIntroduced, now, now);
        console.log(`[ContactService] 📇 Auto-saved new contact: "${cleanPushName}" (+${phoneNumber})`);
        await this.syncVcfFile();

        const created = await this.getContact(normalizedJid);
        return {
          isNew: true,
          needsIntroduction: initialIntroduced === 0,
          contact: created,
        };
      } else {
        let updated = false;
        // Update display_name if pushName is a real human name and no manual custom_name was set
        if (
          !existing.custom_name &&
          !isGenericOrDigits &&
          existing.display_name !== cleanPushName
        ) {
          await db.prepare(`
            UPDATE contacts SET display_name = ?, updated_at = ? WHERE id = ?
          `).run(cleanPushName, now, existing.id);
          existing.display_name = cleanPushName;
          updated = true;
        }

        if (hasBotRepliedBefore && !existing.is_introduced) {
          await db.prepare(`UPDATE contacts SET is_introduced = 1 WHERE id = ?`).run(existing.id);
          existing.is_introduced = 1;
        }

        if (updated) {
          await this.syncVcfFile();
        }

        return {
          isNew: false,
          needsIntroduction: existing.is_introduced === 0 && !hasBotRepliedBefore,
          contact: existing,
        };
      }
    } catch (err) {
      console.error('[ContactService] Error in autoSaveContact:', err);
      return { isNew: false, needsIntroduction: false, contact: null };
    }
  }

  /**
   * Manually saves or updates a contact with a preferred name, notes, or tags.
   */
  public async saveContact(
    phoneOrJid: string,
    name: string,
    notes?: string,
    tags?: string[]
  ): Promise<{ success: boolean; contact?: ContactRecord; message: string }> {
    const phoneNumber = this.extractPhoneNumber(phoneOrJid);
    if (!phoneNumber) {
      return { success: false, message: 'Invalid phone number or JID provided.' };
    }

    const normalizedJid = phoneOrJid.includes('@')
      ? this.normalizeJid(phoneOrJid)
      : `${phoneNumber}@s.whatsapp.net`;
    const cleanName = name.trim();
    const cleanNotes = notes?.trim() || null;
    const tagsJson = JSON.stringify(tags || []);
    const now = Date.now();

    try {
      await db.prepare(`
        INSERT INTO contacts (
          phone_number, jid, display_name, custom_name, notes, tags, is_auto_saved, is_introduced, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 0, 1, ?, ?)
        ON CONFLICT(jid) DO UPDATE SET
          custom_name = excluded.custom_name,
          notes = COALESCE(excluded.notes, contacts.notes),
          tags = excluded.tags,
          updated_at = excluded.updated_at
      `).run(phoneNumber, normalizedJid, cleanName, cleanName, cleanNotes, tagsJson, now, now);

      await this.syncVcfFile();
      const saved = (await this.getContact(normalizedJid)) || (await this.getContact(phoneNumber));
      console.log(`[ContactService] Saved contact: "${cleanName}" (+${phoneNumber})`);
      return {
        success: true,
        contact: saved || undefined,
        message: `Successfully saved contact "${cleanName}" (+${phoneNumber}).`,
      };
    } catch (err: any) {
      console.error('[ContactService] Error in saveContact:', err);
      return { success: false, message: `Failed to save contact: ${err.message}` };
    }
  }

  /**
   * Searches for a contact by phone number, JID, or name.
   */
  public async getContact(query: string): Promise<ContactRecord | null> {
    if (!query) return null;
    const clean = query.trim();
    const digits = this.extractPhoneNumber(clean);

    // 0. Intercept references to boss, owner, creator, or Ademola
    const isBossQuery =
      /^(the\s+)?(my\s+)?(your\s+)?(boss|owner|creator|maker|developer|dev|engineer|ademola|hardez)$/i.test(clean) ||
      /\b(your\s+boss|my\s+boss|the\s+boss|your\s+creator|the\s+creator|your\s+owner|the\s+owner|ademola)\b/i.test(clean);

    if (isBossQuery) {
      const ownerIdentifier =
        config.bot.owners.find((owner) => !owner.endsWith('@lid') && normalizePhoneNumber(owner).length >= 7) ||
        config.bot.owners.find((owner) => owner.endsWith('@lid')) ||
        '';
      const ownerPhone = ownerIdentifier.endsWith('@lid') ? '' : normalizePhoneNumber(ownerIdentifier);
      const ownerJid = ownerIdentifier.includes('@')
        ? this.normalizeJid(ownerIdentifier)
        : ownerPhone ? `${ownerPhone}@s.whatsapp.net` : '';
      return {
        id: -1,
        phone_number: ownerPhone,
        jid: ownerJid,
        display_name: 'Ademola (Creator & Boss)',
        custom_name: 'Ademola (Boss)',
        notes: 'Creator, developer, and owner of Forgelabs assistant',
        tags: '["owner","boss","creator"]',
        is_auto_saved: 0,
        is_introduced: 1,
        created_at: 0,
        updated_at: Date.now(),
      };
    }

    try {
      // Resolve exact JIDs first, including LID aliases synchronized by Baileys.
      const normalizedJid = clean.includes('@') ? this.normalizeJid(clean) : '';
      if (normalizedJid) {
        const aliasRow = await db.prepare(`
          SELECT c.* FROM contacts c
          LEFT JOIN contact_jid_aliases a ON a.contact_jid = c.jid
          WHERE c.jid = ? OR a.alias_jid = ?
          LIMIT 1
        `).get(normalizedJid, normalizedJid) as ContactRecord | undefined;
        if (aliasRow) return aliasRow;
      }

      // Phone numbers must match exactly; substring matching can return the wrong person.
      if (digits.length >= 7) {
        const row = await db.prepare(`
          SELECT c.* FROM contacts c
          LEFT JOIN contact_jid_aliases a ON a.contact_jid = c.jid
          WHERE c.jid = ? OR c.phone_number = ? OR a.alias_jid = ? OR a.alias_jid = ?
          LIMIT 1
        `).get(
          `${digits}@s.whatsapp.net`,
          digits,
          `${digits}@s.whatsapp.net`,
          `${digits}@lid`
        ) as ContactRecord | undefined;
        if (row) return row;
      }

      // Prefer exact names. Escape SQL LIKE metacharacters before allowing a partial match.
      const exactName = await db.prepare(`
        SELECT * FROM contacts
        WHERE (LOWER(custom_name) = LOWER(?) OR LOWER(display_name) = LOWER(?))
          AND display_name != 'Crypto Boss😊'
        ORDER BY updated_at DESC LIMIT 1
      `).get(clean, clean) as ContactRecord | undefined;
      if (exactName) return exactName;

      const escaped = clean.replace(/[\\%_]/g, '\\$&');
      const nameMatch = await db.prepare(`
        SELECT * FROM contacts 
        WHERE (custom_name LIKE ? ESCAPE '\\' OR display_name LIKE ? ESCAPE '\\')
          AND display_name != 'Crypto Boss😊'
        ORDER BY updated_at DESC
        LIMIT 1
      `).get(`%${escaped}%`, `%${escaped}%`) as ContactRecord | undefined;

      return nameMatch || null;
    } catch (err) {
      console.error('[ContactService] Error in getContact:', err);
      return null;
    }
  }

  /**
   * Searches for multiple contacts matching a query string across names, notes, phone, and tags.
   */
  public async searchContacts(query: string, limit: number = 5): Promise<ContactRecord[]> {
    if (!query || query.trim().length === 0) return [];
    const clean = query.trim();

    const single = await this.getContact(clean);
    const results: ContactRecord[] = [];
    if (single && single.id === -1) {
      results.push(single);
    }

    try {
      const rows = await db.prepare(`
        SELECT * FROM contacts 
        WHERE (custom_name LIKE ? OR display_name LIKE ? OR notes LIKE ? OR tags LIKE ? OR phone_number LIKE ?)
          AND display_name != 'Crypto Boss😊'
        ORDER BY updated_at DESC
        LIMIT ?
      `).all(`%${clean}%`, `%${clean}%`, `%${clean}%`, `%${clean}%`, `%${clean}%`, limit) as unknown as ContactRecord[];

      for (const r of rows) {
        if (!results.some((existing) => existing.phone_number === r.phone_number || existing.jid === r.jid)) {
          results.push(r);
        }
      }
      return results.slice(0, limit);
    } catch {
      return results;
    }
  }

  /**
   * Returns all saved contacts up to limit.
   */
  public async getAllContacts(limit: number = 2000): Promise<ContactRecord[]> {
    try {
      return await db.prepare(`
        SELECT * FROM contacts
        ORDER BY COALESCE(custom_name, display_name) ASC
        LIMIT ?
      `).all(limit) as unknown as ContactRecord[];
    } catch {
      return [];
    }
  }

  /**
   * Generates a vCard 3.0 string for a contact
   */
  public generateVCard(displayName: string, phoneNumber: string, notes?: string, jid?: string): string {
    const cleanDigits = this.extractPhoneNumber(phoneNumber);
    const isLid = (jid && jid.endsWith('@lid')) || !cleanDigits || /^10\d{13,}$/.test(cleanDigits);
    const lines = [
      'BEGIN:VCARD',
      'VERSION:3.0',
      `FN:${displayName}`,
    ];

    if (!isLid) {
      lines.push(`TEL;type=CELL;type=VOICE;waid=${cleanDigits}:+${cleanDigits}`);
    } else {
      lines.push(`X-WA-LID:${cleanDigits}`);
    }

    if (notes) {
      lines.push(`NOTE:${notes.replace(/\n/g, '\\n')}`);
    }

    lines.push('END:VCARD');
    return lines.join('\n');
  }

  /**
   * Generates a combined .vcf file content with all contacts
   */
  public async exportVcf(limit: number = 2000): Promise<{ vcfContent: string; count: number }> {
    const contacts = await this.getAllContacts(limit);
    if (contacts.length === 0) {
      return { vcfContent: '', count: 0 };
    }

    const cards = contacts.map((c) => {
      const name = c.custom_name || c.display_name;
      return this.generateVCard(name, c.phone_number, c.notes || undefined, c.jid);
    });

    return {
      vcfContent: cards.join('\n\n'),
      count: contacts.length,
    };
  }

  /**
   * Retrieves the newest eligible inbound message per direct chat when no valid bot reply follows it.
   * Returns oldest outstanding messages first so a long backlog is processed fairly.
   */
  public async getUnrepliedChats(
    afterTimestamp: number = Date.now() - 30 * 24 * 60 * 60 * 1000,
    limit: number = 100,
    now: number = Date.now()
  ): Promise<UnrepliedChat[]> {
    try {
      const sql = `
        WITH latest_inbound AS (
          SELECT l.id, l.chat_jid, l.sender_jid, l.sender_name, l.content_type, l.message_text, l.timestamp, l.is_noise,
                 ROW_NUMBER() OVER (PARTITION BY l.chat_jid ORDER BY l.timestamp DESC, l.id DESC) AS rn
          FROM chat_logs l
          WHERE l.is_group = 0
            AND l.sender_jid != 'bot'
            AND l.chat_jid NOT LIKE '%@g.us'
            AND l.chat_jid NOT LIKE '%broadcast%'
            AND l.chat_jid NOT LIKE '2349014896714%'
            AND l.chat_jid NOT LIKE '2349014896714%'
            AND l.chat_jid NOT LIKE '230652813291679%'
            AND l.timestamp >= ?
        )
        SELECT l.*
        FROM latest_inbound l
        LEFT JOIN dm_reply_attempts a ON a.inbound_log_id = l.id
        WHERE l.rn = 1
          AND COALESCE(l.is_noise, 0) = 0
          AND ((l.message_text IS NOT NULL AND TRIM(l.message_text) != '')
            OR l.content_type IN ('audio', 'image', 'video', 'document', 'sticker', 'contact'))
          AND (a.inbound_log_id IS NULL OR (
            a.status != 'sent'
            AND a.next_attempt_at <= ?
          AND (a.status != 'in_progress' OR a.last_attempt_at < ?)
          ))
          AND NOT EXISTS (
            SELECT 1 FROM chat_logs b
            WHERE b.chat_jid = l.chat_jid
              AND b.sender_jid = 'bot'
              AND (b.timestamp > l.timestamp OR (b.timestamp = l.timestamp AND b.id > l.id))
              AND (
                (b.message_text IS NOT NULL AND TRIM(b.message_text) != ''
                  AND LOWER(b.message_text) NOT LIKE 'network slow small%'
                  AND LOWER(b.message_text) NOT LIKE 'take a breather%'
                  AND LOWER(b.message_text) NOT LIKE '%<tool_call>%'
                  AND b.message_text NOT LIKE '⚠️%')
                OR b.content_type IN ('audio', 'image', 'video', 'document', 'sticker', 'contact', 'poll'))
          )
        ORDER BY l.timestamp ASC, l.id ASC
        LIMIT ?;
      `;
      const rows = await db.prepare(sql).all(afterTimestamp, now, now - 10 * 60_000, Math.min(Math.max(limit, 1), 250)) as Array<{
        id: number;
        chat_jid: string;
        sender_jid: string;
        sender_name: string | null;
        message_text: string | null;
        timestamp: number;
        content_type: string;
      }>;

      return rows.map((r) => {
        let fallbackText = '[User sent a message]';
        if (r.content_type === 'audio') {
          fallbackText = '[User sent a voice note — respond in their current or saved preferred language]';
        } else if (r.content_type === 'image') {
          fallbackText = '[User sent an image — acknowledge it warmly]';
        } else if (r.content_type === 'sticker') {
          fallbackText = '[User sent a sticker — react with a short witty reply]';
        } else if (r.content_type === 'video') {
          fallbackText = '[User sent a video]';
        } else if (r.content_type === 'document') {
          fallbackText = '[User sent a document]';
        }

        return {
          id: r.id,
          chatJid: r.chat_jid,
          senderJid: r.sender_jid,
          senderName: r.sender_name || 'Friend',
          lastMessage: r.message_text && r.message_text.trim() ? r.message_text : fallbackText,
          timestamp: r.timestamp,
          contentType: r.content_type || 'text',
        };
      });
    } catch (err) {
      console.error('[ContactService] Error finding unreplied chats:', err);
      return [];
    }
  }

  /**
   * Retrieves contacts who have sent at least one message to the bot but have 0 outgoing bot replies.
   */
  public async getUncontactedContacts(excludeJidPrefixes: string[] = []): Promise<ContactRecord[]> {
    try {
      const sql = `
        SELECT c.* FROM contacts c
        WHERE c.jid NOT LIKE '%@g.us'
          AND EXISTS (
            SELECT 1 FROM chat_logs in_msg
            WHERE in_msg.chat_jid = c.jid
              AND in_msg.sender_jid != 'bot'
          )
          AND NOT EXISTS (
            SELECT 1 FROM chat_logs out_msg
            WHERE out_msg.chat_jid = c.jid
              AND out_msg.sender_jid = 'bot'
          )
        ORDER BY c.created_at ASC;
      `;
      const allUncontacted = await db.prepare(sql).all() as unknown as ContactRecord[];
      if (excludeJidPrefixes.length === 0) return allUncontacted;

      return allUncontacted.filter((c) => {
        return !excludeJidPrefixes.some((p) => p && c.jid.includes(p));
      });
    } catch (err) {
      console.error('[ContactService] Error finding uncontacted contacts:', err);
      return [];
    }
  }
}

export interface UnrepliedChat {
  id?: number;
  chatJid: string;
  senderJid: string;
  senderName: string;
  lastMessage: string;
  timestamp: number;
  contentType: string;
}

export const contactService = new ContactService();
