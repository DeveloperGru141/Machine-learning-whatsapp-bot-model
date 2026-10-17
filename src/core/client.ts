import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  WASocket,
  proto,
  Browsers,
} from '@whiskeysockets/baileys';
import { db } from '../memory/db.js';
import pino from 'pino';
import qrcode from 'qrcode-terminal';
import { Boom } from '@hapi/boom';
import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { config } from '../config/env.js';
import { normalizeMessage } from './normalizer.js';
import { shouldRespondToMessage } from './filter.js';
import { OutboundSender, setActiveSocketGetter } from './sender.js';
import { chatLogger } from '../memory/chat-logger.js';
import { agentHarness } from '../agent/harness.js';
import { ExecutionContext } from '../plugins/types.js';
import { patternMiner } from '../learning/pattern-miner.js';
import { batchLearner } from '../learning/batch-learner.js';
import { downloadMediaMessage } from '@whiskeysockets/baileys';
import { transcribeAudioBuffer } from './transcription.js';
import { analyzeImageBuffer } from './vision.js';
import { synthesizeVoiceNote } from './tts.js';
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
import { antiBanEngine } from '../security/anti-ban.js';

/**
 * Normalizes a phone number for Baileys pairing code generation.
 * Converts Nigerian standard national numbers starting with 0 (e.g. 09014896714 -> 2349014896714),
 * stripped spaces, dashes, and international prefixes.
 */
export function formatPhoneNumberForPairing(num: string): string {
  let cleaned = num.replace(/[^0-9]/g, '');
  if (cleaned.startsWith('0') && cleaned.length === 11) {
    cleaned = '234' + cleaned.slice(1);
  }
  return cleaned;
}

export class WhatsAppClient {
  private sock: WASocket | null = null;
  private logger = pino({ level: 'silent' });
  private reconnectAttempts = 0;
  private isConnecting = false;
  private keepAliveInterval: NodeJS.Timeout | null = null;
  private unrepliedScanInterval: NodeJS.Timeout | null = null;
  private unrepliedDebounceTimer: NodeJS.Timeout | null = null;
  private isScanningUnreplied = false;
  private pairingRequested = false;
  private latestPairingCode: string | null = null;
  private latestPairingCodeAt = 0;
  private latestQr: string | null = null;
  private attemptedCatchupKeys: Set<string> = new Set();
  private messageStore: Map<string, any> = new Map();
  private deliveryStatusMap: Map<
    string,
    { status: 'SENT_TO_SERVER' | 'DELIVERED_TO_DEVICE' | 'READ'; statusCode: number; updatedAt: number; recipientJid: string }
  > = new Map();
  private deliveryWaiters: Map<
    string,
    Array<(info: { status: 'SENT_TO_SERVER' | 'DELIVERED_TO_DEVICE' | 'READ'; statusCode: number; updatedAt: number }) => void>
  > = new Map();

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
      const timer = setTimeout(() => {
        const latest = this.deliveryStatusMap.get(msgId);
        resolve(latest || null);
      }, timeoutMs);

