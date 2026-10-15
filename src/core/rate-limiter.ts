export interface RateLimitStatus {
  allowed: boolean;
  remainingQuota: number;
  resetInSeconds: number;
}

export interface UserQuotaRecord {
  tokens: number;
  windowStart: number;
}

export class UserRateLimiter {
  private readonly maxTokens = 10;
  private readonly windowDurationMs = 60 * 1000; // 60 seconds
  private quotas: Map<string, UserQuotaRecord> = new Map();

  /**
   * Checks whether the user is permitted to send a message within their current window
   */
  public checkLimit(senderJid: string): RateLimitStatus {
    const now = Date.now();
    const record = this.quotas.get(senderJid);

    // If no existing record or window has elapsed, user has full quota available
    if (!record || now - record.windowStart >= this.windowDurationMs) {
      return {
        allowed: true,
        remainingQuota: this.maxTokens,
        resetInSeconds: Math.ceil(this.windowDurationMs / 1000),
      };
    }

    const resetInSeconds = Math.max(
      0,
      Math.ceil((record.windowStart + this.windowDurationMs - now) / 1000)
    );
    const remainingQuota = Math.max(0, record.tokens);

    return {
      allowed: remainingQuota > 0,
      remainingQuota,
      resetInSeconds,
    };
  }

  /**
   * Consumes a single token from the user's quota, initializing a new window if expired
   */
  public consumeToken(senderJid: string): void {
    const now = Date.now();
    const record = this.quotas.get(senderJid);

    if (!record || now - record.windowStart >= this.windowDurationMs) {
      this.quotas.set(senderJid, {
        tokens: this.maxTokens - 1,
        windowStart: now,
      });
      return;
    }

    if (record.tokens > 0) {
      record.tokens -= 1;
    }
  }

  /**
   * Returns a Map of all currently active (non-expired) user quotas
   */
  public getStats(): Map<string, { tokens: number; windowStart: number; resetInSeconds: number }> {
    const now = Date.now();
    const activeStats = new Map<string, { tokens: number; windowStart: number; resetInSeconds: number }>();

    for (const [jid, record] of this.quotas.entries()) {
      if (now - record.windowStart < this.windowDurationMs) {
        activeStats.set(jid, {
          tokens: record.tokens,
          windowStart: record.windowStart,
          resetInSeconds: Math.max(
            0,
            Math.ceil((record.windowStart + this.windowDurationMs - now) / 1000)
          ),
        });
      } else {
        // Prune expired record to avoid unbounded memory growth
        this.quotas.delete(jid);
      }
    }

    return activeStats;
  }

  /**
   * Explicitly reset a user's rate limit window
   */
  public resetUser(senderJid: string): void {
    this.quotas.delete(senderJid);
  }

  /**
   * Clear all rate limiter state
   */
  public clear(): void {
    this.quotas.clear();
  }
}

export const userRateLimiter = new UserRateLimiter();
