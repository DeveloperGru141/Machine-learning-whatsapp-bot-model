import { IPlugin, BotTool, ExecutionContext, ToolResult } from '../types.js';

/**
 * Decodes standard named and numeric HTML entities into plain text
 */
function decodeHtmlEntities(str: string): string {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&mdash;/g, '—')
    .replace(/&ndash;/g, '–')
    .replace(/&hellip;/g, '…')
    .replace(/&copy;/g, '©')
    .replace(/&reg;/g, '®')
    .replace(/&#(\d+);/g, (_, dec) => {
      try {
        return String.fromCharCode(parseInt(dec, 10));
      } catch {
        return '';
      }
    })
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => {
      try {
        return String.fromCharCode(parseInt(hex, 16));
      } catch {
        return '';
      }
    });
}

/**
 * Cleans raw HTML text: extracts title, strips scripts, styles, tags, and collapses whitespace
 */
function cleanHtmlContent(html: string): { title: string; text: string } {
  // Extract webpage title if present
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? decodeHtmlEntities(titleMatch[1].trim()) : '';

  // Remove non-content elements: scripts, styles, noscript, svg, iframes, HTML comments
  let text = html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, ' ')
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, ' ')
    .replace(/<noscript\b[^<]*(?:(?!<\/noscript>)<[^<]*)*<\/noscript>/gi, ' ')
    .replace(/<svg\b[^<]*(?:(?!<\/svg>)<[^<]*)*<\/svg>/gi, ' ')
    .replace(/<iframe\b[^<]*(?:(?!<\/iframe>)<[^<]*)*<\/iframe>/gi, ' ');

  // Convert block-level elements and line breaks to newlines
  text = text.replace(/<\/(p|div|h[1-6]|li|tr|article|section|header|footer|blockquote)>/gi, '\n');
  text = text.replace(/<(br|hr)\s*\/?>/gi, '\n');

  // Strip all remaining HTML tags
  text = text.replace(/<[^>]+>/g, ' ');

  // Decode HTML entities
  text = decodeHtmlEntities(text);

  // Normalize whitespace: collapse spaces on lines, limit consecutive newlines to 2
  text = text
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .filter((line) => line.length > 0)
    .join('\n\n');

  return { title, text };
}

export class LinkSummarizerPlugin implements IPlugin {
  name = 'LinkSummarizer';
  version = '1.0.0';
  description = 'Fetches and extracts clean text content from web URLs and articles for analysis and summarization';

  tools: BotTool[] = [
    {
      name: 'summarize_link',
      description:
        'Fetches the webpage or article at the specified URL, extracts clean readable content, and returns it for the bot to summarize.',
      parameters: {
        type: 'object',
        properties: {
          url: {
            type: 'string',
            description: 'The web URL (http or https) to fetch, extract, and summarize.',
          },
        },
        required: ['url'],
      },
      execute: async (args: { url: string }, ctx: ExecutionContext): Promise<ToolResult> => {
        try {
          if (!args.url || typeof args.url !== 'string') {
            return {
              success: false,
              message: 'A valid URL must be provided.',
            };
          }

          let targetUrl = args.url.trim();

          // Prepend protocol if missing
          if (!targetUrl.startsWith('http://') && !targetUrl.startsWith('https://')) {
            targetUrl = `https://${targetUrl}`;
          }

          // Validate URL format
          let parsedUrl: URL;
          try {
            parsedUrl = new URL(targetUrl);
          } catch {
            return {
              success: false,
              message: `Invalid URL format: "${args.url}". Please provide a full valid web link.`,
            };
          }

          if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
            return {
              success: false,
              message: `Unsupported protocol "${parsedUrl.protocol}". Only HTTP and HTTPS links are supported.`,
            };
          }

          console.log(`[LinkSummarizer] Fetching content from: ${targetUrl}`);

          // Fetch using Node.js built-in fetch API with browser-like headers and 15s timeout
          const response = await fetch(targetUrl, {
            headers: {
              'User-Agent':
                'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
              'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
              'Accept-Language': 'en-US,en;q=0.9',
            },
            signal: AbortSignal.timeout(15000),
            redirect: 'follow',
          });

          if (!response.ok) {
            return {
              success: false,
              message: `Failed to fetch webpage from ${targetUrl}: HTTP ${response.status} ${response.statusText}`,
            };
          }

          const rawHtml = await response.text();
          if (!rawHtml || rawHtml.trim().length === 0) {
            return {
              success: false,
              message: `The webpage at ${targetUrl} returned an empty response.`,
            };
          }

          // Clean HTML and extract text
          const { title, text } = cleanHtmlContent(rawHtml);

          if (!text.trim()) {
            return {
              success: false,
              message: `Could not extract readable text from ${targetUrl}. The webpage might be protected or require client-side JavaScript rendering.`,
            };
          }

          // Extract first 4000 characters of clean text
          const MAX_CHARS = 4000;
          const isTruncated = text.length > MAX_CHARS;
          const cleanText = isTruncated ? text.slice(0, MAX_CHARS) : text;

          console.log(
            `[LinkSummarizer] Successfully extracted ${cleanText.length} characters (truncated: ${isTruncated}) from ${targetUrl}`
          );

          const summaryTitle = title ? `"${title}"` : targetUrl;
          return {
            success: true,
            message: `Web article ${summaryTitle} fetched successfully. Extracted ${cleanText.length} characters of clean text.${
              isTruncated ? ' (Truncated to first 4000 characters to fit context)' : ''
            }`,
            data: cleanText,
          };
        } catch (err: any) {
          console.error('[LinkSummarizer] Error fetching link:', err);
          return {
            success: false,
            message: `Failed to summarize link: ${err.message}`,
          };
        }
      },
    },
  ];
}

export const linkSummarizerPlugin = new LinkSummarizerPlugin();
