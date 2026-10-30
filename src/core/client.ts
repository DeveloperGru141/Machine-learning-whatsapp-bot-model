import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  Browsers,
  type WAMessage,
  type WASocket,
} from '@whiskeysockets/baileys';
import { db, upsertKnownGroup, findActiveRelaySession, markRelaySessionReplied, saveChannelQuote, saveChannelMeme, setBotSetting } from '../memory/db.js';
import { parseQuoteFromText, WHATSAPP_CHANNEL_INVITE_CODE } from '../plugins/scheduler/channel-quotes-service.js';
import { WHATSAPP_MEME_CHANNEL_INVITE_CODE } from '../plugins/scheduler/channel-memes-service.js';
import { stickerEngine } from '../plugins/stickers/sticker-engine.js';
import { getOrGenerateMemeMedia, getOrGenerateQuoteMedia } from '../plugins/scheduler/media-card-generator.js';
import pino from 'pino';
import qrcode from 'qrcode-terminal';
import { Boom } from '@hapi/boom';
import fs from 'fs';
import path from 'path';
import { config, normalizePhoneNumber } from '../config/env.js';
import { normalizeMessage, NormalizedMessage } from './normalizer.js';
import { shouldRespondToMessage, recordGroupInteraction } from './filter.js';
import { OutboundSender, setActiveSocketGetter, setDeliveryConfirmationWaiter } from './sender.js';
import { chatLogger } from '../memory/chat-logger.js';
import { restrictionGuard } from '../security/restriction-guard.js';
import { agentHarness } from '../agent/harness.js';
import { ExecutionContext } from '../plugins/types.js';
import { patternMiner } from '../learning/pattern-miner.js';
import { batchLearner } from '../learning/batch-learner.js';
import { downloadMediaMessage } from '@whiskeysockets/baileys';
import { analyzeVoiceNote } from './transcription.js';
import { inspectUrlSafety } from '../plugins/link-summarizer/link-plugin.js';
import { analyzeImageBuffer } from './vision.js';
import { requestQueue } from './queue.js';
import { groupAdminPlugin } from '../plugins/group-admin/admin-plugin.js';
import { setupGroupWelcome } from '../plugins/group-admin/welcome.js';
import { messageReactor } from './reactions.js';
import { antiSpamFilter } from './anti-spam.js';
import { healthMonitor } from './health-monitor.js';
import { analyticsEngine } from './analytics.js';
import { userRateLimiter } from './rate-limiter.js';
import { userProfileManager } from '../memory/user-profiles.js';
import { contactService } from '../memory/contact-service.js';
import { setSchedulerSocket } from '../plugins/scheduler/scheduler-plugin.js';
import { setEngagementSocket } from '../plugins/engagement/engagement-plugin.js';
import { setViewOnceSocket, deliverViewOnceMediaToOwner } from '../plugins/view-once/view-once-plugin.js';
import { saveViewOnceMessage, getLatestViewOnceMessages } from '../memory/db.js';
import { antiBanEngine } from '../security/anti-ban.js';

/**
 * Normalizes a phone number for Baileys pairing code generation.
 * Delegates to the central normalizePhoneNumber helper (e.g. 07058967815 -> 2347058967815).
 */
export function formatPhoneNumberForPairing(num: string): string {
  return normalizePhoneNumber(num);
}

export class WhatsAppClient {
  private sock: WASocket | null = null;
  private logger = pino({ level: process.env.BAILEYS_LOG_LEVEL || 'warn' });
  private refreshAccountStanding: (() => Promise<void>) | null = null;
  private reconnectAttempts = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private isConnecting = false;
  private keepAliveInterval: NodeJS.Timeout | null = null;
  private unrepliedScanInterval: NodeJS.Timeout | null = null;
  private unrepliedDebounceTimer: NodeJS.Timeout | null = null;
  private isScanningUnreplied = false;
  private activeInboundDmChats: Map<string, number> = new Map();
  private pairingRequested = false;
  private latestPairingCode: string | null = null;
  private latestPairingCodeAt = 0;
  private latestQr: string | null = null;
  private sessionStartedAt = Date.now();
  private messageStore: Map<string, any> = new Map();
  private deliveryStatusMap: Map<
    string,
    { status: 'SENT_TO_SERVER' | 'DELIVERED_TO_DEVICE' | 'READ'; statusCode: number; updatedAt: number; recipientJid: string }
  > = new Map();
  private deliveryWaiters: Map<
    string,
    Array<(info: { status: 'SENT_TO_SERVER' | 'DELIVERED_TO_DEVICE' | 'READ'; statusCode: number; updatedAt: number }) => void>
  > = new Map();
  private lastStickerReplyTime: Map<string, number> = new Map();

  public recordDeliveryStatus(msgId: string, recipientJid: string, statusNum: number): void {
    if (!msgId || statusNum < 2) return;
    const statusLabel: 'SENT_TO_SERVER' | 'DELIVERED_TO_DEVICE' | 'READ' =
      statusNum >= 4 ? 'READ' : statusNum === 3 ? 'DELIVERED_TO_DEVICE' : 'SENT_TO_SERVER';
    const existing = this.deliveryStatusMap.get(msgId);
    if (!existing || statusNum >= existing.statusCode) {
      const info = {
        status: statusLabel,
        statusCode: statusNum,
        updatedAt: Date.now(),
        recipientJid: recipientJid || existing?.recipientJid || '',
      };
      this.deliveryStatusMap.set(msgId, info);
      if (this.deliveryStatusMap.size > 2000) {
        const oldestKey = this.deliveryStatusMap.keys().next().value;
        if (oldestKey) this.deliveryStatusMap.delete(oldestKey);
      }
      const waiters = this.deliveryWaiters.get(msgId);
      if (waiters && waiters.length > 0) {
        for (const resolve of waiters) {
          try {
            resolve(info);
          } catch {}
        }
        if (statusNum >= 3) {
          this.deliveryWaiters.delete(msgId);
        }
      }
    }
  }

  private loggedOutRetryCount = 0;
  private sessionBundleInvalidated = false;

  /**
   * Waits for WhatsApp server ACK (status >= 2) or device delivery receipt (status >= 3)
   * for a sent message stanza ID.
   */
  public async waitForDeliveryConfirmation(
    msgId: string,
    recipientJid: string,
    timeoutMs: number = 2000
  ): Promise<{
    confirmed: boolean;
    serverAcknowledged: boolean;
    status: 'DELIVERED_TO_DEVICE' | 'SENT_TO_SERVER' | 'READ' | 'DISPATCHED';
    statusLabel: string;
    statusCode: number;
    stanzaId: string;
    msgId: string;
    recipientJid: string;
    timestamp: string;
  }> {
    const formatLabel = (st: 'DELIVERED_TO_DEVICE' | 'SENT_TO_SERVER' | 'READ' | 'DISPATCHED') =>
      st === 'READ'
        ? 'Read by recipient (✓✓)'
        : st === 'DELIVERED_TO_DEVICE'
          ? 'Delivered to device (✓✓)'
          : st === 'SENT_TO_SERVER'
            ? 'Sent to WhatsApp Server (✓)'
            : 'Dispatched to WhatsApp';

    const existing = this.deliveryStatusMap.get(msgId);
    if (existing && existing.statusCode >= 3) {
      return {
        confirmed: true,
        serverAcknowledged: true,
        status: existing.status,
        statusLabel: formatLabel(existing.status),
        statusCode: existing.statusCode,
        stanzaId: msgId,
        msgId,
        recipientJid,
        timestamp: new Date(existing.updatedAt).toISOString(),
      };
    }

    const ackInfo = await new Promise<{
      status: 'SENT_TO_SERVER' | 'DELIVERED_TO_DEVICE' | 'READ';
      statusCode: number;
      updatedAt: number;
    } | null>((resolve) => {
      const list = this.deliveryWaiters.get(msgId) || [];
      const cleanup = () => {
        const current = this.deliveryWaiters.get(msgId);
        if (!current) return;
        const remaining = current.filter((waiter) => waiter !== onDeviceReceipt);
        if (remaining.length > 0) this.deliveryWaiters.set(msgId, remaining);
        else this.deliveryWaiters.delete(msgId);
      };
      const timer = setTimeout(() => {
        const latest = this.deliveryStatusMap.get(msgId);
        cleanup();
        resolve(latest || null);
      }, timeoutMs);
      const onDeviceReceipt = (info: { status: 'SENT_TO_SERVER' | 'DELIVERED_TO_DEVICE' | 'READ'; statusCode: number; updatedAt: number }) => {
        if (info.statusCode >= 3) {
          clearTimeout(timer);
          cleanup();
          resolve(info);
        }
      };
      list.push(onDeviceReceipt);
      this.deliveryWaiters.set(msgId, list);
    });

    const finalInfo = ackInfo || this.deliveryStatusMap.get(msgId);
    if (finalInfo) {
      return {
        confirmed: finalInfo.statusCode >= 3,
        serverAcknowledged: finalInfo.statusCode >= 2,
        status: finalInfo.status,
        statusLabel: formatLabel(finalInfo.status),
        statusCode: finalInfo.statusCode,
        stanzaId: msgId,
        msgId,
        recipientJid,
        timestamp: new Date(finalInfo.updatedAt).toISOString(),
      };
    }

    const fallbackStatus = 'DISPATCHED';
    return {
      confirmed: false,
      serverAcknowledged: false,
      status: fallbackStatus,
      statusLabel: formatLabel(fallbackStatus),
      statusCode: 0,
      stanzaId: msgId,
      msgId,
      recipientJid,
      timestamp: new Date().toISOString(),
    };
  }

  public getLatestPairingCode(): string | null {
    // Pairing codes expire after ~150 seconds on WhatsApp servers
    if (this.latestPairingCodeAt && Date.now() - this.latestPairingCodeAt > 150_000) {
      return null;
    }
    return this.latestPairingCode;
  }

  public getLatestQr(): string | null {
    return this.latestQr;
  }

  public isRegistered(): boolean {
    const creds = this.sock?.authState?.creds;
    return Boolean(creds?.registered === true || (creds?.me?.id && creds?.me?.lid && !creds?.pairingEphemeralKeyPair));
  }

  /**
   * Returns the current valid pairing code for the active socket, or performs a clean
   * session reset if forceReset is true (or if code is expired / none generated yet).
   * Never calls requestPairingCode twice on the same authState to avoid corrupting noise keys.
   */
  public async requestFreshPairingCode(forceReset: boolean = false): Promise<string | null> {
    if (this.isRegistered()) {
      return null;
    }

    const isCodeExpired =
      !this.latestPairingCode ||
      !this.latestPairingCodeAt ||
      Date.now() - this.latestPairingCodeAt >= 150_000;

    // If we already have a fresh code on the current socket (<150s old) and not forcing reset, return it directly!
    if (!forceReset && !isCodeExpired && this.latestPairingCode) {
      return this.latestPairingCode;
    }

    // Clean session wipe & fresh socket start
    console.log('[WhatsAppClient] 🔄 Generating clean pairing session and fresh pairing code...');
    this.sessionBundleInvalidated = true;
    try {
      if (this.sock) {
        this.sock.ev.removeAllListeners('connection.update');
        this.sock.ev.removeAllListeners('creds.update');
        this.sock.ev.removeAllListeners('messages.upsert');
        this.sock.ev.removeAllListeners('messages.update');
        this.sock.ev.removeAllListeners('message-receipt.update');
        try {
          this.sock.end(undefined);
        } catch {}
        this.sock = null;
      }
      if (fs.existsSync(config.paths.sessions)) {
        fs.rmSync(config.paths.sessions, { recursive: true, force: true });
      }
    } catch {}
    this.pairingRequested = false;
    this.latestPairingCode = null;
    this.latestPairingCodeAt = 0;
    this.isConnecting = false;
    await this.start();

    // Wait up to 15 seconds for the fresh socket's QR handshake to generate the single clean pairing code
    for (let i = 0; i < 30; i++) {
      if (this.latestPairingCode) {
        return this.latestPairingCode;
      }
      await new Promise((r) => setTimeout(r, 500));
    }

    return this.latestPairingCode;
  }

  private startKeepAlive(): void {
    this.stopKeepAlive();
    // Keep-alive is handled natively by Baileys keepAliveIntervalMs (iq ping frames).
    // Manual presence updates are avoided to prevent WhatsApp stream terminations.
  }

  private stopKeepAlive(): void {
    if (this.keepAliveInterval) {
      clearInterval(this.keepAliveInterval);
      this.keepAliveInterval = null;
    }
  }

  /**
   * Schedules a debounced unreplied DM scan after history sync or offline message delivery.
   */
  public scheduleUnrepliedScan(delayMs: number = 12_000): void {
    if (this.unrepliedDebounceTimer) {
      clearTimeout(this.unrepliedDebounceTimer);
    }
    this.unrepliedDebounceTimer = setTimeout(async () => {
      this.unrepliedDebounceTimer = null;
      if (!this.isSocketOpen() || this.isScanningUnreplied) return;
      try {
        await this.replyUnrepliedMessages(1);
      } catch (err: any) {
        console.warn('[WhatsAppClient] Scheduled unreplied catch-up warning:', err.message);
      }
    }, delayMs);
    if (this.unrepliedDebounceTimer.unref) this.unrepliedDebounceTimer.unref();
  }

