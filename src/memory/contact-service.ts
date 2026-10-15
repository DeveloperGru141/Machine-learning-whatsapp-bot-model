import { db } from './db.js';

export interface ContactRecord {
  id: number;
  phone_number: string;
  jid: string;
  display_name: string;
  custom_name: string | null;
  notes: string | null;
  tags: string;
  is_auto_saved: number;
  created_at: number;
  updated_at: number;
}

export class ContactService {
  /**
   * Normalizes a WhatsApp JID to remove device suffix (e.g. 23480123:1@s.whatsapp.net -> 23480123@s.whatsapp.net)
   */
  public normalizeJid(jid: string): string {
    if (!jid) return '';
    const clean = jid.split(':')[0];
    return clean.includes('@') ? clean : `${clean}@s.whatsapp.net`;
  }

  /**
   * Extracts pure digits from a phone number or JID
   */
  public extractPhoneNumber(phoneOrJid: string): string {
    return (phoneOrJid || '').split('@')[0].split(':')[0].replace(/[^0-9]/g, '');
  }

  /**
   * Automatically saves or updates an incoming sender in the contact book.
   * Runs passively on all messages so the bot maintains an up-to-date address book.
   */
  public autoSaveContact(jid: string, pushName?: string): void {
    if (!jid || jid.endsWith('@g.us')) return;

    const normalizedJid = this.normalizeJid(jid);
    const phoneNumber = this.extractPhoneNumber(normalizedJid);
    if (!phoneNumber) return;

    const now = Date.now();
    const cleanPushName = pushName?.trim() || `User +${phoneNumber}`;

    try {
      const existing = db.prepare(`
        SELECT id, display_name, custom_name FROM contacts WHERE jid = ? OR phone_number = ?
      `).get(normalizedJid, phoneNumber) as { id: number; display_name: string; custom_name: string | null } | undefined;

      if (!existing) {
        db.prepare(`
          INSERT INTO contacts (
            phone_number, jid, display_name, custom_name, notes, tags, is_auto_saved, created_at, updated_at
          ) VALUES (?, ?, ?, NULL, NULL, '[]', 1, ?, ?)
        `).run(phoneNumber, normalizedJid, cleanPushName, now, now);
        console.log(`[ContactService] Auto-saved new contact: "${cleanPushName}" (+${phoneNumber})`);
      } else {
        // Update display_name if pushName changed and no manual custom_name was set
        if (!existing.custom_name && pushName && existing.display_name !== cleanPushName) {
          db.prepare(`
            UPDATE contacts SET display_name = ?, updated_at = ? WHERE id = ?
          `).run(cleanPushName, now, existing.id);
        }
      }
    } catch (err) {
      console.error('[ContactService] Error in autoSaveContact:', err);
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

    const normalizedJid = `${phoneNumber}@s.whatsapp.net`;
    const cleanName = name.trim();
    const cleanNotes = notes?.trim() || null;
    const tagsJson = JSON.stringify(tags || []);
    const now = Date.now();

    try {
      db.prepare(`
        INSERT INTO contacts (
          phone_number, jid, display_name, custom_name, notes, tags, is_auto_saved, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)
        ON CONFLICT(jid) DO UPDATE SET
          custom_name = excluded.custom_name,
          notes = COALESCE(excluded.notes, contacts.notes),
          tags = excluded.tags,
          updated_at = excluded.updated_at
      `).run(phoneNumber, normalizedJid, cleanName, cleanName, cleanNotes, tagsJson, now, now);

      const saved = this.getContact(phoneNumber);
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
    const digits = clean.replace(/[^0-9]/g, '');

    try {
      // 1. Search by exact phone number or JID
      if (digits.length >= 7) {
        const row = db.prepare(`
          SELECT * FROM contacts 
          WHERE phone_number = ? OR phone_number LIKE ? OR jid = ?
          LIMIT 1
        `).get(digits, `%${digits}%`, `${digits}@s.whatsapp.net`) as ContactRecord | undefined;
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
  public generateVCard(displayName: string, phoneNumber: string, notes?: string): string {
    const cleanDigits = this.extractPhoneNumber(phoneNumber);
    const lines = [
      'BEGIN:VCARD',
      'VERSION:3.0',
      `FN:${displayName}`,
      `TEL;type=CELL;type=VOICE;waid=${cleanDigits}:+${cleanDigits}`,
    ];

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
      return this.generateVCard(name, c.phone_number, c.notes || undefined);
    });

    return {
      vcfContent: cards.join('\n\n'),
      count: contacts.length,
    };
  }
}

export const contactService = new ContactService();
