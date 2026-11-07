import type { IncomingMessage, ServerResponse } from 'http';
import crypto from 'crypto';
import { config } from '../config/env.js';

export interface AuthCheckResult {
  isAuthenticated: boolean;
  reason?: string;
}

export class HttpSecurityManager {
  private failedAttempts = new Map<string, { count: number; blockedUntil: number }>();
  private requestCounts = new Map<string, { count: number; windowStart: number }>();

  /**
   * Resolves the configured ADMIN_API_KEY from environment, or derives a deterministic
   * secret from bot owner configuration.
   */
  public getAdminKey(): string {
    if (process.env.ADMIN_API_KEY && process.env.ADMIN_API_KEY.trim()) {
      return process.env.ADMIN_API_KEY.trim();
    }
    if (process.env.SESSION_BACKUP_KEY && process.env.SESSION_BACKUP_KEY.trim()) {
      return process.env.SESSION_BACKUP_KEY.trim();
    }

    // Deterministic fallback derived from bot owner phone and pairing phone
    const baseSecret = `forgelabs_${config.bot.owners.join('_')}_${config.bot.pairingPhoneNumber || '2347058967815'}`;
    return crypto.createHash('sha256').update(baseSecret).digest('hex').slice(0, 32);
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
  public checkRateLimit(req: IncomingMessage, maxPerMinute: number = 100): boolean {
    const ip = this.getClientIp(req);
    const now = Date.now();

    // Check if IP is currently blocked due to repeated auth failures
    const blockInfo = this.failedAttempts.get(ip);
    if (blockInfo && blockInfo.blockedUntil > now) {
      return false;
    }

    const current = this.requestCounts.get(ip) || { count: 0, windowStart: now };
    if (now - current.windowStart > 60_000) {
      current.count = 1;
      current.windowStart = now;
    } else {
      current.count++;
    }
    this.requestCounts.set(ip, current);

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
    const current = this.failedAttempts.get(ip) || { count: 0, blockedUntil: 0 };
    current.count++;

    // If 5 failed attempts in short succession, block IP for 5 minutes
    if (current.count >= 5) {
      current.blockedUntil = now + 5 * 60 * 1000;
      console.warn(`[HttpSecurity] 🚨 IP ${ip} blocked for 5 minutes due to multiple unauthorized access attempts.`);
    }

    this.failedAttempts.set(ip, current);
  }

  /**
   * Verifies if the request contains valid admin credentials via Bearer token,
   * x-admin-key header, or URL parameter (?token= or ?key=).
   * @param recordFailure Whether to count missing/invalid credentials toward IP blocking (default true).
   *                      Set to false for public probes (like /health) to prevent blocking uptime pingers.
   */
  public verifyAdminAuth(req: IncomingMessage, recordFailure: boolean = true): AuthCheckResult {
    const adminKey = this.getAdminKey();
    if (!adminKey) {
      return { isAuthenticated: false, reason: 'No admin key configured on server' };
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

    // 3. Check query parameters: ?token=... or ?key=...
    if (req.url) {
      try {
        const dummyUrl = new URL(req.url, 'http://localhost');
        const tokenParam = dummyUrl.searchParams.get('token') || dummyUrl.searchParams.get('key');
        if (tokenParam && this.timingSafeEqual(tokenParam.trim(), adminKey)) {
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
    const forwarded = req.headers['x-forwarded-for'];
    if (typeof forwarded === 'string') {
      return forwarded.split(',')[0].trim();
    }
    return req.socket.remoteAddress || '127.0.0.1';
  }
}

export const httpSecurityManager = new HttpSecurityManager();