  /**
   * Starts the human-paced background contact replies cycle for users who DM'd the bot.
   * - Waits 20s after connection opens so live traffic and history sync settle first.
   * - Runs every 2 minutes (120s) 24/7 with batch limit 1 to maintain natural anti-ban pacing.
   * - Replies to unreplied contact DMs in strict accordance with the fine-tuning pipeline.
   */
  public startUnrepliedScanner(): void {
    this.stopUnrepliedScanner();

    const runCycleIfActive = async () => {
      if (!this.isSocketOpen() || this.isScanningUnreplied) return;
      try {
        await this.replyUnrepliedMessages(1);
      } catch (err: any) {
        console.warn('[WhatsAppClient] Unreplied catch-up cycle warning:', err.message);
      }
    };

    // Periodic scanner runs every 2.5 minutes passively for messages that arrived during this session
    this.unrepliedScanInterval = setInterval(() => {
      runCycleIfActive();
    }, 150_000);
    if (this.unrepliedScanInterval.unref) this.unrepliedScanInterval.unref();
  }

  public stopUnrepliedScanner(): void {
    if (this.unrepliedScanInterval) {
      clearInterval(this.unrepliedScanInterval);
      this.unrepliedScanInterval = null;
    }
    if (this.unrepliedDebounceTimer) {
      clearTimeout(this.unrepliedDebounceTimer);
      this.unrepliedDebounceTimer = null;
    }
  }

  public getSocket(): WASocket | null {
    return this.sock;
  }

  public setSocket(sock: WASocket | null): void {
    this.sock = sock;
  }

  
  private backupInFlight = false;
  private backupQueued = false;
  private lastBackupAt = 0;
  private lastBackupHash = '';
  private static readonly BACKUP_MIN_INTERVAL_MS = 30_000;
  private static readonly SESSION_BUNDLE_CHUNK_SIZE = 90_000;
  private static readonly SESSION_BUNDLE_MAX_B64_CHARS = 1_500_000;

  private assembleSessionBundle(env: NodeJS.ProcessEnv): string | undefined {
    const pointer = env.SESSION_BUNDLE_SET || '';
    const match = /^([a-z0-9]+):(\d+)$/.exec(pointer);
    if (!match) return env.SESSION_BUNDLE_BASE64;

    const [, version, rawCount] = match;
    const count = Number(rawCount);
    if (!Number.isInteger(count) || count < 1 || count > 32) return undefined;

    const chunks: string[] = [];
    for (let index = 0; index < count; index++) {
      const chunk = env[`SESSION_BUNDLE_${version}_${String(index).padStart(3, '0')}`];
      if (!chunk) return undefined;
      chunks.push(chunk);
    }
    return chunks.join('');
  }

  /**
   * Reads the freshest session bundle straight from Render, supporting both a
   * legacy single variable and a chunked bundle that stays below OS env limits.
   * process.env only holds the snapshot taken at the last deploy, so after a container
   * restart or rolling deploy it is stale or empty.
   */
  private async fetchLatestSessionBundle(): Promise<string | undefined> {
    const apiKey = process.env.RENDER_API_KEY;
    const serviceId = process.env.RENDER_SERVICE_ID;
    if (apiKey && serviceId) {
      try {
        const res = await fetch(`https://api.render.com/v1/services/${serviceId}/env-vars?limit=100`, {
          headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
          signal: AbortSignal.timeout(15_000),
        });
        if (res.ok) {
          const rows = (await res.json()) as Array<{ envVar?: { key?: string; value?: string } }>;
          const latestEnv: NodeJS.ProcessEnv = {};
          for (const row of rows) {
            if (row.envVar?.key && typeof row.envVar.value === 'string') {
              latestEnv[row.envVar.key] = row.envVar.value;
            }
          }
          const latestBundle = this.assembleSessionBundle(latestEnv);
          if (latestBundle && latestBundle.length > 100) {
            console.log(`[WhatsAppClient] ☁️ Fetched latest session bundle from Render API (${latestBundle.length}b).`);
            return latestBundle;
          }
        } else {
          console.warn(`[WhatsAppClient] Render API bundle fetch returned ${res.status}; falling back to process.env snapshot.`);
        }
      } catch (err: any) {
        console.warn('[WhatsAppClient] Render API bundle fetch failed; falling back to process.env snapshot:', err?.message || err);
      }
    }
    return this.assembleSessionBundle(process.env);
  }

  public async autoBackupSessionToRender(): Promise<void> {
    if (this.sessionBundleInvalidated) return;
    if (this.backupInFlight) {
      this.backupQueued = true;
      return;
    }
    const sinceLast = Date.now() - this.lastBackupAt;
    if (sinceLast < WhatsAppClient.BACKUP_MIN_INTERVAL_MS) {
      if (!this.backupQueued) {
        this.backupQueued = true;
        const t = setTimeout(() => {
          this.backupQueued = false;
          void this.autoBackupSessionToRender();
        }, WhatsAppClient.BACKUP_MIN_INTERVAL_MS - sinceLast + 250);
        t.unref();
      }
      return;
    }

    const credsFile = path.join(config.paths.sessions, 'creds.json');
    if (!fs.existsSync(credsFile)) return;

    this.backupInFlight = true;
    try {
      let rawCreds: any;
      try {
        rawCreds = JSON.parse(fs.readFileSync(credsFile, 'utf8'));
      } catch {
        return;
      }
      const isFullyPaired = Boolean(rawCreds?.registered === true || (rawCreds?.me?.id && rawCreds?.me?.lid && !rawCreds?.pairingEphemeralKeyPair));
      if (!isFullyPaired) return;

      const zlib = await import('zlib');
      const allFiles = fs.readdirSync(config.paths.sessions);
      const mtimeOf = (f: string): number => {
        try { return fs.statSync(path.join(config.paths.sessions, f)).mtimeMs; } catch { return 0; }
      };
      const newestFirst = (a: string, b: string) => mtimeOf(b) - mtimeOf(a);

      const preKeys = allFiles
        .filter((f) => f.startsWith('pre-key-'))
        .sort((a, b) => (parseInt(b.replace(/[^0-9]/g, ''), 10) || 0) - (parseInt(a.replace(/[^0-9]/g, ''), 10) || 0))
        .slice(0, 40);
      const sessions = allFiles.filter((f) => f.startsWith('session-')).sort(newestFirst);
      const senderKeys = allFiles.filter((f) => f.startsWith('sender-key-')).sort(newestFirst);
      const appKeys = allFiles.filter((f) => f.startsWith('app-state-sync-key'));

      const resetMarkers = allFiles.filter((f) => f.startsWith('reset-marker-'));
      // Privacy tokens (tctoken) and LID<->PN maps are required for 1:1 sends; losing them on restart can trigger ack error 463.
      const trustKeys = allFiles.filter((f) => f.startsWith('tctoken-') || f.startsWith('lid-mapping-'));

      // Signal `session-*` ratchets must NEVER be pruned: dropping them causes
      // "MessageCounterError: Key used already or never filled" and undeliverable replies.
      const core = ['creds.json', ...appKeys, ...resetMarkers, ...sessions];
      const prunable = [...trustKeys, ...senderKeys.slice(0, 30), ...preKeys, ...senderKeys.slice(30)];

      const read = (f: string): string | undefined => {
        const fp = path.join(config.paths.sessions, f);
        try { return fs.existsSync(fp) && fs.statSync(fp).isFile() ? fs.readFileSync(fp, 'utf8') : undefined; } catch { return undefined; }
      };
      const filesMap: Record<string, string> = {};
      for (const f of [...core, ...prunable]) {
        const content = read(f);
        if (content !== undefined) filesMap[f] = content;
      }

      if (!filesMap['creds.json'] || filesMap['creds.json'].trim().length < 50) {
        console.warn('[WhatsAppClient] Refusing to backup session: creds.json is empty or incomplete.');
        return;
      }

      const build = (): string => zlib.gzipSync(Buffer.from(JSON.stringify(filesMap), 'utf8'), { level: 9 }).toString('base64');
      let bundle = build();
      let dropped = 0;
      if (bundle.length > WhatsAppClient.SESSION_BUNDLE_MAX_B64_CHARS) {
        const dropOrder = [...prunable].reverse().filter((f) => filesMap[f] !== undefined);
        for (let i = 0; i < dropOrder.length; i += 8) {
          for (const f of dropOrder.slice(i, i + 8)) { delete filesMap[f]; dropped++; }
          bundle = build();
          if (bundle.length <= WhatsAppClient.SESSION_BUNDLE_MAX_B64_CHARS) break;
        }
      }
      if (bundle.length > WhatsAppClient.SESSION_BUNDLE_MAX_B64_CHARS) {
        console.warn(`[WhatsAppClient] Session backup skipped: bundle exceeds the safe Render environment budget (${bundle.length}b).`);
        this.lastBackupAt = Date.now();
        return;
      }

      const crypto = await import('crypto');
      const hash = crypto.createHash('sha1').update(bundle).digest('hex');
      if (hash === this.lastBackupHash) return;

      const apiKey = process.env.RENDER_API_KEY;
      if (!apiKey) {
        console.warn('[WhatsAppClient] Render session backup skipped: RENDER_API_KEY is not configured.');
        this.lastBackupAt = Date.now();
        return;
      }
      const serviceId = process.env.RENDER_SERVICE_ID || 'srv-db9jvcmq1p3s738hpa40';
      const envVarsUrl = `https://api.render.com/v1/services/${serviceId}/env-vars`;
      const headers = {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      };
      const putEnvVar = (key: string, value: string) => fetch(`${envVarsUrl}/${encodeURIComponent(key)}`, {
        method: 'PUT', headers, body: JSON.stringify({ value }), signal: AbortSignal.timeout(15_000),
      });
      const deleteEnvVar = async (key: string): Promise<boolean> => {
        const res = await fetch(`${envVarsUrl}/${encodeURIComponent(key)}`, {
          method: 'DELETE', headers, signal: AbortSignal.timeout(15_000),
        });
        return res.ok || res.status === 404;
      };
      this.lastBackupAt = Date.now();

      const previousPointer = process.env.SESSION_BUNDLE_SET || '';
      const previousMatch = /^([a-z0-9]+):(\d+)$/.exec(previousPointer);
      let saved = false;
      if (bundle.length <= WhatsAppClient.SESSION_BUNDLE_CHUNK_SIZE) {
        const res = await putEnvVar('SESSION_BUNDLE_BASE64', bundle);
        if (res.ok) {
          const pointerDeleted = await deleteEnvVar('SESSION_BUNDLE_SET');
          if (pointerDeleted && previousMatch) {
            for (let index = 0; index < Number(previousMatch[2]); index++) {
              if (!await deleteEnvVar(`SESSION_BUNDLE_${previousMatch[1]}_${String(index).padStart(3, '0')}`)) {
                console.warn('[WhatsAppClient] Could not clean up an old Render session bundle chunk.');
              }
            }
          }
          saved = pointerDeleted;
        } else {
          const body = (await res.text().catch(() => '')).slice(0, 200);
          console.warn(`[WhatsAppClient] Render session backup response: ${res.status} ${body}`);
        }
      } else {
        const version = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
        const chunks: string[] = [];
        for (let offset = 0; offset < bundle.length; offset += WhatsAppClient.SESSION_BUNDLE_CHUNK_SIZE) {
          chunks.push(bundle.slice(offset, offset + WhatsAppClient.SESSION_BUNDLE_CHUNK_SIZE));
        }

        let chunksSaved = true;
        for (let index = 0; index < chunks.length; index++) {
          const key = `SESSION_BUNDLE_${version}_${String(index).padStart(3, '0')}`;
          const res = await putEnvVar(key, chunks[index]);
          if (!res.ok) {
            const body = (await res.text().catch(() => '')).slice(0, 200);
            console.warn(`[WhatsAppClient] Render session chunk backup response: ${res.status} ${body}`);
            chunksSaved = false;
            break;
          }
        }

        if (chunksSaved) {
          const pointerRes = await putEnvVar('SESSION_BUNDLE_SET', `${version}:${chunks.length}`);
          if (pointerRes.ok) {
            const legacyDeleted = await deleteEnvVar('SESSION_BUNDLE_BASE64');
            if (previousMatch) {
              for (let index = 0; index < Number(previousMatch[2]); index++) {
                if (!await deleteEnvVar(`SESSION_BUNDLE_${previousMatch[1]}_${String(index).padStart(3, '0')}`)) {
                  console.warn('[WhatsAppClient] Could not clean up an old Render session bundle chunk.');
                }
              }
            }
            saved = legacyDeleted;
          } else {
            const body = (await pointerRes.text().catch(() => '')).slice(0, 200);
            console.warn(`[WhatsAppClient] Render session bundle pointer update failed: ${pointerRes.status} ${body}`);
          }
        }
      }

      if (saved) {
        this.lastBackupHash = hash;
        console.log(`[WhatsAppClient] 💾 Persisted authenticated session (${Object.keys(filesMap).length} files kept, ${dropped} pruned, ${bundle.length}b base64) to Render!`);
      }
    } catch (err: any) {
      console.warn('[WhatsAppClient] Auto backup to Render failed:', err.message);
    } finally {
      this.backupInFlight = false;
      if (this.backupQueued) {
        this.backupQueued = false;
        const wait = Math.max(500, WhatsAppClient.BACKUP_MIN_INTERVAL_MS - (Date.now() - this.lastBackupAt) + 250);
        const t = setTimeout(() => void this.autoBackupSessionToRender(), wait);
        t.unref();
      }
    }
  }

