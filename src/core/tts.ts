import { exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { config } from '../config/env.js';

const execAsync = promisify(exec);

export async function synthesizeVoiceNote(text: string, voice: string = 'en-US-ChristopherNeural'): Promise<Buffer | null> {
  try {
    const tempDir = config.paths.temp;
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }

    // Clean text of markdown, asterisks, URLs, and emojis for clean speech
    const cleanText = text
      .replace(/[*_~`]/g, '')
      .replace(/https?:\/\/\S+/g, 'link')
      .replace(/[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F700}-\u{1F77F}\u{1F780}-\u{1F7FF}\u{1F800}-\u{1F8FF}\u{1F900}-\u{1F9FF}\u{1FA00}-\u{1FA6F}\u{1FA70}-\u{1FAFF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/gu, '')
      .trim();

    if (!cleanText) return null;

    const hash = crypto.randomBytes(6).toString('hex');
    const tempAudioFile = path.join(tempDir, `tts_${hash}.mp3`);
    const tempTextFile = path.join(tempDir, `tts_${hash}.txt`);

    // Write text to temp file to avoid shell escaping issues
    fs.writeFileSync(tempTextFile, cleanText, 'utf-8');

    // Run edge-tts using system python
    const cmd = `python -m edge_tts --voice "${voice}" -f "${tempTextFile}" --write-media "${tempAudioFile}"`;
    await execAsync(cmd);

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
