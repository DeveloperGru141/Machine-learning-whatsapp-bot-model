import { db } from './db.js';

export interface UserFact {
  fact: string;
  category: string;
  updated_at: number;
}

export interface GroupFact {
  topic: string;
  summary: string;
  updated_at: number;
}

export class MemoryService {
  private insertUserFactStmt = db.prepare(`
    INSERT INTO user_facts (user_jid, fact, category, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(user_jid, fact) DO UPDATE SET updated_at = excluded.updated_at
  `);

  private getUserFactsStmt = db.prepare(`
    SELECT fact, category, updated_at FROM user_facts
    WHERE user_jid = ?
    ORDER BY updated_at DESC LIMIT 10
  `);

  private insertGroupFactStmt = db.prepare(`
    INSERT INTO group_facts (group_jid, topic, summary, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(group_jid, topic) DO UPDATE SET summary = excluded.summary, updated_at = excluded.updated_at
  `);

  private getGroupFactsStmt = db.prepare(`
    SELECT topic, summary, updated_at FROM group_facts
    WHERE group_jid = ?
    ORDER BY updated_at DESC LIMIT 10
  `);

  public saveUserFact(userJid: string, fact: string, category: string = 'general'): void {
    this.insertUserFactStmt.run(userJid, fact, category, Date.now());
  }

  public getUserFacts(userJid: string): UserFact[] {
    return this.getUserFactsStmt.all(userJid) as unknown as UserFact[];
  }

  public saveGroupFact(groupJid: string, topic: string, summary: string): void {
    this.insertGroupFactStmt.run(groupJid, topic, summary, Date.now());
  }

  public getGroupFacts(groupJid: string): GroupFact[] {
    return this.getGroupFactsStmt.all(groupJid) as unknown as GroupFact[];
  }

  public searchChatLogs(query: string, chatJid?: string): Array<{ sender_name: string; message_text: string }> {
    try {
      const sanitized = `%${query.trim()}%`;
      if (chatJid) {
        return db.prepare(`
          SELECT sender_name, message_text FROM chat_logs
          WHERE message_text LIKE ? AND chat_jid = ?
          ORDER BY id DESC LIMIT 8
        `).all(sanitized, chatJid) as unknown as Array<{ sender_name: string; message_text: string }>;
      }

      return db.prepare(`
        SELECT sender_name, message_text FROM chat_logs
        WHERE message_text LIKE ?
        ORDER BY id DESC LIMIT 8
      `).all(sanitized) as unknown as Array<{ sender_name: string; message_text: string }>;
    } catch {
      return [];
    }
  }

  public findStickerByVibe(vibeQuery: string): { filename: string; vibe_tags: string } | null {
    try {
      const sanitized = `%${vibeQuery.toLowerCase().trim()}%`;
      // Match against tags or learned triggers
      const result = db.prepare(`
        SELECT filename, vibe_tags FROM sticker_catalog
        WHERE vibe_tags LIKE ? OR learned_triggers LIKE ?
        ORDER BY usage_count DESC
        LIMIT 1
      `).get(sanitized, sanitized) as unknown as { filename: string; vibe_tags: string } | undefined;

      if (result) return result;

      // Fallback: Return any sticker from catalog
      return (db.prepare(`
        SELECT filename, vibe_tags FROM sticker_catalog
        ORDER BY usage_count DESC
        LIMIT 1
      `).get() as unknown as { filename: string; vibe_tags: string }) || null;
    } catch {
      return null;
    }
  }
}

export const memoryService = new MemoryService();
