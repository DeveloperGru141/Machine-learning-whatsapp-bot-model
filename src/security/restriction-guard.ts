/**
 * Pauses outbound activity while WhatsApp reports a linked-device reach-out restriction.
 *
 * WhatsApp rejects direct sends during these windows (Baileys reports ACK 463). Retrying them
 * can prolong the restriction, so the guard stays closed until a fresh account-standing check
 * confirms that WhatsApp has lifted it. The initial check also runs on every socket connection,
 * which keeps a process restart from sending messages before it learns the account state.
 */

export interface ReachoutLock {
  isActive?: boolean;
  timeEnforcementEnds?: Date | string | number;
  enforcementType?: string;
}

const FALLBACK_LOCK_MS = 30 * 60 * 1000;
const RECHECK_AFTER_END_MS = 15 * 1000;
const RETRY_AFTER_FAILURE_MS = 30 * 1000;
const CATCHUP_GRACE_MS = 30 * 60 * 1000;

class RestrictionGuard {
  private endsAt = 0;
  private since = 0;
  private resumedAt = 0;
  private enforcementType = '';
  private standingVerified = false;
  private recheckTimer: NodeJS.Timeout | null = null;
  private refresher: (() => Promise<void>) | null = null;
  private lastSkipLogAt = 0;

  /** Fail closed until the new socket has fetched current account standing. */
  public beginVerification(): void {
    this.standingVerified = false;
    this.clearRecheck();
  }

  /** Registers the function that re-fetches account standing from WhatsApp. */
  public setRefresher(fn: () => Promise<void>): void {
    this.refresher = fn;
  }

  /** Applies a standing report from WhatsApp (fetch result or live notification). */
  public apply(lock: ReachoutLock | undefined | null): void {
    if (!lock || typeof lock.isActive !== 'boolean') return;

    const now = Date.now();
    this.standingVerified = true;

    if (lock.isActive) {
      const reportedEnd = lock.timeEnforcementEnds == null
        ? Number.NaN
        : new Date(lock.timeEnforcementEnds).getTime();
      // A past end with an active flag means standing still needs verification; retry shortly.
      const ends = Number.isFinite(reportedEnd) && reportedEnd > now
        ? reportedEnd
        : now + (Number.isFinite(reportedEnd) ? RETRY_AFTER_FAILURE_MS : FALLBACK_LOCK_MS);

      if (this.endsAt === 0) {
        this.since = now;
        console.log(
          `[RestrictionGuard] ⏸️ WhatsApp restriction active (${lock.enforcementType || 'unknown'}) until ${new Date(ends).toISOString()}. Pausing direct messages and automated jobs.`
        );
      } else {
        console.log(
          `[RestrictionGuard] ⏸️ WhatsApp restriction remains active (${lock.enforcementType || this.enforcementType || 'unknown'}); next check after ${new Date(ends).toISOString()}.`
        );
      }

      this.endsAt = ends;
      this.enforcementType = lock.enforcementType || this.enforcementType;
      this.scheduleRecheck(ends - now + RECHECK_AFTER_END_MS);
      return;
    }

    const wasRestricted = this.endsAt > 0;
    this.endsAt = 0;
    this.enforcementType = '';
    this.clearRecheck();
    if (wasRestricted) {
      this.resumedAt = now;
      console.log('[RestrictionGuard] ▶️ WhatsApp confirms the restriction is lifted. Resuming outbound activity.');
    } else {
      console.log('[RestrictionGuard] ✅ Account standing verified clear. Direct-message sending is enabled.');
    }
  }

  /** True while account standing is unknown or WhatsApp has an active restriction. */
  public isActive(): boolean {
    return !this.standingVerified || this.endsAt > 0;
  }

  /**
   * Earliest timestamp of messages that should still be answered after the lock lifts, so DMs
   * received while paused can be caught up. Undefined when no pause happened recently.
   */
  public catchupFrom(): number | undefined {
    if (this.isActive()) return this.since || undefined;
    if (this.since && Date.now() - this.resumedAt < CATCHUP_GRACE_MS) return this.since;
    return undefined;
  }

  /** Whether an outbound send must be held back right now. */
  public blocksJid(jid: string | undefined | null): boolean {
    if (!this.standingVerified) return Boolean(jid) && !jid!.endsWith('@g.us');
    if (!this.isActive() || !jid) return false;
    return jid.endsWith('@s.whatsapp.net') || jid.endsWith('@c.us') || jid.endsWith('@lid') || jid === 'status@broadcast';
  }

  /** Rate-limited log line for skipped work. */
  public logSkip(what: string): void {
    const now = Date.now();
    if (now - this.lastSkipLogAt < 60_000) return;
    this.lastSkipLogAt = now;

    if (!this.standingVerified) {
      console.log(`[RestrictionGuard] ⏸️ Skipped ${what} while waiting for WhatsApp account-standing verification.`);
      return;
    }

    const mins = Math.max(1, Math.ceil((this.endsAt - now) / 60_000));
    console.log(`[RestrictionGuard] ⏸️ Skipped ${what} (WhatsApp restriction active; next standing check in about ${mins} min).`);
  }

  /** Retry a failed or unavailable account-standing request without opening the send gate. */
  public retryLater(): void {
    this.scheduleRecheck(RETRY_AFTER_FAILURE_MS);
  }

  private scheduleRecheck(delayMs: number): void {
    this.clearRecheck();
    this.recheckTimer = setTimeout(() => {
      this.recheckTimer = null;
      if (!this.refresher) {
        this.retryLater();
        return;
      }
      this.refresher().catch((err: any) => {
        console.warn(`[RestrictionGuard] Account-standing refresh failed; outbound pause remains active: ${err?.message || err}`);
        this.retryLater();
      });
    }, Math.max(5_000, delayMs));
    this.recheckTimer.unref?.();
  }

  private clearRecheck(): void {
    if (this.recheckTimer) {
      clearTimeout(this.recheckTimer);
      this.recheckTimer = null;
    }
  }
}

export const restrictionGuard = new RestrictionGuard();
