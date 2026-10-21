import { db } from '../memory/db.js';
import { vectorStore } from '../learning/vector-store.js';
import { contactService, ContactRecord } from '../memory/contact-service.js';
import { memoryService, UserFact, GroupFact } from '../memory/memory-service.js';

export interface RagDocument {
  source: 'user_fact' | 'group_fact' | 'contact' | 'historical_chat' | 'vector_knowledge';
  title: string;
  snippet: string;
  relevanceScore: number;
}

export interface RagResult {
  hasMatches: boolean;
  documents: RagDocument[];
  formattedContext: string;
}

export class RagEngine {
  /**
   * Retrieves relevant internal knowledge from user facts, group facts, indexed contacts,
   * and past conversations using hybrid local semantic & keyword retrieval.
   */
  public async retrieveContext(
    query: string,
    chatJid?: string,
    userJid?: string,
    topK: number = 4
  ): Promise<RagResult> {
    if (!query || query.trim().length < 2) {
      return { hasMatches: false, documents: [], formattedContext: '' };
    }

    const cleanQuery = query.trim();
    const queryLower = cleanQuery.toLowerCase();
    const queryVec = vectorStore.embed(cleanQuery);
    const documents: RagDocument[] = [];

    // 1. Search User Facts (if userJid provided or across all user facts if asking generally)
    try {
      let facts: UserFact[] = [];
      if (userJid) {
        facts = memoryService.getUserFacts(userJid);
      }

      const factKeywordRows = db.prepare(`
        SELECT fact, category, updated_at FROM user_facts
        ORDER BY updated_at DESC LIMIT 20
      `).all() as unknown as UserFact[];

      const combinedFacts = [...facts, ...factKeywordRows];
      const seenFacts = new Set<string>();
      const isPersonalQuery = /\b(i|my|me|mine|study|studies|live|work|like|prefer|preference|favorite|course|school)\b/i.test(queryLower);

      for (const f of combinedFacts) {
        if (!f.fact || seenFacts.has(f.fact)) continue;
        seenFacts.add(f.fact);

        const factLower = f.fact.toLowerCase();
        let score = 0;

        const isOwnFact = userJid ? facts.some((uf) => uf.fact === f.fact) : false;
        if (isOwnFact && isPersonalQuery) {
          score = 0.55;
        }

        // Stem matching (e.g. "study" <-> "studies", "prefer" <-> "preference", "comp" <-> "computer")
        const words = queryLower.split(/\s+/).filter((w) => w.length > 2);
        for (const w of words) {
          const stem = w.length >= 4 ? w.slice(0, 4) : w;
          if (factLower.includes(stem)) {
            score = Math.max(score, 0.65);
          }
        }

        const factVec = vectorStore.embed(f.fact);
        const cosine = vectorStore.cosineSimilarity(queryVec, factVec);
        const finalScore = Math.max(score, cosine);

        if (finalScore >= 0.25) {
          documents.push({
            source: 'user_fact',
            title: `User Profile Fact (${f.category || 'general'})`,
            snippet: f.fact,
            relevanceScore: finalScore,
          });
        }
      }
    } catch (err: any) {
      console.warn('[RagEngine] User facts retrieval warning:', err.message);
    }

    // 2. Search Group Facts & Rules
    if (chatJid && chatJid.endsWith('@g.us')) {
      try {
        const groupFacts = memoryService.getGroupFacts(chatJid);
        for (const gf of groupFacts) {
          const text = `${gf.topic}: ${gf.summary}`;
          const textLower = text.toLowerCase();
          const words = queryLower.split(/\s+/).filter((w) => w.length > 2);
          const matchCount = words.filter((w) => textLower.includes(w)).length;
          const gfVec = vectorStore.embed(text);
          const cosine = vectorStore.cosineSimilarity(queryVec, gfVec);
          const score = Math.max(matchCount / Math.max(words.length, 1), cosine);

          if (score >= 0.2) {
            documents.push({
              source: 'group_fact',
              title: `Group Knowledge (${gf.topic})`,
              snippet: gf.summary,
              relevanceScore: score,
            });
          }
        }
      } catch (err: any) {
        console.warn('[RagEngine] Group facts retrieval warning:', err.message);
      }
    }

    // 3. Search Indexed Contacts (375+ contacts database)
    try {
      const isPersonQuery =
        /\b(who is|contact|phone|number|call|reach|message|find|get|ademola|boss|creator)\b/i.test(queryLower) ||
        queryLower.split(/\s+/).length <= 4;

      if (isPersonQuery) {
        const queryTerms = queryLower
          .replace(/^(who is|whats the contact for|get me|find|look up|call)\s+/i, '')
          .replace(/[?.,!]/g, '')
          .trim();

        if (queryTerms.length >= 2) {
          const matchedContacts = contactService.searchContacts(queryTerms, 3);
          for (const c of matchedContacts) {
            const name = c.custom_name || c.display_name || 'Contact';
            const phoneStr = c.phone_number ? `+${c.phone_number}` : c.jid;
            const snippet = `${name} | Phone: ${phoneStr}${c.notes ? ` | Notes: ${c.notes}` : ''}${c.tags ? ` | Tags: ${c.tags}` : ''}`;

            documents.push({
              source: 'contact',
              title: `Contact Card: ${name}`,
              snippet,
              relevanceScore: 0.85,
            });
          }
        }
      }
    } catch (err: any) {
      console.warn('[RagEngine] Contact search retrieval warning:', err.message);
    }

    // 4. Semantic Search over Past Banter & Group Discussions
    try {
      const vectorMatches = vectorStore.searchBanter(cleanQuery, chatJid, 2);
      for (const vm of vectorMatches) {
        if (vm.score >= 0.35) {
          documents.push({
            source: 'vector_knowledge',
            title: `Historical Chat Memory (${vm.timeAgoStr})`,
            snippet: `${vm.senderName}: "${vm.messageText}"`,
            relevanceScore: vm.score,
          });
        }
      }
    } catch (err: any) {
      console.warn('[RagEngine] Vector search retrieval warning:', err.message);
    }

    // 5. Keyword search in past chat_logs for specific discussions
    try {
      const words = queryLower.split(/\s+/).filter((w) => w.length > 3);
      if (words.length > 0) {
        const keyword = words[0];
        const logMatches = memoryService.searchChatLogs(keyword, chatJid);
        for (const lm of logMatches.slice(0, 2)) {
          if (lm.message_text && !documents.some((d) => d.snippet.includes(lm.message_text))) {
            documents.push({
              source: 'historical_chat',
              title: 'Past Chat Discussion',
              snippet: `${lm.sender_name}: "${lm.message_text}"`,
              relevanceScore: 0.4,
            });
          }
        }
      }
    } catch {}

    // Sort by relevance score descending and take topK
    documents.sort((a, b) => b.relevanceScore - a.relevanceScore);
    const topDocs = documents.slice(0, topK);

    if (topDocs.length === 0) {
      return { hasMatches: false, documents: [], formattedContext: '' };
    }

    const lines = topDocs.map((doc) => `• [${doc.title}]: ${doc.snippet}`);
    const formattedContext =
      `# Verified Internal Knowledge Base (Local RAG - SQLite Database):\n` +
      lines.join('\n') +
      `\n[CRITICAL RAG DIRECTIVE: The above data is verified from your local database. Use it directly to answer. DO NOT perform an external web search for information already in your database.]`;

    return {
      hasMatches: true,
      documents: topDocs,
      formattedContext,
    };
  }
}

export const ragEngine = new RagEngine();
