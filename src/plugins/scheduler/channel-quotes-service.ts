import path from 'path';
import fs from 'fs';
import type { WASocket } from '@whiskeysockets/baileys';
import {
  saveChannelQuote,
  getFreshestQuoteForNiche,
  markQuoteUsed,
  getAllChannelQuotes,
  getChannelQuotesStats,
  getAllKnownGroups,
  upsertKnownGroup,
  logAutonomousAction,
  QuoteNiche,
  ChannelQuote,
  db,
} from '../../memory/db.js';
import { chatLogger } from '../../memory/chat-logger.js';
import { llmClient } from '../../agent/llm-client.js';

export const WHATSAPP_CHANNEL_INVITE_CODE = '0029Vb7S3VAFCCoXEIdW5n2k';
export const WHATSAPP_CHANNEL_URL = 'https://whatsapp.com/channel/0029Vb7S3VAFCCoXEIdW5n2k';
export const WHATSAPP_CHANNEL_NAME = 'Quotes📖';

/**
 * Curated authentic motivational quotes seed bank directly aligned with
 * the Quotes📖 channel aesthetic: Deep Thoughts • Life Quotes • Hustle • Tech • Motivation.
 */
export const SEED_CHANNEL_QUOTES: Array<{
  quote: string;
  author: string;
  niche: QuoteNiche;
}> = [
  // TECH & CODING
  {
    quote: 'Talk is cheap. Show me the code.',
    author: 'Linus Torvalds',
    niche: 'tech_coding',
  },
  {
    quote: 'The only way to do great work is to love what you do. If you haven’t found it yet, keep looking.',
    author: 'Steve Jobs',
    niche: 'tech_coding',
  },
  {
    quote: 'Any fool can write code that a computer can understand. Good programmers write code that humans can understand.',
    author: 'Martin Fowler',
    niche: 'tech_coding',
  },
  {
    quote: 'It’s not a bug – it’s an undocumented feature. Every error is just a stepping stone to cleaner logic.',
    author: 'Anonymous Hacker',
    niche: 'tech_coding',
  },
  {
    quote: 'First, solve the problem. Then, write the code. Complexity is the enemy of execution.',
    author: 'John Johnson',
    niche: 'tech_coding',
  },
  {
    quote: 'Make it work, make it right, make it fast. In that exact order.',
    author: 'Kent Beck',
    niche: 'tech_coding',
  },
  {
    quote: 'The best error message is the one that never shows up because you built with care and foresight.',
    author: 'Tech Axiom',
    niche: 'tech_coding',
  },

  // WEALTH & BUSINESS (Empire / Hustle / Trading / Crypto)
  {
    quote: 'Opportunities don\'t happen. You create them.',
    author: 'Chris Grosser',
    niche: 'wealth_business',
  },
  {
    quote: 'The secret of getting ahead is getting started. Don\'t let the fear of losing be greater than the excitement of winning.',
    author: 'Robert Kiyosaki',
    niche: 'wealth_business',
  },
  {
    quote: 'Never depend on a single income. Make investment of time and resources to create a second source.',
    author: 'Warren Buffett',
    niche: 'wealth_business',
  },
  {
    quote: 'We don’t just work for survival; we build systems that generate freedom and long-term leverage.',
    author: 'Empire Mindset',
    niche: 'wealth_business',
  },
  {
    quote: 'Your network is your net worth. Build relationships rooted in value, mutual respect, and undeniable competence.',
    author: 'Tim Sanders',
    niche: 'wealth_business',
  },
  {
    quote: 'Comfort is the enemy of progress. If you want results you’ve never had, you must put in work you’ve never done.',
    author: 'Hustle Maxim',
    niche: 'wealth_business',
  },
  {
    quote: 'Money flows to where attention and value are created. Focus on solving real problems and the rewards will follow.',
    author: 'Wealth Principle',
    niche: 'wealth_business',
  },

  // ACADEMIC & DISCIPLINE (School / Faculty / Campus)
  {
    quote: 'Discipline is choosing between what you want now and what you want most.',
    author: 'Abraham Lincoln',
    niche: 'academic_discipline',
  },
  {
    quote: 'The expert in anything was once a beginner. Consistent study turns confusion into mastery.',
    author: 'Helen Hayes',
    niche: 'academic_discipline',
  },
  {
    quote: 'Success isn’t always about greatness. It’s about consistency. Consistent hard work leads to success.',
    author: 'Dwayne Johnson',
    niche: 'academic_discipline',
  },
  {
    quote: 'Education is the passport to the future, for tomorrow belongs to those who prepare for it today.',
    author: 'Malcolm X',
    niche: 'academic_discipline',
  },
  {
    quote: 'You don’t have to see the whole staircase, just take the first step with conviction and diligence.',
    author: 'Martin Luther King Jr.',
    niche: 'academic_discipline',
  },
  {
    quote: 'Focus is a muscle. The more you eliminate distractions, the sharper your mind becomes.',
    author: 'Deep Work Principle',
    niche: 'academic_discipline',
  },

  // GENERAL GROWTH & MINDSET
  {
    quote: 'Words that speak what the heart can’t. Stay true to your journey, honor your pace, and guard your peace.',
    author: 'Quotes📖 Community',
    niche: 'general_growth',
  },
  {
    quote: 'Your mind is a garden. Your thoughts are the seeds. You can grow flowers or you can grow weeds.',
    author: 'Anonymous',
    niche: 'general_growth',
  },
  {
    quote: 'Never allow waiting to become a habit. Live your dreams and take risks. Life is happening right now.',
    author: 'Paulo Coelho',
    niche: 'general_growth',
  },
  {
    quote: 'Peace begins when expectation ends. Focus on what you control and release the rest.',
    author: 'Ancient Wisdom',
    niche: 'general_growth',
  },
  {
    quote: 'No matter how slow you go, you are still lapping everybody who is sitting on the couch.',
    author: 'Anonymous',
    niche: 'general_growth',
  },
  {
    quote: 'Be proud of how hard you’re trying. Even on the days when it feels like nothing is moving forward.',
    author: 'Quotes📖 Channel',
    niche: 'general_growth',
  },
  {
    quote: 'A bad day doesn’t equal a bad life. Take a deep breath, reset your energy, and keep moving forward.',
    author: 'Mindset Daily',
    niche: 'general_growth',
  },
];

