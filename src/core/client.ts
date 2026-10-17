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
  private attemptedCatchupKeys: Set<string> = new Set();
  private messageStore: Map<string, any> = new Map();

  public getLatestPairingCode(): string | null {
    return this.latestPairingCode;
  }

  public async requestFreshPairingCode(): Promise<string | null> {
    if (!this.sock || this.sock.authState?.creds?.registered) {
      return null;
    }
    const cleanNumber = formatPhoneNumberForPairing(config.bot.pairingPhoneNumber || '09014896714');
    if (!cleanNumber) return null;
    try {
      const code = await this.sock.requestPairingCode(cleanNumber);
      this.latestPairingCode = code;
      console.log(`\n📱 [WhatsAppClient] FRESH PAIRING CODE FOR +${cleanNumber}: ${code}\n`);
      return code;
    } catch (err: any) {
      console.warn(`[WhatsAppClient] Could not request fresh pairing code:`, err.message);
      return this.latestPairingCode;
    }
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
   * - Waits 45s after connection opens so live traffic settles first.
   * - Scans every 15 minutes (skipping quiet hours 11:30 PM - 7:00 AM).
   * - Replies to max 3 unreplied DMs per cycle with 22s-36s human pauses between contacts.
   */
  private startUnrepliedScanner(): void {
    this.stopUnrepliedScanner();

    const runCycleIfActive = async () => {
      const hour = new Date().getHours();
      if (hour >= 23 || hour < 7) {
        return; // Respect quiet sleeping hours
      }
      if (!this.isSocketOpen()) return;
      try {
        await this.replyUnrepliedMessages(3);
      } catch (err: any) {
        console.warn('[WhatsAppClient] Unreplied catch-up cycle warning:', err.message);
      }
    };

    this.unrepliedDebounceTimer = setTimeout(() => {
      runCycleIfActive();
    }, 45_000);
    if (this.unrepliedDebounceTimer.unref) this.unrepliedDebounceTimer.unref();

    this.unrepliedScanInterval = setInterval(() => {
      runCycleIfActive();
    }, 15 * 60 * 1000);
    if (this.unrepliedScanInterval.unref) this.unrepliedScanInterval.unref();
  }

  private stopUnrepliedScanner(): void {
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

      // Detect if PAIRING_PHONE_NUMBER changed vs existing session creds.json
      const credsFile = path.join(config.paths.sessions, 'creds.json');
      if (fs.existsSync(credsFile) && config.bot.pairingPhoneNumber) {
        try {
          const rawCreds = JSON.parse(fs.readFileSync(credsFile, 'utf8'));
          const existingPhone = (rawCreds?.me?.id || '').split(':')[0].split('@')[0].replace(/[^0-9]/g, '');
          const targetPhone = formatPhoneNumberForPairing(config.bot.pairingPhoneNumber);
          if (existingPhone && targetPhone && existingPhone !== targetPhone) {
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

      // Detach any previous listeners from prior socket instance
      if (this.sock) {
        try {
          this.sock.ev.removeAllListeners('connection.update');
          this.sock.ev.removeAllListeners('creds.update');
          this.sock.ev.removeAllListeners('messages.upsert');
        } catch {}
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
        connectTimeoutMs: 20_000,
        defaultQueryTimeoutMs: 15_000,
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

      // Initialize group welcome listener and scheduler background socket
      setActiveSocketGetter(() => this.sock);
      setupGroupWelcome(this.sock);
      setSchedulerSocket(this.sock);
      setEngagementSocket(this.sock);

      // Save auth credentials whenever updated
      this.sock.ev.on('creds.update', saveCreds);

      // Pairing Code Flow (Link with phone number instead of QR)
      if (config.bot.pairingMethod === 'code' && !this.sock.authState.creds.registered && !this.pairingRequested) {
        this.pairingRequested = true;
        setTimeout(async () => {
          if (this.sock?.authState?.creds?.registered) return;

          let phoneNumber = config.bot.pairingPhoneNumber;
          if (!phoneNumber && process.stdin.isTTY) {
            const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
            phoneNumber = await new Promise<string>((resolve) => {
              rl.question('\n📱 Enter your WhatsApp phone number with country code (e.g. 09014896714 or 2349014896714): ', (answer) => {
                rl.close();
                resolve(answer.trim());
              });
            });
          } else if (!phoneNumber) {
            console.warn(
              '⚠️ [WhatsAppClient] Headless server mode detected without PAIRING_PHONE_NUMBER or existing session. Set PAIRING_PHONE_NUMBER in .env or copy ./sessions to the server.'
            );
            this.pairingRequested = false;
            return;
          }

          const cleanNumber = formatPhoneNumberForPairing(phoneNumber);
          if (cleanNumber && this.sock) {
            let retries = 0;
            const maxRetries = 3;
            while (retries < maxRetries) {
              try {
                retries++;
                console.log(`[WhatsAppClient] Requesting pairing code for +${cleanNumber} (Attempt ${retries}/${maxRetries})...`);
                const code = await this.sock.requestPairingCode(cleanNumber);
                this.latestPairingCode = code;
                console.log('\n======================================================');
                console.log(`📱 YOUR WHATSAPP PAIRING CODE: ${code}`);
                console.log('------------------------------------------------------');
                console.log(`Phone Number: +${cleanNumber} (${phoneNumber})`);
                console.log('1. Open WhatsApp on your phone');
                console.log('2. Go to Settings > Linked Devices > Link a Device');
                console.log('3. Tap "Link with phone number instead"');
                console.log(`4. Enter code: ${code}`);
                console.log('======================================================\n');
                break;
              } catch (err: any) {
                console.error(`[WhatsAppClient] Error requesting pairing code (attempt ${retries}):`, err.message);
                if (retries < maxRetries) {
                  await new Promise((resolve) => setTimeout(resolve, 3000));
                } else {
                  this.pairingRequested = false;
                }
              }
            }
          }
        }, 3000);
      }

      // Connection lifecycle management
      this.sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr && config.bot.pairingMethod === 'qr') {
          console.log('\n📱 SCAN THE QR CODE BELOW TO CONNECT WHATSAPP:');
          qrcode.generate(qr, { small: true });
        }

        if (connection === 'close') {
          this.stopKeepAlive();
          healthMonitor.setConnectionStatus(false);
          const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode;
          const errorMsg = (lastDisconnect?.error as any)?.message || (lastDisconnect?.error as any)?.output?.payload?.message || '';
          const isStreamConflict = errorMsg.includes('conflict') || errorMsg.includes('Stream Errored');
          const isRegistered = Boolean(this.sock?.authState?.creds?.registered);
          // If socket was never registered, 401 or 408 is simply an expired pairing code, not a device logout
          const shouldReconnect = isRegistered
            ? (statusCode !== DisconnectReason.loggedOut || isStreamConflict)
            : true;

          console.log(
            `[WhatsAppClient] Connection closed (statusCode: ${statusCode}, reason: ${errorMsg || 'unknown'}). Registered: ${isRegistered}. Reconnecting: ${shouldReconnect}`
          );

          this.stopUnrepliedScanner();

          if (!shouldReconnect) {
            console.error('🚨 [WhatsAppClient] Device was logged out. Clear sessions/ and restart to re-authenticate.');
            return;
          }

          // If unlinked pairing attempt expired or hit 401, wipe partial creds to request a fresh code on next loop
          if (!isRegistered && (statusCode === DisconnectReason.loggedOut || statusCode === 408)) {
            console.log('[WhatsAppClient] Pairing attempt timed out or closed. Clearing stale credentials to generate fresh pairing code...');
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

          // Automatic exponential backoff reconnection for server deployment
          this.reconnectAttempts++;
          const delay = Math.min(2000 * Math.pow(1.5, Math.min(this.reconnectAttempts, 6)), 30000);
          console.log(
            `[WhatsAppClient] Auto-reconnecting (attempt #${this.reconnectAttempts}) in ${(delay / 1000).toFixed(1)}s...`
          );
          setTimeout(() => this.start(), delay);
        } else if (connection === 'open') {
          this.reconnectAttempts = 0;
          this.pairingRequested = false;
          this.latestPairingCode = null;
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
            for (const msg of messages) {
              if (msg.key?.id && msg.message) {
                this.messageStore.set(msg.key.id, msg.message);
              }
              const normalized = normalizeMessage(msg);
              if (normalized) {
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

    // Ignore messages sent by ourselves for agent trigger, but passively log outbound replies
    if (msg.key?.fromMe) {
      const normalized = normalizeMessage(msg);
      if (normalized && (normalized.text || normalized.contentType)) {
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

    const savedContact = contactService.getContact(normalized.senderJid);
    const effectiveSenderName =
      savedContact?.custom_name ||
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
          // Snappy processing delay (100ms-180ms)
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
   * 1. Inbound-first rule: Recipient MUST have initiated a message in chat_logs.
   * 2. Zero cold outreach: Contacts who have never messaged the bot are skipped.
   * 3. Authentic human delays: Reading delay (1.2s-3.8s), typing presence simulation,
   *    and 18s-35s pause between consecutive chats.
   * 4. Batch cap: Processes a max of 5 chats per run to avoid spam flags.
   */
  public async replyUnrepliedMessages(batchLimit: number = 5): Promise<{ repliedCount: number; summary: string }> {
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

        // 2. Skip if already attempted in this runtime session
        const catchupKey = `${chat.chatJid}_${chat.timestamp}`;
        if (this.attemptedCatchupKeys.has(catchupKey)) {
          return false;
        }

        // 3. Must have at least one genuine inbound message from a human in chat_logs
        const hasInbound = db
          .prepare(`SELECT 1 FROM chat_logs WHERE chat_jid = ? AND sender_jid != 'bot' LIMIT 1`)
          .get(chat.chatJid);
        if (!hasInbound) return false;

        // 4. Confirm bot hasn't already replied after this timestamp
        const laterBotReply = db
          .prepare(`SELECT 1 FROM chat_logs WHERE chat_jid = ? AND sender_jid = 'bot' AND timestamp >= ? LIMIT 1`)
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

        const catchupKey = `${chat.chatJid}_${chat.timestamp}`;
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

        // 2. Authentic human reading delay (1.5s - 3.5s) for catch-up cycle
        const isTest = process.env.NODE_ENV === 'test' || Boolean(process.env.LIVETEST_RUNNER);
        const catchupReadDelay = isTest ? 30 : Math.floor(1500 + Math.random() * 2000);
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
        const savedContact = contactService.getContact(chat.senderJid);
        const effectiveSenderName =
          savedContact?.custom_name ||
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

        // 4. Human inter-chat pause between different contacts (22s - 36s)
        if (i < toProcess.length - 1) {
          const interChatPause = isTest ? 100 : Math.floor(22000 + Math.random() * 14000);
          console.log(
            `[WhatsAppClient] ⏳ Human pacing: resting ${(interChatPause / 1000).toFixed(1)}s before replying to next chat...`
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