      const list = this.deliveryWaiters.get(msgId) || [];
      list.push((info) => {
        if (info.statusCode >= 3) {
          clearTimeout(timer);
          resolve(info);
        }
      });
      this.deliveryWaiters.set(msgId, list);
    });

    const finalInfo = ackInfo || this.deliveryStatusMap.get(msgId);
    if (finalInfo) {
      return {
        confirmed: true,
        status: finalInfo.status,
        statusLabel: formatLabel(finalInfo.status),
        statusCode: finalInfo.statusCode,
        stanzaId: msgId,
        msgId,
        recipientJid,
        timestamp: new Date(finalInfo.updatedAt).toISOString(),
      };
    }

    const fallbackStatus = msgId ? 'SENT_TO_SERVER' : 'DISPATCHED';
    return {
      confirmed: Boolean(msgId),
      status: fallbackStatus,
      statusLabel: formatLabel(fallbackStatus),
      statusCode: msgId ? 2 : 1,
      stanzaId: msgId,
      msgId,
      recipientJid,
      timestamp: new Date().toISOString(),
    };
  }

  public getLatestPairingCode(): string | null {
    return this.latestPairingCode;
  }

  public getLatestQr(): string | null {
    return this.latestQr;
  }

  public isRegistered(): boolean {
    const creds = this.sock?.authState?.creds;
    return Boolean(creds?.registered || creds?.account || creds?.me?.id);
  }

  /**
   * Returns the current valid pairing code for the active socket, or performs a clean
   * session reset if forceReset is true (or if no code has been generated yet).
   * Never calls requestPairingCode twice on the same authState to avoid corrupting noise keys.
   */
  public async requestFreshPairingCode(forceReset: boolean = false): Promise<string | null> {
    if (this.isRegistered()) {
      return null;
    }

    // If we already have a fresh code on the current uncorrupted socket (<150s old) and not forcing reset, return it directly!
    if (!forceReset && this.latestPairingCode && Date.now() - this.latestPairingCodeAt < 150_000) {
      return this.latestPairingCode;
    }

    // If forcing a refresh (or no code yet after waiting), perform a clean session wipe & fresh socket start
    if (forceReset) {
      console.log('[WhatsAppClient] 🔄 Force-refreshing pairing session with clean noise credentials...');
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
    }

    // Wait up to 12 seconds for the fresh socket's QR handshake to generate the single clean pairing code
    for (let i = 0; i < 24; i++) {
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
   * Starts the human-paced background contact replies cycle for users who previously DM'd the bot.
   * - Waits 8s after connection opens so live traffic settles first.
   * - Runs every 45 seconds (skipping quiet hours 11:30 PM - 7:00 AM).
   * - Replies to unreplied contact DMs in strict accordance with the fine-tuning pipeline.
   */
  public startUnrepliedScanner(): void {
    this.stopUnrepliedScanner();

    const runCycleIfActive = async () => {
      const hour = new Date().getHours();
      if (hour >= 23 || hour < 7) {
        return; // Respect quiet sleeping hours
      }
      if (!this.isSocketOpen()) return;
      try {
        await this.replyUnrepliedMessages(2);
      } catch (err: any) {
        console.warn('[WhatsAppClient] Unreplied catch-up cycle warning:', err.message);
      }
    };

    this.unrepliedDebounceTimer = setTimeout(() => {
      runCycleIfActive();
    }, 8_000);
    if (this.unrepliedDebounceTimer.unref) this.unrepliedDebounceTimer.unref();

    this.unrepliedScanInterval = setInterval(() => {
      runCycleIfActive();
    }, 45_000);
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

  public isSocketOpen(): boolean {
    return Boolean(this.sock && (this.sock as any).ws?.isOpen);
  }

  public async start(): Promise<void> {
    if (this.isConnecting) {
      console.log('[WhatsAppClient] Connection attempt already in progress, skipping duplicate invocation.');
      return;
    }
    this.isConnecting = true;

    try {
      if (!fs.existsSync(config.paths.sessions)) {
        fs.mkdirSync(config.paths.sessions, { recursive: true });
      }

      // Hydrate session files from SESSION_BUNDLE_BASE64 on cloud containers (Render) if sessions/creds.json is missing and not invalidated
      const credsFile = path.join(config.paths.sessions, 'creds.json');
      if (!fs.existsSync(credsFile) && process.env.SESSION_BUNDLE_BASE64 && !this.sessionBundleInvalidated) {
        try {
          const zlib = await import('zlib');
          const rawBuf = Buffer.from(process.env.SESSION_BUNDLE_BASE64, 'base64');
          const bundleJson =
            rawBuf[0] === 0x1f && rawBuf[1] === 0x8b
              ? zlib.gunzipSync(rawBuf).toString('utf8')
              : rawBuf.toString('utf8');
          const filesMap = JSON.parse(bundleJson) as Record<string, string>;
          for (const [fileName, fileContent] of Object.entries(filesMap)) {
            const safeName = path.basename(fileName);
            fs.writeFileSync(path.join(config.paths.sessions, safeName), fileContent, 'utf8');
          }
          console.log(`[WhatsAppClient] 🔑 Hydrated ${Object.keys(filesMap).length} session files from SESSION_BUNDLE_BASE64.`);
        } catch (err: any) {
          console.warn('[WhatsAppClient] Failed to hydrate SESSION_BUNDLE_BASE64:', err.message);
        }
      }

      // Detect if PAIRING_PHONE_NUMBER changed vs existing session creds.json, or if previous pairing was incomplete
      if (fs.existsSync(credsFile)) {
        try {
          const rawCreds = JSON.parse(fs.readFileSync(credsFile, 'utf8'));
          const isFullyPaired = Boolean(rawCreds?.registered || rawCreds?.account);
          const existingPhone = (rawCreds?.me?.id || '').split(':')[0].split('@')[0].replace(/[^0-9]/g, '');
          const targetPhone = formatPhoneNumberForPairing(config.bot.pairingPhoneNumber || '09014896714');

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
        } catch {}
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
        syncFullHistory: true,
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

      // Initialize group welcome listener and scheduler background socket
      setActiveSocketGetter(() => this.sock);
      setupGroupWelcome(this.sock);
      setSchedulerSocket(this.sock);
      setEngagementSocket(this.sock);

      // Save auth credentials whenever updated
      this.sock.ev.on('creds.update', saveCreds);

      // Connection lifecycle management
      this.sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
          this.latestQr = qr;
          if (config.bot.pairingMethod === 'qr') {
            console.log('\n📱 SCAN THE QR CODE BELOW (OR OPEN /qr ON THE SERVER) TO CONNECT WHATSAPP:');
            qrcode.generate(qr, { small: true });
          }
        }

        // Request deterministic pairing code (ADEM1234) ONCE right when the initial QR noise handshake is ready
        if (qr && config.bot.pairingMethod === 'code' && !this.isRegistered() && !this.pairingRequested) {
          this.pairingRequested = true;
          const phoneNumber = config.bot.pairingPhoneNumber || '09014896714';
          const cleanNumber = formatPhoneNumberForPairing(phoneNumber);
          if (cleanNumber && this.sock) {
            setTimeout(async () => {
              if (!this.sock || this.isRegistered()) return;
              try {
                console.log(`[WhatsAppClient] Requesting clean pairing code for +${cleanNumber}...`);
                const code = await this.sock.requestPairingCode(cleanNumber, 'ADEM1234');
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
          const isRegistered = Boolean(this.sock?.authState?.creds?.registered || this.sock?.authState?.creds?.account);
          const isExplicitLogout = isRegistered && statusCode === DisconnectReason.loggedOut && !isStreamConflict;

          console.log(
            `[WhatsAppClient] Connection closed (statusCode: ${statusCode}, reason: ${errorMsg || 'unknown'}). Registered: ${isRegistered}.`
          );

          this.stopUnrepliedScanner();

          if (isExplicitLogout) {
            console.error(
              '🚨 [WhatsAppClient] Session was logged out by WhatsApp (401 Connection Failure). Clearing stale credentials and starting fresh pairing/QR session automatically...'
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
            setTimeout(() => this.start(), 1500);
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
            setTimeout(() => this.start(), 800);
            return;
          }

          // If Stream Errored (conflict), wait 5s before reconnecting so any older container/socket finishes closing
          if (isStreamConflict) {
            console.log('[WhatsAppClient] Stream conflict detected; waiting 5s before reconnecting...');
            setTimeout(() => this.start(), 5000);
            return;
          }

          // Automatic exponential backoff reconnection for server deployment
          this.reconnectAttempts++;
          const delay = Math.min(2000 * Math.pow(1.5, Math.min(this.reconnectAttempts, 6)), 30000);
          console.log(
            `[WhatsAppClient] Auto-reconnecting (attempt #${this.reconnectAttempts}) in ${(delay / 1000).toFixed(1)}s...`
          );
          setTimeout(() => this.start(), delay);
        } else if (connection === 'open') {
          this.reconnectAttempts = 0;
          this.loggedOutRetryCount = 0;
          this.pairingRequested = false;
          this.latestPairingCode = null;
          this.latestQr = null;
          healthMonitor.setConnectionStatus(true);
          this.startKeepAlive();
          this.startUnrepliedScanner();

          const ownerJid = config.bot.owners[0] || '';
          healthMonitor.startMonitoring(this.sock!, ownerJid);
          analyticsEngine.startPeriodicReports(this.sock!, ownerJid);
          console.log('✅ [WhatsAppClient] Connection established, contact replies cycle & server watchdog active!');
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
                contactService.autoSaveContact(c.id, c.name || c.notify);
              }
            }
          }

          if (messages && messages.length > 0) {
            // Sort messages chronologically (oldest first) so auto-increment id matches chronological order
            const sortedMessages = [...messages].sort((a, b) => {
              const tA = Number(a.messageTimestamp) || 0;
              const tB = Number(b.messageTimestamp) || 0;
              return tA - tB;
            });

            for (const msg of sortedMessages) {
              if (msg.key?.id && msg.message) {
                this.messageStore.set(msg.key.id, msg.message);
              }
              const normalized = normalizeMessage(msg);
              if (normalized && (normalized.text || normalized.contentType)) {
                chatLogger.logMessage({
                  chatJid: normalized.chatJid,
                  senderJid: msg.key?.fromMe ? 'bot' : normalized.senderJid,
                  senderName: msg.key?.fromMe ? config.bot.name : normalized.senderName,
                  isGroup: normalized.isGroup,
                  contentType: normalized.contentType,
                  messageText: normalized.text,
                  stickerFilename: normalized.stickerFilename,
                  timestamp: Number(msg.messageTimestamp) * 1000 || Date.now(),
                });
              }
            }
          }
        } catch (err: any) {
          console.error('[WhatsAppClient] Error processing messaging-history.set:', err.message);
        }
      });

      // Track WhatsApp message delivery receipts (SERVER_ACK ✓, DELIVERY_ACK ✓✓, READ ✓✓)
      this.sock.ev.on('messages.update', (updates) => {
        try {
          for (const u of updates) {
            const msgId = u.key?.id;
            const remoteJid = u.key?.remoteJid || '';
            const status = Number(u.update?.status || 0);
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
            if (msgId) {
              this.recordDeliveryStatus(msgId, remoteJid, status);
            }
          }
        } catch {}
      });

      // Passively record new contacts synced from phonebook
      this.sock.ev.on('contacts.upsert', (contacts) => {
        try {
          for (const c of contacts) {
            if (c.id && !c.id.endsWith('@g.us')) {
              contactService.autoSaveContact(c.id, c.name || c.notify);
            }
          }
        } catch {}
      });

      // Passively track new chats without sending unsolicited messages
      this.sock.ev.on('chats.upsert', async (_newChats) => {
        // Passive observation only — zero unsolicited group outreach
      });

      // Message handler
      this.sock.ev.on('messages.upsert', async (m) => {
        for (const msg of m.messages) {
          await this.processIncomingMessage(msg);
        }
      });
    } finally {
      this.isConnecting = false;
    }
  }

  /**
   * Processes a single incoming Baileys message through normalization, passive analytics,
   * security/spam checks, self-introduction, and LLM reasoning.
   */
  public async processIncomingMessage(msg: proto.IWebMessageInfo): Promise<void> {
    if (msg.key?.id && msg.message) {
      this.messageStore.set(msg.key.id, msg.message);
      if (this.messageStore.size > 2000) {
        const first = this.messageStore.keys().next().value;
        if (first) this.messageStore.delete(first);
      }
    }

    const msgTime = Number(msg.messageTimestamp) * 1000;
    const effectiveMsgTime = msgTime ? Math.min(msgTime, Date.now()) : Date.now();

    // Ignore messages sent by ourselves for agent trigger, and only log if not already logged by OutboundSender
    if (msg.key?.fromMe) {
      if (msg.key?.id && msg.key?.remoteJid) {
        this.recordDeliveryStatus(msg.key.id, msg.key.remoteJid, Number(msg.status || 2));
      }
      const normalized = normalizeMessage(msg);
      if (normalized && (normalized.text || normalized.contentType)) {
        const alreadyLogged = db
          .prepare(
            `SELECT 1 FROM chat_logs WHERE chat_jid = ? AND sender_jid = 'bot' AND message_text = ? AND timestamp >= ? LIMIT 1`
          )
          .get(normalized.chatJid, normalized.text || '', effectiveMsgTime - 20_000);
        if (!alreadyLogged) {
          chatLogger.logMessage({
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
      }
      return;
    }

    const normalized = normalizeMessage(msg);
    if (!normalized) return;

    // 1. Passive Continuous Learning & Analytics: Log EVERY message in all chats
    chatLogger.logMessage({
      chatJid: normalized.chatJid,
      senderJid: normalized.senderJid,
      senderName: normalized.senderName,
      isGroup: normalized.isGroup,
      contentType: normalized.contentType,
      messageText: normalized.text,
      stickerFilename: normalized.stickerFilename,
      timestamp: effectiveMsgTime,
    });

    // Record message health and analytics
    healthMonitor.recordMessage();
    analyticsEngine.trackEvent('message', { type: normalized.contentType }, normalized.chatJid, normalized.senderJid);

    // Persistent User Profile Tracking across all chats
    userProfileManager.upsertProfile(normalized.senderJid, normalized.senderName);

    // Automatic Contact Saving: passively record and index all contacts
    const contactSaveStatus = contactService.autoSaveContact(normalized.senderJid, normalized.senderName);

    // Continuous ML Batch Learning: buffers 20 exchanges before a single compression API call
    batchLearner.recordExchange(normalized.chatJid, normalized.senderJid);

    // Historical Backlog Evaluation:
    // Strictly ignore any message older than 2 minutes for both DMs and groups
    // so the bot NEVER responds to historical messages from when it was offline or during history sync.
    if (msgTime && Date.now() - msgTime > 120_000) {
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
        analyticsEngine.trackEvent('spam_blocked', { action: spamStatus.action }, normalized.chatJid, normalized.senderJid);
        return;
      }
    }

    // 2. Trigger Evaluation (DM vs Group @mention/quote)
    const botJid = this.sock?.user?.id || '';
    const botLid = this.sock?.user?.lid || '';
    const { shouldRespond, cleanedText } = shouldRespondToMessage(
      msg,
      botJid,
      normalized.text,
      botLid
    );

    if (!shouldRespond) return;

    // Per-User Token Rate Limiter (protect against spamming bot reasoning loop)
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

    // Passive Contact Introduction Tracking (no unsolicited canned message)
    if (!normalized.isGroup && contactSaveStatus.needsIntroduction) {
      contactService.markIntroduced(normalized.senderJid);
    }

    let promptText = cleanedText;
    const isIncomingVoiceNote = normalized.contentType === 'audio';

    // Process Voice Notes: Listen to voice notes and transcribe with Groq Whisper
    if (isIncomingVoiceNote) {
      try {
        console.log(`[WhatsAppClient] Downloading voicenote from ${normalized.senderName}...`);
        const audioBuffer = (await downloadMediaMessage(msg, 'buffer', {})) as Buffer;
        const transcript = await transcribeAudioBuffer(audioBuffer);
        if (transcript) {
          promptText = `[User sent a voice note]: "${transcript}"`;
        } else {
          promptText = `[User sent a voice note — reply to them with a natural voice note]`;
        }
      } catch (err: any) {
        console.error('[WhatsAppClient] Voicenote processing error:', err.message);
        promptText = `[User sent a voice note — reply to them with a natural voice note]`;
      }
      chatLogger.updateLatestMessageText(normalized.chatJid, 'audio', promptText);
    } else if (normalized.contentType === 'image') {
      // Process Image: Read visual content with Vision
      try {
        console.log(`[WhatsAppClient] Reading image content from ${normalized.senderName}...`);
        const imgBuffer = (await downloadMediaMessage(msg, 'buffer', {})) as Buffer;
        const visionDesc = await analyzeImageBuffer(imgBuffer, cleanedText);
        if (visionDesc) {
          promptText = `[Visual Content Analysis of Attached Image]:\n${visionDesc}\n\nUser Question/Caption: ${cleanedText || 'Describe and answer based on this image'}`;
          chatLogger.updateLatestMessageText(normalized.chatJid, 'image', promptText);
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
    } else if (normalized.contentType === 'sticker') {
      promptText = `[User sent a sticker]`;
      chatLogger.updateLatestMessageText(normalized.chatJid, 'sticker', promptText);
    }

    if (!promptText) return;

    console.log(
      `[Incoming Trigger] From: ${normalized.senderName} (${normalized.chatJid}): "${promptText.slice(0, 80)}..."`
    );

    // Contextual Message Reactions when tagged in group
    if (this.sock && messageReactor.shouldReact(promptText, normalized.isGroup)) {
      const emoji = messageReactor.getReactionEmoji(promptText);
      messageReactor.reactToMessage(this.sock, msg, emoji).catch(() => {});
    }

    // 3. Build Execution Context
    const sock = this.sock;
    if (!sock) return;

    const isOwner = userProfileManager.isOwner(normalized.senderJid, normalized.senderName);
    const savedContact = contactService.getContact(normalized.senderJid);
    const effectiveSenderName = isOwner
      ? 'Ademola'
      : savedContact?.custom_name ||
        contactService.extractFriendlyFirstName(normalized.senderName) ||
        normalized.senderName;

    const context: ExecutionContext = {
      sock,
      chatJid: normalized.chatJid,
      senderJid: normalized.senderJid,
      senderName: effectiveSenderName,
      isGroup: normalized.isGroup,
      rawMessage: msg,
      replyText: async (text: string) => {
        const safeQuoted = normalized.chatJid.endsWith('@lid') ? undefined : msg;

        // If user sent a voice note, respond with a synthesized AI voice note in the fine-tuned persona!
        if (isIncomingVoiceNote) {
          console.log(`[TTS] Synthesizing voice note reply to ${normalized.senderName}...`);
          await antiBanEngine.simulateTypingPresence(sock, normalized.chatJid, text, true);
          const vnBuffer = await synthesizeVoiceNote(text);
          if (vnBuffer) {
            const res = await OutboundSender.sendAudio(sock, normalized.chatJid, vnBuffer, true, safeQuoted);
            return res;
          }
        }

        // Simulate authentic human typing presence with natural delay & jitter
        await antiBanEngine.simulateTypingPresence(sock, normalized.chatJid, text, false);
        const res = await OutboundSender.replyText(sock, normalized.chatJid, text, safeQuoted);
        return res;
      },
      sendSticker: async () => false,
      sendImage: (bufferOrUrl: Buffer | string, caption?: string) =>
        OutboundSender.sendImage(sock, normalized.chatJid, bufferOrUrl, caption, msg),
      sendAudio: (bufferOrUrl: Buffer | string, isVoiceNote?: boolean) =>
        OutboundSender.sendAudio(sock, normalized.chatJid, bufferOrUrl, isVoiceNote, msg),
      sendVideo: (bufferOrUrl: Buffer | string, caption?: string) =>
        OutboundSender.sendVideo(sock, normalized.chatJid, bufferOrUrl, caption, msg),
      sendContact: (displayName: string, phoneNumber: string) =>
        OutboundSender.sendContact(sock, normalized.chatJid, displayName, phoneNumber, msg),
    };

    // 4. Dispatch via Concurrency Queue (Anti-Crash & Human-Like Rate Limiting)
    requestQueue.enqueue({
      id: `${normalized.chatJid}_${msg.key.id || Date.now()}`,
      senderJid: normalized.senderJid,
      chatJid: normalized.chatJid,
      execute: async () => {
        try {
          // Immediately broadcast typing indicator while AI computes response (only for standard JIDs, never @lid)
          if (!normalized.chatJid.endsWith('@lid')) {
            sock.sendPresenceUpdate('composing', normalized.chatJid).catch(() => {});
          }
          // Snappy processing delay (20ms-50ms)
          await antiBanEngine.simulateReadingDelay((promptText || '').length);
          await agentHarness.handleMessage(promptText, context);
        } catch (err: any) {
          console.error('[WhatsAppClient] Error in agent handler:', err.message);
          healthMonitor.recordError(err);
          analyticsEngine.trackEvent('error', { error: err.message }, normalized.chatJid, normalized.senderJid);
        }
      },
    });
  }

  /**
   * Safely catches up on genuine unreplied 1-on-1 direct messages with human-like pacing.
   * Strictly enforces:
   * 1. Inbound-first rule: Recipient MUST have initiated or replied to a message in chat_logs.
   * 2. Zero cold outreach: Contacts who have never messaged the bot are skipped.
   * 3. Snappy human-paced delays so contacts who replied to the bot get timely responses.
   */
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

    this.isScanningUnreplied = true;
    console.log('[WhatsAppClient] 🔍 Checking for genuine unreplied 1-on-1 direct messages...');

    try {
      const candidates = contactService.getUnrepliedChats();
      const ownPhone = formatPhoneNumberForPairing(config.bot.pairingPhoneNumber || '09014896714');
      const ownSockDigits = (this.sock?.user?.id || '').split(':')[0].split('@')[0];

      // Filter strictly for safety
      const genuineChats = candidates.filter((chat) => {
        // 1. Must not be group, broadcast, or the bot's own number
        if (!chat.chatJid || chat.chatJid.endsWith('@g.us') || chat.chatJid.includes('broadcast')) {
          return false;
        }
        const chatDigits = chat.chatJid.split('@')[0].split(':')[0];
        if (
          chatDigits === ownPhone ||
          chatDigits === ownSockDigits ||
          chatDigits === '2349014896714' ||
          chatDigits === '2347058967815'
        ) {
          return false;
        }

        // 2. Skip if already attempted for this exact message ID/timestamp in this runtime session
        const catchupKey = `${chat.chatJid}_${chat.id || chat.timestamp}`;
        if (this.attemptedCatchupKeys.has(catchupKey)) {
          return false;
        }

        // 3. Must have at least one genuine inbound message from a human in chat_logs
        const hasInbound = db
          .prepare(`SELECT 1 FROM chat_logs WHERE chat_jid = ? AND sender_jid != 'bot' LIMIT 1`)
          .get(chat.chatJid);
        if (!hasInbound) return false;

        // 4. Confirm bot hasn't already sent a valid reply after this message
        const laterBotReply = chat.id
          ? db
              .prepare(
                `SELECT 1 FROM chat_logs
                 WHERE chat_jid = ?
                   AND sender_jid = 'bot'
                   AND id > ?
                   AND timestamp >= ?
                   AND LOWER(COALESCE(message_text, '')) NOT LIKE 'network slow small%'
                   AND LOWER(COALESCE(message_text, '')) NOT LIKE '%<tool_call>%'
                   AND COALESCE(message_text, '') NOT LIKE '⚠️%'
                 LIMIT 1`
              )
              .get(chat.chatJid, chat.id, chat.timestamp)
          : db
              .prepare(
                `SELECT 1 FROM chat_logs
                 WHERE chat_jid = ?
                   AND sender_jid = 'bot'
                   AND timestamp > ?
                   AND LOWER(COALESCE(message_text, '')) NOT LIKE 'network slow small%'
                   AND LOWER(COALESCE(message_text, '')) NOT LIKE '%<tool_call>%'
                   AND COALESCE(message_text, '') NOT LIKE '⚠️%'
                 LIMIT 1`
              )
              .get(chat.chatJid, chat.timestamp);
        if (laterBotReply) return false;

        return true;
      });

      if (genuineChats.length === 0) {
        console.log('[WhatsAppClient] ✅ No unreplied 1-on-1 DMs found. All conversations are up to date.');
        return {
          repliedCount: 0,
          summary: 'All direct messages have been replied to! No unreplied conversations found.',
        };
      }

      console.log(
        `[WhatsAppClient] Found ${genuineChats.length} unreplied chat(s). Processing up to ${batchLimit} with human-like pacing...`
      );

      const toProcess = genuineChats.slice(0, batchLimit);
      let repliedCount = 0;
      const repliedNames: string[] = [];

      for (let i = 0; i < toProcess.length; i++) {
        const chat = toProcess[i];
        if (!this.sock) {
          console.warn('[WhatsAppClient] Socket lost during unreplied catch-up, aborting batch.');
          break;
        }

        const catchupKey = `${chat.chatJid}_${chat.id || chat.timestamp}`;
        this.attemptedCatchupKeys.add(catchupKey);

        console.log(
          `[WhatsAppClient] [${i + 1}/${toProcess.length}] Preparing human-paced reply to ${chat.senderName} (${chat.chatJid}): "${chat.lastMessage.slice(0, 50)}"`
        );

        // 1. Online presence (only for standard JIDs, never @lid to prevent 428 disconnects)
        if (!chat.chatJid.endsWith('@lid')) {
          try {
            await this.sock.sendPresenceUpdate('available', chat.chatJid);
          } catch {}
        }

        // 2. Snappy human reading delay (400ms - 800ms) for catch-up cycle
        const isTest = process.env.NODE_ENV === 'test' || Boolean(process.env.LIVETEST_RUNNER);
        const catchupReadDelay = isTest ? 20 : Math.floor(400 + Math.random() * 400);
        await new Promise((r) => setTimeout(r, catchupReadDelay));

        // 3. Construct synthetic message for context
        const syntheticMsg: proto.IWebMessageInfo = {
          key: {
            remoteJid: chat.chatJid,
            fromMe: false,
            id: `catchup_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
          },
          messageTimestamp: Math.floor(chat.timestamp / 1000) || Math.floor(Date.now() / 1000),
          pushName: chat.senderName,
          message: {
            conversation: chat.lastMessage,
          },
        };

        const sock = this.sock;
        const isOwner = userProfileManager.isOwner(chat.senderJid, chat.senderName);
        const savedContact = contactService.getContact(chat.senderJid);
        const effectiveSenderName = isOwner
          ? 'Ademola'
          : savedContact?.custom_name ||
            contactService.extractFriendlyFirstName(chat.senderName) ||
            chat.senderName;

        const isVoiceNote = chat.contentType === 'audio';

        const context: ExecutionContext = {
          sock,
          chatJid: chat.chatJid,
          senderJid: chat.senderJid,
          senderName: effectiveSenderName,
          isGroup: false,
          rawMessage: syntheticMsg,
          replyText: async (text: string) => {
            if (isVoiceNote) {
              await antiBanEngine.simulateTypingPresence(sock, chat.chatJid, text, true);
              const vnBuffer = await synthesizeVoiceNote(text);
              if (vnBuffer) {
                return OutboundSender.sendAudio(sock, chat.chatJid, vnBuffer, true, undefined);
              }
            }
            await antiBanEngine.simulateTypingPresence(sock, chat.chatJid, text, false);
            return OutboundSender.replyText(sock, chat.chatJid, text, undefined);
          },
          sendSticker: async () => false,
          sendImage: (bufferOrUrl: Buffer | string, caption?: string) =>
            OutboundSender.sendImage(sock, chat.chatJid, bufferOrUrl, caption, undefined),
          sendAudio: (bufferOrUrl: Buffer | string, isVN?: boolean) =>
            OutboundSender.sendAudio(sock, chat.chatJid, bufferOrUrl, isVN, undefined),
          sendVideo: (bufferOrUrl: Buffer | string, caption?: string) =>
            OutboundSender.sendVideo(sock, chat.chatJid, bufferOrUrl, caption, undefined),
          sendContact: (displayName: string, phoneNumber: string) =>
            OutboundSender.sendContact(sock, chat.chatJid, displayName, phoneNumber, undefined),
        };

        try {
          await agentHarness.handleMessage(chat.lastMessage, context);
          repliedCount++;
          repliedNames.push(effectiveSenderName);
          console.log(`[WhatsAppClient] ✅ Successfully caught up with ${effectiveSenderName}.`);
        } catch (err: any) {
          console.error(`[WhatsAppClient] Error replying to ${chat.senderName}:`, err.message);
        }

        // 4. Human inter-chat pause between different contacts (20s between consecutive contacts in same batch)
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
