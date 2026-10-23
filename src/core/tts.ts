import { exec, execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { createRequire } from 'node:module';
import { config } from '../config/env.js';
import { getBotSetting } from '../memory/db.js';

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);

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
 * and conversational cadence mimicking creator Ademola's signature Lagos/Naija Pidgin speaking style:
 * Laid-back, street-smart, confident, brotherly, with authentic markers ("omooo", "bayii", "shaa", "oyaa naw").
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

  // Replace stiff/generic English phrases with Ademola's authentic spoken Naija Pidgin equivalents
  text = text
    .replace(/\bI am doing well\b/gi, 'I dey kampe bayii')
    .replace(/\bHow are you doing\b/gi, 'How far na, wetin dey sup')
    .replace(/\bWhat is going on\b/gi, 'Wetin dey sup bayii')
    .replace(/\bNo problem at all\b|\bNo problem\b/gi, 'No wahala at all')
    .replace(/\bDon't worry about it\b|\bDon't worry\b/gi, 'No worry shaa, no wahala')
    .replace(/\bPlease wait a moment\b|\bWait a second\b/gi, 'Hold on small abeg')
    .replace(/\bI understand what you mean\b|\bI understand\b/gi, 'I grab wetin you talk')
    .replace(/\bDo you understand\b|\bYou understand\b/gi, 'You dey grab?')
    .replace(/\bTo be honest\b/gi, 'No go lie for you')
    .replace(/\bFor real\b/gi, 'no cap')
    .replace(/\bRight now\b|\bAt the moment\b/gi, 'bayii')
    .replace(/\bAnyway\b|\bRegardless\b/gi, 'shaa')
    .replace(/\bCan you\b|\bAre you able to\b/gi, 'You fit')
    .replace(/\bLet me know\b/gi, 'Just yarn me')
    .replace(/\bTell me\b/gi, 'Yarn me');

  // If the script is very plain and lacks any natural spoken opener/interjection, add Ademola's signature Naija conversational lead-in
  const hasConversationalOpener =
    /^(omooo?|abeg|guy|my guy|bro|boss|chief|yo|haha|chai|see ehn|wait|honestly|nah|yeah|how far|wetin|no wahala|ademola|oyaa)/i.test(
      text
    );
  if (!hasConversationalOpener && text.length > 18) {
    const openers = [
      'Omooo, ',
      'See wetin dey sup bayii, ',
      'Oyaa naw, ',
      'No wahala at all, ',
      'My guy, ',
      'How far na, ',
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
 * Formats voice note scripts into clear, fluent, articulate English.
 * Strips markdown, emojis, URLs, expands acronyms for natural speech, and ensures zero Pidgin.
 */
export function formatEnglishVoiceScript(rawText: string): string {
  let text = (rawText || '').trim();
  if (!text) return '';

  // 1. Strip markdown formatting and URLs
  text = text
    .replace(/[*_~`#>-]/g, ' ')
    .replace(/https?:\/\/\S+/g, 'the link')
    .replace(/[\p{Emoji_Presentation}\p{Extended_Pictographic}\p{Emoji_Modifier}\u{FE0F}\u{200D}]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();

  // 2. Translate any lingering Pidgin words into polished English
  text = text
    .replace(/\bwetin dey sup bayii\b|\bwetin dey sup\b|\bwetin dey\b/gi, 'what is going on')
    .replace(/\bno wahala at all\b|\bno wahala\b/gi, 'no problem at all')
    .replace(/\bhow far na\b|\bhow far\b/gi, 'hello, how are you')
    .replace(/\babeg\b/gi, 'please')
    .replace(/\bsharp sharp\b/gi, 'quickly')
    .replace(/\bomooo?\b/gi, 'well')
    .replace(/\bbayii\b/gi, 'now')
    .replace(/\bshaa\b/gi, 'anyway')
    .replace(/\boyaa?\s*naw?\b|\boyaa?\b/gi, 'alright')
    .replace(/\bu fit\b|\byou fit\b/gi, 'you can')
    .replace(/\byou dey grab\??\b/gi, 'do you understand?')
    .replace(/\byarn me\b/gi, 'tell me')
    .replace(/\bi dey kampe\b/gi, 'I am doing well')
    .replace(/\be choke\b/gi, 'it is impressive')
    .replace(/\bno cap\b/gi, 'truly')
    .replace(/\bna wa o*\b|\bna wa\b/gi, 'that is surprising');

  // 3. Expand acronyms and abbreviations for smooth English pronunciation
  text = text
    .replace(/\bAI\b/g, 'A.I.')
    .replace(/\bML\b/g, 'M.L.')
    .replace(/\bPDF\b/g, 'P.D.F.')
    .replace(/\bDM\b/g, 'direct message')
    .replace(/\bVN\b/g, 'voice note')
    .replace(/\bURL\b/g, 'link')
    .replace(/\bAPI\b/g, 'A.P.I.')
    .replace(/\bFAQ\b/g, 'F.A.Q.')
    .replace(/\bCEO\b/g, 'C.E.O.')
    .replace(/\betc\b/gi, 'etcetera')
    .replace(/\be\.g\.\b/gi, 'for example')
    .replace(/\bi\.e\.\b/gi, 'that is')
    .replace(/\bapprox\.\b/gi, 'approximately');

  // 4. Clean up punctuation and spacing for natural speaking rhythm
  text = text
    .replace(/,{2,}/g, ',')
    .replace(/\s+([,.;!?])/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();

  return text;
}

/**
 * Synthesizes natural human-like English voice notes with emotion, authentic phonetic
 * pronunciation, and warm microphone presence using ElevenLabs Neural TTS.
 * Fallback to EdgeTTS and Google TTS if ElevenLabs is unavailable.
 * Transcodes to native OGG Opus (48kHz mono VoIP) so WhatsApp plays it as a real PTT voice note.
 */
export async function synthesizeVoiceNote(
  text: string,
  voice?: string
): Promise<Buffer | null> {
  const spokenText = formatEnglishVoiceScript(text);
  if (!spokenText) return null;

  const tempDir = config.paths.temp;
  if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true });
  }

  const hash = crypto.randomBytes(6).toString('hex');
  const tempMp3File = path.join(tempDir, `tts_${hash}.mp3`);
  const tempOggFile = path.join(tempDir, `tts_${hash}.ogg`);

  const dynamicVoiceId = getBotSetting('elevenlabs_voice_id', config.elevenlabs?.voiceId) || 'pNInz6obpgDQGcFmaJgB';
  const dynamicProvider = getBotSetting('tts_provider', 'elevenlabs');
  const elevenLabsVoice = voice || dynamicVoiceId;
  const elevenLabsModel = config.elevenlabs?.modelId || 'eleven_multilingual_v2';
  const elevenLabsApiKey = config.elevenlabs?.apiKey;

  // If user or system configured native Nigerian Edge-TTS or provider is edge-tts, route directly
  if (dynamicProvider === 'edge-tts' || elevenLabsVoice === 'en-NG-AbeoNeural' || elevenLabsVoice === 'edge-tts') {
    return oldSynthesizeVoiceNote(text, 'en-NG-AbeoNeural');
  }

  // 1. Primary Engine: ElevenLabs Humanlike Multilingual Neural TTS
  if (elevenLabsApiKey) {
    try {
      console.log(`[TTS] 🎙️ Synthesizing humanlike voice note with ElevenLabs (${elevenLabsVoice}, model: ${elevenLabsModel})...`);
      const elevenEndpoint = `https://api.elevenlabs.io/v1/text-to-speech/${elevenLabsVoice}?output_format=mp3_44100_128`;

      const response = await fetch(elevenEndpoint, {
        method: 'POST',
        headers: {
          'xi-api-key': elevenLabsApiKey,
          'Content-Type': 'application/json',
          'Accept': 'audio/mpeg',
        },
        body: JSON.stringify({
          text: spokenText,
          model_id: elevenLabsModel,
          voice_settings: {
            stability: 0.50,
            similarity_boost: 0.80,
            style: 0.20,
            use_speaker_boost: true,
          },
        }),
        signal: AbortSignal.timeout(25_000),
      });

      if (response.ok) {
        const audioArray = await response.arrayBuffer();
        const mp3Buffer = Buffer.from(audioArray);
        fs.writeFileSync(tempMp3File, mp3Buffer);
        console.log(`[TTS] ✅ ElevenLabs synthesized ${mp3Buffer.length} bytes of audio.`);

        // Convert MP3 -> genuine WhatsApp OGG Opus PTT VoIP stream
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
              const oggData = fs.readFileSync(tempOggFile);
              try { if (fs.existsSync(tempMp3File)) fs.unlinkSync(tempMp3File); } catch {}
              try { if (fs.existsSync(tempOggFile)) fs.unlinkSync(tempOggFile); } catch {}
              return oggData;
            }
          } catch (ffErr: any) {
            console.warn('[TTS] ffmpeg conversion warning, returning MP3 buffer:', ffErr.message);
          }
        }
        try { if (fs.existsSync(tempMp3File)) fs.unlinkSync(tempMp3File); } catch {}
        return mp3Buffer;
      } else {
        const errText = await response.text();
        console.warn(`[TTS] ElevenLabs returned ${response.status}:`, errText.slice(0, 160));
      }
    } catch (elevenErr: any) {
      console.warn('[TTS] ElevenLabs synthesis failed, trying fallback:', elevenErr.message || elevenErr);
    }
  }

  // 2. Fallback Engine: Edge-TTS and Google TTS
  return oldSynthesizeVoiceNote(text, voice);
}

export async function oldSynthesizeVoiceNote(
  text: string,
  voice: string = config.bot.voice || 'en-US-BrianMultilingualNeural'
): Promise<Buffer | null> {
  try {
    const tempDir = config.paths.temp;
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }

    const spokenText = formatEnglishVoiceScript(text);
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

