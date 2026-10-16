import zlib from 'node:zlib';
import { downloadMediaMessage, proto } from '@whiskeysockets/baileys';
import { IPlugin, BotTool, ExecutionContext, ToolResult } from '../types.js';
import { config } from '../../config/env.js';
import { unwrapMessage } from '../../core/normalizer.js';

/**
 * Decodes standard PDF literal string escape sequences
 */
function unescapePdfText(str: string): string {
  return str
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\r')
    .replace(/\\t/g, '\t')
    .replace(/\\b/g, '\b')
    .replace(/\\f/g, '\f')
    .replace(/\\\(/g, '(')
    .replace(/\\\)/g, ')')
    .replace(/\\\\/g, '\\')
    .replace(/\\([0-7]{1,3})/g, (_, oct) => {
      try {
        return String.fromCharCode(parseInt(oct, 8));
      } catch {
        return '';
      }
    });
}

/**
 * Extracts plain text from a raw PDF buffer without external dependencies.
 * Uses regex-based stream chunk extraction, zlib decompression of FlateDecode streams,
 * and text extraction from PDF text blocks (Tj, TJ operators).
 */
export function extractTextFromPdf(buffer: Buffer): string {
  const textChunks: string[] = [];
  const rawLatin = buffer.toString('latin1');

  // Search for stream ... endstream blocks
  const streamRegex = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
  let match: RegExpExecArray | null;

  while ((match = streamRegex.exec(rawLatin)) !== null) {
    const rawStream = match[1];
    let streamText = '';

    // Check if the stream is compressed (FlateDecode)
    let contentToScan = rawStream;
    try {
      const streamBuf = Buffer.from(rawStream, 'latin1');
      const decompressed = zlib.inflateSync(streamBuf);
      contentToScan = decompressed.toString('latin1');
    } catch {
      try {
        const streamBuf = Buffer.from(rawStream, 'latin1');
        const decompressed = zlib.inflateRawSync(streamBuf);
        contentToScan = decompressed.toString('latin1');
      } catch {
        // Use raw uncompressed stream data
      }
    }

    // Look for PDF string literals in parenthetical operators: (text) Tj
    const tjRegex = /\(([^()]*)\)\s*(?:Tj|'|")/g;
    let tjMatch: RegExpExecArray | null;
    while ((tjMatch = tjRegex.exec(contentToScan)) !== null) {
      const decoded = unescapePdfText(tjMatch[1]);
      if (decoded.trim()) {
        streamText += decoded + ' ';
      }
    }

    // Look for PDF array operators: [ (text1) 20 (text2) ] TJ
    const arrayTjRegex = /\[(.*?)\]\s*TJ/gi;
    let arrayMatch: RegExpExecArray | null;
    while ((arrayMatch = arrayTjRegex.exec(contentToScan)) !== null) {
      const parts = arrayMatch[1].match(/\(([^()]*)\)/g);
      if (parts) {
        const joined = parts.map((p) => unescapePdfText(p.slice(1, -1))).join('');
        if (joined.trim()) {
          streamText += joined + ' ';
        }
      }
    }

    if (streamText.trim()) {
      textChunks.push(streamText.trim());
    } else {
      // Fallback: extract printable ASCII/UTF-8 words from stream content
      const readableWords = contentToScan.match(/[\x20-\x7E\t\n\r]{4,}/g);
      if (readableWords) {
        const cleaned = readableWords
          .map((w) => w.trim())
          .filter((w) => w.length > 5 && !w.startsWith('/') && !w.includes('Font') && !w.includes('Obj'))
          .join(' ');
        if (cleaned.length > 30) {
          textChunks.push(cleaned);
        }
      }
    }
  }

  // Fallback if no streams matched or yielded text: scan entire buffer for text literals and printable strings
  if (textChunks.join('\n').length < 50) {
    const globalTj = rawLatin.match(/\(([^()]{3,})\)\s*(?:Tj|'|"|TJ)/g);
    if (globalTj) {
      const extracted = globalTj
        .map((m) => unescapePdfText(m.replace(/^\(|\)\s*(?:Tj|'|"|TJ)?$/gi, '')))
        .join(' ');
      if (extracted.trim()) textChunks.push(extracted.trim());
    }

    const readableRuns = rawLatin.match(/[A-Za-z0-9 .,!?:;'"()\/\-]{8,}/g);
    if (readableRuns) {
      const filtered = readableRuns
        .map((s) => s.trim())
        .filter(
          (s) =>
            !s.startsWith('/') &&
            !s.includes('obj') &&
            !s.includes('endobj') &&
            !s.includes('xref') &&
            !s.includes('Catalog')
        );
      if (filtered.length > 0) {
        textChunks.push(filtered.join(' '));
      }
    }
  }

  return textChunks
    .join('\n\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Extracts plain text from DOCX (zipped XML) without external packages
 */
export function extractTextFromDocx(buffer: Buffer): string {
  try {
    // 1. Primary parser: Central Directory (handles standard zips, streaming writers, and data descriptors)
    const eocdSig = Buffer.from([0x50, 0x4b, 0x05, 0x06]);
    const eocdOffset = buffer.lastIndexOf(eocdSig);
    if (eocdOffset !== -1 && eocdOffset + 22 <= buffer.length) {
      const cdOffset = buffer.readUInt32LE(eocdOffset + 16);
      let cdPos = cdOffset;
      while (cdPos < eocdOffset && cdPos + 46 <= buffer.length) {
        if (buffer.readUInt32LE(cdPos) !== 0x02014b50) break;
        const method = buffer.readUInt16LE(cdPos + 10);
        const compSize = buffer.readUInt32LE(cdPos + 20);
        const fnLen = buffer.readUInt16LE(cdPos + 28);
        const extraLen = buffer.readUInt16LE(cdPos + 30);
        const commentLen = buffer.readUInt16LE(cdPos + 32);
        const localHeaderOffset = buffer.readUInt32LE(cdPos + 42);
        const filename = buffer.toString('utf8', cdPos + 46, cdPos + 46 + fnLen);

        if (filename === 'word/document.xml') {
          if (localHeaderOffset + 30 <= buffer.length && buffer.readUInt32LE(localHeaderOffset) === 0x04034b50) {
            const locFnLen = buffer.readUInt16LE(localHeaderOffset + 26);
            const locExtraLen = buffer.readUInt16LE(localHeaderOffset + 28);
            const dataOffset = localHeaderOffset + 30 + locFnLen + locExtraLen;
            const compData = buffer.subarray(dataOffset, dataOffset + compSize);
            const decomp = method === 8 ? zlib.inflateRawSync(compData) : compData;
            const xml = decomp.toString('utf8');
            const textMatches = xml.match(/<w:t[^>]*>([\s\S]*?)<\/w:t>/g) || [];
            const clean = textMatches.map((m) => m.replace(/<[^>]+>/g, '')).join(' ');
            if (clean.trim()) return clean.trim();
          }
        }
        cdPos += 46 + fnLen + extraLen + commentLen;
      }
    }

    // 2. Secondary fallback: sequential local header scanning
    let offset = 0;
    while (offset < buffer.length - 30) {
      if (buffer.readUInt32LE(offset) !== 0x04034b50) {
        offset++;
        continue;
      }
      const method = buffer.readUInt16LE(offset + 8);
      const compSize = buffer.readUInt32LE(offset + 18);
      const fnLen = buffer.readUInt16LE(offset + 26);
      const extraLen = buffer.readUInt16LE(offset + 28);
      const filename = buffer.toString('utf8', offset + 30, offset + 30 + fnLen);
      const dataOffset = offset + 30 + fnLen + extraLen;

      if (filename === 'word/document.xml' && compSize > 0) {
        const compData = buffer.subarray(dataOffset, dataOffset + compSize);
        const decomp = method === 8 ? zlib.inflateRawSync(compData) : compData;
        const xml = decomp.toString('utf8');
        const textMatches = xml.match(/<w:t[^>]*>([\s\S]*?)<\/w:t>/g) || [];
        const clean = textMatches.map((m) => m.replace(/<[^>]+>/g, '')).join(' ');
        if (clean.trim()) return clean.trim();
      }
      offset = dataOffset + Math.max(1, compSize);
    }
  } catch {
    // If ZIP decompression fails, fallback to regex search
  }

  const xmlMatches = buffer.toString('utf-8').match(/<w:t[^>]*>([\s\S]*?)<\/w:t>/g);
  if (xmlMatches && xmlMatches.length > 0) {
    return xmlMatches.map((m) => m.replace(/<[^>]+>/g, '')).join(' ').trim();
  }

  return '';
}

export class DocumentReaderPlugin implements IPlugin {
  name = 'DocumentReader';
  version = '1.0.0';
  description = 'Reads and summarizes documents (PDF, DOCX, TXT, CSV) sent to the bot or quoted in chat';

  tools: BotTool[] = [
    {
      name: 'read_document',
      description:
        'Reads, parses, and extracts text content from an attached or quoted document (PDF, DOCX, TXT, CSV) so the bot can answer questions, summarize, or analyze the file.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Optional question, query, or topic to focus on when reviewing the document content.',
          },
        },
      },
      execute: async (args: { query?: string }, ctx: ExecutionContext): Promise<ToolResult> => {
        try {
          const raw = ctx.rawMessage;
          if (!raw) {
            return {
              success: false,
              message:
                'No document detected. Please send a document (PDF, TXT, CSV, DOCX) or reply directly to a document message with your request.',
            };
          }

          const unwrappedRaw = unwrapMessage(raw.message);
          const contextInfo =
            unwrappedRaw?.extendedTextMessage?.contextInfo ||
            raw.message?.extendedTextMessage?.contextInfo ||
            unwrappedRaw?.documentMessage?.contextInfo ||
            (raw.message as any)?.documentMessage?.contextInfo;

          let targetMessage: any = null;
          let docMessage: any = null;

          // Check if quoted message is a document
          const unwrappedQuoted = unwrapMessage(contextInfo?.quotedMessage);
          if (unwrappedQuoted?.documentMessage) {
            targetMessage = {
              key: {
                remoteJid: ctx.chatJid,
                id: contextInfo?.stanzaId,
                participant: contextInfo?.participant,
              },
              message: contextInfo?.quotedMessage,
            };
            docMessage = unwrappedQuoted.documentMessage;
          } else if (unwrappedRaw?.documentMessage) {
            targetMessage = raw;
            docMessage = unwrappedRaw.documentMessage;
          }

          if (!targetMessage || !docMessage) {
            return {
              success: false,
              message:
                'No document detected. Please send a document (PDF, TXT, CSV, DOCX) or reply directly to a document message with your request.',
            };
          }

          const fileName = docMessage.fileName || 'document';
          const mimetype = (docMessage.mimetype || '').toLowerCase();
          console.log(`[DocumentReader] Downloading document: "${fileName}" (${mimetype})...`);

          const buffer = (await downloadMediaMessage(targetMessage, 'buffer', {})) as Buffer;

          if (!buffer || buffer.length === 0) {
            return {
              success: false,
              message: `Failed to download document "${fileName}" from WhatsApp.`,
            };
          }

          const lowerName = fileName.toLowerCase();
          let extractedText = '';

          if (lowerName.endsWith('.pdf') || mimetype.includes('pdf')) {
            console.log(`[DocumentReader] Extracting text from PDF (${buffer.length} bytes)...`);
            extractedText = extractTextFromPdf(buffer);
          } else if (lowerName.endsWith('.docx') || mimetype.includes('word') || mimetype.includes('officedocument')) {
            console.log(`[DocumentReader] Extracting text from DOCX (${buffer.length} bytes)...`);
            extractedText = extractTextFromDocx(buffer);
          } else if (
            lowerName.endsWith('.txt') ||
            lowerName.endsWith('.csv') ||
            lowerName.endsWith('.tsv') ||
            lowerName.endsWith('.json') ||
            lowerName.endsWith('.md') ||
            mimetype.includes('text')
          ) {
            console.log(`[DocumentReader] Reading text file (${buffer.length} bytes)...`);
            extractedText = buffer.toString('utf-8');
          } else {
            // General fallback: attempt UTF-8 text decode, otherwise PDF-like extraction
            const asUtf8 = buffer.toString('utf-8');
            const nonPrintable = asUtf8.slice(0, 500).replace(/[\x20-\x7E\t\n\r]/g, '').length;
            if (nonPrintable < 30) {
              extractedText = asUtf8;
            } else {
              extractedText = extractTextFromPdf(buffer);
            }
          }

          if (!extractedText.trim()) {
            return {
              success: false,
              message: `Could not extract readable text from "${fileName}". The file may be image-only (scanned), password-protected, or in an unsupported format.`,
            };
          }

          // Truncate to first 3000 chars to stay within token budget
          const MAX_CHARS = 3000;
          const isTruncated = extractedText.length > MAX_CHARS;
          const finalData = isTruncated ? extractedText.slice(0, MAX_CHARS) : extractedText;

          console.log(`[DocumentReader] Successfully extracted ${finalData.length} chars (truncated: ${isTruncated}) from "${fileName}".`);

          return {
            success: true,
            message: `Document "${fileName}" read successfully. Extracted ${finalData.length} characters of content${
              args.query ? ` for query: "${args.query}"` : ''
            }.${isTruncated ? ' (Content truncated to first 3000 chars to fit token limit)' : ''}`,
            data: finalData,
          };
        } catch (err: any) {
          console.error('[DocumentReader] Error processing document:', err);
          return {
            success: false,
            message: `Failed to read document: ${err.message}`,
          };
        }
      },
    },
  ];
}

export const documentReaderPlugin = new DocumentReaderPlugin();
