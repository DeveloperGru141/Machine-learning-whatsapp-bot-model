import sharp from 'sharp';
import fs from 'fs';
import path from 'path';
import { db } from '../../memory/db.js';
import { config } from '../../config/env.js';

const CHANNEL_MEDIA_DIR = path.join(path.dirname(config.paths.database), 'channel_media');

export function escapeXml(str: string): string {
  if (!str) return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Smart text wrapper that respects natural newlines, dialogue speakers, and word boundaries.
 */
export function wrapTextWithParagraphs(text: string, maxCharsPerLine: number = 30): string[] {
  if (!text) return [];
  // Strip markdown bold/italic asterisks & underscores for clean visual typography
  const sanitized = text
    .replace(/\\r\\n/g, '\n')
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '')
    .replace(/\*+/g, '')
    .replace(/_+/g, '')
    .replace(/—\s*Forgelabs Assistant.*$/i, '')
    .replace(/#\w+/g, '') // remove hashtags
    .trim();

  const rawParagraphs = sanitized.split(/\r?\n/).map((p) => p.trim());
  const allLines: string[] = [];

  for (let i = 0; i < rawParagraphs.length; i++) {
    const p = rawParagraphs[i];
    if (p.length === 0) {
      if (allLines.length > 0 && allLines[allLines.length - 1] !== '') {
        allLines.push('');
      }
      continue;
    }

    const words = p.split(/\s+/);
    let currentLine = '';
    for (const w of words) {
      if ((currentLine + ' ' + w).trim().length <= maxCharsPerLine) {
        currentLine = (currentLine + ' ' + w).trim();
      } else {
        if (currentLine) allLines.push(currentLine);
        currentLine = w;
      }
    }
    if (currentLine) allLines.push(currentLine);
  }

  // Remove trailing blank lines
  while (allLines.length > 0 && allLines[allLines.length - 1] === '') {
    allLines.pop();
  }

  return allLines;
}

/**
 * Dynamically renders an HD viral meme card (1080x1080) with modern styling and high readability.
 */
export async function renderMemeCard(caption: string, outputPath: string): Promise<string> {
  const lines = wrapTextWithParagraphs(caption, 28);
  const totalLines = lines.length;

  // Adaptive font sizing based on length
  let fontSize = 48;
  if (totalLines > 9) fontSize = 32;
  else if (totalLines > 6) fontSize = 38;
  else if (totalLines > 4) fontSize = 44;
  else if (totalLines <= 3) fontSize = 52;

  const lineHeight = Math.round(fontSize * 1.38);
  const totalHeight = totalLines * lineHeight;
  const startY = Math.max(220, Math.round(530 - totalHeight / 2 + fontSize * 0.7));

  const textElements: string[] = [];
  let currentY = startY;

  for (let idx = 0; idx < lines.length; idx++) {
    const line = lines[idx];
    if (line === '') {
      currentY += Math.round(lineHeight * 0.5);
      continue;
    }

    const isPunchline = idx >= lines.length - 2 && lines.length > 3;
    const isSpeaker = /^(Me|Nobody|Interviewer|Brain|Parents|Doctor|Alarm|Crypto traders|Account balance|WhatsApp group|The Wi-Fi router|Rider|Baba|Customer):/i.test(line);

    let fill = '#ffffff';
    let weight = '700';

    if (isSpeaker) {
      fill = '#38bdf8'; // Sky blue for dialogue speaker
      weight = '800';
    } else if (isPunchline) {
      fill = '#fb7185'; // Rose accent for punchline
      weight = '800';
    }

    textElements.push(
      `<text x="540" y="${currentY}" font-family="system-ui, -apple-system, sans-serif" font-size="${fontSize}" font-weight="${weight}" fill="${fill}" text-anchor="middle">${escapeXml(line)}</text>`
    );
    currentY += lineHeight;
  }

  const svg = `
  <svg width="1080" height="1080" viewBox="0 0 1080 1080" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="bgGrad" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stop-color="#090d16" />
        <stop offset="50%" stop-color="#111827" />
        <stop offset="100%" stop-color="#1f1124" />
      </linearGradient>
      <linearGradient id="badgeGrad" x1="0%" y1="0%" x2="100%" y2="0%">
        <stop offset="0%" stop-color="#f43f5e" />
        <stop offset="100%" stop-color="#ec4899" />
      </linearGradient>
    </defs>
    
    <!-- Background Canvas -->
    <rect width="1080" height="1080" fill="url(#bgGrad)" />
    
    <!-- Outer Card Frame -->
    <rect x="50" y="50" width="980" height="980" rx="36" fill="#151b28" fill-opacity="0.8" stroke="#f43f5e" stroke-opacity="0.35" stroke-width="3" />
    <rect x="68" y="68" width="944" height="944" rx="28" fill="none" stroke="#ffffff" stroke-opacity="0.06" stroke-width="1.5" />

    <!-- Top Badge Header -->
    <rect x="350" y="105" width="380" height="56" rx="28" fill="url(#badgeGrad)" />
    <text x="540" y="141" font-family="system-ui, -apple-system, sans-serif" font-size="22" font-weight="900" fill="#ffffff" text-anchor="middle" letter-spacing="3">FORGELABS MEMES</text>

    <!-- Meme Text Lines -->
    ${textElements.join('\n    ')}

    <!-- Bottom Signature -->
    <line x1="440" y1="945" x2="640" y2="945" stroke="#f43f5e" stroke-opacity="0.4" stroke-width="2" />
    <text x="540" y="995" font-family="system-ui, -apple-system, sans-serif" font-size="22" font-weight="600" fill="#9ca3af" text-anchor="middle" letter-spacing="1">Forgelabs Assistant</text>
  </svg>
  `;

  const dir = path.dirname(outputPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  await sharp(Buffer.from(svg)).jpeg({ quality: 92 }).toFile(outputPath);
  return outputPath;
}

/**
 * Dynamically renders an inspiring, high-definition Motivational Quote card (1080x1080).
 */
export async function renderQuoteCard(
  quote: string,
  author: string | null | undefined,
  niche: string,
  outputPath: string
): Promise<string> {
  const lines = wrapTextWithParagraphs(quote, 26);
  const totalLines = lines.length;

  let fontSize = 48;
  if (totalLines > 8) fontSize = 34;
  else if (totalLines > 5) fontSize = 40;
  else if (totalLines <= 3) fontSize = 52;

  const lineHeight = Math.round(fontSize * 1.4);
  const totalHeight = totalLines * lineHeight;
  const startY = Math.max(250, Math.round(510 - totalHeight / 2 + fontSize * 0.7));

  // Theming by Niche
  const themeMap: Record<string, { bg1: string; bg2: string; accent1: string; accent2: string; title: string }> = {
    tech_coding: {
      bg1: '#071626',
      bg2: '#0b2b40',
      accent1: '#0284c7',
      accent2: '#38bdf8',
      title: 'TECH &amp; PRECISION',
    },
    wealth_business: {
      bg1: '#092318',
      bg2: '#0e3a29',
      accent1: '#059669',
      accent2: '#34d399',
      title: 'WEALTH &amp; STRATEGY',
    },
    academic_discipline: {
      bg1: '#1b1b2f',
      bg2: '#272744',
      accent1: '#4f46e5',
      accent2: '#818cf8',
      title: 'SCHOLAR FOCUS',
    },
    general_growth: {
      bg1: '#1f102e',
      bg2: '#31164a',
      accent1: '#9333ea',
      accent2: '#c084fc',
      title: 'DAILY ELEVATION',
    },
    evening_reflection: {
      bg1: '#070b19',
      bg2: '#0f172a',
      accent1: '#38bdf8',
      accent2: '#818cf8',
      title: 'NIGHT REFLECTION',
    },
  };

  const theme = themeMap[niche] || themeMap.general_growth;

  const textElements = lines
    .map((line, idx) => {
      const y = startY + idx * lineHeight;
      return `<text x="540" y="${y}" font-family="system-ui, -apple-system, sans-serif" font-size="${fontSize}" font-weight="700" fill="#f8fafc" text-anchor="middle">${escapeXml(line)}</text>`;
    })
    .join('\n    ');

  const cleanAuthor = author ? author.replace(/^[-—\s]+/, '').trim() : 'Quotes📖';

  const svg = `
  <svg width="1080" height="1080" viewBox="0 0 1080 1080" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="quoteBg" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stop-color="${theme.bg1}" />
        <stop offset="100%" stop-color="${theme.bg2}" />
      </linearGradient>
      <linearGradient id="quoteAccent" x1="0%" y1="0%" x2="100%" y2="0%">
        <stop offset="0%" stop-color="${theme.accent1}" />
        <stop offset="100%" stop-color="${theme.accent2}" />
      </linearGradient>
    </defs>
    
    <!-- Background Canvas -->
    <rect width="1080" height="1080" fill="url(#quoteBg)" />
    
    <!-- Outer Glow Frame -->
    <rect x="50" y="50" width="980" height="980" rx="36" fill="#0d1117" fill-opacity="0.75" stroke="${theme.accent2}" stroke-opacity="0.3" stroke-width="3" />
    <rect x="68" y="68" width="944" height="944" rx="28" fill="none" stroke="#ffffff" stroke-opacity="0.05" stroke-width="1.5" />

    <!-- Category Pill Badge -->
    <rect x="340" y="105" width="400" height="54" rx="27" fill="url(#quoteAccent)" />
    <text x="540" y="141" font-family="system-ui, -apple-system, sans-serif" font-size="20" font-weight="900" fill="#ffffff" text-anchor="middle" letter-spacing="3">${theme.title}</text>

    <!-- Quote Body -->
    ${textElements}

    <!-- Author Attribution -->
    <text x="540" y="${Math.min(880, startY + totalLines * lineHeight + 65)}" font-family="system-ui, -apple-system, sans-serif" font-size="28" font-style="italic" font-weight="600" fill="${theme.accent2}" text-anchor="middle">— ${escapeXml(cleanAuthor)}</text>

    <!-- Footer Signature -->
    <line x1="440" y1="945" x2="640" y2="945" stroke="${theme.accent2}" stroke-opacity="0.3" stroke-width="2" />
    <text x="540" y="995" font-family="system-ui, -apple-system, sans-serif" font-size="22" font-weight="600" fill="#94a3b8" text-anchor="middle" letter-spacing="1">Forgelabs Assistant</text>
  </svg>
  `;

  const dir = path.dirname(outputPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  await sharp(Buffer.from(svg)).jpeg({ quality: 92 }).toFile(outputPath);
  return outputPath;
}

/**
 * Returns a guaranteed valid, beautifully rendered image path for any meme.
 */
export async function getOrGenerateMemeMedia(
  memeId: number | string,
  caption: string,
  existingPath?: string | null
): Promise<string> {
  if (existingPath && fs.existsSync(existingPath)) {
    const isLegacyBroken = existingPath.includes('meme_default.jpg');
    if (!isLegacyBroken) {
      try {
        const stats = fs.statSync(existingPath);
        if (stats.size > 2000) return existingPath;
      } catch {}
    }
  }

  const filename = `meme_${memeId}.jpg`;
  fs.mkdirSync(CHANNEL_MEDIA_DIR, { recursive: true });
  const targetPath = path.join(CHANNEL_MEDIA_DIR, filename);
  await renderMemeCard(caption, targetPath);

  // Update DB if this is a known numeric meme ID
  if (typeof memeId === 'number' || /^\d+$/.test(String(memeId))) {
    try {
      await db.prepare('UPDATE channel_memes SET image_path = ? WHERE id = ?').run(targetPath, Number(memeId));
    } catch {}
  }

  return targetPath;
}

/**
 * Returns a guaranteed valid, beautifully rendered image path for any motivational quote.
 */
export async function getOrGenerateQuoteMedia(
  quoteId: number | string,
  quote: string,
  author: string | null | undefined,
  niche: string,
  existingPath?: string | null
): Promise<string> {
  if (existingPath && fs.existsSync(existingPath)) {
    const isLegacyBroken = /quote_(tech_coding|wealth_business|academic_discipline|general_growth)\.jpg$/.test(existingPath);
    if (!isLegacyBroken) {
      try {
        const stats = fs.statSync(existingPath);
        if (stats.size > 2000) return existingPath;
      } catch {}
    }
  }

  const filename = `quote_${quoteId}.jpg`;
  fs.mkdirSync(CHANNEL_MEDIA_DIR, { recursive: true });
  const targetPath = path.join(CHANNEL_MEDIA_DIR, filename);
  await renderQuoteCard(quote, author, niche, targetPath);

  if (typeof quoteId === 'number' || /^\d+$/.test(String(quoteId))) {
    try {
      await db.prepare('UPDATE channel_quotes SET image_path = ? WHERE id = ?').run(targetPath, Number(quoteId));
    } catch {}
  }

  return targetPath;
}
