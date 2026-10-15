import { exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { config } from '../config/env.js';

const execAsync = promisify(exec);

/**
 * Synthesizes natural human-like voice notes with emotion and conversational cadence.
 * Defaults to authentic warm Nigerian/African English (en-NG-AbeoNeural),
 * with support for expressive US conversational (en-US-BrianMultilingualNeural).
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
      .replace(/[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F700}-\u{1F77F}\u{1F780}-\u{1F7FF}\u{1F800}-\u{1F8FF}\u{1F900}-\u{1F9FF}\u{1FA00}-\u{1FA6F}\u{1FA70}-\u{1FAFF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/gu, '')
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
    const tempAudioFile = path.join(tempDir, `tts_${hash}.mp3`);
    const tempTextFile = path.join(tempDir, `tts_${hash}.txt`);

    // Write text to temp file to avoid shell escaping issues
    fs.writeFileSync(tempTextFile, spokenText, 'utf-8');

    // Run edge-tts with natural conversational pacing (+3% rate)
    const selectedVoice = voice || config.bot.voice || 'en-NG-AbeoNeural';
    const cmd = `python -m edge_tts --voice "${selectedVoice}" --rate="+3%" -f "${tempTextFile}" --write-media "${tempAudioFile}"`;
    
    try {
      await execAsync(cmd);
    } catch (cmdErr: any) {
      console.warn(`[TTS] Primary voice "${selectedVoice}" failed, falling back to en-US-BrianMultilingualNeural...`);
      const fallbackCmd = `python -m edge_tts --voice "en-US-BrianMultilingualNeural" --rate="+3%" -f "${tempTextFile}" --write-media "${tempAudioFile}"`;
      await execAsync(fallbackCmd);
    }

    if (!fs.existsSync(tempAudioFile)) {
      return null;
    }

    const audioBuffer = fs.readFileSync(tempAudioFile);

    // Clean up temporary files
    try {
      fs.unlinkSync(tempTextFile);
      fs.unlinkSync(tempAudioFile);
    } catch {}

    return audioBuffer;
  } catch (err: any) {
    console.error('[TTS] Voice synthesis error:', err.message);
    return null;
  }
}
