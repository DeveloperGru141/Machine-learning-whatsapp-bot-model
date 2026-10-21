import { config } from '../config/env.js';
import { llmClient } from '../agent/llm-client.js';

export interface VoiceNoteAnalysis {
  transcript: string;
  summary: string;
}

/**
 * Transcribes audio/voice note using Groq Whisper (whisper-large-v3 with turbo fallback)
 * with Nigerian English prompt optimization.
 */
export async function transcribeAudioBuffer(audioBuffer: Buffer): Promise<string | null> {
  const apiKeys = config.groq.apiKeys.length > 0 ? config.groq.apiKeys : [config.groq.apiKey || ''];
  const activeKey = apiKeys.find((k) => Boolean(k && k.trim())) || config.groq.apiKey;

  if (!activeKey) {
    console.warn('[Transcription] No GROQ_API_KEY configured for Whisper transcription.');
    return null;
  }

  const models = ['whisper-large-v3', 'whisper-large-v3-turbo'];

  for (const model of models) {
    try {
      const formData = new FormData();
      const blob = new Blob([audioBuffer], { type: 'audio/ogg' });
      formData.append('file', blob, 'voicenote.ogg');
      formData.append('model', model);
      formData.append('language', 'en');
      formData.append(
        'prompt',
        'WhatsApp voice note in Nigerian English, Pidgin, or standard English. Common words: how far, wetin dey sup, abeg, omo, bro, guy, Ademola, Forgelabs, boss, audio, assignment, score, game.'
      );
      formData.append('response_format', 'json');

      const res = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${activeKey}`,
        },
        body: formData,
        signal: AbortSignal.timeout(12_000),
      });

      if (!res.ok) {
        const errText = await res.text();
        console.warn(`[Transcription] Groq Whisper (${model}) returned HTTP ${res.status}: ${errText.slice(0, 100)}`);
        continue;
      }

      const data = (await res.json()) as { text?: string };
      const transcription = data.text?.trim() || null;
      if (transcription) {
        console.log(`[Transcription] 🎙️ Heard voicenote (${model}): "${transcription.slice(0, 80)}..."`);
        return transcription;
      }
    } catch (err: any) {
      console.warn(`[Transcription] Model ${model} attempt failed: ${err.message}`);
    }
  }

  return null;
}

/**
 * Generates a concise, high-value 1-sentence summary of a transcribed voice note.
 */
export async function summarizeTranscript(transcript: string): Promise<string> {
  if (!transcript || transcript.trim().length === 0) return '';
  if (transcript.split(/\s+/).length <= 10) {
    return transcript.trim();
  }

  try {
    const res = await llmClient.chatCompletion({
      messages: [
        {
          role: 'system',
          content:
            'You are an expert executive secretary. Summarize the following WhatsApp voice note transcript in exactly ONE concise, natural sentence (max 20 words). Capture the core intent or question clearly. Do NOT start with "The speaker says" or "In this audio". State the core message directly.',
        },
        {
          role: 'user',
          content: transcript,
        },
      ],
      max_tokens: 60,
      temperature: 0.3,
    });

    const summary = res.choices[0]?.message?.content?.trim();
    if (summary) {
      return summary.replace(/^["']|["']$/g, '');
    }
  } catch (err: any) {
    console.warn('[Transcription] Summary generation error:', err.message);
  }

  // Fallback: clean snippet
  const words = transcript.split(/\s+/);
  return words.slice(0, 15).join(' ') + (words.length > 15 ? '...' : '');
}

/**
 * Transcribes and summarizes an audio voice note in one unified call.
 */
export async function analyzeVoiceNote(audioBuffer: Buffer): Promise<VoiceNoteAnalysis | null> {
  const transcript = await transcribeAudioBuffer(audioBuffer);
  if (!transcript) return null;
  const summary = await summarizeTranscript(transcript);
  return { transcript, summary };
}
