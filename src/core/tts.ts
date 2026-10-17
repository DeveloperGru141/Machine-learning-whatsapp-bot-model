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

const AUDIO_FILTER_CHAIN =
  'highpass=f=75,equalizer=f=185:width_type=o:width=1.4:g=2.2,acompressor=threshold=-16dB:ratio=2.2:attack=12:release=140';

/**
 * Infuses generic written sentences with natural spoken Nigerian Pidgin / Naija voice-note warmth
 * and conversational cadence so voice notes never sound like flat, generic text readouts.
 */
export function enrichSpokenPidginCadence(rawText: string): string {
  let text = (rawText || '').trim();
  if (!text) return '';

  // Strip markdown formatting and URLs
  text = text
    .replace(/[*_~`#>-]/g, ' ')
    .replace(/https?:\/\/\S+/g, 'the link I dropped')
    .replace(/[\p{Emoji_Presentation}\p{Extended_Pictographic}\p{Emoji_Modifier}\u{FE0F}\u{200D}]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();

  // Replace stiff/generic English phrases with natural spoken Naija Pidgin equivalents
  text = text
    .replace(/\bI am doing well\b/gi, 'I dey kampe my guy')
    .replace(/\bHow are you doing\b/gi, 'How far na, how body')
    .replace(/\bWhat is going on\b/gi, 'Wetin dey sup')
    .replace(/\bNo problem at all\b/gi, 'No wahala at all')
    .replace(/\bDon't worry about it\b/gi, 'No worry yourself abeg')
    .replace(/\bPlease wait a moment\b/gi, 'Hold on small abeg')
    .replace(/\bI understand what you mean\b/gi, 'I grab wetin you talk')
    .replace(/\bTo be honest\b/gi, 'No go lie for you')
    .replace(/\bFor real\b/gi, 'no cap')
    .replace(/\bLet me know\b/gi, 'Just yarn me');

  // If the script is very plain and lacks any natural spoken opener/interjection, add a warm Naija conversational lead-in
  const hasConversationalOpener =
    /^(omo|abeg|guy|my guy|bro|boss|chief|yo|haha|chai|see ehn|wait|honestly|nah|yeah|how far|wetin|no wahala|ademola)/i.test(
      text
    );
  if (!hasConversationalOpener && text.length > 18) {
    const openers = [
      'Omo my guy, ',
      'See ehn, ',
      'Chai, ',
      'My guy, ',
      'No wahala na, ',
    ];
    const idx = text.length % openers.length;
    text = `${openers[idx]}${text.charAt(0).toLowerCase()}${text.slice(1)}`;
  }

  return text;
}

/**
 * Nigerian Pidgin & Naija Slang Phonetic Pronunciation Lexicon for Neural TTS (en-NG-AbeoNeural).
 * Converts Pidgin orthography into exact phonetic syllables and prosodic micro-pauses
 * so the TTS engine pronounces Pidgin naturally like a native Nigerian speaker.
 */
export function formatPidginPhonetics(rawText: string): string {
  let spoken = enrichSpokenPidginCadence(rawText);
  if (!spoken) return '';

  // 1. Expand abbreviations & tech acronyms for natural speech
  spoken = spoken
    .replace(/\bngl\b/gi, 'no go lie,')
    .replace(/\bfr\b/gi, 'for real,')
    .replace(/\btbh\b/gi, 'to be honest,')
    .replace(/\bidk\b/gi, 'I no even sabi')
    .replace(/\blmao\b|\blol\b|\blwkmd\b/gi, 'haha,')
    .replace(/\bsmh\b/gi, 'na wa oh,')
    .replace(/\bbtc\b/gi, 'Bitcoin')
    .replace(/\beth\b/gi, 'Ethereum')
    .replace(/\bsol\b/gi, 'Solana')
    .replace(/\bai\b/gi, 'A.I.')
    .replace(/\bml\b/gi, 'M.L.')
    .replace(/\bpdf\b/gi, 'P.D.F.')
    .replace(/\big\b/gi, 'Instagram')
    .replace(/\bvn\b/gi, 'voice note')
    .replace(/\bdm\b/gi, 'D.M.');

  // 2. Multi-word Nigerian Pidgin expressions -> natural spoken rhythm + phonetic spelling
  spoken = spoken
    .replace(/\bno wahala\b/gi, 'no waa-haa-lah')
    .replace(/\bwetin dey happen\b/gi, 'wey-tin day happen')
    .replace(/\bwetin dey sup\b/gi, 'wey-tin day sup')
    .replace(/\bwetin dey\b/gi, 'wey-tin day')
    .replace(/\bhow far na\b/gi, 'how faa nah,')
    .replace(/\bhow far\b/gi, 'how faa,')
    .replace(/\bno be small\b/gi, 'no bee small')
    .replace(/\be choke\b/gi, 'eh choke oh')
    .replace(/\bi dey kampe\b/gi, 'I day kam-peh')
    .replace(/\bsharp sharp\b/gi, 'sharp, sharp')
    .replace(/\bsee ehn\b/gi, 'see ehn,')
    .replace(/\bno cap\b/gi, 'no cap,')
    .replace(/\bna wa o+\b/gi, 'naa waa oh,')
    .replace(/\bna wa\b/gi, 'naa waa,');

  // 3. Single-word Nigerian Pidgin & Yoruba/Igbo/Naija vocabulary -> exact phonetic mapping
  spoken = spoken
    .replace(/\bademola\b/gi, 'Ah-deh-maw-lah')
    .replace(/\bforgelabs\b/gi, 'Forge Labs')
    .replace(/\bwetin\b/gi, 'wey-tin')
    .replace(/\bdey\b/gi, 'day')
    .replace(/\babeg\b/gi, 'ah-beg,')
    .replace(/\bwahala\b/gi, 'waa-haa-lah')
    .replace(/\bsabi\b/gi, 'sah-bee')
    .replace(/\bomo\b/gi, 'aw-maw,')
    .replace(/\bchai\b/gi, 'chah-ee,')
    .replace(/\bsha\b/gi, 'shah')
    .replace(/\babi\b/gi, 'ah-bee')
    .replace(/\bshebi\b/gi, 'sheh-bee')
    .replace(/\bshey\b/gi, 'shay')
    .replace(/\bsef\b/gi, 'seff')
    .replace(/\bcomot\b/gi, 'kaw-mawt')
    .replace(/\bjapa\b/gi, 'jaa-paa')
    .replace(/\bgbege\b/gi, 'gbeh-geh')
    .replace(/\bkasala\b/gi, 'kah-sah-lah')
    .replace(/\bpikin\b/gi, 'pee-keen')
    .replace(/\buna\b/gi, 'oo-nah')
    .replace(/\boya\b/gi, 'aw-yah,')
    .replace(/\bkpele\b|\bpele\b/gi, 'peh-leh')
    .replace(/\boshey\b/gi, 'oh-shay')
    .replace(/\bnawa\b/gi, 'naa-waa')
    .replace(/\bchop\b/gi, 'chawp')
    .replace(/\byarn\b/gi, 'yaan')
    .replace(/\bgbedu\b/gi, 'gbeh-doo')
    .replace(/\bvawulence\b/gi, 'vah-woo-lense')
    .replace(/\bsapa\b/gi, 'sah-paa')
    .replace(/\bawoof\b/gi, 'ah-woof')
    .replace(/\begbon\b/gi, 'eh-gbon')
    .replace(/\boga\b/gi, 'aw-gah')
    .replace(/\bmad o+\b/gi, 'mad oh,')
    .replace(/\b([a-zA-Z]+)\s+o+\b/gi, '$1 oh');

  // 4. Add natural breathing pauses around commas/ellipses and clean whitespace
  spoken = spoken
    .replace(/,{2,}/g, ',')
    .replace(/\s+([,.;!?])/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();

  return spoken;
}

/**
 * Synthesizes natural human-like Nigerian & Pidgin voice notes with emotion, authentic phonetic
 * pronunciation, and warm microphone presence.
 * Defaults to warm Nigerian English/Pidgin (en-NG-AbeoNeural), with fallback to en-NG-EzinneNeural
 * and en-US-BrianMultilingualNeural.
 * Transcodes to native OGG Opus (48kHz mono VoIP) so WhatsApp plays it as a real PTT voice note.
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

    const spokenText = formatPidginPhonetics(text);
    if (!spokenText) return null;

    const hash = crypto.randomBytes(6).toString('hex');
    const tempMp3File = path.join(tempDir, `tts_${hash}.mp3`);
    const tempOggFile = path.join(tempDir, `tts_${hash}.ogg`);
    const tempTextFile = path.join(tempDir, `tts_${hash}.txt`);

    // Write phonetic Pidgin script to temp file to avoid shell escaping issues
    fs.writeFileSync(tempTextFile, spokenText, 'utf-8');

    const selectedVoice = voice || config.bot.voice || 'en-NG-AbeoNeural';
    const runners = ['edge-tts', 'python3 -m edge_tts', 'python -m edge_tts'];

    // Slight warm baritone pitch (-2Hz) and natural conversational cadence (-2% rate so Pidgin syllables breathe naturally)
    const runEdgeTts = async (targetVoice: string): Promise<boolean> => {
      for (const runner of runners) {
        try {
          const cmd = `${runner} --voice "${targetVoice}" --rate="-2%" --pitch="-2Hz" -f "${tempTextFile}" --write-media "${tempMp3File}"`;
          await execAsync(cmd, { timeout: 15_000 });
          if (fs.existsSync(tempMp3File) && fs.statSync(tempMp3File).size > 100) {
            return true;
          }
        } catch {}
      }
      return false;
    };

    try {
      let generated = await runEdgeTts(selectedVoice);
      if (!generated && selectedVoice !== 'en-NG-EzinneNeural') {
        console.warn(`[TTS] Primary voice "${selectedVoice}" unavailable, trying en-NG-EzinneNeural...`);
        generated = await runEdgeTts('en-NG-EzinneNeural');
      }
      if (!generated) {
        console.warn(`[TTS] Nigerian voices unavailable, trying en-US-BrianMultilingualNeural...`);
        generated = await runEdgeTts('en-US-BrianMultilingualNeural');
      }

      // Pure Node.js HTTP TTS fallback (Nigerian English tl=en-NG) if Python/edge-tts is not installed on external server
      if (!generated) {
        try {
          const ttsChunk = spokenText.slice(0, 200);
          const gUrl = `https://translate.google.com/translate_tts?ie=UTF-8&tl=en-NG&client=tw-ob&q=${encodeURIComponent(ttsChunk)}`;
          const res = await fetch(gUrl, {
            headers: { 'User-Agent': 'Mozilla/5.0' },
            signal: AbortSignal.timeout(10_000),
          });
          if (res.ok) {
            const arrBuf = await res.arrayBuffer();
            fs.writeFileSync(tempMp3File, Buffer.from(arrBuf));
            generated = true;
          }
        } catch {}
      }

      if (!fs.existsSync(tempMp3File)) {
        return null;
      }

      // Convert MP3 -> genuine OGG Opus stream with warm WhatsApp microphone presence shaping
      if (ffmpegPath && fs.existsSync(ffmpegPath)) {
        try {
          await execFileAsync(ffmpegPath, [
            '-y',
            '-i',
            tempMp3File,
            '-af',
            AUDIO_FILTER_CHAIN,
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

