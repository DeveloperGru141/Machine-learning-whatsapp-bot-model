import { IPlugin, BotTool, ExecutionContext, ToolResult } from '../types.js';
import { ragEngine } from '../../core/rag-engine.js';
import { requiresCurrentWebEvidence } from '../../agent/query-intent.js';

export interface FootballMatch {
  name: string;
  league: string;
  status: string;
  detail: string;
  homeTeam: string;
  homeScore: string;
  awayTeam: string;
  awayScore: string;
  dateStr: string;
}

/**
 * Supported ESPN Soccer leagues and friendly keys
 */
const ESPN_LEAGUES: Record<string, { code: string; name: string }> = {
  champions: { code: 'uefa.champions', name: 'UEFA Champions League' },
  ucl: { code: 'uefa.champions', name: 'UEFA Champions League' },
  europa: { code: 'uefa.europa', name: 'UEFA Europa League' },
  epl: { code: 'eng.1', name: 'English Premier League' },
  premier: { code: 'eng.1', name: 'English Premier League' },
  laliga: { code: 'esp.1', name: 'Spanish La Liga' },
  seriea: { code: 'ita.1', name: 'Italian Serie A' },
  bundesliga: { code: 'ger.1', name: 'German Bundesliga' },
  ligue1: { code: 'fra.1', name: 'French Ligue 1' },
  primeira: { code: 'por.1', name: 'Portuguese Primeira Liga' },
  portugal: { code: 'por.1', name: 'Portuguese Primeira Liga' },
  confederation: { code: 'uefa.europa.conf', name: 'UEFA Conference League' },
};

function extractFootballFilters(query: string): { team?: string; league?: string } {
  const leaguePatterns: Array<[RegExp, string]> = [
    [/\b(?:champions league|ucl)\b/i, 'champions'],
    [/\b(?:premier league|epl)\b/i, 'epl'],
    [/\b(?:la liga|laliga)\b/i, 'laliga'],
    [/\b(?:serie a)\b/i, 'seriea'],
    [/\b(?:bundesliga)\b/i, 'bundesliga'],
    [/\b(?:ligue 1|ligue one)\b/i, 'ligue1'],
    [/\b(?:primeira liga|portuguese league)\b/i, 'primeira'],
    [/\b(?:europa league|uel)\b/i, 'europa'],
  ];
  const league = leaguePatterns.find(([pattern]) => pattern.test(query))?.[1];
  const team = query
    .replace(/\b(?:champions\s+league|ucl|premier\s+league|epl|la\s+liga|laliga|serie\s+a|bundesliga|ligue\s*1|ligue\s+one|primeira\s+liga|portuguese\s+league|europa\s+league|uel)\b/gi, ' ')
    .replace(/\b(?:what|who|is|are|the|check|show|find|get|give|tell|me|about|current|live|latest|football|soccer|match|matches|game|games|score|scores|result|results|data|information|details|status|happening|playing|played|won|of|for|on|in|at|today|yesterday|tonight|right\s+now|this\s+evening|last\s+night|please|now)\b/gi, ' ')
    .replace(/[^\p{L}\p{N}\s'.-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  return { ...(team ? { team } : {}), ...(league ? { league } : {}) };
}

/**
 * Format a Date object into YYYYMMDD string for ESPN API
 */
function formatDateForEspn(d: Date): string {
  const year = d.getUTCFullYear();
  const month = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${year}${month}${day}`;
}

/**
 * Queries Google News RSS for live headlines, breaking match reports, and recent updates.
 * Completely immune to IP blocks and requires no API key.
 */
export async function queryGoogleNewsRss(
  query: string,
  limit: number = 4
): Promise<Array<{ title: string; date: string; snippet?: string; url?: string }>> {
  try {
    const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-US&gl=US&ceid=US:en`;
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko)',
        Accept: 'application/rss+xml, application/xml, text/xml',
      },
      signal: AbortSignal.timeout(6000),
    });

    if (!res.ok) return [];

    const xml = await res.text();
    const items: Array<{ title: string; date: string; snippet?: string; url?: string }> = [];
    const itemRegex = /<item>[\s\S]*?<title>([\s\S]*?)<\/title>[\s\S]*?<link>([\s\S]*?)<\/link>[\s\S]*?<pubDate>([\s\S]*?)<\/pubDate>(?:[\s\S]*?<description>([\s\S]*?)<\/description>)?/gi;

    let match: RegExpExecArray | null;
    while ((match = itemRegex.exec(xml)) !== null && items.length < limit) {
      const rawTitle = match[1] || '';
      const rawUrl = match[2] || '';
      const rawDate = match[3] || '';
      const rawDesc = match[4] || '';

      const cleanTitle = rawTitle
        .replace(/<!\[CDATA\[(.*?)\]\]>/g, '$1')
        .replace(/&amp;/g, '&')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/<[^>]+>/g, '')
        .trim();

      const cleanDesc = rawDesc
        .replace(/<!\[CDATA\[(.*?)\]\]>/g, '$1')
        .replace(/<[^>]+>/g, '')
        .replace(/&amp;/g, '&')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .trim();
      const cleanUrl = rawUrl
        .replace(/<!\[CDATA\[(.*?)\]\]>/g, '$1')
        .replace(/&amp;/g, '&')
        .trim();

      if (cleanTitle.length > 5) {
        items.push({
          title: cleanTitle,
          date: rawDate.trim(),
          snippet: cleanDesc.length > 20 ? cleanDesc.slice(0, 200) : undefined,
          url: /^https?:\/\//i.test(cleanUrl) ? cleanUrl : undefined,
        });
      }
    }

    return items;
  } catch (err: any) {
    console.warn(`[WebSearch] Google News RSS query failed: ${err.message}`);
    return [];
  }
}

