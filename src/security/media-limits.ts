import { downloadMediaMessage, type WAMessage } from '@whiskeysockets/baileys';
import type { Transform } from 'node:stream';

const MAX_CONCURRENT_MEDIA_DOWNLOADS = 3;
const MAX_QUEUED_MEDIA_DOWNLOADS = 6;
let activeDownloads = 0;
const waitingDownloads: Array<() => void> = [];

function declaredFileLength(message: WAMessage): number | null {
  const pending: Array<{ value: unknown; depth: number }> = [{ value: message.message, depth: 0 }];
  const seen = new Set<object>();
  let visited = 0;

  while (pending.length && visited < 200) {
    const { value, depth } = pending.pop()!;
    if (!value || typeof value !== 'object' || depth > 8 || seen.has(value)) continue;
    seen.add(value);
    visited++;

    const record = value as Record<string, unknown>;
    if ('fileLength' in record) {
      const rawLength = record.fileLength as any;
      const length = typeof rawLength?.toNumber === 'function' ? rawLength.toNumber() : Number(rawLength);
      if (Number.isFinite(length) && length >= 0) return length;
    }

    for (const child of Object.values(record).slice(0, 50)) {
      if (child && typeof child === 'object') pending.push({ value: child, depth: depth + 1 });
    }
  }
  return null;
}

async function acquireDownloadSlot(): Promise<() => void> {
  if (activeDownloads >= MAX_CONCURRENT_MEDIA_DOWNLOADS) {
    if (waitingDownloads.length >= MAX_QUEUED_MEDIA_DOWNLOADS) {
      throw new Error('Media processing is busy; try again shortly.');
    }
    await new Promise<void>((resolve) => waitingDownloads.push(resolve));
  } else {
    activeDownloads++;
  }

  let released = false;
  return () => {
    if (released) return;
    released = true;
    const nextWaitingDownload = waitingDownloads.shift();
    if (nextWaitingDownload) nextWaitingDownload();
    else activeDownloads = Math.max(0, activeDownloads - 1);
  };
}

/** Download WhatsApp media as a stream and stop once its plaintext size exceeds the cap. */
export async function downloadMediaMessageBounded(message: WAMessage, maxBytes: number): Promise<Buffer> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new Error('Invalid media size limit.');

  const declaredSize = declaredFileLength(message);
  if (declaredSize !== null && declaredSize > maxBytes) {
    throw new Error(`Media exceeds the ${maxBytes}-byte processing limit.`);
  }

  const releaseSlot = await acquireDownloadSlot();
  let stream: Transform | undefined;
  try {
    stream = await downloadMediaMessage(message, 'stream', {});
    const chunks: Buffer[] = [];
    let totalBytes = 0;

    for await (const chunk of stream) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      totalBytes += bytes.length;
      if (totalBytes > maxBytes) {
        stream.destroy();
        throw new Error(`Media exceeds the ${maxBytes}-byte processing limit.`);
      }
      chunks.push(bytes);
    }

    return Buffer.concat(chunks, totalBytes);
  } finally {
    stream?.destroy();
    releaseSlot();
  }
}
