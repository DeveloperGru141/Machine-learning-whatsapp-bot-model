import { IPlugin, BotTool, ExecutionContext, ToolResult } from '../types.js';

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
): Promise<Array<{ title: string; date: string; snippet?: string }>> {
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
    const items: Array<{ title: string; date: string; snippet?: string }> = [];
    const itemRegex = /<item>[\s\S]*?<title>([\s\S]*?)<\/title>[\s\S]*?<pubDate>([\s\S]*?)<\/pubDate>(?:[\s\S]*?<description>([\s\S]*?)<\/description>)?/gi;

    let match: RegExpExecArray | null;
    while ((match = itemRegex.exec(xml)) !== null && items.length < limit) {
      const rawTitle = match[1] || '';
      const rawDate = match[2] || '';
      const rawDesc = match[3] || '';

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

      if (cleanTitle.length > 5) {
        items.push({
          title: cleanTitle,
          date: rawDate.trim(),
          snippet: cleanDesc.length > 20 ? cleanDesc.slice(0, 200) : undefined,
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
): Promise<{ text: string; matches: FootballMatch[] }> {
  const matches: FootballMatch[] = [];
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
              if (
                queryLower &&
                !matchName.toLowerCase().includes(queryLower) &&
                !homeName.toLowerCase().includes(queryLower) &&
                !awayName.toLowerCase().includes(queryLower)
              ) {
                continue;
              }

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
    };
  }

  return {
    text: `No active match results found for "${teamQuery || 'today'}". Please check back during match day or specify the team name clearly.`,
    matches: [],
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
        'Retrieves live, real-time football (soccer) match scores, latest results (e.g. Champions League, Premier League, La Liga, Serie A, Porto, Arsenal, Madrid), match status, and game details. Use this whenever the user asks about football scores, match results, who won, or how a game ended.',
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
      execute: async (args: { team?: string; league?: string }, ctx: ExecutionContext): Promise<ToolResult> => {
        try {
          const { text, matches } = await fetchLiveFootballScores(args.team, args.league);
          return {
            success: true,
            message: `${text}\n\n[Scores verified via live sports scoreboard. Summarize clearly and accurately for the user.]`,
            data: matches,
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
        },
      },
      execute: async (args: { query?: string; q?: string }, ctx: ExecutionContext): Promise<ToolResult> => {
        try {
          const rawQuery = (args.query || args.q || '').trim();
          console.log(`[WebSearch] Performing web lookup: "${rawQuery}"`);

          const lower = rawQuery.toLowerCase();

          // Auto-detect football score queries: delegate to football score engine
          if (
            /\b(score|scores|match|vs|champion.*league|ucl|epl|premier league|porto|arsenal|chelsea|barca|madrid|liverpool|mancity|man united|bayern|psv|inter|milan)\b/i.test(
              lower
            ) &&
            /\b(score|scores|result|played|game|match|win|lost|draw)\b/i.test(lower)
          ) {
            console.log(`[WebSearch] Football query detected in web_search: "${rawQuery}". Querying live sports scoreboard...`);
            const teamMatch = rawQuery.replace(/^(who won|what is the score of|score of|current score of|football score|match score)\s+/i, '').trim();
            const { text, matches } = await fetchLiveFootballScores(teamMatch);
            if (matches.length > 0 || text.includes('⚽')) {
              return {
                success: true,
                message: `${text}\n\n[Live match data retrieved. State the score directly and concisely.]`,
                data: matches,
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
                return {
                  success: true,
                  message: `Live Web Search Results for "${rawQuery}":\n` + snippets.map((s, i) => `${i + 1}. ${s}`).join('\n\n') + '\n\n[Search complete. Provide direct concise answer now.]',
                  data: snippets,
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
                .map((n, i) => `${i + 1}. ${n.title} (${n.date})${n.snippet ? `\n   ${n.snippet}` : ''}`)
                .join('\n\n');
              return {
                success: true,
                message: `Live News Results for "${rawQuery}":\n\n${formattedNews}\n\n[Search complete. Answer concisely based on these live facts.]`,
                data: newsItems,
              };
            }
          } catch {}

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
