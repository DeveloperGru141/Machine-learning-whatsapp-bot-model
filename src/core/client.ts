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
import { config } from '../config/env.js';
import { normalizeMessage } from './normalizer.js';
import { shouldRespondToMessage } from './filter.js';
import { OutboundSender } from './sender.js';
import { chatLogger } from '../memory/chat-logger.js';
import { agentHarness } from '../agent/harness.js';
import { ExecutionContext } from '../plugins/types.js';
import { patternMiner } from '../learning/pattern-miner.js';
import { stickerPlugin } from '../plugins/sticker/sticker-plugin.js';

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

    // Save auth credentials whenever updated
    this.sock.ev.on('creds.update', saveCreds);

    // Connection lifecycle management
    this.sock.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        console.log('\n📱 SCAN THE QR CODE BELOW TO CONNECT WHATSAPP:');
        qrcode.generate(qr, { small: true });
      }

      if (connection === 'close') {
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
        console.log('✅ [WhatsAppClient] Connection established successfully!');
      }
    });

    // Message handler
    this.sock.ev.on('messages.upsert', async (m) => {
      if (m.type !== 'notify') return;

      for (const msg of m.messages) {
        const normalized = normalizeMessage(msg);
        if (!normalized) continue;

        // 1. Passive Continuous Learning: Log EVERY message in all chats
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

        // Harvest incoming sticker if present to expand sticker catalog autonomously
        if (normalized.contentType === 'sticker') {
          stickerPlugin.harvestIncomingSticker(msg).catch(() => {});
        }

        // Continuous ML Pattern Mining
        patternMiner.analyzeInteraction(normalized.chatJid);

        // 2. Trigger Evaluation (DM vs Group @mention/quote)
        const botJid = this.sock?.user?.id || '';
        const { shouldRespond, cleanedText } = shouldRespondToMessage(
          msg,
          botJid,
          normalized.text
        );

        if (!shouldRespond || !cleanedText) continue;

        console.log(
          `[Incoming Trigger] From: ${normalized.senderName} (${normalized.chatJid}): "${cleanedText}"`
        );

        // 3. Build Execution Context
        const sock = this.sock!;
        const context: ExecutionContext = {
          sock,
          chatJid: normalized.chatJid,
          senderJid: normalized.senderJid,
          senderName: normalized.senderName,
          isGroup: normalized.isGroup,
          rawMessage: msg,
          replyText: (text: string) => OutboundSender.replyText(sock, normalized.chatJid, text, msg),
          sendSticker: (bufferOrPath: Buffer | string) =>
            OutboundSender.sendSticker(sock, normalized.chatJid, bufferOrPath, msg),
          sendImage: (bufferOrUrl: Buffer | string, caption?: string) =>
            OutboundSender.sendImage(sock, normalized.chatJid, bufferOrUrl, caption, msg),
          sendAudio: (bufferOrUrl: Buffer | string, isVoiceNote?: boolean) =>
            OutboundSender.sendAudio(sock, normalized.chatJid, bufferOrUrl, isVoiceNote, msg),
        };

        // 4. Dispatch to Groq Agent Harness
        try {
          await agentHarness.handleMessage(cleanedText, context);
        } catch (err) {
          console.error('[WhatsAppClient] Error in agent handler:', err);
        }
      }
    });
  }
}

export const whatsAppClient = new WhatsAppClient();