/**
 * Seeds initial curated quotes if the database is currently empty.
 */
export function seedChannelQuotesIfEmpty(): void {
  try {
    const countRow = db.prepare('SELECT COUNT(*) as count FROM channel_quotes').get() as { count: number };
    if (!countRow || countRow.count === 0) {
      console.log(`[ChannelQuotes] 📖 Seeding ${SEED_CHANNEL_QUOTES.length} initial quotes from ${WHATSAPP_CHANNEL_NAME}...`);
      for (const item of SEED_CHANNEL_QUOTES) {
        const candidateImg = path.resolve(`assets/channel_media/quote_${item.niche}.jpg`);
        const imgPath = fs.existsSync(candidateImg) ? candidateImg : null;
        saveChannelQuote(item.quote, item.author, item.niche, WHATSAPP_CHANNEL_INVITE_CODE, undefined, imgPath);
      }
    }
  } catch (err: any) {
    console.error('[ChannelQuotes] Error seeding initial quotes:', err?.message || err);
  }
}

/**
 * Intelligently classifies a WhatsApp group into a niche based on its subject and description.
 */
export function detectGroupNiche(subject: string, description?: string): QuoteNiche {
  const text = `${subject || ''} ${description || ''}`.toLowerCase();

  // 1. Tech & Coding
  if (
    /\b(tech|code|coding|dev|developer|ai|software|ift|engineering|computer|science|web|frontend|backend|fullstack|data|cyber|python|javascript|typescript|algorithm|repo|git|cloud)\b/i.test(
      text
    )
  ) {
    return 'tech_coding';
  }

  // 2. Wealth & Business (Empire / Crypto / Trading)
  if (
    /\b(empire|wealth|money|hustle|crypto|forex|trade|trading|business|finance|investment|invest|cash|fund|funds|naira|dollar|roi|profit|market|venture|millionaire|billionaire|capital)\b/i.test(
      text
    )
  ) {
    return 'wealth_business';
  }

  // 3. Academic & Discipline (University / Faculty / Study / Department)
  if (
    /\b(faculty|dept|department|class|study|exam|assignment|course|semester|campus|unilorin|university|school|student|lecture|academic|tutorial|matric|cgpa)\b/i.test(
      text
    )
  ) {
    return 'academic_discipline';
  }

  // 4. Default: General Growth & Mindset
  return 'general_growth';
}

