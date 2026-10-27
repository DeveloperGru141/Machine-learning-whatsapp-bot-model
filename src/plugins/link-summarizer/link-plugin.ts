import { IPlugin, BotTool, ExecutionContext, ToolResult } from '../types.js';

export interface UrlSafetyVerdict {
  url: string;
  resolvedUrl: string;
  isSuspicious: boolean;
  verdict: 'safe' | 'phishing' | 'ponzi' | 'scam' | 'suspicious';
  reason: string;
  pageTitle?: string;
  recommendedAction: 'delete_and_warn' | 'warn_regular_pidgin' | 'pass';
}

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
export function cleanHtmlContent(html: string): { title: string; text: string } {
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? decodeHtmlEntities(titleMatch[1].trim()) : '';

  let text = html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, ' ')
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, ' ')
    .replace(/<noscript\b[^<]*(?:(?!<\/noscript>)<[^<]*)*<\/noscript>/gi, ' ')
    .replace(/<svg\b[^<]*(?:(?!<\/svg>)<[^<]*)*<\/svg>/gi, ' ')
    .replace(/<iframe\b[^<]*(?:(?!<\/iframe>)<[^<]*)*<\/iframe>/gi, ' ');

  text = text.replace(/<\/(p|div|h[1-6]|li|tr|article|section|header|footer|blockquote)>/gi, '\n');
  text = text.replace(/<(br|hr)\s*\/?>/gi, '\n');
  text = text.replace(/<[^>]+>/g, ' ');
  text = decodeHtmlEntities(text);

  text = text
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .filter((line) => line.length > 0)
    .join('\n\n');

  return { title, text };
}

/**
 * High-speed URL safety and fraud inspector
 */
