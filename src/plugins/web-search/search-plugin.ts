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
          console.log(`[WebSearch] Performing web lookup: "${args.query}"`);
          const encodedQuery = encodeURIComponent(args.query.trim());

          // Query DuckDuckGo Instant Answer API (fast, reliable, zero key required)
          const url = `https://api.duckduckgo.com/?q=${encodedQuery}&format=json&no_html=1&skip_disambig=1`;
          const res = await fetch(url, {
            headers: {
              'User-Agent': 'WhatsAppBot/1.0',
            },
          });

          if (!res.ok) {
            return {
              success: false,
              message: `Search request failed with HTTP ${res.status}`,
            };
          }

          const data = (await res.json()) as any;
          const results: string[] = [];

          if (data.AbstractText) {
            results.push(`Summary: ${data.AbstractText}`);
          }
          if (data.Answer) {
            results.push(`Direct Answer: ${data.Answer}`);
          }

          if (Array.isArray(data.RelatedTopics)) {
            for (const topic of data.RelatedTopics.slice(0, 5)) {
              if (topic.Text) {
                results.push(`- ${topic.Text} ${topic.FirstURL ? `(${topic.FirstURL})` : ''}`);
              }
            }
          }

          // Fallback if no instant answer returned
          if (results.length === 0) {
            return {
              success: true,
              message: `Web search for "${args.query}" executed. No direct summary found, please refine the query or ask for specific details.`,
              data: [],
            };
          }

          return {
            success: true,
            message: `Web Search Results for "${args.query}":\n${results.join('\n')}`,
            data: results,
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
