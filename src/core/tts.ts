import { exec, execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { config } from '../config/env.js';

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

let ffmpegPath: string | null = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  ffmpegPath = require('ffmpeg-static');
} catch {
  ffmpegPath = null;
}

/**
 * Synthesizes natural human-like voice notes with emotion and conversational cadence.
 * Defaults to authentic warm Nigerian/African English (en-NG-AbeoNeural),
 * with support for expressive US conversational (en-US-BrianMultilingualNeural).
 * Transcodes to native OGG Opus (48kHz mono VoIP) so WhatsApp plays it natively without corruption.
 */
export async function synthesizeVoiceNote(
  text: string,
  voice: string = config.bot.voice || 'en-NG-AbeoNeural'
): Promise<Buffer | null> {
  try {
    const tempDir = config.paths.temp;
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }

    // Expand internet slang & technical acronyms into natural spoken words
    let spokenText = text
      .replace(/[*_~`#>-]/g, ' ')
      .replace(/https?:\/\/\S+/g, 'the link')
      .replace(/[\p{Emoji_Presentation}\p{Extended_Pictographic}\p{Emoji_Modifier}\u{FE0F}\u{200D}]/gu, '')
      .replace(/\bngl\b/gi, 'not gonna lie')
      .replace(/\bfr\b/gi, 'for real')
      .replace(/\btbh\b/gi, 'to be honest')
      .replace(/\bidk\b/gi, "I don't know")
      .replace(/\blmao\b|\blol\b/gi, 'haha')
      .replace(/\bbtc\b/gi, 'Bitcoin')
      .replace(/\beth\b/gi, 'Ethereum')
      .replace(/\bsol\b/gi, 'Solana')
      .replace(/\bai\b/gi, 'A.I.')
      .replace(/\bpdf\b/gi, 'P.D.F.')
      .replace(/\big\b/gi, 'Instagram')
      .replace(/\bvn\b/gi, 'voice note')
      .replace(/\s+/g, ' ')
      .trim();

    if (!spokenText) return null;

    const hash = crypto.randomBytes(6).toString('hex');
    const tempMp3File = path.join(tempDir, `tts_${hash}.mp3`);
    const tempOggFile = path.join(tempDir, `tts_${hash}.ogg`);
    const tempTextFile = path.join(tempDir, `tts_${hash}.txt`);

    // Write text to temp file to avoid shell escaping issues
    fs.writeFileSync(tempTextFile, spokenText, 'utf-8');

    // Run edge-tts with natural conversational pacing (+3% rate)
    const selectedVoice = voice || config.bot.voice || 'en-NG-AbeoNeural';
    const cmd = `python -m edge_tts --voice "${selectedVoice}" --rate="+3%" -f "${tempTextFile}" --write-media "${tempMp3File}"`;

    try {
      try {
        await execAsync(cmd);
      } catch (cmdErr: any) {
        console.warn(`[TTS] Primary voice "${selectedVoice}" failed, falling back to en-US-BrianMultilingualNeural...`);
        const fallbackCmd = `python -m edge_tts --voice "en-US-BrianMultilingualNeural" --rate="+3%" -f "${tempTextFile}" --write-media "${tempMp3File}"`;
        await execAsync(fallbackCmd);
      }

      if (!fs.existsSync(tempMp3File)) {
        return null;
      }

      // Convert MP3 -> genuine OGG Opus stream required by WhatsApp PTT voice notes
      if (ffmpegPath && fs.existsSync(ffmpegPath)) {
        try {
          await execFileAsync(ffmpegPath, [
            '-y',
            '-i',
            tempMp3File,
            '-c:a',
            'libopus',
            '-b:a',
            '64k',
            '-vbr',
            'on',
            '-compression_level',
            '10',
            '-frame_duration',
            '60',
            '-application',
            'voip',
            '-ar',
            '48000',
            '-ac',
            '1',
            tempOggFile,
          ]);
          if (fs.existsSync(tempOggFile)) {
            return fs.readFileSync(tempOggFile);
          }
        } catch (ffErr: any) {
          console.warn('[TTS] ffmpeg OGG Opus conversion warning, using raw MP3:', ffErr.message);
        }
      }

      return fs.readFileSync(tempMp3File);
    } finally {
      // Clean up temporary files reliably
      try {
        if (fs.existsSync(tempTextFile)) fs.unlinkSync(tempTextFile);
        if (fs.existsSync(tempMp3File)) fs.unlinkSync(tempMp3File);
        if (fs.existsSync(tempOggFile)) fs.unlinkSync(tempOggFile);
      } catch {}
    }
  } catch (err: any) {
    console.error('[TTS] Voice synthesis error:', err.message);
    return null;
  }
}

/**
 * Transcodes an arbitrary audio buffer (e.g. MP3/WAV/AAC) into native WhatsApp OGG Opus stream.
 */
export async function transcodeToOggOpus(inputBuffer: Buffer): Promise<Buffer> {
  if (inputBuffer.length >= 4 && inputBuffer.subarray(0, 4).toString('ascii') === 'OggS') {
    return inputBuffer;
  }
  if (!ffmpegPath || !fs.existsSync(ffmpegPath)) {
    return inputBuffer;
  }
  const tempDir = config.paths.temp;
  if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true });
  }
  const hash = crypto.randomBytes(6).toString('hex');
  const tempIn = path.join(tempDir, `transcode_${hash}.input`);
  const tempOut = path.join(tempDir, `transcode_${hash}.ogg`);
  fs.writeFileSync(tempIn, inputBuffer);
  try {
    await execFileAsync(ffmpegPath, [
      '-y',
      '-i',
      tempIn,
      '-c:a',
      'libopus',
      '-b:a',
      '64k',
      '-vbr',
      'on',
      '-compression_level',
      '10',
      '-frame_duration',
      '60',
      '-application',
      'voip',
      '-ar',
      '48000',
      '-ac',
      '1',
      tempOut,
    ]);
    if (fs.existsSync(tempOut)) {
      return fs.readFileSync(tempOut);
    }
    return inputBuffer;
  } catch (err: any) {
    console.warn('[TTS] Error transcoding to Ogg Opus:', err.message);
    return inputBuffer;
  } finally {
    try { if (fs.existsSync(tempIn)) fs.unlinkSync(tempIn); } catch {}
    try { if (fs.existsSync(tempOut)) fs.unlinkSync(tempOut); } catch {}
  }
}

