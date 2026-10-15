import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  WASocket,
} from '@whiskeysockets/baileys';
import pino from 'pino';
import qrcode from 'qrcode-terminal';
import { Boom } from '@hapi/boom';
import fs from 'fs';
import readline from 'readline';
import { config } from '../config/env.js';
import { normalizeMessage } from './normalizer.js';
import { shouldRespondToMessage } from './filter.js';
import { OutboundSender } from './sender.js';
import { chatLogger } from '../memory/chat-logger.js';
import { agentHarness } from '../agent/harness.js';
import { ExecutionContext } from '../plugins/types.js';
import { patternMiner } from '../learning/pattern-miner.js';
import { stickerPlugin } from '../plugins/sticker/sticker-plugin.js';
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

export class WhatsAppClient {
  private sock: WASocket | null = null;
  private logger = pino({ level: 'silent' });

  public async start(): Promise<void> {
    if (!fs.existsSync(config.paths.sessions)) {
      fs.mkdirSync(config.paths.sessions, { recursive: true });
    }

    const { state, saveCreds } = await useMultiFileAuthState(config.paths.sessions);
    const { version, isLatest } = await fetchLatestBaileysVersion();
    console.log(`[WhatsAppClient] Starting Baileys v${version.join('.')} (Latest: ${isLatest})`);

    this.sock = makeWASocket({
      version,
      logger: this.logger,
      auth: state,
      printQRInTerminal: false,
      generateHighQualityLinkPreview: true,
      browser: ['Ubuntu', 'Chrome', '20.0.04'],
    });

    // Initialize group welcome listener and scheduler background socket
    setupGroupWelcome(this.sock);
    setSchedulerSocket(this.sock);

    // Save auth credentials whenever updated
    this.sock.ev.on('creds.update', saveCreds);

    // Pairing Code Flow (Link with phone number instead of QR)
    if (config.bot.pairingMethod === 'code' && !this.sock.authState.creds.registered) {
      setTimeout(async () => {
        let phoneNumber = config.bot.pairingPhoneNumber;
        if (!phoneNumber) {
          const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
          phoneNumber = await new Promise<string>((resolve) => {
            rl.question('\n📱 Enter your WhatsApp phone number with country code (e.g. 2348012345678): ', (answer) => {
              rl.close();
              resolve(answer.trim());
            });
          });
        }

        const cleanNumber = phoneNumber.replace(/[^0-9]/g, '');
        if (cleanNumber) {
          try {
            const code = await this.sock!.requestPairingCode(cleanNumber);
            console.log('\n======================================================');
            console.log(`📱 YOUR WHATSAPP PAIRING CODE: ${code}`);
            console.log('------------------------------------------------------');
            console.log('1. Open WhatsApp on your phone');
            console.log('2. Go to Settings > Linked Devices > Link a Device');
            console.log('3. Tap "Link with phone number instead"');
            console.log(`4. Enter code: ${code}`);
            console.log('======================================================\n');
          } catch (err: any) {
            console.error('[WhatsAppClient] Error requesting pairing code:', err.message);
          }
        }
      }, 4000);
    }

    // Connection lifecycle management
    this.sock.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr && config.bot.pairingMethod === 'qr') {
        console.log('\n📱 SCAN THE QR CODE BELOW TO CONNECT WHATSAPP:');
        qrcode.generate(qr, { small: true });
      }