  public isSocketOpen(): boolean {
    return Boolean(this.sock && (this.sock as any).ws?.isOpen);
  }

  private cancelReconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private scheduleReconnect(delayMs: number): void {
    if (this.reconnectTimer) {
      console.log('[WhatsAppClient] Reconnect already scheduled; ignoring duplicate close event.');
      return;
    }
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.start().catch((err: any) => {
        console.error('[WhatsAppClient] Reconnect start failed:', err instanceof Error ? err.name : typeof err);
      });
    }, delayMs);
    this.reconnectTimer.unref?.();
  }

  public async start(): Promise<void> {
    if (this.isConnecting) {
      console.log('[WhatsAppClient] Connection attempt already in progress, skipping duplicate invocation.');
      return;
    }
    this.cancelReconnect();
    this.isConnecting = true;

    try {
      if (!fs.existsSync(config.paths.sessions)) {
        fs.mkdirSync(config.paths.sessions, { recursive: true });
      }

      // Hydrate session files from SESSION_BUNDLE_BASE64 on cloud containers (Render) if sessions/creds.json is missing and not invalidated
      const credsFile = path.join(config.paths.sessions, 'creds.json');
      const hydrateSource = !fs.existsSync(credsFile) && !this.sessionBundleInvalidated ? await this.fetchLatestSessionBundle() : undefined;
      if (!fs.existsSync(credsFile) && hydrateSource && !this.sessionBundleInvalidated) {
        try {
          const zlib = await import('zlib');
          const rawBuf = Buffer.from(hydrateSource, 'base64');
          const bundleJson =
            rawBuf[0] === 0x1f && rawBuf[1] === 0x8b
              ? zlib.gunzipSync(rawBuf).toString('utf8')
              : rawBuf.toString('utf8');
          const filesMap = JSON.parse(bundleJson) as Record<string, string>;
          // Guard: Only hydrate if creds.json is non-empty, valid JSON, and fully registered!
          let parsedCreds: any = null;
          try {
            parsedCreds = JSON.parse(filesMap['creds.json'] || '{}');
          } catch {}
          const isUsable = Boolean(
            parsedCreds?.registered === true ||
              (parsedCreds?.me?.id && parsedCreds?.me?.lid && !parsedCreds?.pairingEphemeralKeyPair)
          );

          if (filesMap['creds.json'] && isUsable) {
            // One-time recovery: stale pairwise Signal sessions for the owner can make DM replies
            // get accepted by the server but never decrypt on the owner's devices. Skip them on the
            // first boot that lacks the marker so Baileys negotiates fresh sessions (groups unaffected).
            const resetMarker = 'reset-marker-owner-sessions-v1';
            const needsOwnerReset = filesMap[resetMarker] === undefined;
            const ownerSessionRe = /^session-(102409552584830|2348108574293)[_.@]/;
            let skippedOwnerSessions = 0;
            for (const [fileName, fileContent] of Object.entries(filesMap)) {
              const safeName = path.basename(fileName);
              if (needsOwnerReset && ownerSessionRe.test(safeName)) {
                skippedOwnerSessions++;
                continue;
              }
              fs.writeFileSync(path.join(config.paths.sessions, safeName), fileContent, 'utf8');
            }
            if (needsOwnerReset) {
              fs.writeFileSync(path.join(config.paths.sessions, resetMarker), new Date().toISOString(), 'utf8');
              console.log(`[WhatsAppClient] ♻️ One-time owner session reset: dropped ${skippedOwnerSessions} stale owner Signal session(s).`);
            }
            console.log(`[WhatsAppClient] 🔑 Hydrated ${Object.keys(filesMap).length - skippedOwnerSessions} session files from SESSION_BUNDLE_BASE64.`);
          } else {
            console.warn('[WhatsAppClient] SESSION_BUNDLE_BASE64 is unlinked or incomplete; skipping hydration to await fresh pairing.');
          }
        } catch (err: any) {
          console.warn('[WhatsAppClient] Failed to hydrate SESSION_BUNDLE_BASE64:', err.message);
        }
      }

      // Detect if PAIRING_PHONE_NUMBER changed vs existing session creds.json, or if previous pairing was incomplete
      if (fs.existsSync(credsFile)) {
        try {
          const content = fs.readFileSync(credsFile, 'utf8').trim();
          if (!content) {
            fs.rmSync(config.paths.sessions, { recursive: true, force: true });
            fs.mkdirSync(config.paths.sessions, { recursive: true });
            this.pairingRequested = false;
          } else {
            const rawCreds = JSON.parse(content);
            const isFullyPaired = Boolean(rawCreds?.registered === true || (rawCreds?.me?.id && rawCreds?.me?.lid && !rawCreds?.pairingEphemeralKeyPair));
            const existingPhone = (rawCreds?.me?.id || '').split(':')[0].split('@')[0].replace(/[^0-9]/g, '');
            const targetPhone = formatPhoneNumberForPairing(config.bot.pairingPhoneNumber || '07058967815');

            if (!isFullyPaired) {
              // Incomplete pairing attempt left a partial creds.me without account/registered; wipe so Baileys sends RegistrationNode
              fs.rmSync(config.paths.sessions, { recursive: true, force: true });
              fs.mkdirSync(config.paths.sessions, { recursive: true });
              this.pairingRequested = false;
            } else if (existingPhone && targetPhone && existingPhone !== targetPhone) {
              console.log(
                `[WhatsAppClient] 🔄 Default bot number changed (+${existingPhone} -> +${targetPhone}). Archiving previous session and preparing fresh pairing for +${targetPhone}...`
              );
              const backupDir = path.resolve(`./sessions_prev_${existingPhone}`);
              try {
                if (fs.existsSync(backupDir)) fs.rmSync(backupDir, { recursive: true, force: true });
                fs.cpSync(config.paths.sessions, backupDir, { recursive: true });
              } catch {}
              fs.rmSync(config.paths.sessions, { recursive: true, force: true });
              fs.mkdirSync(config.paths.sessions, { recursive: true });
              this.pairingRequested = false;
              this.latestPairingCode = null;
            }
          }
        } catch {
          fs.rmSync(config.paths.sessions, { recursive: true, force: true });
          fs.mkdirSync(config.paths.sessions, { recursive: true });
          this.pairingRequested = false;
        }
      }

      // Detach any previous listeners and cleanly close prior socket instance to prevent conflict
      if (this.sock) {
        try {
          this.sock.ev.removeAllListeners('connection.update');
          this.sock.ev.removeAllListeners('creds.update');
          this.sock.ev.removeAllListeners('messages.upsert');
          this.sock.ev.removeAllListeners('messages.update');
          this.sock.ev.removeAllListeners('message-receipt.update');
          try {
            this.sock.end(undefined);
          } catch {}
        } catch {}
        this.sock = null;
      }

      const { state, saveCreds } = await useMultiFileAuthState(config.paths.sessions);
      // Persist contact privacy tokens and LID mappings after Baileys writes them.
      // These key-store updates do not emit `creds.update`, so without this hook
      // newly learned trust data would be lost on the next ephemeral-container restart.
      const persistSignalKeys = state.keys.set.bind(state.keys);
      state.keys.set = async (data) => {
        await persistSignalKeys(data);
        if (
          Object.keys(data).some((category) => category === 'tctoken' || category === 'lid-mapping') &&
          this.isRegistered()
        ) {
          this.autoBackupSessionToRender();
        }
      };
      const { version, isLatest } = await fetchLatestBaileysVersion();
      console.log(`[WhatsAppClient] Starting Baileys v${version.join('.')} (Latest: ${isLatest})`);

      const msgRetryCounterMap = new Map<string, any>();
      const msgRetryCounterCache = {
        get: <T>(key: string): T | undefined => msgRetryCounterMap.get(key) as T,
        set: <T>(key: string, value: T): void => { msgRetryCounterMap.set(key, value); },
        del: (key: string): void => { msgRetryCounterMap.delete(key); },
        flushAll: (): void => { msgRetryCounterMap.clear(); },
      };

      this.sock = makeWASocket({
        version,
        logger: this.logger,
        auth: state,
        printQRInTerminal: false,
        generateHighQualityLinkPreview: true,
        browser: Browsers.ubuntu('Chrome'),
        keepAliveIntervalMs: 30_000,
        connectTimeoutMs: 60_000,
        qrTimeout: 180_000,
        defaultQueryTimeoutMs: 20_000,
        retryRequestDelayMs: 500,
        maxMsgRetryCount: 5,
        syncFullHistory: false,
        markOnlineOnConnect: false,
        msgRetryCounterCache,
        getMessage: async (key) => {
          if (key.id) {
            return this.messageStore.get(key.id);
          }
          return undefined;
        },
        shouldIgnoreJid: (jid) => jid?.endsWith('@broadcast') || jid?.includes('status@broadcast'),
      });
      // Hold direct sends until this socket has checked WhatsApp account standing. This closes the
      // reconnect window where the bot could otherwise retry DMs before learning a restriction is active.
      restrictionGuard.beginVerification();

      // Initialize group welcome listener and scheduler background socket
      setActiveSocketGetter(() => this.sock);
      setDeliveryConfirmationWaiter((msgId, recipientJid, timeoutMs) =>
        this.waitForDeliveryConfirmation(msgId, recipientJid, timeoutMs)
      );
      setupGroupWelcome(this.sock);
      setSchedulerSocket(this.sock);
      setEngagementSocket(this.sock);
      setViewOnceSocket(this.sock);

      // Save auth credentials whenever updated
      this.sock.ev.on('creds.update', async () => {
        await saveCreds();
        if (this.isRegistered()) {
          this.autoBackupSessionToRender();
        }
      });

      // Connection lifecycle management
      const connectionSocket = this.sock;
      if (!connectionSocket) throw new Error('WhatsApp socket was not created');

      // Restriction guard: while WhatsApp has the account reach-out time-locked, hold back 1:1 and status
      // sends instead of sending doomed messages (retries can extend the lock). Groups are unaffected.
      const rawSendMessage = (connectionSocket as any).sendMessage.bind(connectionSocket);
      (connectionSocket as any).sendMessage = async (jid: string, ...rest: any[]) => {
        if (restrictionGuard.blocksJid(jid)) {
          restrictionGuard.logSkip(`outbound send to ${jid.endsWith('@lid') ? 'LID chat' : jid === 'status@broadcast' ? 'status' : 'DM'}`);
          return undefined;
        }
        const isDirectMessage = jid.endsWith('@s.whatsapp.net') || jid.endsWith('@lid');
        const payload = rest[0];
        const isProtocolAction = Boolean(payload?.delete || payload?.react || payload?.pollUpdateMessage);
        if (isDirectMessage && !isProtocolAction) {
          const check = await antiBanEngine.canSendOutbound({ chatJid: jid, isGroup: false }, true);
          if (!check.allowed) {
            console.warn(`[AntiBan] 🛡️ Blocked direct socket send: ${check.reason}`);
            throw new Error(check.reason || 'Anti-spam policy blocked this direct message.');
          }
        }
        const safeArgs = [...rest];
        if (!isProtocolAction && payload && typeof payload === 'object') {
          safeArgs[0] = OutboundSender.sanitizeOutgoingPayload(payload);
        }
        return await antiBanEngine.scheduleDispatch(jid, () => rawSendMessage(jid, ...safeArgs));
      };

      let lastStandingRefreshAt = 0;
      const refreshStanding = async (): Promise<void> => {
        const s: any = connectionSocket;
        if (this.sock !== connectionSocket) return;
        if (Date.now() - lastStandingRefreshAt < 15_000) return;
        lastStandingRefreshAt = Date.now();
        if (typeof s?.fetchAccountReachoutTimelock !== 'function') {
          console.warn('[AccountStanding] This Baileys socket cannot fetch reach-out standing; outbound pause remains until a standing update is available.');
          restrictionGuard.retryLater();
          return;
        }
        try {
          const lock = await s.fetchAccountReachoutTimelock();
          if (this.sock !== connectionSocket) return;
          console.log(`[AccountStanding] reachoutTimelock active=${lock?.isActive} type=${lock?.enforcementType} ends=${lock?.timeEnforcementEnds?.toISOString?.() || lock?.timeEnforcementEnds || 'n/a'}`);
          if (typeof lock?.isActive !== 'boolean') {
            restrictionGuard.retryLater();
            return;
          }
          restrictionGuard.apply(lock);
        } catch (err: any) {
          console.log(`[AccountStanding] check failed: ${err?.message || err}`);
          restrictionGuard.retryLater();
        }
      };
      restrictionGuard.setRefresher(refreshStanding);
      this.refreshAccountStanding = refreshStanding;
      connectionSocket.ev.on('connection.update', async (update) => {
        if (this.sock !== connectionSocket) return;
        const { connection, lastDisconnect, qr } = update;

        // Live restriction updates pushed by WhatsApp
        if ((update as any).reachoutTimeLock) {
          restrictionGuard.apply((update as any).reachoutTimeLock);
        }

        if (qr) {
          this.latestQr = qr;
          console.log('\n📱 SCAN THE QR CODE BELOW (OR OPEN /qr ON THE SERVER) TO CONNECT WHATSAPP:');
          qrcode.generate(qr, { small: true });
        }

        // Request deterministic pairing code (ADEM1234) ONCE right when the initial QR noise handshake is ready
        if (qr && !this.isRegistered() && !this.pairingRequested) {
          this.pairingRequested = true;
          const phoneNumber = config.bot.pairingPhoneNumber || '07058967815';
          const cleanNumber = formatPhoneNumberForPairing(phoneNumber);
          if (cleanNumber && this.sock) {
            setTimeout(async () => {
              if (!this.sock || this.isRegistered()) return;
              try {
                console.log(`[WhatsAppClient] Requesting clean pairing code for +${cleanNumber}...`);
                let code: string;
                try {
                  code = await this.sock.requestPairingCode(cleanNumber, 'ADEM1234');
                } catch {
                  code = await this.sock.requestPairingCode(cleanNumber);
                }
                this.latestPairingCode = code;
                this.latestPairingCodeAt = Date.now();
                console.log('\n======================================================');
                console.log(`📱 YOUR WHATSAPP PAIRING CODE: ${code} (ADEM-1234)`);
                console.log('------------------------------------------------------');
                console.log(`Phone Number: +${cleanNumber} (${phoneNumber})`);
                console.log('1. Open WhatsApp on your phone');
                console.log('2. Go to Settings > Linked Devices > Link a Device');
                console.log('3. Tap "Link with phone number instead"');
                console.log(`4. Enter code: ${code}`);
                console.log('======================================================\n');
              } catch (err: any) {
                console.error(`[WhatsAppClient] Error requesting pairing code:`, err.message);
                this.pairingRequested = false;
              }
            }, 800);
          }
        }

        if (connection === 'close') {
          this.stopKeepAlive();
          healthMonitor.setConnectionStatus(false);
          const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode;
          const errorMsg = (lastDisconnect?.error as any)?.message || (lastDisconnect?.error as any)?.output?.payload?.message || '';
          const isStreamConflict = errorMsg.includes('conflict') || errorMsg.includes('Stream Errored');
          const isRegistered = this.isRegistered();
          const isExplicitLogout =
            statusCode === DisconnectReason.loggedOut &&
            (errorMsg.toLowerCase().includes('logged out') || (lastDisconnect?.error as any)?.output?.payload?.message === 'Logged Out');

          console.log(
            `[WhatsAppClient] Connection closed (statusCode: ${statusCode}, reason: ${errorMsg || 'unknown'}). Registered: ${isRegistered}.`
          );

          this.stopUnrepliedScanner();

          if (isExplicitLogout) {
            console.error(
              '🚨 [WhatsAppClient] Session was logged out by WhatsApp (Explicit Logout). Clearing stale credentials and starting fresh pairing/QR session automatically...'
            );
            this.sessionBundleInvalidated = true;
            this.loggedOutRetryCount = 0;
            this.pairingRequested = false;
            this.latestPairingCode = null;
            this.latestQr = null;
            try {
              if (fs.existsSync(config.paths.sessions)) {
                fs.rmSync(config.paths.sessions, { recursive: true, force: true });
              }
            } catch {}
            this.scheduleReconnect(1500);
            return;
          }

          // Handle 401 Disconnect / Connection Failure
          if (statusCode === 401 || statusCode === DisconnectReason.loggedOut || errorMsg.includes('Connection Failure')) {
            if (isRegistered) {
              this.loggedOutRetryCount++;
              if (this.loggedOutRetryCount <= 3) {
                console.log(
                  `[WhatsAppClient] 401 Disconnect / Connection Failure (attempt ${this.loggedOutRetryCount}/3). Waiting 5s in case of rolling deploy conflict...`
                );
                this.scheduleReconnect(5000);
                return;
              }
              console.error(
                '🚨 [WhatsAppClient] Session credentials permanently rejected by WhatsApp (401 Unauthorized after 3 retries). Clearing invalid credentials and generating clean pairing code ADEM1234...'
              );
            }
            this.sessionBundleInvalidated = true;
            this.loggedOutRetryCount = 0;
            this.pairingRequested = false;
            this.latestPairingCode = null;
            this.latestQr = null;
            try {
              if (fs.existsSync(config.paths.sessions)) {
                fs.rmSync(config.paths.sessions, { recursive: true, force: true });
              }
            } catch {}
            this.scheduleReconnect(1000);
            return;
          }

          // If unlinked pairing attempt closed for ANY reason (428, 408, 401), wipe partial creds so next loop starts a clean RegistrationNode with ADEM1234
          if (!isRegistered) {
            console.log('[WhatsAppClient] Unlinked pairing socket closed. Resetting partial credentials to keep pairing code ADEM1234 active...');
            try {
              if (fs.existsSync(config.paths.sessions)) {
                fs.rmSync(config.paths.sessions, { recursive: true, force: true });
              }
            } catch {}
            this.pairingRequested = false;
          }

          // Fast instant reconnect for common socket resets (428 Connection Terminated, 408 ECONNRESET/Connection Lost, 515 restartRequired)
          if (
            statusCode === DisconnectReason.restartRequired ||
            statusCode === DisconnectReason.connectionClosed ||
            statusCode === DisconnectReason.connectionLost ||
            statusCode === 428 ||
            statusCode === 408 ||
            errorMsg.includes('Connection Terminated') ||
            errorMsg.includes('ECONNRESET') ||
            errorMsg.includes('Connection Closed')
          ) {
            console.log(`[WhatsAppClient] Transient socket reset (code: ${statusCode}, reason: ${errorMsg || 'socket drop'}). Reconnecting in 800ms...`);
            this.scheduleReconnect(800);
            return;
          }

          // If Stream Errored (conflict), wait 5s before reconnecting so any older container/socket finishes closing
          if (isStreamConflict) {
            console.log('[WhatsAppClient] Stream conflict detected; waiting 5s before reconnecting...');
            this.scheduleReconnect(5000);
            return;
          }

          // Automatic exponential backoff reconnection for server deployment
          this.reconnectAttempts++;
          const delay = Math.min(2000 * Math.pow(1.5, Math.min(this.reconnectAttempts, 6)), 30000);
          console.log(
            `[WhatsAppClient] Auto-reconnecting (attempt #${this.reconnectAttempts}) in ${(delay / 1000).toFixed(1)}s...`
          );
          this.scheduleReconnect(delay);
        } else if (connection === 'open') {
          this.cancelReconnect();
          this.reconnectAttempts = 0;
          this.loggedOutRetryCount = 0;
          this.pairingRequested = false;
          this.latestPairingCode = null;
          this.latestQr = null;
          healthMonitor.setConnectionStatus(true);
          if (this.isRegistered()) { this.autoBackupSessionToRender(); }
          this.startKeepAlive();
          this.startUnrepliedScanner();

          const ownerJid = config.bot.owners[0] || '';
          healthMonitor.startMonitoring(this.sock!, ownerJid);
          analyticsEngine.startPeriodicReports(this.sock!, ownerJid);
          this.syncGroups().catch((err) => console.warn('[WhatsAppClient] Error syncing groups on connect:', err?.message || err));
          console.log('✅ [WhatsAppClient] Connection established, contact replies cycle & server watchdog active!');

          // Check account standing immediately; the guard holds DMs until this confirms unlocked status.
          const diagSock: any = this.sock;
          void (async () => {
            await this.refreshAccountStanding?.();
            try {
              if (this.sock === diagSock && typeof diagSock?.fetchNewChatMessageCap === 'function') {
                const cap = await diagSock.fetchNewChatMessageCap();
                console.log(`[AccountStanding] newChatCap=${JSON.stringify(cap)}`);
              }
            } catch (err: any) {
              console.log(`[AccountStanding] check failed: ${err?.message || err}`);
            }
          })();
        }
      });

      // Synchronize historical messages and contacts sent by WhatsApp Web history sync
      this.sock.ev.on('messaging-history.set', async ({ chats, contacts, messages }) => {
        try {
          console.log(
            `[WhatsAppClient] History sync received: ${chats?.length || 0} chats, ${contacts?.length || 0} contacts, ${messages?.length || 0} messages`
          );

          if (contacts && contacts.length > 0) {
            for (const c of contacts) {
              if (c.id && !c.id.endsWith('@g.us')) {
                await contactService.syncWhatsAppContact(c);
              }
            }
          }

          // Also collect any embedded messages inside chat objects (e.g. unread DM conversations)
          const allSyncMessages: WAMessage[] = [...(messages || [])] as WAMessage[];
          if (chats && chats.length > 0) {
            for (const chat of chats) {
              if (chat.id && !chat.id.endsWith('@g.us') && (chat.name || (chat as any).notify)) {
                await contactService.autoSaveContact(chat.id, chat.name || (chat as any).notify);
              } else if (chat.id && chat.id.endsWith('@g.us') && (chat.name || (chat as any).subject)) {
                await upsertKnownGroup(chat.id, chat.name || (chat as any).subject);
              }
              const embedded = (chat as any).messages;
              if (Array.isArray(embedded)) {
                for (const item of embedded) {
                  const m = item?.message || item;
                  if (m?.key) {
                    allSyncMessages.push(m);
                  }
                }
              }
            }
          }

          let loggedDmCount = 0;
          if (allSyncMessages.length > 0) {
            const parseTs = (raw: any): number => {
              const val =
                typeof raw?.toNumber === 'function'
                  ? raw.toNumber()
                  : typeof raw?.low === 'number'
                  ? (raw.unsigned ? raw.low : (raw.low >>> 0))
                  : Number(raw);
              const n = Number(val);
              return n > 1e11 ? n : n > 0 ? n * 1000 : 0;
            };

            // Sort messages chronologically (oldest first) so auto-increment id matches chronological order
            const sortedMessages = [...allSyncMessages].sort((a, b) => {
              return parseTs(a.messageTimestamp) - parseTs(b.messageTimestamp);
            });

            for (const msg of sortedMessages) {
              if (msg.key?.id && msg.message) {
                this.messageStore.set(msg.key.id, msg.message);
              }
              const normalized = normalizeMessage(msg);
              if (normalized && (normalized.text || normalized.contentType)) {
                const msgTs = parseTs(msg.messageTimestamp) || (Date.now() - 86400_000);
                await chatLogger.logMessage({
                  chatJid: normalized.chatJid,
                  senderJid: msg.key?.fromMe ? 'bot' : normalized.senderJid,
                  senderName: msg.key?.fromMe ? config.bot.name : normalized.senderName,
                  isGroup: normalized.isGroup,
                  contentType: normalized.contentType,
                  messageText: normalized.text,
                  stickerFilename: normalized.stickerFilename,
                  timestamp: msgTs,
                });
                if (!normalized.isGroup && !msg.key?.fromMe) {
                  await contactService.autoSaveContact(normalized.senderJid, normalized.senderName);
                  loggedDmCount++;
                }
              }
            }
          }
        } catch (err: any) {
          console.error('[WhatsAppClient] Error processing messaging-history.set:', err.message);
        }
      });

      // Raw protocol diagnostics for outbound delivery: server ACK/NACK (with error code) and raw receipts.
      try {
        const ws: any = (this.sock as any).ws;
        ws?.on?.('CB:ack,class:message', (node: any) => {
          const a = node?.attrs || {};
          if (a.error || (a.id && OutboundSender.isDispatchedId(a.id))) {
            console.log(`[WA-Ack] id=${String(a.id || '').slice(-8)} from=${a.from || '?'} error=${a.error || 'none'}`);
          }
          // 463 = account restricted / missing privacy token: re-check standing so the pause engages.
          if (String(a.error) === '463') {
            this.refreshAccountStanding?.().catch(() => {});
          }
        });
        ws?.on?.('CB:receipt', (node: any) => {
          const a = node?.attrs || {};
          if (a.id && OutboundSender.isDispatchedId(a.id)) {
            console.log(`[WA-Receipt] id=${String(a.id).slice(-8)} from=${a.from || '?'} participant=${a.participant || '-'} type=${a.type || 'delivery'}`);
          }
        });
      } catch {}

      // Track WhatsApp message delivery receipts (SERVER_ACK ✓, DELIVERY_ACK ✓✓, READ ✓✓)
      this.sock.ev.on('messages.update', (updates) => {
        try {
          for (const u of updates) {
            const msgId = u.key?.id;
            const remoteJid = u.key?.remoteJid || '';
            const status = Number(u.update?.status || 0);
            if (msgId && u.key?.fromMe && OutboundSender.isDispatchedId(msgId)) {
              console.log(`[Receipt] messages.update id=${msgId.slice(-8)} chat=${remoteJid} status=${status}`);
            }
            if (msgId && status >= 2) {
              this.recordDeliveryStatus(msgId, remoteJid, status);
            }
          }
        } catch {}
      });

      this.sock.ev.on('message-receipt.update', (receipts) => {
        try {
          for (const r of receipts) {
            const msgId = r.key?.id;
            const remoteJid = r.key?.remoteJid || '';
            const receipt = r.receipt;
            const status = receipt?.readTimestamp ? 4 : receipt?.receiptTimestamp ? 3 : 2;
            if (msgId && OutboundSender.isDispatchedId(msgId)) {
              console.log(`[Receipt] message-receipt.update id=${msgId.slice(-8)} chat=${remoteJid} user=${receipt?.userJid || '?'} status=${status}`);
            }
            if (msgId) {
              this.recordDeliveryStatus(msgId, remoteJid, status);
            }
          }
        } catch {}
      });

      // Passively record new contacts synced from phonebook
      this.sock.ev.on('contacts.upsert', async (contacts) => {
        try {
          for (const c of contacts) {
            if (c.id && !c.id.endsWith('@g.us')) {
              await contactService.syncWhatsAppContact(c);
            }
          }
        } catch {}
      });

      // Passively extract any unread DM messages attached to chats.upsert events
      this.sock.ev.on('chats.upsert', async (newChats) => {
        try {
          for (const chat of newChats) {
            if (chat.id && chat.id.endsWith('@g.us')) {
              if (chat.name || (chat as any).subject) {
                await upsertKnownGroup(chat.id, chat.name || (chat as any).subject);
              }
              continue;
            }
            if (!chat.id || chat.id.includes('broadcast')) continue;
            if (chat.name || (chat as any).notify) {
              await contactService.autoSaveContact(chat.id, chat.name || (chat as any).notify);
            }
            const embedded = (chat as any).messages;
            if (Array.isArray(embedded)) {
              for (const item of embedded) {
                const m = item?.message || item;
                if (!m?.key) continue;
                const normalized = normalizeMessage(m);
                if (normalized && !normalized.isGroup && (normalized.text || normalized.contentType)) {
                  const rawVal =
                    typeof (m.messageTimestamp as any)?.toNumber === 'function'
                      ? (m.messageTimestamp as any).toNumber()
                      : typeof (m.messageTimestamp as any)?.low === 'number'
                      ? ((m.messageTimestamp as any).unsigned ? (m.messageTimestamp as any).low : ((m.messageTimestamp as any).low >>> 0))
                      : Number(m.messageTimestamp);
                  const n = Number(rawVal);
                  const ts = n > 1e11 ? n : n > 0 ? n * 1000 : (Date.now() - 86400_000);
                  await chatLogger.logMessage({
                    chatJid: normalized.chatJid,
                    senderJid: m.key?.fromMe ? 'bot' : normalized.senderJid,
                    senderName: m.key?.fromMe ? config.bot.name : normalized.senderName,
                    isGroup: false,
                    contentType: normalized.contentType,
                    messageText: normalized.text,
                    stickerFilename: normalized.stickerFilename,
                    timestamp: ts,
                  });
                }
              }
            }
          }

        } catch {}
      });

      // Passively record group subject updates
      this.sock.ev.on('groups.update', async (updates) => {
        try {
          for (const u of updates) {
            if (u.id && u.subject) {
              await upsertKnownGroup(u.id, u.subject);
            }
          }
        } catch {}
      });

      // Message handler. Log only aggregate metadata so we can distinguish missing
      // Baileys events from messages dropped later, without logging message text or JIDs.
      this.sock.ev.on('messages.upsert', async (event) => {
        const messages = event.messages || [];
        const incoming = messages.filter((msg) => !msg.key?.fromMe);
        const incomingDms = incoming.filter((msg) => {
          const jid = msg.key?.remoteJid || '';
          return Boolean(jid) && !jid.endsWith('@g.us') && !jid.includes('broadcast') && !jid.endsWith('@newsletter');
        });
        const dmLids = incomingDms.filter((msg) => msg.key?.remoteJid?.endsWith('@lid')).length;
        const dmPns = incomingDms.filter((msg) => msg.key?.remoteJid?.endsWith('@s.whatsapp.net')).length;
        const groups = incoming.filter((msg) => msg.key?.remoteJid?.endsWith('@g.us')).length;
        const missingContent = incoming.filter((msg) => !msg.message).length;
        console.log(
          `[BaileysInbound] upsert type=${event.type || 'unknown'} batch=${messages.length} inboundDm=${incomingDms.length} dmLid=${dmLids} dmPn=${dmPns} groups=${groups} missingContent=${missingContent}`
        );

        for (const msg of messages) {
          try {
            await this.processIncomingMessage(msg);
          } catch (err: any) {
            const errorName = err instanceof Error ? err.name : typeof err;
            const chatType = msg.key?.remoteJid?.endsWith('@g.us')
              ? 'group'
              : msg.key?.remoteJid?.endsWith('@lid')
                ? 'lid_dm'
                : msg.key?.remoteJid?.endsWith('@s.whatsapp.net')
                  ? 'phone_dm'
                  : 'other';
            console.error(`[BaileysInbound] process failed chatType=${chatType} errorType=${errorName}`);
          }
        }
      });
    } finally {
      this.isConnecting = false;
    }
  }

  /**
   * Fetches all WhatsApp groups the bot is currently participating in and syncs them to SQLite.
   */
  public async syncGroups(): Promise<void> {
    if (!this.sock?.groupFetchAllParticipating) return;
    try {
      const participating = await this.sock.groupFetchAllParticipating();
      const botNumber = this.sock.user?.id ? `${this.sock.user.id.split(':')[0].split('@')[0]}@s.whatsapp.net` : '';
      const botLid = this.sock.user?.lid ? `${this.sock.user.lid.split(':')[0].split('@')[0]}@lid` : '';

      for (const group of Object.values(participating) as any[]) {
        if (!group.id || !group.subject) continue;
        const isAdmin = Boolean(
          group.participants?.some((p: any) => {
            const pId = p.id ? `${p.id.split(':')[0].split('@')[0]}@${p.id.split('@')[1] || 's.whatsapp.net'}` : '';
            const pLid = p.lid ? `${p.lid.split(':')[0].split('@')[0]}@lid` : '';
            return (
              (p.admin === 'admin' || p.admin === 'superadmin') &&
              (p.id === this.sock?.user?.id || pId === botNumber || pLid === botLid)
            );
          })
        );
        await upsertKnownGroup(group.id, group.subject, group.participants?.length || 0, isAdmin);
      }
      console.log(`[WhatsAppClient] 👥 Synced ${Object.keys(participating).length} participating groups into memory.`);
    } catch (err: any) {
      console.warn('[WhatsAppClient] Failed to fetch participating groups:', err?.message || err);
    }
  }

  /**
   * Processes a single incoming Baileys message through normalization, passive analytics,
   * security/spam checks, self-introduction, and LLM reasoning.
   */
  public async processIncomingMessage(msg: WAMessage): Promise<void> {
    if (msg.key?.id && msg.message) {
      this.messageStore.set(msg.key.id, msg.message);
      if (this.messageStore.size > 2000) {
        const first = this.messageStore.keys().next().value;
        if (first) this.messageStore.delete(first);
      }
    }

    // Safely parse timestamp even if deserialized as protobuf Long object
    const rawVal =
      typeof (msg.messageTimestamp as any)?.toNumber === 'function'
        ? (msg.messageTimestamp as any).toNumber()
        : typeof (msg.messageTimestamp as any)?.low === 'number'
        ? ((msg.messageTimestamp as any).unsigned ? (msg.messageTimestamp as any).low : ((msg.messageTimestamp as any).low >>> 0))
        : Number(msg.messageTimestamp);
    const numTs = Number(rawVal);
    const msgTime = numTs > 1e11 ? numTs : numTs > 0 ? numTs * 1000 : Date.now();
    const effectiveMsgTime = !isNaN(msgTime) && msgTime > 0 ? Math.min(msgTime, Date.now()) : Date.now();

    // 1. Check if this is an automated outbound message sent by OutboundSender
    const isBotDispatched = Boolean(msg.key?.id && OutboundSender.isDispatchedId(msg.key.id));
    if (isBotDispatched) {
      if (msg.key?.id && msg.key?.remoteJid) {
        this.recordDeliveryStatus(msg.key.id, msg.key.remoteJid, Number(msg.status || 2));
      }
      return;
    }

    // 2. Distinguish "Message Yourself" (user testing on their own WhatsApp phone) vs user texting a 3rd party
    const cleanRemote = (msg.key?.remoteJid || '').split('@')[0].split(':')[0];
    const botOwnDigits = (this.sock?.user?.id || '').split('@')[0].split(':')[0] || '2347058967815';
    const isMessageToSelf =
      Boolean(msg.key?.fromMe) &&
      !msg.key?.remoteJid?.endsWith('@g.us') &&
      (cleanRemote === botOwnDigits || cleanRemote === '2347058967815' || cleanRemote === config.bot.pairingPhoneNumber);

    // If fromMe and NOT Message Yourself, the owner is manually texting someone else: do not intervene!
    if (msg.key?.fromMe && !isMessageToSelf) {
      if (msg.key?.id && msg.key?.remoteJid) {
        this.recordDeliveryStatus(msg.key.id, msg.key.remoteJid, Number(msg.status || 2));
      }
      const normalized = normalizeMessage(msg);
      if (normalized && (normalized.text || normalized.contentType)) {
        await chatLogger.logMessage({
          chatJid: normalized.chatJid,
          senderJid: 'bot',
          senderName: config.bot.name,
          isGroup: normalized.isGroup,
          contentType: normalized.contentType,
          messageText: normalized.text,
          stickerFilename: normalized.stickerFilename,
          timestamp: effectiveMsgTime,
        });
      }
      return;
    }

    // 3. Handle live incoming messages from WhatsApp Channels (Quotes📖 & Memes) with media attachments
    if (msg.key?.remoteJid?.endsWith('@newsletter')) {
      await this.handleNewsletterMessage(msg);
      return;
    }

    // 3b. Anti-ViewOnce Interceptor: Vault any incoming View-Once media before it expires or is opened
    await this.interceptViewOnceMessage(msg);

    const normalized = normalizeMessage(msg);
    if (!normalized) return;

    // If Message Yourself, set sender to the owner so owner recognition triggers properly
    if (isMessageToSelf) {
      normalized.senderJid = config.bot.owners[0] || '2348108574293@s.whatsapp.net';
      normalized.senderName = 'Ademola';
    }

    const trainingConsent = chatLogger.parseTrainingConsentDirective(normalized.text || '');
    if (trainingConsent !== null && !normalized.isGroup) {
      await chatLogger.setTrainingConsent(normalized.senderJid, trainingConsent);
      const consentReply = trainingConsent
        ? 'Training consent is on. Future text exchanges from you may be used in filtered training examples; you can send “!training forget” any time to opt out.'
        : 'Training consent is off. Your future messages will be excluded from training exports, and your prior live examples will be removed the next time the training dataset is rebuilt.';
      if (this.sock) {
        const isOwner = userProfileManager.isOwner(normalized.senderJid, normalized.senderName);
        await OutboundSender.replyText(this.sock, normalized.chatJid, consentReply, msg, isOwner, false, undefined, true);
      }
      return;
    }

    // 1. Passive Continuous Learning & Analytics: Log EVERY message in all chats
    const inboundLogId = await chatLogger.logMessage({
      chatJid: normalized.chatJid,
      senderJid: normalized.senderJid,
      senderName: normalized.senderName,
      isGroup: normalized.isGroup,
      contentType: normalized.contentType,
      messageText: normalized.text,
      stickerFilename: normalized.stickerFilename,
      messageId: msg.key?.id || undefined,
      timestamp: effectiveMsgTime,
    });

    // Record message health and analytics
    healthMonitor.recordMessage();
    await analyticsEngine.trackEvent('message', { type: normalized.contentType }, normalized.chatJid, normalized.senderJid);

    // Persistent User Profile Tracking across all chats
    await userProfileManager.upsertProfile(normalized.senderJid, normalized.senderName);
    await userProfileManager.observeMessageLanguage(normalized.senderJid, normalized.text || '');

    // Automatic Contact Saving: passively record and index all contacts
    const contactSaveStatus = await contactService.autoSaveContact(normalized.senderJid, normalized.senderName);

    // Continuous ML Learning: updates linguistic metrics, humor exemplars, and style patterns on every turn
    await patternMiner.analyzeInteraction(normalized.chatJid);
    await batchLearner.recordExchange(normalized.chatJid, normalized.senderJid);

    // Historical Backlog Evaluation:
    // Drop messages older than 10 minutes to avoid answering ancient messages on boot,
    // while giving plenty of leeway for redeploys, reboot delays, or short clock skews.
    if (!isNaN(msgTime) && msgTime > 0 && Date.now() - msgTime > 600_000) {
      if (!normalized.isGroup && msgTime >= this.sessionStartedAt - 15 * 60 * 1000) {
        this.scheduleUnrepliedScan(12_000);
      }
      return;
    }

    // Passive Group Admin: Check and delete unauthorized group invite links
    if (normalized.isGroup && normalized.text && this.sock) {
      const wasLinkDeleted = await groupAdminPlugin.handleAntiLink(
        this.sock,
        msg,
        normalized.chatJid,
        normalized.senderJid,
        normalized.text
      );
      if (wasLinkDeleted) return;
    }

    // Autonomous Suspicious Link Sentinel & Scam Inspector
    if (normalized.text && this.sock && !msg.key?.fromMe) {
      const urlMatches = normalized.text.match(/\bhttps?:\/\/[^\s<>"'()]+\b/gi);
      if (urlMatches && urlMatches.length > 0) {
        for (const url of urlMatches) {
          const report = await inspectUrlSafety(url);
          if (report.isSuspicious) {
            console.log(`[LinkSentinel] 🚨 High-risk link detected from ${normalized.senderName}: ${url} (${report.verdict})`);
            const senderDigits = normalized.senderJid.split('@')[0].split(':')[0];

            if (normalized.isGroup) {
              let botIsAdmin = false;
              try {
                const meta = await this.sock.groupMetadata(normalized.chatJid);
                const botNum = this.sock.user?.id ? this.sock.user.id.split(':')[0].split('@')[0] : '';
                const botLid = this.sock.user?.lid ? this.sock.user.lid.split(':')[0].split('@')[0] : '';
                const me = meta?.participants?.find((p: any) => {
                  const pNum = p.id ? p.id.split(':')[0].split('@')[0] : '';
                  const pLid = p.lid ? p.lid.split(':')[0].split('@')[0] : '';
                  return pNum === botNum || (botLid && pLid === botLid);
                });
                botIsAdmin = Boolean(me && (me.admin === 'admin' || me.admin === 'superadmin'));
              } catch {}

              if (botIsAdmin) {
                try {
                  await this.sock.sendMessage(normalized.chatJid, { delete: msg.key });
                } catch {}

                const adminWarn = `🛡️ *ADMIN SECURITY WARNING* 🚨\nAttention @${senderDigits}:\nThe link you posted was scanned by security sentinel and flagged as a high-risk threat:\n• *Verdict*: ${report.verdict.toUpperCase()}\n• *Reason*: ${report.reason}\n\nPosting deceptive links, phishing portals, or fraudulent schemes violates group rules. Further violations will result in removal.`;
                await OutboundSender.replyText(
                  this.sock,
                  normalized.chatJid,
                  adminWarn,
                  undefined,
                  false,
                  false,
                  [normalized.senderJid]
                );
                return;
              } else {
                const pidginWarn = `🚨 *SCAM ALERT! MAKE UNA SHINE YOUR EYES O!* ⚠️\nOmo @${senderDigits}, which kind link you drop so? That link dey smell fishy die! 🐟\n• *Wetin dey happen*: ${report.reason}\n\nAbeg everybody for this group, make nobody click that link or put any pin/BVN/password o! Na format dem dey use clear people money. No fall for this kind scam! 🛑`;
                await OutboundSender.replyText(
                  this.sock,
                  normalized.chatJid,
                  pidginWarn,
                  undefined,
                  false,
                  false,
                  [normalized.senderJid]
                );
                return;
              }
            } else {
              const dmWarn = `⚠️ *Security Sentinel Warning:*\nThe link you sent appears to be dangerous/fraudulent:\n• *Verdict*: ${report.verdict.toUpperCase()}\n• *Reason*: ${report.reason}\n\nPlease do not click it, enter any personal credentials, or transfer money to this platform.`;
              await OutboundSender.replyText(this.sock, normalized.chatJid, dmWarn);
              return;
            }
          }
        }
      }
    }


    // Passive Anti-Spam Moderation for Groups only (prevent accidental DM blockage)
    if (normalized.isGroup && this.sock) {
      const spamStatus = await antiSpamFilter.checkMessage(
        normalized.senderJid,
        normalized.chatJid,
        normalized.text || '',
        this.sock,
        msg
      );
      if (spamStatus.isSpam) {
        await analyticsEngine.trackEvent('spam_blocked', { action: spamStatus.action }, normalized.chatJid, normalized.senderJid);
        return;
      }
    }

    // 2. Trigger Evaluation (DM vs Group @mention/quote)
    const botJid = this.sock?.user?.id || '';
    const botLid = this.sock?.user?.lid || '';
    const { shouldRespond, cleanedText } = await shouldRespondToMessage(
      msg,
      botJid,
      normalized.text,
      botLid
    );

    if (!shouldRespond) return;

    // While WhatsApp has the account restricted, 1:1 replies would be rejected (and retries can extend
    // the lock). Skip DM handling; the message is already logged and is answered by the catch-up scan later.
    if (!normalized.isGroup && restrictionGuard.isActive()) {
      restrictionGuard.logSkip('DM reply');
      return;
    }
    // Fast-Path for Bot Owner: Private DM View-Once Retrieval
    const isOwnerDmUser = userProfileManager.isOwner(normalized.senderJid, normalized.senderName);
    if (!normalized.isGroup && isOwnerDmUser && normalized.text) {
      const trimmedLower = normalized.text.trim().toLowerCase();
      const isVoCmd =
        /^(?:[./!]?(?:rvo|viewonce|view\s*once)|(?:get|show|send|retrieve|give\s*me)\s+(?:the\s+)?(?:last\s+)?view\s*once)/i.test(
          trimmedLower
        );

      if (isVoCmd && this.sock) {
        const numMatch = trimmedLower.match(/\b(\d+)\b/);
        const targetIndex = numMatch ? parseInt(numMatch[1], 10) : 1;

        let queryFilter: string | undefined = undefined;
        const nameMatch = trimmedLower.match(/(?:from|by)\s+([a-z0-9_\-\s]{2,20})/i);
        if (nameMatch) {
          queryFilter = nameMatch[1].trim();
        }

        const records = await getLatestViewOnceMessages(10, queryFilter);
        if (records.length === 0) {
          await OutboundSender.replyText(
            this.sock,
            normalized.chatJid,
            queryFilter
              ? `🔍 No captured View-Once media found matching "${queryFilter}" in the vault.`
              : `📦 No captured View-Once media currently stored in the vault.`,
            msg,
            true
          );
          return;
        }

        const idx = Math.max(0, targetIndex - 1);
        const selected = records[idx] || records[0];

        await deliverViewOnceMediaToOwner(this.sock, normalized.chatJid, selected, msg);

        if (records.length > 1 && targetIndex === 1) {
          setTimeout(async () => {
            try {
              await OutboundSender.replyText(
                this.sock!,
                normalized.chatJid,
                `💡 *Tip:* There are *${records.length}* total View-Once media items vaulted. Reply with *.viewonce 2* to see earlier ones.`,
                undefined,
                true
              );
            } catch {}
          }, 1500);
        }
        return;
      }
    }

    // Handle Incoming Stickers: Parse vibe and reply with a matching sticker from our catalog!
    if (normalized.contentType === 'sticker') {
      await this.handleIncomingSticker(msg, normalized);
      return;
    }

    // Inbound Reply Routing: If this is a DM reply from someone who was messaged on behalf of another user/group,
    // automatically route their reply back to whoever told the bot to message them, NEVER to owner Ademola!
    if (!normalized.isGroup && this.sock && (normalized.text || normalized.contentType)) {
      const senderPhone = contactService.extractPhoneNumber(normalized.senderJid);
      const activeRelay = await findActiveRelaySession(normalized.senderJid, senderPhone);

      if (activeRelay) {
        console.log(
          `[RelayRouting] 🎯 Inbound reply from messaged contact ${normalized.senderJid} -> routing back to origin chat ${activeRelay.origin_chat_jid} (requester: ${activeRelay.requester_jid})`
        );

        const savedContact = await contactService.getContact(normalized.senderJid);
        const contactName =
          savedContact?.custom_name ||
          savedContact?.display_name ||
          normalized.senderName ||
          (senderPhone ? `+${senderPhone}` : 'Contact');
        const replyBody = normalized.text || `[Sent ${normalized.contentType}]`;

        // Send confirmation/acknowledgement to the contact in DM
        const requesterDisplayName = activeRelay.requester_name || 'them';
        await OutboundSender.replyText(
          this.sock,
          normalized.chatJid,
          `Got it! I don forward your reply give ${requesterDisplayName} sharp sharp. 🤝`,
          msg
        );

        // Forward the reply to the origin chat / requester (and NOT to Ademola unless Ademola requested it)
        if (activeRelay.origin_is_group) {
          const reqPhone = contactService.extractPhoneNumber(activeRelay.requester_jid);
          const mentionTag = reqPhone ? `@${reqPhone}` : `@${activeRelay.requester_jid.split('@')[0]}`;
          const relayNotice = `💬 *Reply from ${contactName}*:\n"${replyBody}"\n\n_CC: ${mentionTag}_`;

          await OutboundSender.replyText(
            this.sock,
            activeRelay.origin_chat_jid,
            relayNotice,
            undefined,
            true,
            false,
            [activeRelay.requester_jid]
          );
        } else {
          const relayNotice = `💬 *Reply from ${contactName}*:\n"${replyBody}"`;

          await OutboundSender.replyText(
            this.sock,
            activeRelay.origin_chat_jid,
            relayNotice,
            undefined,
            true
          );
        }

        await markRelaySessionReplied(activeRelay.id);
        return;
      }
    }

    // Per-User Token Rate Limiter (protect against spamming bot reasoning loop; owners are exempt)
    const isOwnerUser = userProfileManager.isOwner(normalized.senderJid, normalized.senderName);
    if (!isOwnerUser) {
      const limitStatus = userRateLimiter.checkLimit(normalized.senderJid);
      if (!limitStatus.allowed) {
        console.warn(`[UserRateLimiter] User ${normalized.senderJid} throttled. Reset in ${limitStatus.resetInSeconds}s`);
        if (this.sock) {
          await OutboundSender.replyText(
            this.sock,
            normalized.chatJid,
            `Take a breather small! Try again in ${limitStatus.resetInSeconds}s.`,
            msg
          );
        }
        return;
      }
      userRateLimiter.consumeToken(normalized.senderJid);
    }

    // Passive Contact Introduction Tracking (no unsolicited canned message)
    if (!normalized.isGroup && contactSaveStatus.needsIntroduction) {
      await contactService.markIntroduced(normalized.senderJid);
    }

    let promptText = cleanedText;
    const isIncomingVoiceNote = normalized.contentType === 'audio';

    // Process Voice Notes: Listen to voice notes and transcribe with Groq Whisper
    if (isIncomingVoiceNote) {
      try {
        console.log(`[WhatsAppClient] Downloading voicenote from ${normalized.senderName}...`);
        const audioBuffer = (await downloadMediaMessage(msg, 'buffer', {})) as Buffer;

        // If sent by creator & owner Ademola, save as a high-fidelity voice sample for ElevenLabs voice cloning
        if (isOwnerUser && audioBuffer && audioBuffer.length > 5000) {
          try {
            const voiceDir = path.resolve('./data/voice_samples');
            if (!fs.existsSync(voiceDir)) fs.mkdirSync(voiceDir, { recursive: true });
            const sampleFile = path.join(voiceDir, 'ademola_voice_sample.ogg');
            fs.writeFileSync(sampleFile, audioBuffer);
            await setBotSetting('ademola_voice_sample_at', String(Date.now()));
            await setBotSetting('ademola_voice_sample_path', sampleFile);
            console.log(`[WhatsAppClient] 🎙️ Saved fresh voice sample from Ademola (${audioBuffer.length} bytes) for TTS voice cloning!`);
          } catch (sampleErr: any) {
            console.warn('[WhatsAppClient] Could not save voice sample:', sampleErr.message);
          }
        }

        const analysis = await analyzeVoiceNote(audioBuffer);
        const transcript = analysis?.transcript || null;
        const summary = analysis?.summary || '';

        if (transcript) {
          if (!normalized.isGroup && this.sock) {
            const vnCard = `🎙️ *Voice Note Transcribed:*\n"${transcript}"\n\n💡 *Summary:*\n${summary}`;
            await OutboundSender.replyText(this.sock, normalized.chatJid, vnCard, msg);
          }
          promptText = `[User sent a voice message]: "${transcript}"\n[Voice Note Summary]: "${summary}"\n(Reply naturally and clearly to their voice note in authentic Nigerian WhatsApp flow)`;
        } else {
          promptText = `[User sent a voice message — reply with a natural text response]`;
        }
      } catch (err: any) {
        console.error('[WhatsAppClient] Voicenote processing error:', err.message);
        promptText = `[User sent a voice message — reply with a natural text response]`;
      }
      await chatLogger.updateLatestMessageText(normalized.chatJid, 'audio', promptText);
    } else if (normalized.contentType === 'image') {
      // Process Image: Read visual content with Vision
      try {
        console.log(`[WhatsAppClient] Reading image content from ${normalized.senderName}...`);
        const imgBuffer = (await downloadMediaMessage(msg, 'buffer', {})) as Buffer;
        const visionDesc = await analyzeImageBuffer(imgBuffer, cleanedText);
        if (visionDesc) {
          promptText = `[Visual Content Analysis of Attached Image]:\n${visionDesc}\n\nUser Question/Caption: ${cleanedText || 'Describe and answer based on this image'}`;
          await chatLogger.updateLatestMessageText(normalized.chatJid, 'image', promptText);
        } else if (!promptText) {
          promptText = `[User sent an image without caption]`;
        }
      } catch (err: any) {
        console.error('[WhatsAppClient] Image vision processing error:', err.message);
        if (!promptText) {
          promptText = `[User sent an image]`;
        }
      }
    } else if (normalized.contentType === 'document') {
      promptText = `[User sent or quoted a document: "${normalized.text}"]. Please use the read_document tool to read, inspect, and answer or summarize based on this file.`;
    }

    if (!promptText) return;

    const voiceLanguageSample = promptText.match(/message\]: "([\s\S]*?)"\n\[Voice Note Summary\]/)?.[1];
    await userProfileManager.observeMessageLanguage(
      normalized.senderJid,
      voiceLanguageSample || normalized.text || cleanedText || ''
    );

    console.log(
      `[Incoming Trigger] From: ${normalized.senderName} (${normalized.chatJid}): "${promptText.slice(0, 80)}..."`
    );

    // Contextual Message Reactions when tagged in group
    if (this.sock && messageReactor.shouldReact(promptText, normalized.isGroup)) {
      const emoji = await messageReactor.getReactionEmoji(promptText);
      await messageReactor.reactToMessage(this.sock, msg, emoji).catch(() => {});
    }

    // 3. Build Execution Context
    const sock = this.sock;
    if (!sock) return;

    const isOwner = userProfileManager.isOwner(normalized.senderJid, normalized.senderName);
    const savedContact = await contactService.getContact(normalized.senderJid);
    const effectiveSenderName = isOwner
      ? 'Ademola'
      : normalized.isGroup
        ? contactService.extractFriendlyFirstName(normalized.senderName) || normalized.senderName
        : savedContact?.custom_name || contactService.extractFriendlyFirstName(normalized.senderName) || normalized.senderName;

    const incomingCharLen = (cleanedText || promptText || '').length;

    let liveOutboundDispatched = false;
    const context: ExecutionContext = {
      sock,
      chatJid: normalized.chatJid,
      senderJid: normalized.senderJid,
      senderName: effectiveSenderName,
      isGroup: normalized.isGroup,
      rawMessage: msg,
      replyText: async (text: string) => {
        const safeQuoted = normalized.chatJid.endsWith('@lid') ? undefined : msg;

        // Simulate authentic human typing presence scaled to incoming message length, reply length, and chat type
        await antiBanEngine.simulateTypingPresence(
          sock,
          normalized.chatJid,
          text,
          false,
          incomingCharLen,
          normalized.isGroup,
          isOwner
        );
        // Always reply to the exact chat the message arrived from (never rewrite @lid -> PN).
        const res = await OutboundSender.replyText(
          sock,
          normalized.chatJid,
          text,
          safeQuoted,
          isOwner,
          false,
          undefined,
          true
        );
        if (res?.key?.id) liveOutboundDispatched = true;
        if (normalized.isGroup) {
          recordGroupInteraction(normalized.chatJid);
        }
        return res;
      },
      sendSticker: async (bufferOrPath: Buffer | string, mentions?: string[]) => {
        const safeQuoted = normalized.chatJid.endsWith('@lid') ? undefined : msg;
        const res = await OutboundSender.sendSticker(
          sock,
          normalized.chatJid,
          bufferOrPath,
          safeQuoted,
          mentions || (normalized.isGroup && normalized.senderJid ? [normalized.senderJid] : undefined),
          true
        );
        if (res?.key?.id) liveOutboundDispatched = true;
        return res;
      },
      sendImage: (bufferOrUrl: Buffer | string, caption?: string) => {
        const safeQuoted = normalized.chatJid.endsWith('@lid') ? undefined : msg;
        return OutboundSender.sendImage(sock, normalized.chatJid, bufferOrUrl, caption, safeQuoted, true)
          .then((res) => { if (res?.key?.id) liveOutboundDispatched = true; return res; });
      },
      sendAudio: (bufferOrUrl: Buffer | string, isVoiceNote?: boolean) => {
        const safeQuoted = normalized.chatJid.endsWith('@lid') ? undefined : msg;
        return OutboundSender.sendAudio(sock, normalized.chatJid, bufferOrUrl, isVoiceNote, safeQuoted, true)
          .then((res) => { if (res?.key?.id) liveOutboundDispatched = true; return res; });
      },
      sendVideo: (bufferOrUrl: Buffer | string, caption?: string) => {
        const safeQuoted = normalized.chatJid.endsWith('@lid') ? undefined : msg;
        return OutboundSender.sendVideo(sock, normalized.chatJid, bufferOrUrl, caption, safeQuoted, true)
          .then((res) => { if (res?.key?.id) liveOutboundDispatched = true; return res; });
      },
      sendContact: (displayName: string, phoneNumber: string) => {
        const safeQuoted = normalized.chatJid.endsWith('@lid') ? undefined : msg;
        return OutboundSender.sendContact(sock, normalized.chatJid, displayName, phoneNumber, safeQuoted, true)
          .then((res) => { if (res?.key?.id) liveOutboundDispatched = true; return res; });
      },
      sendPoll: (question: string, options: string[], selectableCount?: number) =>
        OutboundSender.sendPoll(sock, normalized.chatJid, question, options, selectableCount, msg)
          .then((res) => { if (res?.key?.id) liveOutboundDispatched = true; return res; }),
    };

    // 4. Dispatch via the bounded concurrency queue and shared outbound rate controls.
    const trackLiveDm = !normalized.isGroup && Number.isSafeInteger(inboundLogId) && Number(inboundLogId) > 0;
    const liveAttemptClaimed = trackLiveDm
      ? await chatLogger.claimUnrepliedAttempt(Number(inboundLogId), normalized.chatJid)
      : false;
    let liveAttemptCompleted = false;
    if (trackLiveDm) {
      this.activeInboundDmChats.set(
        normalized.chatJid,
        (this.activeInboundDmChats.get(normalized.chatJid) || 0) + 1
      );
    }
    const enqueued = requestQueue.enqueue({
      id: `${normalized.chatJid}_${msg.key.id || Date.now()}`,
      senderJid: normalized.senderJid,
      chatJid: normalized.chatJid,
      execute: async () => {
        let stopTyping: (() => void) | null = null;
        try {
          // 1. Start active typing bubble immediately so users know the bot is actively crafting their reply
          stopTyping = antiBanEngine.startTypingHeartbeat(sock, normalized.chatJid);
          // 2. Light natural cadence pause (50ms in DM, 300-600ms in group)
          await antiBanEngine.simulateReadingDelay(incomingCharLen, normalized.isGroup, isOwner);
          await agentHarness.handleMessage(promptText, context);
          if (liveAttemptClaimed) {
            await chatLogger.finishUnrepliedAttempt(Number(inboundLogId), liveOutboundDispatched);
            liveAttemptCompleted = true;
          }

          // 3. Autonomous Pattern-Based Sticker Engine:
          // If the conversation reached heavy laughter, hype, or relatable banter, occasionally drop a matching sticker!
          if (stickerEngine.shouldTriggerAutonomousSticker(promptText, normalized.chatJid)) {
            const match = stickerEngine.getMatchingSticker(promptText);
            if (match && fs.existsSync(match.absolutePath)) {
              setTimeout(async () => {
                try {
                  const mentions = normalized.isGroup && normalized.senderJid ? [normalized.senderJid] : undefined;
                  await OutboundSender.sendSticker(sock, normalized.chatJid, match.absolutePath, msg, mentions);
                  await chatLogger.logOutboundSticker(normalized.chatJid, match.filename, match.vibe);
                } catch {}
              }, 1200);
            }
          }
        } catch (err: any) {
          if (liveAttemptClaimed) {
            await chatLogger.finishUnrepliedAttempt(Number(inboundLogId), false, err?.message || String(err));
            liveAttemptCompleted = true;
          }
          console.error('[WhatsAppClient] Error in agent handler:', err.message);
          healthMonitor.recordError(err);
          await analyticsEngine.trackEvent('error', { error: err.message }, normalized.chatJid, normalized.senderJid);
        } finally {
          if (liveAttemptClaimed && !liveAttemptCompleted) {
            await chatLogger.finishUnrepliedAttempt(Number(inboundLogId), false, 'Incoming handler ended without a confirmed outbound send');
          }
          if (trackLiveDm) this.releaseActiveInboundDmChat(normalized.chatJid);
          if (stopTyping) {
            stopTyping();
          }
        }
      },
    });
    if (!enqueued) {
      if (liveAttemptClaimed) {
        await chatLogger.finishUnrepliedAttempt(Number(inboundLogId), false, 'Request queue rejected the inbound message');
      }
      if (trackLiveDm) this.releaseActiveInboundDmChat(normalized.chatJid);
      console.warn(`[WhatsAppClient] Request queue full; skipped reply for ${normalized.chatJid}.`);
    }
  }

  /**
   * Responds to an incoming WhatsApp sticker by parsing its visual content & conversation context
   * and replying with a sticker from the 550+ catalog matching the exact same emotional vibe.
   */
  
  /**
   * Anti-ViewOnce Vault Interceptor:
   * Detects View-Once media on arrival and saves the decrypted buffer to disk before it expires.
   */
  private async interceptViewOnceMessage(msg: WAMessage): Promise<void> {
    try {
      const rawM = msg.message;
      if (!rawM) return;

      const viewOnce =
        rawM.viewOnceMessage ||
        rawM.viewOnceMessageV2 ||
        rawM.viewOnceMessageV2Extension ||
        rawM.ephemeralMessage?.message?.viewOnceMessage ||
        rawM.ephemeralMessage?.message?.viewOnceMessageV2 ||
        rawM.ephemeralMessage?.message?.viewOnceMessageV2Extension;

      if (!viewOnce || !viewOnce.message) return;

      const inner = viewOnce.message;
      const isVideo = Boolean(inner.videoMessage);
      const isAudio = Boolean(inner.audioMessage);
      const isImage = Boolean(inner.imageMessage);
      if (!isVideo && !isAudio && !isImage) return;

      const mediaType: 'image' | 'video' | 'audio' = isVideo ? 'video' : isAudio ? 'audio' : 'image';
      const ext = isVideo ? 'mp4' : isAudio ? 'ogg' : 'jpg';
      const caption = inner.imageMessage?.caption || inner.videoMessage?.caption || '';
      const msgId = msg.key?.id || `vo_${Date.now()}`;
      const chatJid = msg.key?.remoteJid || '';
      const isGroup = chatJid.endsWith('@g.us');
      const senderJid = isGroup ? (msg.key?.participant || chatJid) : chatJid;
      const senderName = msg.pushName || senderJid.split('@')[0];

      let chatName = isGroup ? 'Group Chat' : senderName;
      if (isGroup) {
        try {
          const knownGroup = await db.prepare('SELECT subject FROM known_groups WHERE group_jid = ?').get(chatJid) as { subject: string } | undefined;
          if (knownGroup?.subject) chatName = knownGroup.subject;
        } catch {}
      }

      console.log(`[AntiViewOnce] 👁️ Detected View-Once ${mediaType} from ${senderName} in ${chatName} (msgId: ${msgId}). Downloading...`);

      const viewOnceDir = path.resolve('./data/view_once');
      if (!fs.existsSync(viewOnceDir)) {
        fs.mkdirSync(viewOnceDir, { recursive: true });
      }

      const filePath = path.join(viewOnceDir, `${msgId}.${ext}`);

      const buffer = (await downloadMediaMessage(
        {
          key: msg.key,
          message: inner,
        } as WAMessage,
        'buffer',
        {}
      )) as Buffer;

      if (buffer && buffer.length > 0) {
        fs.writeFileSync(filePath, buffer);
        await saveViewOnceMessage({
          message_id: msgId,
          chat_jid: chatJid,
          chat_name: chatName,
          sender_jid: senderJid,
          sender_name: senderName,
          is_group: isGroup,
          media_type: mediaType,
          caption,
          file_path: filePath,
          file_size: buffer.length,
          timestamp: Date.now(),
        });
        console.log(`[AntiViewOnce] 🛡️ Successfully vaulted View-Once ${mediaType} (${Math.round(buffer.length / 1024)} KB) -> ${filePath}`);
      }
    } catch (err: any) {
      console.warn(`[AntiViewOnce] Could not capture View-Once media:`, err.message);
    }
  }

  private async handleIncomingSticker(
    msg: WAMessage,
    normalized: NormalizedMessage
  ): Promise<void> {
    if (!this.sock) return;

    // Rate-limit sticker replies: max 1 reply per 5 seconds per chat to prevent sticker ping-pong loops
    const lastReply = this.lastStickerReplyTime.get(normalized.chatJid) || 0;
    if (Date.now() - lastReply < 5_000) {
      return;
    }
    this.lastStickerReplyTime.set(normalized.chatJid, Date.now());

    try {
      console.log(
        `[StickerEngine] 📥 Incoming sticker from ${normalized.senderName} (${normalized.chatJid}) - parsing visual vibe...`
      );

      const match = await stickerEngine.getStickerForIncomingSticker(msg, normalized.chatJid);
      if (match && fs.existsSync(match.absolutePath)) {
        // Anti-ban realistic human reading/reaction presence delay
        await antiBanEngine.simulateReadingDelay(15, normalized.isGroup);

        const mentions = normalized.isGroup && normalized.senderJid ? [normalized.senderJid] : undefined;
        await OutboundSender.sendSticker(this.sock, normalized.chatJid, match.absolutePath, msg, mentions);
        await chatLogger.logOutboundSticker(normalized.chatJid, match.filename, match.vibe);
        console.log(`[StickerEngine] 🎨 Replied to sticker with matching vibe "${match.vibe}" sticker: ${match.filename} (tagged: ${normalized.senderName})`);
      }
    } catch (err: any) {
      console.error('[StickerEngine] Error replying to incoming sticker:', err.message);
    }
  }

  /**
   * Safely catches up on genuine unreplied 1-on-1 direct messages with human-like pacing.
   * Strictly enforces:
   * 1. Inbound-first rule: Recipient MUST have initiated or replied to a message in chat_logs.
   * 2. Zero cold outreach: Contacts who have never messaged the bot are skipped.
   * 3. Realistic human reading + typing delays proportional to message length.
   */

  /**
   * Ingests real-time messages from followed WhatsApp Channels (Memes & Quotes📖).
   * Automatically downloads and saves any accompanying media (images/videos) alongside captions.
   */
  private async handleNewsletterMessage(msg: WAMessage): Promise<void> {
    try {
      const channelJid = msg.key?.remoteJid || '';
      const msgId = msg.key?.id || String(Date.now());
      const text =
        msg.message?.conversation ||
        msg.message?.extendedTextMessage?.text ||
        msg.message?.imageMessage?.caption ||
        msg.message?.videoMessage?.caption ||
        '';

      // Download attached media (image or video)
      let downloadedImagePath: string | null = null;
      const isMedia = Boolean(msg.message?.imageMessage || msg.message?.videoMessage);
      if (isMedia) {
        try {
          const mediaKey = msg.message?.imageMessage?.mediaKey || msg.message?.videoMessage?.mediaKey;
          if (!mediaKey || (mediaKey instanceof Uint8Array && mediaKey.length === 0)) {
            // Channel media has no encryption key, skip Baileys decrypt
            throw new Error('Newsletter media has no decryptable mediaKey');
          }
          const buffer = (await downloadMediaMessage(msg, 'buffer', {})) as Buffer;
          if (buffer && buffer.length > 0) {
            const ext = msg.message?.videoMessage ? 'mp4' : 'jpg';
            const mediaDir = path.resolve('./assets/channel_media');
            if (!fs.existsSync(mediaDir)) {
              fs.mkdirSync(mediaDir, { recursive: true });
            }
            downloadedImagePath = path.join(mediaDir, `media_${msgId}.${ext}`);
            fs.writeFileSync(downloadedImagePath, buffer);
            console.log(`[WhatsAppClient] 📥 Downloaded channel media to ${downloadedImagePath} (${buffer.length} bytes)`);
          }
        } catch (mediaErr: any) {
          console.warn('[WhatsAppClient] Could not download newsletter media:', mediaErr.message);
        }
      }

      // Memes Channel: 120363423493864317@newsletter
      // Quotes Channel: 120363423071912423@newsletter
      const isMemeChannel =
        channelJid === '120363423493864317@newsletter' ||
        text.toLowerCase().includes('meme') ||
        (isMedia && !text.includes('—'));

      if (isMemeChannel) {
        const caption = text || '😂 Viral Meme from WhatsApp Channel';
        let finalImgPath = downloadedImagePath;
        if (!finalImgPath) {
          try {
            finalImgPath = await getOrGenerateMemeMedia(msgId, caption, null);
          } catch {}
        }
        await saveChannelMeme(
          caption,
          finalImgPath ? 'image' : 'text',
          null,
          finalImgPath,
          WHATSAPP_MEME_CHANNEL_INVITE_CODE,
          msgId
        );
        console.log(
          `[WhatsAppClient] 😂 Ingested meme from channel: "${caption.slice(0, 35)}..." [Image: ${finalImgPath ? 'YES' : 'NO'}]`
        );
      } else {
        const parsed = parseQuoteFromText(text || 'Keep pushing forward and make today count.');
        if (parsed) {
          let finalImgPath = downloadedImagePath;
          if (!finalImgPath) {
            try {
              finalImgPath = await getOrGenerateQuoteMedia(msgId, parsed.quote, parsed.author, parsed.niche, null);
            } catch {}
          }
          await saveChannelQuote(
            parsed.quote,
            parsed.author,
            parsed.niche,
            WHATSAPP_CHANNEL_INVITE_CODE,
            msgId,
            finalImgPath
          );
          console.log(
            `[WhatsAppClient] 📖 Ingested quote from channel: "${parsed.quote.slice(0, 30)}..." (${parsed.niche}) [Image: ${finalImgPath ? 'YES' : 'NO'}]`
          );
        }
      }
    } catch (err: any) {
      console.error('[WhatsAppClient] Error handling newsletter message:', err.message);
    }
  }

  private releaseActiveInboundDmChat(chatJid: string): void {
    const count = this.activeInboundDmChats.get(chatJid) || 0;
    if (count <= 1) this.activeInboundDmChats.delete(chatJid);
    else this.activeInboundDmChats.set(chatJid, count - 1);
  }

  public async replyUnrepliedMessages(batchLimit: number = 2): Promise<{ repliedCount: number; summary: string }> {
    if (this.isScanningUnreplied) {
      console.log('[WhatsAppClient] Unreplied catch-up is already running. Skipping concurrent run.');
      return {
        repliedCount: 0,
        summary: 'Unreplied message catch-up is currently in progress. Please wait for the current run to finish.',
      };
    }

    if (!this.sock) {
      console.warn('[WhatsAppClient] Cannot process unreplied messages: WhatsApp socket is disconnected.');
      return {
        repliedCount: 0,
        summary: 'Cannot catch up on unreplied messages: Bot is currently disconnected from WhatsApp.',
      };
    }

    if (restrictionGuard.isActive()) {
      restrictionGuard.logSkip('unreplied DM catch-up');
      return {
        repliedCount: 0,
        summary: 'WhatsApp has temporarily restricted this account from sending direct messages, so DM replies are paused. They will resume automatically when the restriction ends.',
      };
    }

    this.isScanningUnreplied = true;
    console.log('[WhatsAppClient] 🔍 Checking for genuine unreplied 1-on-1 direct messages...');

    try {
      const now = Date.now();
      const catchupFrom = restrictionGuard.catchupFrom();
      const oldestEligible = Math.min(now - 30 * 24 * 60 * 60 * 1000, catchupFrom ?? Number.MAX_SAFE_INTEGER);
      const candidates = await contactService.getUnrepliedChats(
        oldestEligible,
        Math.min(250, Math.max(20, batchLimit * 10)),
        now
      );
      const ownPhone = formatPhoneNumberForPairing(config.bot.pairingPhoneNumber || '07058967815');
      const ownSockDigits = (this.sock?.user?.id || '').split(':')[0].split('@')[0];
      // Filter strictly for safety
      const genuineChats = candidates.filter((chat) => {
        // 1. Must not be group, broadcast, or the bot's own number
        if (!chat.chatJid || chat.chatJid.endsWith('@g.us') || chat.chatJid.includes('broadcast')) {
          return false;
        }
        if (this.activeInboundDmChats.has(chat.chatJid)) return false;
        const chatDigits = chat.chatJid.split('@')[0].split(':')[0];
        if (
          chatDigits === ownPhone ||
          chatDigits === ownSockDigits ||
          chatDigits === '2349014896714' ||
          chatDigits === '2347058967815' ||
          chatDigits === '230652813291679' ||
          chat.chatJid.includes('230652813291679')
        ) {
          return false;
        }

        // The SQL query already validates the newest inbound message, prior valid replies,
        // its retry window, and eligibility. Keep only recipient safety checks here.
        return true;
      });

      if (genuineChats.length === 0) {
        console.log('[WhatsAppClient] ✅ No 1-on-1 DM is currently eligible for reply or retry.');
        return {
          repliedCount: 0,
          summary: 'No direct message is currently eligible for a reply or retry. Failed sends remain queued for their next scheduled retry.',
        };
      }

      console.log(
        `[WhatsAppClient] Found ${genuineChats.length} unreplied chat(s). Processing up to ${batchLimit} with human-like pacing...`
      );

      const toProcess = genuineChats.slice(0, batchLimit);
      let repliedCount = 0;
      const repliedNames: string[] = [];
      const isTest = process.env.NODE_ENV === 'test' || Boolean(process.env.LIVETEST_RUNNER);

      for (let i = 0; i < toProcess.length; i++) {
        const chat = toProcess[i];
        if (!this.sock) {
          console.warn('[WhatsAppClient] Socket lost during unreplied catch-up, aborting batch.');
          break;
        }

        if (this.activeInboundDmChats.has(chat.chatJid)) continue;
        this.activeInboundDmChats.set(
          chat.chatJid,
          (this.activeInboundDmChats.get(chat.chatJid) || 0) + 1
        );
        const inboundLogId = Number(chat.id);
        if (!Number.isSafeInteger(inboundLogId) || inboundLogId <= 0 ||
            !await chatLogger.claimUnrepliedAttempt(inboundLogId, chat.chatJid)) {
          this.releaseActiveInboundDmChat(chat.chatJid);
          continue;
        }
        let outboundDispatched = false;
        const trackDispatch = async <T>(promise: Promise<T>): Promise<T> => {
          const result = await promise;
          if ((result as any)?.key?.id) outboundDispatched = true;
          return result;
        };

        console.log(
          `[WhatsAppClient] [${i + 1}/${toProcess.length}] Preparing human-paced reply to ${chat.senderName} (${chat.chatJid}).`
        );

        try {
          // Human reading delay proportional to the user's unreplied message length.
          const userMsgLen = (chat.lastMessage || '').length;
          await antiBanEngine.simulateReadingDelay(userMsgLen, false);

          const syntheticMsg: WAMessage = {
            key: {
              remoteJid: chat.chatJid,
              fromMe: false,
              id: `catchup_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
            },
            messageTimestamp: Math.floor(chat.timestamp / 1000) || Math.floor(Date.now() / 1000),
            pushName: chat.senderName,
            message: { conversation: chat.lastMessage },
          };

          const sock = this.sock;
          const isOwner = userProfileManager.isOwner(chat.senderJid, chat.senderName);
          const savedContact = await contactService.getContact(chat.senderJid);
          const effectiveSenderName = isOwner
            ? 'Ademola'
            : savedContact?.custom_name ||
              contactService.extractFriendlyFirstName(chat.senderName) ||
              chat.senderName;

          const context: ExecutionContext = {
            sock,
            chatJid: chat.chatJid,
            senderJid: chat.senderJid,
            senderName: effectiveSenderName,
            isGroup: false,
            rawMessage: syntheticMsg,
            replyText: async (text: string) => {
              await antiBanEngine.simulateTypingPresence(sock, chat.chatJid, text, false, userMsgLen, false);
              return trackDispatch(OutboundSender.replyText(sock, chat.chatJid, text, undefined, isOwner, false, undefined, true));
            },
            sendSticker: async (bufferOrPath: Buffer | string) =>
              trackDispatch(OutboundSender.sendSticker(sock, chat.chatJid, bufferOrPath, undefined, undefined, true)),
            sendImage: (bufferOrUrl: Buffer | string, caption?: string) =>
              trackDispatch(OutboundSender.sendImage(sock, chat.chatJid, bufferOrUrl, caption, undefined, true)),
            sendAudio: (bufferOrUrl: Buffer | string, isVN?: boolean) =>
              trackDispatch(OutboundSender.sendAudio(sock, chat.chatJid, bufferOrUrl, isVN, undefined, true)),
            sendVideo: (bufferOrUrl: Buffer | string, caption?: string) =>
              trackDispatch(OutboundSender.sendVideo(sock, chat.chatJid, bufferOrUrl, caption, undefined, true)),
            sendContact: (displayName: string, phoneNumber: string) =>
              trackDispatch(OutboundSender.sendContact(sock, chat.chatJid, displayName, phoneNumber, undefined, true)),
            sendPoll: (question: string, options: string[], selectableCount?: number) =>
              trackDispatch(OutboundSender.sendPoll(sock, chat.chatJid, question, options, selectableCount, undefined)),
          };

          await agentHarness.handleMessage(chat.lastMessage, context);
          await chatLogger.finishUnrepliedAttempt(inboundLogId, outboundDispatched);
          if (outboundDispatched) {
            repliedCount++;
            repliedNames.push(effectiveSenderName);
            console.log(`[WhatsAppClient] ✅ Successfully dispatched catch-up reply to ${effectiveSenderName}.`);
          } else {
            console.warn(`[WhatsAppClient] No outbound reply was dispatched to ${effectiveSenderName}; retry has been scheduled.`);
          }
        } catch (err: any) {
          await chatLogger.finishUnrepliedAttempt(inboundLogId, false, err?.message || String(err));
          console.error(`[WhatsAppClient] Error replying to ${chat.senderName}:`, err.message);
        } finally {
          this.releaseActiveInboundDmChat(chat.chatJid);
        }

        // 3. Human inter-chat pause between different contacts (20s between consecutive contacts in same batch)
        if (i < toProcess.length - 1) {
          const interChatPause = isTest ? 50 : 20_000;
          console.log(
            `[WhatsAppClient] ⏳ Human pacing: waiting ${(interChatPause / 1000).toFixed(0)}s before replying to next contact...`
          );
          await new Promise((r) => setTimeout(r, interChatPause));
        }
      }

      const summary = `Successfully replied to ${repliedCount} contact(s) with human-like pacing: ${repliedNames.join(', ') || 'None'}. Remaining unreplied: ${Math.max(0, genuineChats.length - repliedCount)}.`;
      console.log(`[WhatsAppClient] 🏁 Unreplied catch-up complete: ${summary}`);
      return {
        repliedCount,
        summary,
      };
    } finally {
      this.isScanningUnreplied = false;
    }
  }
}

export const whatsAppClient = new WhatsAppClient();
