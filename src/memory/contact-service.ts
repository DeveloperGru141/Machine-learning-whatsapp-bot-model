import fs from 'fs';
import path from 'path';
import { db } from './db.js';
import { config } from '../config/env.js';

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
   * Extracts pure digits from a phone number or JID, converting 11-digit Nigerian numbers (08..., 07..., 09...) to 234...
   */
  public extractPhoneNumber(phoneOrJid: string): string {
    const rawUser = (phoneOrJid || '').split('@')[0].split(':')[0];
    let digits = rawUser.replace(/[^0-9]/g, '');
    if (
      !phoneOrJid.endsWith('@lid') &&
      digits.startsWith('0') &&
      digits.length === 11 &&
      /^0[789][01]\d{8}$/.test(digits)
    ) {
      digits = '234' + digits.slice(1);
    }
    return digits;
  }

  /**
   * Automatically syncs all saved contacts to data/contacts.vcf on disk
   */
  public syncVcfFile(): void {
    try {
      const { vcfContent, count } = this.exportVcf(5000);
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
  public markIntroduced(jid: string): void {
    if (!jid) return;
    const normalizedJid = this.normalizeJid(jid);
    const phoneNumber = this.extractPhoneNumber(normalizedJid);
    try {
      db.prepare(`
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
      return 'Hardez';
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
  public autoSaveContact(jid: string, pushName?: string): AutoSaveResult {
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
      const existing = db.prepare(`
        SELECT * FROM contacts WHERE jid = ? OR phone_number = ? LIMIT 1
      `).get(normalizedJid, phoneNumber) as ContactRecord | undefined;

      // Check if the bot has ever sent an outbound reply to this chat in chat_logs
      const priorBotReply = db.prepare(`
        SELECT 1 FROM chat_logs WHERE chat_jid = ? AND sender_jid = 'bot' LIMIT 1
      `).get(normalizedJid);
      const hasBotRepliedBefore = Boolean(priorBotReply);

      if (!existing) {
        const initialIntroduced = hasBotRepliedBefore ? 1 : 0;
        db.prepare(`
          INSERT INTO contacts (
            phone_number, jid, display_name, custom_name, notes, tags, is_auto_saved, is_introduced, created_at, updated_at
          ) VALUES (?, ?, ?, NULL, NULL, '[]', 1, ?, ?, ?)
        `).run(phoneNumber, normalizedJid, cleanPushName, initialIntroduced, now, now);
        console.log(`[ContactService] 📇 Auto-saved new contact: "${cleanPushName}" (+${phoneNumber})`);
        this.syncVcfFile();

        const created = this.getContact(normalizedJid);
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
          db.prepare(`
            UPDATE contacts SET display_name = ?, updated_at = ? WHERE id = ?
          `).run(cleanPushName, now, existing.id);
          existing.display_name = cleanPushName;
          updated = true;
        }

        if (hasBotRepliedBefore && !existing.is_introduced) {
          db.prepare(`UPDATE contacts SET is_introduced = 1 WHERE id = ?`).run(existing.id);
          existing.is_introduced = 1;
        }

        if (updated) {
          this.syncVcfFile();
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
  public saveContact(
    phoneOrJid: string,
    name: string,
    notes?: string,
    tags?: string[]
  ): { success: boolean; contact?: ContactRecord; message: string } {
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
      db.prepare(`
        INSERT INTO contacts (
          phone_number, jid, display_name, custom_name, notes, tags, is_auto_saved, is_introduced, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 0, 1, ?, ?)
        ON CONFLICT(jid) DO UPDATE SET
          custom_name = excluded.custom_name,
          notes = COALESCE(excluded.notes, contacts.notes),
          tags = excluded.tags,
          updated_at = excluded.updated_at
      `).run(phoneNumber, normalizedJid, cleanName, cleanName, cleanNotes, tagsJson, now, now);

      this.syncVcfFile();
      const saved = this.getContact(normalizedJid) || this.getContact(phoneNumber);
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
  public getContact(query: string): ContactRecord | null {
    if (!query) return null;
    const clean = query.trim();
    const digits = this.extractPhoneNumber(clean);

    try {
      // 1. Search by exact JID, phone number, or @lid/@s.whatsapp.net variants
      if (digits.length >= 7) {
        const row = db.prepare(`
          SELECT * FROM contacts 
          WHERE jid = ? OR phone_number = ? OR jid = ? OR jid = ? OR phone_number LIKE ?
          LIMIT 1
        `).get(
          clean,
          digits,
          `${digits}@s.whatsapp.net`,
          `${digits}@lid`,
          `%${digits}%`
        ) as ContactRecord | undefined;
        if (row) return row;
      }

      // 2. Search by name
      const nameMatch = db.prepare(`
        SELECT * FROM contacts 
        WHERE custom_name LIKE ? OR display_name LIKE ?
        ORDER BY updated_at DESC
        LIMIT 1
      `).get(`%${clean}%`, `%${clean}%`) as ContactRecord | undefined;

      return nameMatch || null;
    } catch (err) {
      console.error('[ContactService] Error in getContact:', err);
      return null;
    }
  }

  /**
   * Returns all saved contacts up to limit.
   */
  public getAllContacts(limit: number = 2000): ContactRecord[] {
    try {
      return db.prepare(`
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
    const isLid = (jid && jid.endsWith('@lid')) || cleanDigits.length > 13;
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
  public exportVcf(limit: number = 2000): { vcfContent: string; count: number } {
    const contacts = this.getAllContacts(limit);
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
   * Retrieves all non-group chats where the latest recorded message was from a user (awaiting bot reply).
   */
  public getUnrepliedChats(): UnrepliedChat[] {
    try {
      const sql = `
        WITH LastPerChat AS (
          SELECT 
            id,
            chat_jid,
            sender_jid,
            sender_name,
            is_group,
            content_type,
            message_text,
            timestamp,
            ROW_NUMBER() OVER (PARTITION BY chat_jid ORDER BY id DESC) as rn
          FROM chat_logs
          WHERE is_group = 0
            AND NOT (sender_jid = 'bot' AND COALESCE(message_text, '') LIKE 'network slow small%')
        )
        SELECT * FROM LastPerChat
        WHERE rn = 1 
          AND sender_jid != 'bot'
          AND (
            (message_text IS NOT NULL AND TRIM(message_text) != '')
            OR content_type = 'audio'
          )
        ORDER BY timestamp ASC;
      `;
      const rows = db.prepare(sql).all() as Array<{
        id: number;
        chat_jid: string;
        sender_jid: string;
        sender_name: string;
        message_text: string;
        timestamp: number;
        content_type: string;
      }>;

      return rows.map((r) => ({
        chatJid: r.chat_jid,
        senderJid: r.sender_jid,
        senderName: r.sender_name || 'Friend',
        lastMessage:
          r.message_text && r.message_text.trim()
            ? r.message_text
            : '[User sent a voice note — reply to them with a warm, natural voice note]',
        timestamp: r.timestamp,
        contentType: r.content_type || 'text',
      }));
    } catch (err) {
      console.error('[ContactService] Error finding unreplied chats:', err);
      return [];
    }
  }

  /**
   * Retrieves contacts who have sent at least one message to the bot but have 0 outgoing bot replies.
   */
  public getUncontactedContacts(excludeJidPrefixes: string[] = []): ContactRecord[] {
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
      const allUncontacted = db.prepare(sql).all() as unknown as ContactRecord[];
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
  chatJid: string;
  senderJid: string;
  senderName: string;
  lastMessage: string;
  timestamp: number;
  contentType: string;
}

export const contactService = new ContactService();
