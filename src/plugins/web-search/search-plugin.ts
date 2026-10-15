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

          // 2. Query DuckDuckGo Instant Answer API with 4s timeout
          const encodedQuery = encodeURIComponent(rawQuery);
          const url = `https://api.duckduckgo.com/?q=${encodedQuery}&format=json&no_html=1&skip_disambig=1`;
          const res = await fetch(url, {
            headers: { 'User-Agent': 'WhatsAppBot/1.0' },
            signal: AbortSignal.timeout(4000),
          });

          if (res.ok) {
            const data = (await res.json()) as any;
            const results: string[] = [];

            if (data.AbstractText) {
              results.push(`Summary: ${data.AbstractText}`);
            }
            if (data.Answer) {
              results.push(`Direct Answer: ${data.Answer}`);
            }

            if (Array.isArray(data.RelatedTopics)) {
              for (const topic of data.RelatedTopics.slice(0, 3)) {
                if (topic.Text) {
                  results.push(`- ${topic.Text}`);
                }
              }
            }

            if (results.length > 0) {
              return {
                success: true,
                message: `Web Search Results for "${rawQuery}":\n${results.join('\n')}`,
                data: results,
              };
            }
          }

          // 3. Fallback: Wikipedia summary
          try {
            const cleanTopic = rawQuery.replace(/^(who is|what is|whats the|define)\s+/i, '').trim();
            const wikiRes = await fetch(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(cleanTopic)}`, {
              signal: AbortSignal.timeout(3000),
            });
            if (wikiRes.ok) {
              const wikiData = (await wikiRes.json()) as any;
              if (wikiData.extract) {
                return {
                  success: true,
                  message: `Summary for "${cleanTopic}": ${wikiData.extract}`,
                  data: [wikiData.extract],
                };
              }
            }
          } catch {}

          return {
            success: true,
            message: `Search executed for "${rawQuery}". No direct summary was returned. State what you know clearly and directly.`,
            data: [],
          };
        } catch (err: any) {
          return {
            success: false,
            message: `Web search temporary error: ${err.message}`,
          };
        }
      },
    },
  ];
}

export const webSearchPlugin = new WebSearchPlugin();
