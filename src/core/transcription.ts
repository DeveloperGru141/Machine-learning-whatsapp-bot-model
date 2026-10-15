import { config } from '../config/env.js';

export async function transcribeAudioBuffer(audioBuffer: Buffer): Promise<string | null> {
  if (!config.groq.apiKey) {
    console.warn('[Transcription] GROQ_API_KEY is not configured');
    return null;
  }

  try {
    const formData = new FormData();
    const blob = new Blob([audioBuffer], { type: 'audio/ogg' });
    formData.append('file', blob, 'voicenote.ogg');
    formData.append('model', 'whisper-large-v3-turbo');
    formData.append('response_format', 'json');

    const res = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.groq.apiKey}`,
      },
      body: formData,
    });

    if (!res.ok) {
      const errText = await res.text();
      console.error(`[Transcription] Groq Whisper API error (HTTP ${res.status}):`, errText);
      return null;
    }

    const data = (await res.json()) as { text?: string };
    const transcription = data.text?.trim() || null;
    if (transcription) {
      console.log(`[Transcription] Heard voicenote: "${transcription}"`);
    }
    return transcription;
  } catch (err: any) {
    console.error('[Transcription] Failed to transcribe audio:', err.message);
    return null;
  }
}