/**
 * Parses and cleans quotes from raw text messages or captions scraped from the channel.
 */
export function parseQuoteFromText(rawText: string): { quote: string; author?: string; niche: QuoteNiche } | null {
  if (!rawText || rawText.trim().length < 15) return null;
  const clean = rawText.trim();

  // If text contains author separator e.g. "— Author" or "- Author" or "~ Author"
  const authorMatch = clean.match(/^(.*?)(?:\s*[—–~-]\s*([A-Za-z0-9\s.]{3,35}))$/s);
  let quoteText = clean;
  let author: string | undefined = undefined;

  if (authorMatch && authorMatch[1] && authorMatch[2]) {
    quoteText = authorMatch[1].trim().replace(/^["']|["']$/g, '');
    author = authorMatch[2].trim();
  }

  if (quoteText.length < 12) return null;

  // Classify niche
  const niche = detectGroupNiche(clean);
  return {
    quote: quoteText,
    author: author || 'Quotes📖 Channel',
    niche,
  };
}

/**
 * Live Scraper: Resolves the WhatsApp Channel via Baileys and fetches recent messages.
 */
export async function scrapeWhatsAppChannelQuotes(
  socket: WASocket
): Promise<{ channelJid: string | null; newQuotesSaved: number }> {
  let newQuotesSaved = 0;
  let channelJid: string | null = null;

  try {
    seedChannelQuotesIfEmpty();

    console.log(`[ChannelQuotes] 🔍 Querying WhatsApp Channel metadata for invite code: ${WHATSAPP_CHANNEL_INVITE_CODE}...`);
    const metadata: any = await (socket as any).newsletterMetadata?.('invite', WHATSAPP_CHANNEL_INVITE_CODE);

    if (metadata?.id) {
      channelJid = metadata.id;
      console.log(`[ChannelQuotes] ✅ Resolved channel JID: ${channelJid} (${metadata.name || WHATSAPP_CHANNEL_NAME})`);

      // Ensure bot follows the channel
      try {
        await (socket as any).newsletterFollow?.(channelJid);
      } catch {}

      // Subscribe to real-time updates
      try {
        await (socket as any).subscribeNewsletterUpdates?.(channelJid);
      } catch {}

      // Fetch recent messages
      try {
        const fetchPromise = (socket as any).newsletterFetchMessages?.(channelJid, 25);
        const timeoutPromise = new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Channel quotes fetch timed out after 5s')), 5000)
        );
        const queryRes: any = await Promise.race([fetchPromise, timeoutPromise]);
        if (queryRes) {
          // Parse BinaryNode children or message list
          const messages = extractMessagesFromNewsletterNode(queryRes);
          for (const msg of messages) {
            const parsed = parseQuoteFromText(msg.text);
            if (parsed) {
              const saved = saveChannelQuote(
                parsed.quote,
                parsed.author,
                parsed.niche,
                WHATSAPP_CHANNEL_INVITE_CODE,
                msg.id
              );
              if (saved) newQuotesSaved++;
            }
          }
        }
      } catch (fetchErr: any) {
        console.warn(`[ChannelQuotes] newsletterFetchMessages note: ${fetchErr.message}`);
      }
    }
  } catch (err: any) {
    console.warn(`[ChannelQuotes] WhatsApp Channel protocol query note: ${err.message}`);
  }

  console.log(`[ChannelQuotes] 📚 Scrape complete. New quotes added: ${newQuotesSaved}.`);
  return { channelJid, newQuotesSaved };
}

/**
 * Helper to recursively extract text contents from Baileys BinaryNodes.
 */
function extractMessagesFromNewsletterNode(node: any): Array<{ id?: string; text: string }> {
  const results: Array<{ id?: string; text: string }> = [];
  if (!node) return results;

  const inspect = (item: any) => {
    if (!item) return;
    if (typeof item === 'string' && item.length > 20) {
      results.push({ text: item });
      return;
    }
    if (item.tag === 'message' || item.tag === 'message_updates') {
      const msgId = item.attrs?.id || item.attrs?.server_id;
      if (item.content) {
        if (Array.isArray(item.content)) {
          for (const c of item.content) inspect(c);
        } else if (typeof item.content === 'string') {
          results.push({ id: msgId, text: item.content });
        }
      }
    }
    if (Array.isArray(item.content)) {
      for (const child of item.content) inspect(child);
    }
  };

  inspect(node);
  return results;
}

/**
 * Formats a high-impact, authentic morning greeting and niche-tailored motivational quote for a group.
 */
export async function formatGroupMorningMotivation(
  groupSubject: string,
  niche: QuoteNiche,
  quote: ChannelQuote
): Promise<string> {
  const groupClean = (groupSubject || 'the group').trim();

  // High-energy, culturally attuned greeting and charge tailored to the group's niche
  let greetingIntro = '';
  let chargeTakeaway = '';

  switch (niche) {
    case 'tech_coding':
      greetingIntro = `🌅 *GOOD MORNING ${groupClean.toUpperCase()}!* ⚡💻\n\nTop of the morning to our brilliant developers, builders, and tech minds! As we step out today, let us focus on shipping clean, resilient solutions.`;
      chargeTakeaway = `💡 *Today's Charge:*\nClear logic and daily consistency beat burnout every single time. Whatever feature, repo, or problem you are tackling today, step into it with full confidence and precision! 🚀`;
      break;

    case 'wealth_business':
      greetingIntro = `🌅 *GOOD MORNING ${groupClean.toUpperCase()}!* 💯💸\n\nRise and grind to all the visionaries, entrepreneurs, and real hustlers in the building! The market and opportunities wait for no one.`;
      chargeTakeaway = `💡 *Today's Charge:*\nStay disciplined with your capital, execute your plans without hesitation, and keep building high-value assets. Let your results speak today! 📈🔥`;
      break;

    case 'academic_discipline':
      greetingIntro = `🌅 *GOOD MORNING ${groupClean.toUpperCase()}!* 📚🎓\n\nWarm morning greetings to our dedicated scholars! Another day to grow in wisdom, master tough concepts, and conquer your academic goals.`;
      chargeTakeaway = `💡 *Today's Charge:*\nSmall, disciplined study sessions compounded over time lead to undeniable mastery. Eliminate distractions, stay curious, and make today count! ✨`;
      break;

    case 'general_growth':
    default:
      greetingIntro = `🌅 *GOOD MORNING ${groupClean.toUpperCase()}!* ☀️✨\n\nRise and shine everyone! Wishing each and every member of this group a blessed, peaceful, and super productive day ahead.`;
      chargeTakeaway = `💡 *Today's Charge:*\nGuard your energy, treat people with grace, and remember that every new sunrise brings fresh opportunities to win. Step forward boldly! 🌟`;
      break;
  }

  // Clean, beautifully styled WhatsApp morning broadcast format (zero LLM scratchpad/arithmetic risk)
  return (
    `${greetingIntro}\n\n` +
    `📜 *Words of the Day (from Quotes📖):*\n` +
    `> "${quote.quote_text}"\n` +
    `— *${quote.author || 'Quotes📖'}*\n\n` +
    `${chargeTakeaway}\n\n` +
    `— *Forgelabs Assistant* 🫡`
  );
}

export async function broadcastMorningGroupMotivation(
  socket: WASocket,
  targetGroupJid?: string
): Promise<{ groupsContacted: number; deliveredGroups: string[] }> {
  seedChannelQuotesIfEmpty();

  // Try scraping fresh quotes first if online
  try {
    await scrapeWhatsAppChannelQuotes(socket);
  } catch {}

  // Resolve target groups
  let targetGroups: Array<{ id: string; subject: string }> = [];

  if (targetGroupJid) {
    let groupSubject = 'WhatsApp Group';
    const known = getAllKnownGroups().find((g) => g.group_jid === targetGroupJid);
    if (known) {
      groupSubject = known.subject;
    }
    targetGroups.push({ id: targetGroupJid, subject: groupSubject });
  } else {
    // Collect all participating groups from Baileys socket and local database
    const groupMap = new Map<string, string>();

    // 1. Local database known groups
    const dbGroups = getAllKnownGroups(30);
    for (const g of dbGroups) {
      if (g.group_jid && g.subject) {
        groupMap.set(g.group_jid, g.subject);
      }
    }

    // 2. Live participating groups from socket
    if (socket?.groupFetchAllParticipating) {
      try {
        const liveGroups = await socket.groupFetchAllParticipating();
        for (const [jid, metadata] of Object.entries(liveGroups)) {
          if (jid && metadata?.subject) {
            groupMap.set(jid, metadata.subject);
            upsertKnownGroup(jid, metadata.subject, metadata.participants?.length || 0);
          }
        }
      } catch (err: any) {
        console.warn('[ChannelQuotes] groupFetchAllParticipating warning:', err.message);
      }
    }

    targetGroups = Array.from(groupMap.entries()).map(([id, subject]) => ({ id, subject }));
  }

  // Deduplicate groups by normalized subject so groups with multiple community links are only messaged once
  const seenSubjects = new Set<string>();
  const uniqueGroups: Array<{ id: string; subject: string }> = [];
  for (const g of targetGroups) {
    const clean = g.subject.trim().toLowerCase();
    if (seenSubjects.has(clean)) {
      console.log(`[ChannelQuotes] ⏭️ Skipping duplicate group with identical subject: "${g.subject}" (${g.id})`);
      continue;
    }
    seenSubjects.add(clean);
    uniqueGroups.push(g);
  }
  targetGroups = uniqueGroups;

  if (targetGroups.length === 0) {
    console.log('[ChannelQuotes] ⚠️ No participating groups found to broadcast morning motivation.');
    return { groupsContacted: 0, deliveredGroups: [] };
  }

  console.log(`[ChannelQuotes] 🚀 Starting morning motivation broadcast to ${targetGroups.length} unique group(s)...`);

  const deliveredGroups: string[] = [];
  const isTest = process.env.NODE_ENV === 'test' || Boolean(process.env.LIVETEST_RUNNER);
  const interGroupPauseMs = isTest ? 20 : 6_000; // 6s human-like pacing for anti-ban safety

  for (let i = 0; i < targetGroups.length; i++) {
    const group = targetGroups[i];
    try {
      // Per-group 18-hour anti-spam guard: Never send more than 1 morning greeting per day to any group
      const recentSend = db.prepare(`
        SELECT COUNT(*) as count FROM chat_logs 
        WHERE chat_jid = ? 
          AND (message_text LIKE '%GOOD MORNING%' OR message_text LIKE '%Words of the Day%' OR message_text LIKE '%Today''s Charge%')
          AND timestamp > ?
      `).get(group.id, Date.now() - 18 * 60 * 60 * 1000) as { count: number } | undefined;

      if (recentSend && recentSend.count > 0) {
        console.log(`[ChannelQuotes] ⏭️ Skipping group "${group.subject}" - morning motivation already sent within last 18 hours.`);
        continue;
      }

      // 1. Detect group niche
      const niche = detectGroupNiche(group.subject);

      // 2. Select freshest quote matching this niche
      const quote = getFreshestQuoteForNiche(niche);
      if (!quote) {
        console.warn(`[ChannelQuotes] No quote found for niche: ${niche}`);
        continue;
      }

      // 3. Format warm greeting + quote
      const messageText = await formatGroupMorningMotivation(group.subject, niche, quote);

      // 4. Send message to group (with accompanying image if available)
      const hasImage = Boolean(quote.image_path && fs.existsSync(quote.image_path));
      if (hasImage) {
        await socket.sendMessage(group.id, {
          image: fs.readFileSync(quote.image_path!),
          caption: messageText,
        });
      } else {
        await socket.sendMessage(group.id, { text: messageText });
      }
      chatLogger.logOutboundMessage(group.id, messageText);
      markQuoteUsed(quote.id);
      deliveredGroups.push(group.subject);

      console.log(
        `[ChannelQuotes] ✅ Delivered morning motivation to "${group.subject}" (${niche}): "${quote.quote_text.slice(0, 30)}..."`
      );

      logAutonomousAction('morning_group_motivation', group.id, group.subject, `Delivered morning quote (${niche})`);

      // 5. Anti-ban pacing between groups
      if (i < targetGroups.length - 1) {
        await new Promise((resolve) => setTimeout(resolve, interGroupPauseMs));
      }
    } catch (err: any) {
      console.error(`[ChannelQuotes] ❌ Failed to deliver to group "${group.subject}":`, err.message);
    }
  }

  console.log(
    `[ChannelQuotes] 🏁 Morning group motivation broadcast finished. Delivered to ${deliveredGroups.length}/${targetGroups.length} groups.`
  );
  return { groupsContacted: deliveredGroups.length, deliveredGroups };
}