export async function inspectUrlSafety(targetUrl: string): Promise<UrlSafetyVerdict> {
  let url = (targetUrl || '').trim();
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    url = `https://${url}`;
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return {
      url: targetUrl,
      resolvedUrl: targetUrl,
      isSuspicious: false,
      verdict: 'safe',
      reason: 'Invalid URL format',
      recommendedAction: 'pass',
    };
  }

  const hostname = parsed.hostname.toLowerCase();
  const pathname = parsed.pathname.toLowerCase();
  const fullHref = parsed.href.toLowerCase();

  // 1. Whitelist of top trusted domains
  const trustedDomains = [
    'google.com',
    'www.google.com',
    'youtube.com',
    'www.youtube.com',
    'youtu.be',
    'wikipedia.org',
    'en.wikipedia.org',
    'github.com',
    'instagram.com',
    'facebook.com',
    'twitter.com',
    'x.com',
    'linkedin.com',
    'whatsapp.com',
    'wa.me',
    'spotify.com',
    'apple.com',
    'microsoft.com',
    'bbc.com',
    'cnn.com',
    'espn.com',
    'punchng.com',
    'vanguardngr.com',
  ];

  const isTrusted = trustedDomains.some((d) => hostname === d || hostname.endsWith(`.${d}`));
  // If trusted and doesn't contain obvious scam query parameters, pass immediately
  if (isTrusted && !/free-airtime|bvn|palliative|grant|airdrop/i.test(fullHref)) {
    return {
      url,
      resolvedUrl: url,
      isSuspicious: false,
      verdict: 'safe',
      reason: 'Domain is a verified trusted platform',
      recommendedAction: 'pass',
    };
  }

  // 2. High-risk domain and URL pattern heuristics
  const phishingPatterns = [
    /opay.*(?:claim|bonus|promo|login|update)/i,
    /palmpay.*(?:claim|bonus|promo|login|update)/i,
    /kuda.*(?:claim|bonus|promo|login|update)/i,
    /bvn.*(?:update|link|portal|verify)/i,
    /cbn.*(?:grant|loan|palliative|disbursement)/i,
    /tinubu.*(?:grant|palliative|fund|cash)/i,
    /fg.*(?:grant|palliative|empowerment|cash-transfer)/i,
    /bank.*(?:verify|update|unblock|token)/i,
    /seed-?phrase/i,
    /claim-?(?:bonus|reward|airdrop|eth|sol|btc)/i,
    /double-?(?:income|investment|profit|naira|capital)/i,
    /free-?(?:50gb|data|airtime|recharge|iphone)/i,
    /spin-?(?:wheel|win|cash)/i,
  ];

  for (const pat of phishingPatterns) {
    if (pat.test(hostname) || pat.test(pathname)) {
      return {
        url,
        resolvedUrl: url,
        isSuspicious: true,
        verdict: 'phishing',
        reason: 'Matches known Nigerian banking/palliative phishing pattern targeting unsuspecting users',
        recommendedAction: 'delete_and_warn',
      };
    }
  }

  // 3. Suspicious generic TLD combinations
  const suspiciousTlds = ['.xyz', '.top', '.tk', '.ml', '.ga', '.cf', '.click', '.buzz', '.work', '.icu', '.vip', '.rest'];
  const hasSuspiciousTld = suspiciousTlds.some((tld) => hostname.endsWith(tld));
  const hasPromoWord = /grant|free|cash|bonus|airtime|portal|claim|reward|invest|money/i.test(fullHref);

  if (hasSuspiciousTld && hasPromoWord) {
    return {
      url,
      resolvedUrl: url,
      isSuspicious: true,
      verdict: 'scam',
      reason: `Suspicious high-risk domain extension (${hostname}) offering monetary rewards or grants`,
      recommendedAction: 'delete_and_warn',
    };
  }

  // 4. Web scraping inspection: Follow redirects and inspect page text
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
      signal: AbortSignal.timeout(8000),
      redirect: 'follow',
    });

    const finalUrl = res.url || url;
    const finalParsed = new URL(finalUrl);
    const finalHost = finalParsed.hostname.toLowerCase();

    // Check if redirect leads to known scam
    for (const pat of phishingPatterns) {
      if (pat.test(finalHost) || pat.test(finalParsed.pathname.toLowerCase())) {
        return {
          url,
          resolvedUrl: finalUrl,
          isSuspicious: true,
          verdict: 'phishing',
          reason: 'Link redirects to a deceptive phishing or grant portal',
          recommendedAction: 'delete_and_warn',
        };
      }
    }

    if (res.ok) {
      const html = await res.text();
      const { title, text } = cleanHtmlContent(html.slice(0, 30000));
      const pageTextLower = `${title} ${text}`.toLowerCase();

      // Scan for crypto wallet phishing
      if (
        (pageTextLower.includes('seed phrase') || pageTextLower.includes('private key') || pageTextLower.includes('recovery phrase')) &&
        (pageTextLower.includes('enter') || pageTextLower.includes('import') || pageTextLower.includes('connect'))
      ) {
        return {
          url,
          resolvedUrl: finalUrl,
          isSuspicious: true,
          verdict: 'phishing',
          reason: 'Webpage prompts users to expose their 12/24-word secret recovery seed phrases',
          pageTitle: title,
          recommendedAction: 'delete_and_warn',
        };
      }

      // Scan for Banking credential theft
      if (
        (pageTextLower.includes('enter your bvn') || pageTextLower.includes('atm pin') || pageTextLower.includes('card details to claim')) &&
        (pageTextLower.includes('grant') || pageTextLower.includes('palliative') || pageTextLower.includes('bonus'))
      ) {
        return {
          url,
          resolvedUrl: finalUrl,
          isSuspicious: true,
          verdict: 'phishing',
          reason: 'Deceptive webpage soliciting BVN and financial pins under the guise of an official grant',
          pageTitle: title,
          recommendedAction: 'delete_and_warn',
        };
      }

      // Scan for Ponzi / Doubling investment scams
      if (
        (pageTextLower.includes('double your money') ||
          pageTextLower.includes('100% return in 24 hours') ||
          pageTextLower.includes('daily roi') ||
          pageTextLower.includes('passive investment plan')) &&
        (pageTextLower.includes('deposit') || pageTextLower.includes('register') || pageTextLower.includes('package'))
      ) {
        return {
          url,
          resolvedUrl: finalUrl,
          isSuspicious: true,
          verdict: 'ponzi',
          reason: 'Fraudulent high-yield doubling/Ponzi investment scheme with unrealistic guaranteed returns',
          pageTitle: title,
          recommendedAction: 'delete_and_warn',
        };
      }

      // Scan for WhatsApp viral share scam
      if (
        pageTextLower.includes('share to 5 groups') ||
        pageTextLower.includes('share to 10 friends') ||
        pageTextLower.includes('share on whatsapp to claim')
      ) {
        return {
          url,
          resolvedUrl: finalUrl,
          isSuspicious: true,
          verdict: 'scam',
          reason: 'Viral WhatsApp chain scam requiring users to spam groups to unlock non-existent prizes',
          pageTitle: title,
          recommendedAction: 'warn_regular_pidgin',
        };
      }

      return {
        url,
        resolvedUrl: finalUrl,
        isSuspicious: false,
        verdict: 'safe',
        reason: 'Inspected page content; no known phishing or scam indicators detected',
        pageTitle: title,
        recommendedAction: 'pass',
      };
    }
  } catch (inspectErr: any) {
    console.warn(`[LinkSummarizer] URL safety inspection warning for ${url}: ${inspectErr.message}`);
  }

  return {
    url,
    resolvedUrl: url,
    isSuspicious: false,
    verdict: 'safe',
    reason: 'URL inspection completed without high-risk indicators',
    recommendedAction: 'pass',
  };
}

