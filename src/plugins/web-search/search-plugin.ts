import { IPlugin, BotTool, ExecutionContext, ToolResult } from '../types.js';

export class WebSearchPlugin implements IPlugin {
  name = 'WebSearch';
  version = '1.0.0';
  description = 'Performs live web searches to supply up-to-date real-time data, current news, facts, and information';

  tools: BotTool[] = [
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
        },
        required: ['query'],
      },
      execute: async (args: { query: string }, ctx: ExecutionContext): Promise<ToolResult> => {
        try {
          const rawQuery = (args.query || '').trim();
          console.log(`[WebSearch] Performing web lookup: "${rawQuery}"`);

          // 1. Ultra-fast real-time crypto price lookup (<200ms)
          const lower = rawQuery.toLowerCase();
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
                  message: `Live Web Search Results for "${rawQuery}":\n` + snippets.map((s, i) => `${i + 1}. ${s}`).join('\n\n'),
                  data: snippets,
                };
              }
            }
          } catch (ddgHtmlErr: any) {
            console.warn(`[WebSearch] DDG HTML lookup error: ${ddgHtmlErr.message}`);
          }

          // 3. Fallback: Wikipedia REST summary
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

          // 4. Fallback: DuckDuckGo Instant Answer API
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

          return {
            success: true,
            message: `Search executed for "${rawQuery}". No direct web snippets found. State the answer using your general knowledge directly.`,
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
