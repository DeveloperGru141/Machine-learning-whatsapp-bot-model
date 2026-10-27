import { db } from '../memory/db.js';

export interface BanterSearchResult {
  id: number;
  chatJid: string;
  senderName: string;
  messageText: string;
  contextText?: string;
  vibe: string;
  score: number;
  timestamp: number;
  timeAgoStr: string;
}

export class VectorStore {
  // Vector dimension: 256 dimensions for fast, dense local semantic matching
  private readonly DIMENSION = 256;

  /**
   * Fast 32-bit FNV-1a hash function for strings.
   */
  private fnv1a(str: string): number {
    let hash = 2166136261;
    for (let i = 0; i < str.length; i++) {
      hash ^= str.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
  }

  /**
   * Generates a normalized 256-dimensional subword & n-gram embedding vector locally.
   * Runs in microseconds without any external API or neural network downloads.
   */
  public embed(text: string): Float32Array {
    const vector = new Float32Array(this.DIMENSION);
    if (!text || typeof text !== 'string') return vector;

    const lower = text.toLowerCase().trim();
    // 1. Word tokens
    const words = lower.match(/[a-zA-Z0-9\u00C0-\u024F\u1E00-\u1EFF]+/g) || [];
    if (words.length === 0) return vector;

    // Feature counts
    const features = new Map<string, number>();

    // Single words
    for (const w of words) {
      features.set(w, (features.get(w) || 0) + 1.0);

      // Character tri-grams for subword slang matching (e.g. "whine", "lmao", "werey", "dey")
      if (w.length >= 3) {
        for (let i = 0; i <= w.length - 3; i++) {
          const tri = w.slice(i, i + 3);
          features.set(`_tri_${tri}`, (features.get(`_tri_${tri}`) || 0) + 0.4);
        }
      }
    }

    // Word bigrams for phrasal context (e.g. "dey play", "my guy", "no wahala", "inside life")
    for (let i = 0; i < words.length - 1; i++) {
      const bi = `${words[i]}_${words[i + 1]}`;
      features.set(bi, (features.get(bi) || 0) + 1.5);
    }

    // Hash features into the 256-dim vector space with sublinear term frequency
    for (const [feat, count] of features.entries()) {
      const weight = Math.log1p(count);
      const h1 = this.fnv1a(feat);
      const idx = h1 % this.DIMENSION;
      const sign = (h1 >>> 16) % 2 === 0 ? 1 : -1;
      vector[idx] += sign * weight;
    }

    // L2 Normalize to unit sphere (so cosine similarity = dot product)
    let norm = 0;
    for (let i = 0; i < this.DIMENSION; i++) {
      norm += vector[i] * vector[i];
    }
    norm = Math.sqrt(norm);

    if (norm > 0) {
      for (let i = 0; i < this.DIMENSION; i++) {
        vector[i] /= norm;
      }
    }

    return vector;
  }

  /**
   * Computes cosine similarity between two unit vectors: dot product.
   */
  public cosineSimilarity(a: Float32Array, b: Float32Array): number {
    let dot = 0;
    const len = Math.min(a.length, b.length);
    for (let i = 0; i < len; i++) {
      dot += a[i] * b[i];
    }
    return Math.max(0, Math.min(1.0, dot));
  }

  /**
   * Serializes a Float32Array to a compact base64 string for fast SQLite storage.
   */
  private serializeVector(vec: Float32Array): string {
    return Buffer.from(vec.buffer).toString('base64');
  }

  /**
   * Deserializes a base64 string back into a Float32Array.
   */
  private deserializeVector(str: string): Float32Array {
    const buf = Buffer.from(str, 'base64');
    return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
  }

  /**
   * Indexes a memorable group banter message into the vector database.
   */
  public indexBanter(
    chatJid: string,
    senderJid: string,
    senderName: string,
    messageText: string,
    contextText?: string,
    vibe: string = 'banter'
  ): void {
    if (!messageText || messageText.trim().length < 3) return;

    try {
      const cleanMessage = messageText.trim();
      const combinedText = contextText ? `${contextText} -> ${cleanMessage}` : cleanMessage;
      const vec = this.embed(combinedText);
      const serialized = this.serializeVector(vec);
      const now = Date.now();

      db.prepare(`
        INSERT INTO group_banter_vectors (chat_jid, sender_jid, sender_name, message_text, context_text, vibe, embedding, timestamp)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(chatJid, senderJid, senderName, cleanMessage, contextText || null, vibe, serialized, now);
    } catch (err: any) {
      console.warn('[VectorStore] Warning indexing banter:', err?.message || err);
    }
  }

  /**
   * Searches past group banter using local vector semantic search.
   */
  public searchBanter(query: string, chatJid?: string | string[], topK: number = 3): BanterSearchResult[] {
    if (!query || query.trim().length < 2) return [];

    try {
      const queryVec = this.embed(query);

      // Fetch candidates from group_banter_vectors
      let sql = `SELECT id, chat_jid, sender_name, message_text, context_text, vibe, embedding, timestamp FROM group_banter_vectors`;
      const params: any[] = [];
      if (Array.isArray(chatJid)) {
        if (chatJid.length === 0) return [];
        sql += ` WHERE chat_jid IN (${chatJid.map(() => '?').join(', ')})`;
        params.push(...chatJid);
      } else if (chatJid) {
        sql += ` WHERE chat_jid = ?`;
        params.push(chatJid);
      }
      sql += ` ORDER BY id DESC LIMIT 250`;

      const rows = db.prepare(sql).all(...params) as Array<{
        id: number;
        chat_jid: string;
        sender_name: string;
        message_text: string;
        context_text: string | null;
        vibe: string;
        embedding: string;
        timestamp: number;
      }>;

      if (rows.length === 0) return [];

      const now = Date.now();
      const scored: BanterSearchResult[] = [];

      for (const row of rows) {
        const docVec = this.deserializeVector(row.embedding);
        const sim = this.cosineSimilarity(queryVec, docVec);

        const ageMs = now - row.timestamp;
        const daysAgo = Math.floor(ageMs / (24 * 3600 * 1000));
        const timeAgoStr =
          daysAgo === 0
            ? 'earlier today'
            : daysAgo === 1
            ? 'yesterday'
            : `${daysAgo} days ago`;

        scored.push({
          id: row.id,
          chatJid: row.chat_jid,
          senderName: row.sender_name || 'Member',
          messageText: row.message_text,
          contextText: row.context_text || undefined,
          vibe: row.vibe,
          score: sim,
          timestamp: row.timestamp,
          timeAgoStr,
        });
      }

      // Sort by cosine similarity descending
      scored.sort((a, b) => b.score - a.score);
      return scored.slice(0, topK);
    } catch (err: any) {
      console.warn('[VectorStore] Error searching banter vectors:', err?.message || err);
      return [];
    }
  }

  /**
   * Scans chat_logs for historical high-humor/banter group messages and indexes them into vector space.
   */
  public indexHistoricalBanter(): { indexedCount: number } {
    try {
      // Find historical group messages that were banter/humor or have laughter
      const rows = db.prepare(`
        SELECT l.chat_jid, l.sender_jid, l.sender_name, l.message_text, l.timestamp
        FROM chat_logs l
        WHERE l.is_group = 1 
          AND l.content_type = 'text' 
          AND l.message_text IS NOT NULL
          AND l.sender_jid != 'bot'
          AND (
            l.message_text LIKE '%😂%' 
            OR l.message_text LIKE '%🤣%' 
            OR l.message_text LIKE '%💀%' 
            OR l.message_text LIKE '%lol%' 
            OR l.message_text LIKE '%lmao%'
            OR l.message_text LIKE '%whine%'
            OR l.message_text LIKE '%werey%'
            OR l.message_text LIKE '%cruise%'
          )
          AND NOT EXISTS (
            SELECT 1 FROM group_banter_vectors v
            WHERE v.chat_jid = l.chat_jid AND v.message_text = l.message_text
          )
        ORDER BY l.id DESC LIMIT 100
      `).all() as Array<{
        chat_jid: string;
        sender_jid: string;
        sender_name: string | null;
        message_text: string;
        timestamp: number;
      }>;

      for (const r of rows) {
        this.indexBanter(
          r.chat_jid,
          r.sender_jid,
          r.sender_name || 'Member',
          r.message_text,
          undefined,
          'humor'
        );
      }

      console.log(`[VectorStore] 📚 Indexed ${rows.length} historical group banter vectors into local database.`);
      return { indexedCount: rows.length };
    } catch (err: any) {
      console.warn('[VectorStore] Warning indexing historical banter:', err?.message || err);
      return { indexedCount: 0 };
    }
  }
}

export const vectorStore = new VectorStore();