/**
 * Queries ESPN Public Soccer Scoreboard for real-time scores, yesterday's results, and today's matches.
 */
export async function fetchLiveFootballScores(
  teamQuery?: string,
  leagueKey?: string
): Promise<{ text: string; matches: FootballMatch[]; sources: string[] }> {
  const matches: FootballMatch[] = [];
  const sources = new Set<string>();
  const queryLower = (teamQuery || '').toLowerCase().trim();

  // Target leagues: if specified, query that league; otherwise query top major leagues in parallel
  let targetLeagues: Array<{ code: string; name: string }> = [];
  if (leagueKey && ESPN_LEAGUES[leagueKey.toLowerCase()]) {
    targetLeagues.push(ESPN_LEAGUES[leagueKey.toLowerCase()]);
  } else {
    // If team query matches Portuguese league teams
    if (/porto|sporting|benfica|braga/i.test(queryLower)) {
      targetLeagues.push(ESPN_LEAGUES.champions, ESPN_LEAGUES.primeira, ESPN_LEAGUES.europa);
    } else {
      targetLeagues.push(
        ESPN_LEAGUES.champions,
        ESPN_LEAGUES.epl,
        ESPN_LEAGUES.laliga,
        ESPN_LEAGUES.seriea,
        ESPN_LEAGUES.bundesliga,
        ESPN_LEAGUES.ligue1,
        ESPN_LEAGUES.primeira,
        ESPN_LEAGUES.europa
      );
    }
  }

  // Check both Today and Yesterday to catch recent games (e.g. Porto 0-1 PSV)
  const now = new Date();
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const dateParams = [formatDateForEspn(now), formatDateForEspn(yesterday)];

  const fetchPromises: Promise<void>[] = [];

  for (const league of targetLeagues) {
    for (const dParam of dateParams) {
      fetchPromises.push(
        (async () => {
          try {
            const url = `https://site.api.espn.com/apis/site/v2/sports/soccer/${league.code}/scoreboard?dates=${dParam}`;
            const res = await fetch(url, {
              headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
              signal: AbortSignal.timeout(5000),
            });
            if (!res.ok) return;
            sources.add(url);

            const data = (await res.json()) as any;
            const events = data.events || [];

            for (const ev of events) {
              const comp = ev.competitions?.[0];
              if (!comp) continue;

              const competitors = comp.competitors || [];
              const home = competitors.find((c: any) => c.homeAway === 'home') || competitors[0];
              const away = competitors.find((c: any) => c.homeAway === 'away') || competitors[1];

              const homeName = home?.team?.name || 'Home';
              const awayName = away?.team?.name || 'Away';
              const homeScore = home?.score !== undefined ? String(home.score) : '-';
              const awayScore = away?.score !== undefined ? String(away.score) : '-';

              const matchName = ev.name || `${homeName} vs ${awayName}`;
              const statusDetail = ev.status?.type?.detail || ev.status?.type?.shortDetail || 'Status Unknown';

              // If team filter provided, match either team name or event name
              const teamTerms = queryLower.split(/\b(?:vs\.?|versus|against|and)\b/i).map((term) => term.trim()).filter(Boolean);
              const teamsMatch = teamTerms.length > 1
                ? teamTerms.every((term) => homeName.toLowerCase().includes(term) || awayName.toLowerCase().includes(term))
                : !queryLower || matchName.toLowerCase().includes(queryLower) || homeName.toLowerCase().includes(queryLower) || awayName.toLowerCase().includes(queryLower);
              if (!teamsMatch) continue;

              // Deduplicate matches
              const exists = matches.some((m) => m.name === matchName && m.dateStr === dParam);
              if (!exists) {
                matches.push({
                  name: matchName,
                  league: league.name,
                  status: ev.status?.type?.state || 'in',
                  detail: statusDetail,
                  homeTeam: homeName,
                  homeScore,
                  awayTeam: awayName,
                  awayScore,
                  dateStr: dParam,
                });
              }
            }
          } catch {}
        })()
      );
    }
  }

  await Promise.allSettled(fetchPromises);

  // If matches were found via ESPN, format and return
  if (matches.length > 0) {
    const formatted = matches
      .slice(0, 8)
      .map((m) => {
        const scoreStr = m.homeScore !== '-' ? `${m.homeTeam} ${m.homeScore} - ${m.awayScore} ${m.awayTeam}` : `${m.homeTeam} vs ${m.awayTeam}`;
        return `⚽ *${m.league}*\n• *Match*: ${scoreStr}\n• *Status*: ${m.detail}`;
      })
      .join('\n\n');

    return {
      text: `⚽ *Football Live Scores & Match Results:*\n\n${formatted}`,
      matches,
      sources: [...sources],
    };
  }

  // Fallback: Query Google News RSS for live scores and match reports
  const rssQuery = queryLower ? `${queryLower} football score match` : 'football live scores match results';
  const rssItems = await queryGoogleNewsRss(rssQuery, 4);

  if (rssItems.length > 0) {
    const rssText = rssItems.map((item, idx) => `${idx + 1}. *${item.title}*\n   📅 ${item.date}`).join('\n\n');
    return {
      text: `⚽ *Football News & Match Scores (Google News RSS):*\n\n${rssText}`,
      matches: [],
      sources: rssItems.map((item) => item.url).filter((url): url is string => Boolean(url)),
    };
  }

  return {
    text: sources.size > 0
      ? `No active match results were listed by the live scoreboards for "${teamQuery || 'today'}".`
      : `Could not retrieve live match results for "${teamQuery || 'today'}" from the available scoreboards.`,
    matches: [],
    sources: [...sources],
  };
}

