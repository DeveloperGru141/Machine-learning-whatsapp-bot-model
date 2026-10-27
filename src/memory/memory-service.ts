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

  /**
   * Returns the current chat plus chats where this sender has appeared in the
   * message log. Baileys can identify the same account with a phone JID or a
   * LID, so include known aliases before looking up participation.
   */
  public getChatsForParticipant(senderJid: string, currentChatJid: string, limit = 100): string[] {
    const chats = new Set<string>([currentChatJid]);
    if (!senderJid || senderJid === 'bot') return [...chats];

    try {
      const normalizedJid = senderJid.replace(/:\d+(?=@)/, '');
      const senderIds = new Set([senderJid, normalizedJid]);
      const senderPlaceholders = [...senderIds].map(() => '?').join(', ');
      const canonicalRows = db.prepare(`
        SELECT DISTINCT contact_jid
        FROM contact_jid_aliases
        WHERE alias_jid IN (${senderPlaceholders}) OR contact_jid IN (${senderPlaceholders})
      `).all(...senderIds, ...senderIds) as Array<{ contact_jid: string }>;

      const canonicalIds = new Set([...senderIds, ...canonicalRows.map((row) => row.contact_jid)]);
      const canonicalPlaceholders = [...canonicalIds].map(() => '?').join(', ');
      const aliasRows = db.prepare(`
        SELECT alias_jid FROM contact_jid_aliases WHERE contact_jid IN (${canonicalPlaceholders})
      `).all(...canonicalIds) as Array<{ alias_jid: string }>;
      const participantIds = new Set([...canonicalIds, ...aliasRows.map((row) => row.alias_jid)]);
      const participantPlaceholders = [...participantIds].map(() => '?').join(', ');
      const recentChats = db.prepare(`
        SELECT chat_jid, MAX(timestamp) AS latest
        FROM chat_logs
        WHERE sender_jid IN (${participantPlaceholders}) AND sender_jid != 'bot'
        GROUP BY chat_jid
        ORDER BY latest DESC
        LIMIT ?
      `).all(...participantIds, Math.min(Math.max(limit, 1), 250)) as Array<{ chat_jid: string }>;

      for (const row of recentChats) chats.add(row.chat_jid);
    } catch {
      // Current chat remains available if older databases lack alias records.
    }

    return [...chats];
  }

  public searchChatLogs(query: string, chatJids: string[]): Array<{ sender_name: string; message_text: string }> {
    try {
      if (chatJids.length === 0) return [];
      const sanitized = `%${query.trim()}%`;
      return db.prepare(`
        SELECT sender_name, message_text FROM chat_logs
        WHERE message_text LIKE ? AND chat_jid IN (${chatJids.map(() => '?').join(', ')})
          AND COALESCE(is_noise, 0) = 0
          AND LOWER(message_text) NOT LIKE '%<think%'
          AND LOWER(message_text) NOT LIKE '%<analysis%'
          AND LOWER(message_text) NOT LIKE '%<reasoning%'
          AND LOWER(message_text) NOT LIKE '%<tool_call%'
        ORDER BY id DESC LIMIT 8
      `).all(sanitized, ...chatJids) as unknown as Array<{ sender_name: string; message_text: string }>;
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
