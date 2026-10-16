import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  WASocket,
  proto,
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
import { OutboundSender } from './sender.js';
import { chatLogger } from '../memory/chat-logger.js';
import { agentHarness } from '../agent/harness.js';
import { ExecutionContext } from '../plugins/types.js';
import { patternMiner } from '../learning/pattern-miner.js';
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
  private messageStore: Map<string, any> = new Map();

  private startKeepAlive(): void {
    this.stopKeepAlive();
    // Active presence ping every 45s keeps the WebSocket tunnel alive through cloud firewalls, NATs, and proxies
    this.keepAliveInterval = setInterval(async () => {
      if (this.sock && this.sock.user) {
        try {
          await this.sock.sendPresenceUpdate('available');
        } catch {
          // Socket might be temporarily reconnecting or busy
        }
      }
    }, 45 * 1000);

    if (this.keepAliveInterval.unref) {
      this.keepAliveInterval.unref();
    }
  }

  private stopKeepAlive(): void {
    if (this.keepAliveInterval) {
      clearInterval(this.keepAliveInterval);
      this.keepAliveInterval = null;
    }
  }

  private startUnrepliedScanner(): void {
    this.stopUnrepliedScanner();
    // Continuous 3-minute scan ensures bot always goes through its contact list
    this.unrepliedScanInterval = setInterval(() => {
      this.replyUnrepliedMessages().catch((err) => {
        console.error('[WhatsAppClient] Periodic unreplied scan error:', err.message);
      });
    }, 3 * 60 * 1000);

    if (this.unrepliedScanInterval.unref) {
      this.unrepliedScanInterval.unref();
    }
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
        browser: ['Ubuntu', 'Chrome', '20.0.04'],
        keepAliveIntervalMs: 25_000,
        connectTimeoutMs: 60_000,
        defaultQueryTimeoutMs: 60_000,
        retryRequestDelayMs: 2000,
        maxMsgRetryCount: 5,
        syncFullHistory: false,
        markOnlineOnConnect: true,
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
      setupGroupWelcome(this.sock);
      setSchedulerSocket(this.sock);

      // Save auth credentials whenever updated
      this.sock.ev.on('creds.update', saveCreds);

      // Pairing Code Flow (Link with phone number instead of QR)
      if (config.bot.pairingMethod === 'code' && !this.sock.authState.creds.registered && !this.pairingRequested) {
        this.pairingRequested = true;
        setTimeout(async () => {
          if (this.sock?.authState?.creds?.registered) return;

          let phoneNumber = config.bot.pairingPhoneNumber;
          if (!phoneNumber) {
            const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
            phoneNumber = await new Promise<string>((resolve) => {
              rl.question('\n📱 Enter your WhatsApp phone number with country code (e.g. 09014896714 or 2349014896714): ', (answer) => {
                rl.close();
                resolve(answer.trim());
              });
            });
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
          const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

          console.log(
            `[WhatsAppClient] Connection closed (statusCode: ${statusCode}, reason: ${lastDisconnect?.error?.message || 'unknown'}). Reconnecting: ${shouldReconnect}`
          );

          this.stopUnrepliedScanner();

          if (!shouldReconnect) {
            console.error('🚨 [WhatsAppClient] Device was logged out. Clear sessions/ and restart to re-authenticate.');
            return;
          }

          // Fast immediate restart on DisconnectReason.restartRequired (515)
          if (statusCode === DisconnectReason.restartRequired) {
            console.log('[WhatsAppClient] Session restart required by WhatsApp server (code 515). Reconnecting in 1s...');
            setTimeout(() => this.start(), 1000);
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
          healthMonitor.setConnectionStatus(true);
          this.startKeepAlive();
          this.startUnrepliedScanner();

          const ownerJid = config.bot.owners[0] || '';
          healthMonitor.startMonitoring(this.sock!, ownerJid);
          analyticsEngine.startPeriodicReports(this.sock!, ownerJid);
          console.log('✅ [WhatsAppClient] Connection established and server watchdog active!');

          // Proactively scan contacts and chat history for unreplied messages after initial socket sync (4s)
          setTimeout(() => {
            this.replyUnrepliedMessages().catch((err) => {
              console.error('[WhatsAppClient] Initial unreplied scan error:', err.message);
            });
          }, 4000);
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

      // Passively record new contacts synced from phonebook and debounce unreplied check
      this.sock.ev.on('contacts.upsert', (contacts) => {
        try {
          for (const c of contacts) {
            if (c.id && !c.id.endsWith('@g.us')) {
              contactService.autoSaveContact(c.id, c.name || c.notify);
            }
          }

          if (this.unrepliedDebounceTimer) clearTimeout(this.unrepliedDebounceTimer);
          this.unrepliedDebounceTimer = setTimeout(() => {
            this.replyUnrepliedMessages().catch(() => {});
          }, 3000);
        } catch {}
      });

      // Immediately greet and introduce self to any new group the bot is added to or joins
      this.sock.ev.on('chats.upsert', async (newChats) => {
        try {
          for (const chat of newChats) {
            if (chat.id && chat.id.endsWith('@g.us')) {
              const hasReplied = chatLogger.hasBotRepliedAfter(chat.id, 0);
              if (!hasReplied && this.sock) {
                console.log(`[WhatsAppClient] 🚀 New group detected via chats.upsert: ${chat.id}. Greeting and introducing bot...`);
                const groupIntro = `Hi everyone! I'm ${config.bot.name}, built by Ademola (an aspiring ML/AI Engineer). Excited to be here! Tag me with @mention or reply to my messages if you need quick answers, live web searches, video downloads, or reminders.`;
                await OutboundSender.replyText(this.sock, chat.id, groupIntro);
                chatLogger.logOutboundMessage(chat.id, groupIntro);
              }
            }
          }
        } catch (err: any) {
          console.error('[WhatsAppClient] Error in chats.upsert handler:', err?.message || err);
        }
      });
    } finally {
      this.isConnecting = false;
    }

    // Message handler
    this.sock.ev.on('messages.upsert', async (m) => {
      for (const msg of m.messages) {
        await this.processIncomingMessage(msg);
      }
    });
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

    // Ignore messages sent by ourselves
    if (msg.key?.fromMe) return;

    const normalized = normalizeMessage(msg);
    if (!normalized) return;

    const msgTime = Number(msg.messageTimestamp) * 1000;
    const effectiveMsgTime = msgTime ? Math.min(msgTime, Date.now()) : Date.now();

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

    // Continuous ML Pattern Mining
    patternMiner.analyzeInteraction(normalized.chatJid);

    // Historical Backlog Evaluation:
    // In groups: skip backlog older than 2 minutes to prevent spamming groups on reconnect
    if (normalized.isGroup && msgTime && Date.now() - msgTime > 120_000) {
      return;
    }

    // In DMs: if older than 2 minutes, check if already answered or if older than 24 hours
    if (!normalized.isGroup && msgTime && Date.now() - msgTime > 120_000) {
      if (Date.now() - msgTime > 24 * 60 * 60 * 1000) {
        return;
      }
      if (chatLogger.hasBotRepliedAfter(normalized.chatJid, effectiveMsgTime)) {
        return;
      }
      console.log(`[WhatsAppClient] Answering backlog DM from ${normalized.senderName} (${normalized.chatJid})...`);
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

    // First-Message Contact Auto-Save & Self-Introduction
    if (!normalized.isGroup && contactSaveStatus.needsIntroduction) {
      contactService.markIntroduced(normalized.senderJid);
      const firstName = contactService.extractFriendlyFirstName(normalized.senderName);

      const isSimpleGreeting =
        normalized.contentType === 'text' &&
        /^(hi+|hello+|hey+|yo+|sup|how\s*far|good\s*(morning|afternoon|evening|day)|greetings|hola|waddup|what'?s\s*up)[!.,?\s]*$/i.test(
          (cleanedText || '').trim()
        );

      const introGreeting = firstName ? `Hi ${firstName}!` : `Hi!`;
      const introText = isSimpleGreeting
        ? `${introGreeting} I'm ${config.bot.name}, pleased to meet you. Save my contact as ${config.bot.name} — I've saved yours already. How far, how's everything going?`
        : `${introGreeting} I'm ${config.bot.name}, pleased to meet you. Save my contact as ${config.bot.name} — I've saved yours already.`;

      try {
        console.log(`[WhatsAppClient] 🤝 Sending first-message self-introduction to ${normalized.senderName} (${normalized.chatJid})`);
        if (this.sock) {
          await OutboundSender.replyText(this.sock, normalized.chatJid, introText, msg);
        }
        chatLogger.logOutboundMessage(normalized.chatJid, introText);
      } catch (introErr: any) {
        console.error('[WhatsAppClient] Error sending self-introduction:', introErr.message);
      }

      // If their first message was only a simple greeting ("Hi"/"Hello"), the self-introduction already greeted them warmly!
      if (isSimpleGreeting) {
        return;
      }
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

    const context: ExecutionContext = {
      sock,
      chatJid: normalized.chatJid,
      senderJid: normalized.senderJid,
      senderName: normalized.senderName,
      isGroup: normalized.isGroup,
      rawMessage: msg,
      replyText: async (text: string) => {
        // If user sent a voice note, respond with a synthesized AI voice note in the fine-tuned persona!
        if (isIncomingVoiceNote) {
          console.log(`[TTS] Synthesizing voice note reply to ${normalized.senderName}...`);
          try {
            await sock.sendPresenceUpdate('recording', normalized.chatJid);
          } catch {}
          const vnBuffer = await synthesizeVoiceNote(text);
          if (vnBuffer) {
            const res = await OutboundSender.sendAudio(sock, normalized.chatJid, vnBuffer, true, msg);
            try {
              await sock.sendPresenceUpdate('paused', normalized.chatJid);
            } catch {}
            return res;
          }
        }

        // Show typing presence right before sending for an authentic brief delay (250-800ms)
        try {
          await sock.sendPresenceUpdate('composing', normalized.chatJid);
        } catch {}
        const typingDelay = Math.min(800, Math.max(250, Math.floor(text.length * 6)));
        await new Promise((r) => setTimeout(r, typingDelay));
        const res = await OutboundSender.replyText(sock, normalized.chatJid, text, msg);
        try {
          await sock.sendPresenceUpdate('paused', normalized.chatJid);
        } catch {}
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

    // 4. Dispatch via Concurrency Queue (Anti-Crash & Rate Limiting)
    requestQueue.enqueue({
      id: `${normalized.chatJid}_${msg.key.id || Date.now()}`,
      senderJid: normalized.senderJid,
      chatJid: normalized.chatJid,
      execute: async () => {
        try {
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
   * Scans all saved contacts, sessions, and chat logs to find and reply to any unreplied direct messages.
   */
  public async replyUnrepliedMessages(): Promise<{ repliedCount: number; summary: string }> {
    if (!this.sock) {
      return { repliedCount: 0, summary: 'WhatsApp socket is not connected.' };
    }
    if (this.isScanningUnreplied) {
      return { repliedCount: 0, summary: 'Unreplied contact scan already in progress.' };
    }
    this.isScanningUnreplied = true;

    try {
      const sock = this.sock;
      const botJid = sock.user?.id || '';
      const cleanBotId = (botJid || '').split(':')[0].split('@')[0];
      let repliedCount = 0;
      const details: string[] = [];

      console.log('[WhatsAppClient] 🔍 Starting scan of contacts and chat logs for unreplied messages...');

      // 1. Process active unreplied DMs found in chat_logs
      const unrepliedChats = contactService.getUnrepliedChats();
      for (const chat of unrepliedChats) {
        // Exclude bot's own self messages
        if (
          chat.chatJid.includes(cleanBotId) ||
          chat.senderJid.includes(cleanBotId) ||
          chat.chatJid.startsWith('271614570692796')
        ) {
          continue;
        }

        // Check if message is within reasonable window (last 48 hours)
        if (Date.now() - chat.timestamp > 48 * 60 * 60 * 1000) {
          continue;
        }

        // Skip if bot has already replied since then
        if (chatLogger.hasBotRepliedAfter(chat.chatJid, chat.timestamp)) {
          continue;
        }

        console.log(`[WhatsAppClient] Answering unreplied message from ${chat.senderName} (${chat.chatJid}): "${chat.lastMessage}"`);

        // Auto-save and send self-introduction if this is the first time the bot replies to this contact
        const saveStatus = contactService.autoSaveContact(chat.senderJid, chat.senderName);
        if (saveStatus.needsIntroduction) {
          contactService.markIntroduced(chat.senderJid);
          const firstName = contactService.extractFriendlyFirstName(chat.senderName);
          const introGreeting = firstName ? `Hi ${firstName}!` : `Hi!`;
          const introText = `${introGreeting} I'm ${config.bot.name}, pleased to meet you. Save my contact as ${config.bot.name} — I've saved yours already.`;
          try {
            await OutboundSender.replyText(sock, chat.chatJid, introText);
            chatLogger.logOutboundMessage(chat.chatJid, introText);
          } catch {}
        }

        const isAudioChat = chat.contentType === 'audio' || chat.lastMessage.toLowerCase().includes('voice note');

        const context: ExecutionContext = {
          sock,
          chatJid: chat.chatJid,
          senderJid: chat.senderJid,
          senderName: chat.senderName,
          isGroup: false,
          replyText: async (text: string) => {
            if (isAudioChat) {
              console.log(`[TTS] Synthesizing OGG Opus voice note reply to ${chat.senderName}...`);
              try {
                await sock.sendPresenceUpdate('recording', chat.chatJid);
              } catch {}
              const vnBuffer = await synthesizeVoiceNote(text);
              if (vnBuffer) {
                const res = await OutboundSender.sendAudio(sock, chat.chatJid, vnBuffer, true);
                try {
                  await sock.sendPresenceUpdate('paused', chat.chatJid);
                } catch {}
                return res;
              }
            }
            try {
              await sock.sendPresenceUpdate('composing', chat.chatJid);
            } catch {}
            const typingDelay = Math.min(800, Math.max(250, Math.floor(text.length * 6)));
            await new Promise((r) => setTimeout(r, typingDelay));
            const res = await OutboundSender.replyText(sock, chat.chatJid, text);
            try {
              await sock.sendPresenceUpdate('paused', chat.chatJid);
            } catch {}
            return res;
          },
          sendSticker: async () => false,
          sendImage: (bufferOrUrl: Buffer | string, caption?: string) =>
            OutboundSender.sendImage(sock, chat.chatJid, bufferOrUrl, caption),
          sendAudio: (bufferOrUrl: Buffer | string, isVoiceNote?: boolean) =>
            OutboundSender.sendAudio(sock, chat.chatJid, bufferOrUrl, isVoiceNote),
          sendVideo: (bufferOrUrl: Buffer | string, caption?: string) =>
            OutboundSender.sendVideo(sock, chat.chatJid, bufferOrUrl, caption),
          sendContact: (displayName: string, phoneNumber: string) =>
            OutboundSender.sendContact(sock, chat.chatJid, displayName, phoneNumber),
        };

      try {
        await agentHarness.handleMessage(chat.lastMessage, context);
        repliedCount++;
        details.push(`Replied to ${chat.senderName} (${chat.chatJid})`);
        await new Promise((r) => setTimeout(r, 2000));
      } catch (err: any) {
        console.error(`[WhatsAppClient] Error replying to unreplied chat ${chat.chatJid}:`, err.message);
      }
    }

    // 2. Process saved contacts who reached out (auto-saved or active session) with 0 bot replies
    const uncontacted = contactService.getUncontactedContacts([cleanBotId, '271614570692796', '2349014896714']);
    for (const c of uncontacted) {
      if (c.jid.includes(cleanBotId) || c.jid.startsWith('271614570692796') || c.jid.includes('2349014896714')) {
        continue;
      }

      const sessionFile = path.join(config.paths.sessions, `session-${c.phone_number}.0.json`);
      const hasActiveSession = fs.existsSync(sessionFile);

      // Double-check no bot message was logged
      if (chatLogger.hasBotRepliedAfter(c.jid, 0)) continue;

      const hasInbound = db.prepare(`SELECT 1 FROM chat_logs WHERE chat_jid = ? AND sender_jid != 'bot' LIMIT 1`).get(c.jid);

      // Contact reached out if they sent an inbound message or have an active encryption session
      if (hasInbound || hasActiveSession) {

        const firstName = contactService.extractFriendlyFirstName(c.custom_name || c.display_name);
        console.log(`[WhatsAppClient] Sending self-introduction & follow-up to uncontacted contact: ${c.display_name} (${c.jid})`);

        const greeting = `${firstName ? `Hi ${firstName}!` : 'Hi!'} I'm ${config.bot.name}, pleased to meet you. Save my contact as ${config.bot.name} — I've saved yours already. Saw you reached out earlier, how far?`;

        try {
          await OutboundSender.replyText(sock, c.jid, greeting);
          chatLogger.logOutboundMessage(c.jid, greeting);
          contactService.markIntroduced(c.jid);
          repliedCount++;
          details.push(`Introduced & followed up with ${c.display_name} (${c.jid})`);
          await new Promise((r) => setTimeout(r, 2000));
        } catch (err: any) {
          console.error(`[WhatsAppClient] Error sending follow-up to ${c.jid}:`, err.message);
        }
      }
    }

    // 3. Scan sessions folder for external peers that initiated contact but were missed
    try {
      if (fs.existsSync(config.paths.sessions)) {
        const sessionFiles = fs.readdirSync(config.paths.sessions);
        for (const file of sessionFiles) {
          const match = file.match(/^session-(\d+)\.0\.json$/);
          if (match) {
            const num = match[1];
            if (num === cleanBotId || num.startsWith('271614570692796') || num === '2349014896714') {
              continue;
            }
            const targetJid = num.length > 13 ? `${num}@lid` : `${num}@s.whatsapp.net`;
            if (chatLogger.hasBotRepliedAfter(targetJid, 0)) {
              continue;
            }

            console.log(`[WhatsAppClient] Sending self-introduction & follow-up to session peer ${targetJid}...`);
            const followUp = `Hi! I'm ${config.bot.name}, pleased to meet you. Save my contact as ${config.bot.name} — I've saved yours already. Saw your message earlier, how far?`;

            try {
              await OutboundSender.replyText(sock, targetJid, followUp);
              chatLogger.logOutboundMessage(targetJid, followUp);
              contactService.autoSaveContact(targetJid, `User +${num}`);
              contactService.markIntroduced(targetJid);
              repliedCount++;
              details.push(`Introduced & followed up with session peer (${targetJid})`);
              await new Promise((r) => setTimeout(r, 2000));
            } catch (err: any) {
              console.warn(`[WhatsAppClient] Could not reach session peer ${targetJid}:`, err.message);
            }
          }
        }
      }
    } catch (err: any) {
      console.error('[WhatsAppClient] Error scanning session files:', err.message);
    }

      const summary = repliedCount > 0
        ? `Checked contacts and successfully replied to ${repliedCount} unreplied message(s):\n${details.map(d => `• ${d}`).join('\n')}`
        : 'Scanned all contacts and chat logs: all contacts are up to date with zero unreplied messages.';

      console.log(`[WhatsAppClient] ${summary}`);
      return { repliedCount, summary };
    } finally {
      this.isScanningUnreplied = false;
    }
  }
}

export const whatsAppClient = new WhatsAppClient();