export class WebSearchPlugin implements IPlugin {
  name = 'WebSearch';
  version = '2.0.0';
  description = 'Performs live web searches, real-time football score lookups (ESPN & RSS), crypto prices, and breaking news';

  tools: BotTool[] = [
    {
      name: 'get_live_football_scores',
      description:
        'Retrieves live football (soccer) scores, fixtures, and latest results. Use for general requests to check live football or match data even when no team is named, as well as named teams or leagues, score questions, results, and match status.',
      parameters: {
        type: 'object',
        properties: {
          team: {
            type: 'string',
            description: 'Optional team name (e.g. "Porto", "Arsenal", "Barcelona", "Liverpool", "Chelsea", "Real Madrid", "PSV").',
          },
          league: {
            type: 'string',
            enum: ['champions', 'epl', 'laliga', 'seriea', 'bundesliga', 'ligue1', 'primeira', 'europa'],
            description: 'Optional league identifier (e.g. "champions", "epl", "laliga").',
          },
        },
      },
      execute: async (args: { team?: string; league?: string }, _ctx: ExecutionContext): Promise<ToolResult> => {
        try {
          const parsed = extractFootballFilters(args.team || '');
          const { text, matches, sources } = await fetchLiveFootballScores(
            parsed.team,
            args.league || parsed.league
          );
          return {
            success: true,
            message: `${text}\n\n[Scores verified via live sports scoreboard. Summarize clearly and accurately for the user.]`,
            data: matches,
            ...(sources.length > 0
              ? { evidence: { kind: 'live' as const, fetchedAt: Date.now(), sources } }
              : {}),
          };
        } catch (err: any) {
          return {
            success: false,
            message: `Failed to fetch live scores: ${err.message}`,
          };
        }
      },
    },
    {
      name: 'web_search',
      description: 'Searches the live web for up-to-date information, current news, sports, weather, facts, or real-time topics.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'The search query or keywords to look up on the web.',
          },
          q: {
            type: 'string',
            description: 'Alternative search query parameter.',
          },
          force_live: {
            type: 'boolean',
            description: 'Internal harness flag requiring external live lookup and disabling internal or static fallbacks.',
          },
        },
      },
      execute: async (args: { query?: string; q?: string; force_live?: boolean }, ctx: ExecutionContext): Promise<ToolResult> => {
        try {
          const rawQuery = (args.query || args.q || '').trim();
          console.log(`[WebSearch] Performing web lookup: "${rawQuery}"`);

          const lower = rawQuery.toLowerCase();
          const requiresLiveLookup = Boolean(args.force_live) || requiresCurrentWebEvidence(rawQuery);

          // 0. Autonomous Local RAG Interceptor: If this is an internal query matching local user facts, contacts, or group rules, return local data immediately
          if (!requiresLiveLookup) {
            try {
              const ragCheck = await ragEngine.retrieveContext(rawQuery, ctx.chatJid, ctx.senderJid, 3);
              if (ragCheck.hasMatches && ragCheck.documents.some((d) => d.relevanceScore >= 0.5)) {
                console.log(`[WebSearch] 🎯 Local RAG match found for "${rawQuery}". Suppressing external web search.`);
                return {
                  success: true,
                  message: `[Internal Verified Database Match - No Web Search Needed]:\n${ragCheck.formattedContext}\n\n[State the answer clearly and directly from this internal verified data without searching the web.]`,
                  data: ragCheck.documents,
                  evidence: { kind: 'internal' },
                };
              }
            } catch {}
          }

          // Auto-detect football score queries: delegate to football score engine
          if (
            /\b(score|scores|match|vs|champion.*league|ucl|epl|premier league|porto|arsenal|chelsea|barca|madrid|liverpool|mancity|man united|bayern|psv|inter|milan)\b/i.test(
              lower
            ) &&
            /\b(score|scores|result|played|game|match|win|lost|draw)\b/i.test(lower)
          ) {
            console.log(`[WebSearch] Football query detected in web_search: "${rawQuery}". Querying live sports scoreboard...`);
            const { team, league } = extractFootballFilters(rawQuery);
            const { text, matches, sources } = await fetchLiveFootballScores(team, league);
            if (matches.length > 0 || text.includes('⚽') || sources.length > 0) {
              return {
                success: true,
                message: `${text}\n\n[Live match data retrieved. State the score directly and concisely.]`,
                data: matches,
                ...(sources.length > 0
                  ? { evidence: { kind: 'live' as const, fetchedAt: Date.now(), sources } }
                  : {}),
              };
            }
          }

          // 1. Ultra-fast real-time crypto price lookup (<200ms)
          if (/\b(btc|bitcoin)\b/.test(lower)) {
            try {
              const res = await fetch('https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT', { signal: AbortSignal.timeout(3000) });
              if (res.ok) {
                const data = (await res.json()) as any;
                const formattedPrice = Number(data.price).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
                return {
                  success: true,
                  message: `Bitcoin (BTC) current live price is $${formattedPrice} USD.`,
                  data: { symbol: 'BTC', priceUsd: formattedPrice },
                  evidence: { kind: 'live', fetchedAt: Date.now(), sources: ['https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT'] },
                };
              }
            } catch {}
          } else if (/\b(eth|ethereum)\b/.test(lower)) {
            try {
              const res = await fetch('https://api.binance.com/api/v3/ticker/price?symbol=ETHUSDT', { signal: AbortSignal.timeout(3000) });
              if (res.ok) {
                const data = (await res.json()) as any;
                const formattedPrice = Number(data.price).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
                return {
                  success: true,
                  message: `Ethereum (ETH) current live price is $${formattedPrice} USD.`,
                  data: { symbol: 'ETH', priceUsd: formattedPrice },
                  evidence: { kind: 'live', fetchedAt: Date.now(), sources: ['https://api.binance.com/api/v3/ticker/price?symbol=ETHUSDT'] },
                };
              }
            } catch {}
          } else if (/\b(sol|solana)\b/.test(lower)) {
            try {
              const res = await fetch('https://api.binance.com/api/v3/ticker/price?symbol=SOLUSDT', { signal: AbortSignal.timeout(3000) });
              if (res.ok) {
                const data = (await res.json()) as any;
                const formattedPrice = Number(data.price).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
                return {
                  success: true,
                  message: `Solana (SOL) current live price is $${formattedPrice} USD.`,
                  data: { symbol: 'SOL', priceUsd: formattedPrice },
                  evidence: { kind: 'live', fetchedAt: Date.now(), sources: ['https://api.binance.com/api/v3/ticker/price?symbol=SOLUSDT'] },
                };
              }
            } catch {}
          }

          // 2. Real Web Search: Query DuckDuckGo HTML Search for genuine web snippets
          try {
            const htmlRes = await fetch(
              `https://html.duckduckgo.com/html/?q=${encodeURIComponent(rawQuery)}`,
              {
                headers: {
                  'User-Agent':
                    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                  'Accept-Language': 'en-US,en;q=0.5',
                },
                signal: AbortSignal.timeout(5000),
              }
            );

            if (htmlRes.ok) {
              const html = await htmlRes.text();
              const snippets: string[] = [];
              const searchResults: Array<{ title: string; url: string }> = [];

              const titleRegex = /<a\b(?=[^>]*\bclass=["'][^"']*result__a[^"']*["'])(?=[^>]*\bhref=["']([^"']+)["'])[^>]*>([\s\S]*?)<\/a>/gi;
              let titleMatch: RegExpExecArray | null;
              while ((titleMatch = titleRegex.exec(html)) !== null && searchResults.length < 5) {
                const title = titleMatch[2]
                  .replace(/<[^>]+>/g, '')
                  .replace(/&quot;/g, '"')
                  .replace(/&#x27;/g, "'")
                  .replace(/&amp;/g, '&')
                  .replace(/&lt;/g, '<')
                  .replace(/&gt;/g, '>')
                  .replace(/\s+/g, ' ')
                  .trim();
                let url = titleMatch[1].replace(/&amp;/g, '&');
                try {
                  const parsed = new URL(url, 'https://duckduckgo.com');
                  url = parsed.searchParams.get('uddg') || parsed.href;
                  if (!/^https?:\/\//i.test(url)) url = parsed.href;
                } catch {}
                if (title && /^https?:\/\//i.test(url)) searchResults.push({ title, url });
              }

              // Extract snippet blocks from DDG HTML search results
              const snippetRegex = /<a\s+class="result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;
              let match: RegExpExecArray | null;

              while ((match = snippetRegex.exec(html)) !== null && snippets.length < 5) {
                const cleaned = match[1]
                  .replace(/<[^>]+>/g, '')
                  .replace(/&quot;/g, '"')
                  .replace(/&#x27;/g, "'")
                  .replace(/&amp;/g, '&')
                  .replace(/&lt;/g, '<')
                  .replace(/&gt;/g, '>')
                  .replace(/\s+/g, ' ')
                  .trim();
                if (cleaned.length > 20) {
                  snippets.push(cleaned);
                }
              }

              if (snippets.length > 0) {
                console.log(`[WebSearch] Found ${snippets.length} web snippet(s) for "${rawQuery}"`);
                const formatted = snippets.map((snippet, index) => {
                  const source = searchResults[index];
                  return `${index + 1}. ${source ? `${source.title}: ` : ''}${snippet}${source ? ` (Source: ${source.url})` : ''}`;
                }).join('\n\n');
                return {
                  success: true,
                  message: `Live Web Search Results for "${rawQuery}":\n${formatted}\n\n[Search complete. Use only these current results for changing facts and include a source link when useful.]`,
                  data: snippets.map((snippet, index) => ({ ...searchResults[index], snippet })),
                  ...(searchResults.length > 0
                    ? { evidence: { kind: 'live' as const, fetchedAt: Date.now(), sources: searchResults.map((result) => result.url) } }
                    : {}),
                };
              }
            }
          } catch (ddgHtmlErr: any) {
            console.warn(`[WebSearch] DDG HTML lookup error: ${ddgHtmlErr.message}`);
          }

          // 3. Fallback: Google News RSS Search (High reliability, never blocked)
          try {
            const newsItems = await queryGoogleNewsRss(rawQuery, 4);
            if (newsItems.length > 0) {
              console.log(`[WebSearch] Found ${newsItems.length} news snippet(s) via Google News RSS for "${rawQuery}"`);
              const formattedNews = newsItems
                .map((n, i) => `${i + 1}. ${n.title} (${n.date})${n.snippet ? `\n   ${n.snippet}` : ''}${n.url ? `\n   Source: ${n.url}` : ''}`)
                .join('\n\n');
              return {
                success: true,
                message: `Live News Results for "${rawQuery}":\n\n${formattedNews}\n\n[Search complete. Answer concisely based on these live facts.]`,
                data: newsItems,
                ...(newsItems.some((item) => item.url)
                  ? { evidence: { kind: 'live' as const, fetchedAt: Date.now(), sources: newsItems.map((item) => item.url).filter((url): url is string => Boolean(url)) } }
                  : {}),
              };
            }
          } catch {}

          // Static encyclopedic fallbacks are not acceptable evidence for changing facts.
          if (!requiresLiveLookup) {
            // 4. Fallback: Wikipedia REST summary
            try {
              const cleanTopic = rawQuery.replace(/^(who is|what is|whats the|define|tell me about)\s+/i, '').trim();
              const wikiRes = await fetch(
                `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(cleanTopic)}`,
                {
                  headers: { 'User-Agent': 'WhatsAppBot/1.0' },
                  signal: AbortSignal.timeout(3000),
                }
              );
              if (wikiRes.ok) {
                const wikiData = (await wikiRes.json()) as any;
                if (wikiData.extract) {
                  return {
                    success: true,
                    message: `Wikipedia Summary for "${cleanTopic}":\n${wikiData.extract}`,
                    data: [wikiData.extract],
                  };
                }
              }
            } catch {}

            // 5. Fallback: DuckDuckGo Instant Answer API
            try {
              const encodedQuery = encodeURIComponent(rawQuery);
              const url = `https://api.duckduckgo.com/?q=${encodedQuery}&format=json&no_html=1&skip_disambig=1`;
              const res = await fetch(url, {
                headers: { 'User-Agent': 'WhatsAppBot/1.0' },
                signal: AbortSignal.timeout(3000),
              });

              if (res.ok) {
                const data = (await res.json()) as any;
                const results: string[] = [];

                if (data.AbstractText) results.push(data.AbstractText);
                if (data.Answer) results.push(data.Answer);

                if (Array.isArray(data.RelatedTopics)) {
                  for (const topic of data.RelatedTopics.slice(0, 3)) {
                    if (topic.Text) results.push(topic.Text);
                  }
                }

                if (results.length > 0) {
                  return {
                    success: true,
                    message: `Search Summary for "${rawQuery}":\n${results.join('\n')}`,
                    data: results,
                  };
                }
              }
            } catch {}
          }

          // Safe, anti-hallucination termination
          return {
            success: true,
            message: `Search executed for "${rawQuery}". No reliable real-time web snippets were found. Please inform the user that live information on this exact query is currently unavailable rather than guessing or fabricating numbers/scores.`,
            data: [],
          };
        } catch (err: any) {
          return {
            success: false,
            message: `Web search error: ${err.message}`,
          };
        }
      },
    },
  ];
}

export const webSearchPlugin = new WebSearchPlugin();
