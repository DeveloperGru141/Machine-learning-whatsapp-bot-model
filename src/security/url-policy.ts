import { lookup } from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';
import { Readable } from 'node:stream';

function isBlockedIp(address: string): boolean {
  const version = isIP(address);
  if (version === 4) {
    const parts = address.split('.').map(Number);
    if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
    const [a, b] = parts;
    return a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 0 || b === 168 || (b === 88 && parts[2] === 99))) ||
      (a === 198 && (b === 18 || b === 19 || b === 51)) ||
      (a === 203 && b === 0);
  }
  if (version === 6) {
    const normalized = address.toLowerCase();
    if (normalized.startsWith('::ffff:')) {
      const mapped = normalized.slice('::ffff:'.length);
      return isIP(mapped) === 4 ? isBlockedIp(mapped) : true;
    }
    const firstHextet = Number.parseInt(normalized.split(':', 1)[0], 16);
    const secondHextet = Number.parseInt(normalized.split(':')[1] || '0', 16);
    const isGlobalUnicast = firstHextet >= 0x2000 && firstHextet <= 0x3fff;
    const isIetfSpecialPurpose = firstHextet === 0x2001 && secondHextet <= 0x01ff;
    const isDocumentation = (firstHextet === 0x2001 && secondHextet === 0x0db8) ||
      (firstHextet === 0x3fff && secondHextet <= 0x0fff);
    const is6to4 = firstHextet === 0x2002;
    return !isGlobalUnicast || isIetfSpecialPurpose || isDocumentation || is6to4;
  }
  return true;
}

/** Reject non-HTTP(S), credential-bearing, local, private, and reserved URL targets. */
export async function assertPublicHttpUrl(input: string | URL): Promise<URL> {
  let url: URL;
  try {
    url = input instanceof URL ? new URL(input.href) : new URL(input);
  } catch {
    throw new Error('Invalid URL.');
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('Only HTTP and HTTPS URLs are supported.');
  if (url.username || url.password) throw new Error('URLs containing credentials are not allowed.');

  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!hostname || hostname === 'localhost' || hostname.endsWith('.localhost') ||
      hostname.endsWith('.local') || hostname.endsWith('.internal') || hostname.endsWith('.test')) {
    throw new Error('Local and private network URLs are not allowed.');
  }

  await resolvePublicAddress(hostname);
  return url;
}

async function resolvePublicAddress(hostname: string): Promise<string> {
  if (isIP(hostname)) {
    if (isBlockedIp(hostname)) throw new Error('Local and private network URLs are not allowed.');
    return hostname;
  }

  let addresses: Array<{ address: string }>;
  try {
    addresses = await lookup(hostname, { all: true, verbatim: true });
  } catch {
    throw new Error('The URL host could not be resolved.');
  }
  if (addresses.length === 0 || addresses.some(({ address }) => isBlockedIp(address))) {
    throw new Error('The URL host resolves to a local or private network.');
  }
  return addresses[0].address;
}

/** Connect to the already checked address so DNS cannot change between validation and request. */
function requestPinnedPublicUrl(url: URL, address: string, init: RequestInit): Promise<Response> {
  const method = (init.method || 'GET').toUpperCase();
  if (method !== 'GET' && method !== 'HEAD') {
    throw new Error('Public URL downloads only support GET or HEAD requests.');
  }
  if (init.body != null) throw new Error('Public URL downloads do not accept a request body.');

  const headers: Record<string, string> = {};
  new Headers(init.headers).forEach((value, name) => { headers[name] = value; });
  const pinnedLookup = (_hostname: string, options: any, callback: (...args: any[]) => void) => {
    const family = isIP(address);
    if (options?.all) callback(null, [{ address, family }]);
    else callback(null, address, family);
  };
  const transport = url.protocol === 'https:' ? https : http;

  return new Promise((resolve, reject) => {
    const request = transport.request(url, {
      method,
      headers,
      signal: init.signal || AbortSignal.timeout(30_000),
      lookup: pinnedLookup as any,
      agent: false,
      ...(url.protocol === 'https:' && !isIP(url.hostname.replace(/^\[|\]$/g, ''))
        ? { servername: url.hostname }
        : {}),
    }, (incoming) => {
      const responseHeaders = new Headers();
      for (const [name, value] of Object.entries(incoming.headers)) {
        if (Array.isArray(value)) value.forEach((item) => responseHeaders.append(name, item));
        else if (value !== undefined) responseHeaders.set(name, value);
      }
      const body = method === 'HEAD' || incoming.statusCode === 204 || incoming.statusCode === 304
        ? null
        : Readable.toWeb(incoming) as ReadableStream<Uint8Array>;
      const response = new Response(body, {
        status: incoming.statusCode || 502,
        statusText: incoming.statusMessage || '',
        headers: responseHeaders,
      });
      Object.defineProperty(response, 'url', { value: url.href });
      resolve(response);
    });
    request.once('error', reject);
    request.end();
  });
}

/** Fetch a public URL while validating each redirect target before following it. */
export async function fetchPublicHttpUrl(
  input: string | URL,
  init: RequestInit = {},
  maxRedirects: number = 5
): Promise<Response> {
  let url = await assertPublicHttpUrl(input);
  for (let redirectCount = 0; redirectCount <= maxRedirects; redirectCount++) {
    const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    const address = await resolvePublicAddress(hostname);
    const response = await requestPinnedPublicUrl(url, address, init);
    const location = response.headers.get('location');
    if (response.status < 300 || response.status >= 400 || !location) return response;
    await response.body?.cancel().catch(() => {});
    if (redirectCount === maxRedirects) throw new Error('The URL exceeded the redirect limit.');
    url = await assertPublicHttpUrl(new URL(location, url));
  }
  throw new Error('The URL exceeded the redirect limit.');
}

/** Read a response body with a hard upper bound to avoid memory exhaustion. */
export async function readLimitedResponse(response: Response, maxBytes: number): Promise<Buffer> {
  const contentLength = Number(response.headers.get('content-length') || 0);
  if (contentLength > maxBytes) {
    await response.body?.cancel().catch(() => {});
    throw new Error(`The downloaded file exceeds the ${maxBytes}-byte limit.`);
  }
  if (!response.body) return Buffer.alloc(0);

  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel();
        throw new Error(`The downloaded file exceeds the ${maxBytes}-byte limit.`);
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, totalBytes);
}
