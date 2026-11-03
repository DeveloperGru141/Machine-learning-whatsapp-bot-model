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

  public async saveUserFact(userJid: string, fact: string, category: string = 'general'): Promise<void> {
    await this.insertUserFactStmt.run(userJid, fact, category, Date.now());
  }

  public async getUserFacts(userJid: string): Promise<UserFact[]> {
    return await this.getUserFactsStmt.all(userJid) as unknown as UserFact[];
  }

  public async saveGroupFact(groupJid: string, topic: string, summary: string): Promise<void> {
    await this.insertGroupFactStmt.run(groupJid, topic, summary, Date.now());
  }

  public async getGroupFacts(groupJid: string): Promise<GroupFact[]> {
    return await this.getGroupFactsStmt.all(groupJid) as unknown as GroupFact[];
  }

  /**
   * Returns the current chat plus chats where this sender has appeared in the
   * message log. Baileys can identify the same account with a phone JID or a
   * LID, so include known aliases before looking up participation.
   */
  public async getChatsForParticipant(senderJid: string, currentChatJid: string, limit = 100): Promise<string[]> {
    const chats = new Set<string>([currentChatJid]);
    if (!senderJid || senderJid === 'bot') return [...chats];

    try {
      const normalizedJid = senderJid.replace(/:\d+(?=@)/, '');
      const senderIds = new Set([senderJid, normalizedJid]);
      const senderPlaceholders = [...senderIds].map(() => '?').join(', ');
      const canonicalRows = await db.prepare(`
        SELECT DISTINCT contact_jid
        FROM contact_jid_aliases
        WHERE alias_jid IN (${senderPlaceholders}) OR contact_jid IN (${senderPlaceholders})
      `).all(...senderIds, ...senderIds) as Array<{ contact_jid: string }>;

      const canonicalIds = new Set([...senderIds, ...canonicalRows.map((row) => row.contact_jid)]);
      const canonicalPlaceholders = [...canonicalIds].map(() => '?').join(', ');
      const aliasRows = await db.prepare(`
        SELECT alias_jid FROM contact_jid_aliases WHERE contact_jid IN (${canonicalPlaceholders})
      `).all(...canonicalIds) as Array<{ alias_jid: string }>;
      const participantIds = new Set([...canonicalIds, ...aliasRows.map((row) => row.alias_jid)]);
      const participantPlaceholders = [...participantIds].map(() => '?').join(', ');
      const recentChats = await db.prepare(`
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

  public async searchChatLogs(
    query: string,
    chatJids: string[]
  ): Promise<Array<{ sender_name: string; message_text: string; timestamp: number; matchScore: number }>> {
    try {
      if (chatJids.length === 0) return [];
      const stopWords = new Set([
        'the', 'and', 'for', 'that', 'this', 'with', 'from', 'what', 'when', 'where', 'which', 'who', 'why', 'how',
        'did', 'does', 'do', 'was', 'were', 'are', 'is', 'have', 'has', 'had', 'can', 'could', 'would', 'should',
        'you', 'your', 'yours', 'we', 'our', 'ours', 'they', 'them', 'their', 'about', 'into', 'then', 'than',
        'earlier', 'before', 'last', 'time', 'talk', 'talked', 'discuss', 'discussed', 'agree', 'agreed', 'remember',
        'tell', 'told', 'said', 'say', 'conversation', 'chat', 'please', 'me', 'my', 'i', 'a', 'an', 'on', 'to', 'of',
      ]);
      const queryTerms = [...new Set((query.toLocaleLowerCase().match(/[\p{L}\p{N}]{2,}/gu) || [])
        .filter((term) => !stopWords.has(term)))].slice(0, 8);
      const chatPlaceholders = chatJids.map(() => '?').join(', ');
      const termClauses = queryTerms.map(() => 'LOWER(message_text) LIKE ?');
      const termParams = queryTerms.map((term) => `%${term}%`);
      const matchCondition = termClauses.length ? `AND (${termClauses.join(' OR ')})` : '';
      const relevanceOrder = queryTerms.length
        ? `(${queryTerms.map(() => 'CASE WHEN LOWER(message_text) LIKE ? THEN 1 ELSE 0 END').join(' + ')}) DESC,`
        : '';
      const candidates = await db.prepare(`
        SELECT sender_name, message_text, timestamp FROM chat_logs
        WHERE chat_jid IN (${chatPlaceholders})
          ${matchCondition}
          AND COALESCE(is_noise, 0) = 0
          AND LOWER(message_text) NOT LIKE '%<think%'
          AND LOWER(message_text) NOT LIKE '%<analysis%'
          AND LOWER(message_text) NOT LIKE '%<reasoning%'
          AND LOWER(message_text) NOT LIKE '%<tool_call%'
        ORDER BY ${relevanceOrder} id DESC LIMIT 250
      `).all(...chatJids, ...termParams, ...(queryTerms.length ? termParams : [])) as unknown as Array<{
        sender_name: string;
        message_text: string;
        timestamp: number;
      }>;

      const lowerQuery = query.toLocaleLowerCase().trim();
      return candidates
        .map((row) => {
          const body = (row.message_text || '').toLocaleLowerCase();
          const matchScore = (queryTerms.length === 0 ? 0.5 : queryTerms.reduce((score, term) => score + (body.includes(term) ? 1 : 0), 0)) +
            (lowerQuery.length >= 5 && body.includes(lowerQuery) ? 1.5 : 0);
          return { ...row, matchScore };
        })
        .sort((a, b) => b.matchScore - a.matchScore || b.timestamp - a.timestamp)
        .slice(0, 8);
    } catch {
      return [];
    }
  }

  public async findStickerByVibe(vibeQuery: string): Promise<{ filename: string; vibe_tags: string } | null> {
    try {
      const sanitized = `%${vibeQuery.toLowerCase().trim()}%`;
      // Match against tags or learned triggers
      const result = await db.prepare(`
        SELECT filename, vibe_tags FROM sticker_catalog
        WHERE vibe_tags LIKE ? OR learned_triggers LIKE ?
        ORDER BY usage_count DESC
        LIMIT 1
      `).get(sanitized, sanitized) as unknown as { filename: string; vibe_tags: string } | undefined;

      if (result) return result;

      // Fallback: Return any sticker from catalog
      return (await db.prepare(`
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