      if (connection === 'close') {
        healthMonitor.setConnectionStatus(false);
        const shouldReconnect =
          (lastDisconnect?.error as Boom)?.output?.statusCode !== DisconnectReason.loggedOut;
        console.log(
          `[WhatsAppClient] Connection closed due to:`,
          lastDisconnect?.error,
          `- Reconnecting: ${shouldReconnect}`
        );

        if (shouldReconnect) {
          setTimeout(() => this.start(), 3000);
        } else {
          console.log('[WhatsAppClient] Logged out. Delete sessions/ to re-authenticate.');
        }
      } else if (connection === 'open') {
        healthMonitor.setConnectionStatus(true);
        const ownerJid = config.bot.owners[0] || '';
        healthMonitor.startMonitoring(this.sock!, ownerJid);
        analyticsEngine.startPeriodicReports(this.sock!, ownerJid);
        console.log('✅ [WhatsAppClient] Connection established successfully!');
      }
    });

    // Message handler
    this.sock.ev.on('messages.upsert', async (m) => {
      if (m.type !== 'notify') return;

      for (const msg of m.messages) {
        const normalized = normalizeMessage(msg);
        if (!normalized) continue;

        // 1. Passive Continuous Learning & Analytics: Log EVERY message in all chats
        chatLogger.logMessage({
          chatJid: normalized.chatJid,
          senderJid: normalized.senderJid,
          senderName: normalized.senderName,
          isGroup: normalized.isGroup,
          contentType: normalized.contentType,
          messageText: normalized.text,
          stickerFilename: normalized.stickerFilename,
          timestamp: Number(msg.messageTimestamp) * 1000 || Date.now(),
        });

        // Record message health and analytics
        healthMonitor.recordMessage();
        analyticsEngine.trackEvent('message', { type: normalized.contentType }, normalized.chatJid, normalized.senderJid);

        // Persistent User Profile Tracking across all chats
        userProfileManager.upsertProfile(normalized.senderJid, normalized.senderName);

        // Automatic Contact Saving: passively record and index all contacts
        contactService.autoSaveContact(normalized.senderJid, normalized.senderName);

        // Harvest incoming sticker if present to expand sticker catalog autonomously
        if (normalized.contentType === 'sticker') {
          stickerPlugin.harvestIncomingSticker(msg).catch(() => {});
        }

        // Continuous ML Pattern Mining
        patternMiner.analyzeInteraction(normalized.chatJid);

        // Passive Group Admin: Check and delete unauthorized group invite links
        if (normalized.isGroup && normalized.text) {
          const wasLinkDeleted = await groupAdminPlugin.handleAntiLink(
            this.sock,
            msg,
            normalized.chatJid,
            normalized.senderJid,
            normalized.text
          );
          if (wasLinkDeleted) continue;
        }

        // Passive Anti-Spam Moderation (frequency, repetition, flood checks)
        const spamStatus = await antiSpamFilter.checkMessage(
          normalized.senderJid,
          normalized.chatJid,
          normalized.text || '',
          this.sock,
          msg
        );
        if (spamStatus.isSpam) {
          analyticsEngine.trackEvent('spam_blocked', { action: spamStatus.action }, normalized.chatJid, normalized.senderJid);
          continue;
        }

        // 2. Trigger Evaluation (DM vs Group @mention/quote)
        const botJid = this.sock?.user?.id || '';
        const { shouldRespond, cleanedText } = shouldRespondToMessage(
          msg,
          botJid,
          normalized.text
        );

        if (!shouldRespond) continue;

        // Per-User Token Rate Limiter (protect against spamming bot reasoning loop)
        const limitStatus = userRateLimiter.checkLimit(normalized.senderJid);
        if (!limitStatus.allowed) {
          console.warn(`[UserRateLimiter] User ${normalized.senderJid} throttled. Reset in ${limitStatus.resetInSeconds}s`);
          await OutboundSender.replyText(
            this.sock!,
            normalized.chatJid,
            `⏳ Slow down! You have reached your message quota. Please wait ${limitStatus.resetInSeconds}s before sending another request.`,
            msg
          );
          continue;
        }
        userRateLimiter.consumeToken(normalized.senderJid);

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
            }
          } catch (err: any) {
            console.error('[WhatsAppClient] Voicenote processing error:', err.message);
          }
        } else if (normalized.contentType === 'image') {
          // Process Image: Read visual content with Groq Vision
          try {
            console.log(`[WhatsAppClient] Reading image content from ${normalized.senderName}...`);
            const imgBuffer = (await downloadMediaMessage(msg, 'buffer', {})) as Buffer;
            const visionDesc = await analyzeImageBuffer(imgBuffer, cleanedText);
            if (visionDesc) {
              promptText = `[Visual Content Analysis of Attached Image]:\n${visionDesc}\n\nUser Question/Caption: ${cleanedText || 'Describe and answer based on this image'}`;
            }
          } catch (err: any) {
            console.error('[WhatsAppClient] Image vision processing error:', err.message);
          }
        } else if (normalized.contentType === 'document') {
          promptText = `[User sent or quoted a document: "${normalized.text}"]. Please use the read_document tool to read, inspect, and answer or summarize based on this file.`;
        }

        if (!promptText) continue;

        console.log(
          `[Incoming Trigger] From: ${normalized.senderName} (${normalized.chatJid}): "${promptText.slice(0, 80)}..."`
        );

        // Contextual Message Reactions when tagged in group
        if (messageReactor.shouldReact(promptText, normalized.isGroup)) {
          const emoji = messageReactor.getReactionEmoji(promptText);
          messageReactor.reactToMessage(this.sock!, msg, emoji).catch(() => {});
        }

        // 3. Build Execution Context
        const sock = this.sock!;
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
              const vnBuffer = await synthesizeVoiceNote(text);
              if (vnBuffer) {
                return await OutboundSender.sendAudio(sock, normalized.chatJid, vnBuffer, true, msg);
              }
            }
            return await OutboundSender.replyText(sock, normalized.chatJid, text, msg);
          },
          sendSticker: (bufferOrPath: Buffer | string) =>
            OutboundSender.sendSticker(sock, normalized.chatJid, bufferOrPath, msg),
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
    });
  }
}

export const whatsAppClient = new WhatsAppClient();
