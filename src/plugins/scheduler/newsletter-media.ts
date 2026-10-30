import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import {
  downloadMediaMessage,
  extractMessageContent,
  getContentType,
  proto,
  type WAMessage,
} from '@whiskeysockets/baileys';
import { config } from '../../config/env.js';

const MAX_NEWSLETTER_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_NEWSLETTER_IMAGE_PIXELS = 40_000_000;

export interface DecodedNewsletterMessage {
  id?: string;
  text: string;
  hasImage: boolean;
  message: WAMessage;
}

/** Decode the plaintext newsletter payload using the same Baileys protobuf path as its receive handler. */
export function extractNewsletterMessages(node: any, channelJid: string): DecodedNewsletterMessage[] {
  const messages: DecodedNewsletterMessage[] = [];
  const seen = new Set<string>();

  const visit = (item: any): void => {
    if (!item) return;
    if (Array.isArray(item)) {
      for (const child of item) visit(child);
      return;
    }

    if (item.tag === 'message') {
      const plaintext = Array.isArray(item.content)
        ? item.content.find((child: any) => child?.tag === 'plaintext')
        : undefined;
      const raw = plaintext?.content;
      if (raw) {
        try {
          const bytes = typeof raw === 'string' ? Buffer.from(raw, 'binary') : Buffer.from(raw);
          const decoded = proto.Message.decode(bytes);
          const id = item.attrs?.message_id || item.attrs?.server_id || item.attrs?.id;
          if (id && seen.has(String(id))) return;
          if (id) seen.add(String(id));

          const message = proto.WebMessageInfo.fromObject({
            key: { remoteJid: channelJid, id, fromMe: false },
            message: decoded,
            messageTimestamp: Number(item.attrs?.t) || 0,
          }) as WAMessage;
          const content = (extractMessageContent(message.message) ?? message.message) || undefined;
          const contentType = getContentType(content);
          const typed = content as Record<string, any> | undefined;
          const text = String(
            typed?.conversation ||
            typed?.extendedTextMessage?.text ||
            typed?.imageMessage?.caption ||
            typed?.videoMessage?.caption ||
            typed?.documentMessage?.caption ||
            ''
          ).trim();

          messages.push({
            id: id ? String(id) : undefined,
            text,
            hasImage: contentType === 'imageMessage' && Boolean(typed?.imageMessage),
            message,
          });
        } catch {
          // Ignore malformed or unsupported newsletter payloads without logging message content.
        }
      }
      return;
    }

    if (Array.isArray(item.content)) visit(item.content);
  };

  visit(node);
  return messages;
}

/** Download a channel image only after callers have checked deduplication and their per-run budget. */
export async function downloadNewsletterImage(message: WAMessage): Promise<Buffer | null> {
  const content = (extractMessageContent(message.message) ?? message.message) || undefined;
  const image = (content as any)?.imageMessage;
  if (!image) return null;

  const declaredSize = Number(image.fileLength || 0);
  if (declaredSize > MAX_NEWSLETTER_IMAGE_BYTES) return null;

  try {
    const buffer = await downloadMediaMessage(message, 'buffer', {});
    if (!Buffer.isBuffer(buffer) || buffer.length < 300 || buffer.length > MAX_NEWSLETTER_IMAGE_BYTES) return null;
    return buffer;
  } catch (error: any) {
    console.warn(`[NewsletterMedia] Image download failed (${error?.message || 'unknown error'}).`);
    return null;
  }
}

/** Normalize and persist channel media next to the configured SQLite database for disk-backed deployments. */
export async function persistNewsletterImage(
  buffer: Buffer,
  channelJid: string,
  messageId?: string
): Promise<string | null> {
  try {
    const mediaDirectory = path.join(path.dirname(config.paths.database), 'channel_media');
    fs.mkdirSync(mediaDirectory, { recursive: true });
    const identity = messageId || createHash('sha256').update(buffer).digest('hex');
    const filename = `newsletter_${createHash('sha256').update(`${channelJid}:${identity}`).digest('hex')}.jpg`;
    const outputPath = path.join(mediaDirectory, filename);
    if (fs.existsSync(outputPath) && fs.statSync(outputPath).size > 2_000) return outputPath;

    const image = sharp(buffer, { limitInputPixels: MAX_NEWSLETTER_IMAGE_PIXELS });
    const metadata = await image.metadata();
    if (!metadata.format || !['jpeg', 'png', 'webp', 'gif', 'tiff', 'avif'].includes(metadata.format)) return null;

    const normalized = await image
      .rotate()
      .resize({ width: 1920, height: 1920, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 88, mozjpeg: true })
      .toBuffer();
    if (normalized.length < 500) return null;
    fs.writeFileSync(outputPath, normalized);
    return outputPath;
  } catch (error: any) {
    console.warn(`[NewsletterMedia] Image could not be normalized (${error?.message || 'unknown error'}).`);
    return null;
  }
}