export class LinkSummarizerPlugin implements IPlugin {
  name = 'LinkSummarizer';
  version = '2.0.0';
  description = 'Fetches and summarizes web articles and inspects URLs for security, fraud, phishing, and scam detection';

  tools: BotTool[] = [
    {
      name: 'inspect_suspicious_link',
      description:
        'Inspects any suspicious URL or web link for fraud, phishing, Ponzi schemes, fake grants, or security threats using live web scraping heuristics.',
      parameters: {
        type: 'object',
        properties: {
          url: {
            type: 'string',
            description: 'The URL to inspect for safety, legitimacy, and fraud.',
          },
        },
        required: ['url'],
      },
      execute: async (args: { url: string }, _ctx: ExecutionContext): Promise<ToolResult> => {
        try {
          const report = await inspectUrlSafety(args.url);
          const verdictEmoji = report.isSuspicious ? '🚨' : '✅';
          return {
            success: true,
            message: `${verdictEmoji} *URL Safety Report:*\n• *Target*: ${report.url}\n• *Verdict*: ${report.verdict.toUpperCase()}\n• *Suspicious*: ${report.isSuspicious ? 'YES' : 'NO'}\n• *Details*: ${report.reason}${report.pageTitle ? `\n• *Page Title*: "${report.pageTitle}"` : ''}`,
            data: report,
          };
        } catch (err: any) {
          return {
            success: false,
            message: `Inspection error: ${err.message}`,
          };
        }
      },
    },
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
      execute: async (args: { url: string }, _ctx: ExecutionContext): Promise<ToolResult> => {
        try {
          if (!args.url || typeof args.url !== 'string') {
            return {
              success: false,
              message: 'A valid URL must be provided.',
            };
          }

          let targetUrl = args.url.trim();

          if (!targetUrl.startsWith('http://') && !targetUrl.startsWith('https://')) {
            targetUrl = `https://${targetUrl}`;
          }

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

          const response = await fetch(targetUrl, {
            headers: {
              'User-Agent':
                'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
              Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
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

          const { title, text } = cleanHtmlContent(rawHtml);

          if (!text.trim()) {
            return {
              success: false,
              message: `Could not extract readable text from ${targetUrl}. The webpage might be protected or require client-side JavaScript rendering.`,
            };
          }

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
