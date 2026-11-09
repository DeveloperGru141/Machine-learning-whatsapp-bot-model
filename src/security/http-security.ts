import type { IncomingMessage, ServerResponse } from 'http';
import crypto from 'crypto';
import { isIP } from 'node:net';

export interface AuthCheckResult {
  isAuthenticated: boolean;
  reason?: string;
}

export class HttpSecurityManager {
  private failedAttempts = new Map<string, { count: number; blockedUntil: number; lastAttemptAt: number }>();
  private requestCounts = new Map<string, { count: number; windowStart: number }>();
  private requestsSincePrune = 0;
  private readonly maxTrackedKeys = 10_000;

  /**
   * Resolves an explicitly configured admin secret. No predictable fallback is used:
   * admin endpoints fail closed if the deployment has no secret configured.
   */
  public getAdminKey(): string | null {
    const configuredKey = process.env.ADMIN_API_KEY?.trim() || process.env.SESSION_BACKUP_KEY?.trim() || '';
    return configuredKey.length >= 32 ? configuredKey : null;
  }

  /**
   * Applies standard HTTP security headers to all responses
   */
  public applySecurityHeaders(res: ServerResponse): void {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-XSS-Protection', '1; mode=block');
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    res.setHeader('Referrer-Policy', 'no-referrer');
  }

  /**
   * Rate limits incoming HTTP requests per IP to prevent DoS and brute-force scans.
   */
  public checkRateLimit(req: IncomingMessage, maxPerMinute: number = 100, bucket = 'global'): boolean {
    const ip = this.getClientIp(req);
    const now = Date.now();
    const key = `${bucket}:${ip}`;

    this.pruneMaps(now);

    // Check if IP is currently blocked due to repeated auth failures
    const blockInfo = this.failedAttempts.get(ip);
    if (blockInfo && blockInfo.blockedUntil > now) {
      return false;
    }

    const current = this.requestCounts.get(key) || { count: 0, windowStart: now };
    if (now - current.windowStart > 60_000) {
      current.count = 1;
      current.windowStart = now;
    } else {
      current.count++;
    }
    if (!this.requestCounts.has(key)) this.keepMapBounded(this.requestCounts);
    this.requestCounts.set(key, current);

    return current.count <= maxPerMinute;
  }

  /**
   * Records a failed authentication attempt and blocks IP if threshold exceeded.
   * Exempts local loopback and internal cloud cluster/proxy IP ranges (10.x, 172.16-31.x, 192.168.x).
   */
  public recordAuthFailure(req: IncomingMessage): void {
    const ip = this.getClientIp(req);
    // Never block local loopback, internal cluster IPs, or Render proxy routers
    if (
      ip === '127.0.0.1' ||
      ip === '::1' ||
      ip.startsWith('10.') ||
      ip.startsWith('192.168.') ||
      /^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(ip)
    ) {
      return;
    }

    const now = Date.now();
    const previous = this.failedAttempts.get(ip);
    const current = !previous || now - previous.lastAttemptAt > 10 * 60_000 ||
      (previous.blockedUntil > 0 && previous.blockedUntil <= now)
      ? { count: 0, blockedUntil: 0, lastAttemptAt: now }
      : previous;
    current.count++;
    current.lastAttemptAt = now;

    // If 5 failed attempts in short succession, block IP for 5 minutes
    if (current.count >= 5) {
      current.blockedUntil = now + 5 * 60 * 1000;
      console.warn(`[HttpSecurity] 🚨 IP ${ip} blocked for 5 minutes due to multiple unauthorized access attempts.`);
    }

    if (!this.failedAttempts.has(ip)) this.keepMapBounded(this.failedAttempts);
    this.failedAttempts.set(ip, current);
  }

  /**
   * Verifies if the request contains valid admin credentials via Bearer token,
   * x-admin-key header, or HTTP Basic password. Credentials in URL parameters are
   * intentionally rejected because URLs are commonly retained in logs/history.
   * @param recordFailure Whether to count missing/invalid credentials toward IP blocking (default true).
   *                      Set to false for public probes (like /health) to prevent blocking uptime pingers.
   */
  public verifyAdminAuth(req: IncomingMessage, recordFailure: boolean = true): AuthCheckResult {
    const adminKey = this.getAdminKey();
    if (!adminKey) {
      return { isAuthenticated: false, reason: 'No strong admin key configured on server' };
    }

    // 1. Check Authorization header: Bearer <key>
    const authHeader = req.headers['authorization'];
    if (authHeader && authHeader.startsWith('Bearer ')) {
      const token = authHeader.slice(7).trim();
      if (this.timingSafeEqual(token, adminKey)) {
        return { isAuthenticated: true };
      }
    }

    // 2. Check custom x-admin-key header
    const customHeader = req.headers['x-admin-key'];
    if (typeof customHeader === 'string' && this.timingSafeEqual(customHeader.trim(), adminKey)) {
      return { isAuthenticated: true };
    }

    // Basic auth lets the browser pair page authenticate without putting the
    // admin secret in its URL. The username is ignored; the password is the key.
    if (authHeader?.startsWith('Basic ')) {
      try {
        const decoded = Buffer.from(authHeader.slice(6).trim(), 'base64').toString('utf8');
        const separator = decoded.indexOf(':');
        if (separator >= 0 && this.timingSafeEqual(decoded.slice(separator + 1), adminKey)) {
          return { isAuthenticated: true };
        }
      } catch {}
    }

    if (recordFailure) {
      this.recordAuthFailure(req);
    }
    return { isAuthenticated: false, reason: 'Invalid or missing authentication credentials' };
  }

  /**
   * Constant-time string equality comparison to prevent timing attacks
   */
  private timingSafeEqual(a: string, b: string): boolean {
    const bufA = Buffer.from(a);
    const bufB = Buffer.from(b);
    if (bufA.length !== bufB.length) return false;
    return crypto.timingSafeEqual(bufA, bufB);
  }

  /**
   * Resolves remote IP address safely from headers or socket
   */
  private getClientIp(req: IncomingMessage): string {
    const cloudflareIp = req.headers['cf-connecting-ip'];
    if (process.env.RENDER_EXTERNAL_URL && typeof cloudflareIp === 'string' && isIP(cloudflareIp.trim())) {
      // Render's Cloudflare edge overwrites this header, unlike X-Forwarded-For,
      // which can contain caller-supplied values.
      return cloudflareIp.trim();
    }
    return req.socket.remoteAddress || '127.0.0.1';
  }

  private pruneMaps(now: number): void {
    this.requestsSincePrune++;
    if (this.requestsSincePrune < 256 && this.requestCounts.size < this.maxTrackedKeys) return;
    this.requestsSincePrune = 0;
    for (const [key, value] of this.requestCounts) {
      if (now - value.windowStart > 60_000) this.requestCounts.delete(key);
    }
    for (const [key, value] of this.failedAttempts) {
      if (value.blockedUntil <= now && now - value.lastAttemptAt > 10 * 60_000) this.failedAttempts.delete(key);
    }
  }

  private keepMapBounded<T>(map: Map<string, T>): void {
    if (map.size < this.maxTrackedKeys) return;
    const oldestKey = map.keys().next().value;
    if (oldestKey !== undefined) map.delete(oldestKey);
  }
}

export const httpSecurityManager = new HttpSecurityManager();
