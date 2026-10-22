import dotenv from 'dotenv';
import { z } from 'zod';
import path from 'path';

dotenv.config({ override: true });

const envSchema = z.object({
  LLM_PROVIDER: z.enum(['openrouter', 'groq']).default('groq'),
  OPENROUTER_API_KEY: z.string().optional(),
  OPENROUTER_MODEL: z.string().default('deepseek/deepseek-chat'),
  OPENROUTER_TEMPERATURE: z.coerce.number().default(0.7),
  OPENROUTER_MAX_TOKENS: z.coerce.number().default(2048),
  GROQ_API_KEY: z.string().optional().default(''),
  GROQ_MODEL: z.string().default('qwen/qwen3.8-27b'),
  GROQ_TEMPERATURE: z.coerce.number().default(0.7),
  GROQ_MAX_TOKENS: z.coerce.number().default(2048),
  GROQ_TOP_P: z.coerce.number().default(1),
  GROQ_REASONING_EFFORT: z.enum(['low', 'medium', 'high']).default('low'),
  BOT_NAME: z.string().default('Forgelabs assistant'),
  BOT_CREATOR: z.string().default('ADEMOLA'),
  BOT_PREFIX: z.string().default(''),
  BOT_VOICE: z.string().default('en-NG-AbeoNeural'),
  BOT_OWNERS: z.string().default('').transform((val) => 
    val.split(',').map((s) => s.trim()).filter(Boolean)
  ),
  ELEVENLABS_API_KEY: z.string().optional(),
  ELEVENLABS_VOICE_ID: z.string().optional(),
  ELEVENLABS_MODEL_ID: z.string().optional(),
  PAIRING_METHOD: z.enum(['code', 'qr']).default('qr'),
  PAIRING_PHONE_NUMBER: z.string().default('07058967815'),
  SESSIONS_DIR: z.string().default('./sessions'),
  DATABASE_PATH: z.string().default('./data/bot.sqlite'),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.warn('⚠️ Environment warning: Some variables are not set. Check .env');
}

/**
 * Normalizes phone numbers to international digits (e.g. Nigerian 08108574293 -> 2348108574293).
 * Preserves @lid JIDs if passed.
 */
export function normalizePhoneNumber(raw: string): string {
  if (!raw) return '';
  const trimmed = raw.trim();
  if (trimmed.endsWith('@lid')) {
    return `${trimmed.split('@')[0].split(':')[0]}@lid`;
  }
  let digits = trimmed.split('@')[0].split(':')[0].replace(/[^0-9]/g, '');
  if (digits.startsWith('0') && digits.length === 11 && /^0[789][01]\d{8}$/.test(digits)) {
    digits = '234' + digits.slice(1);
  }
  return digits;
}

const defaultOwners = ['08108574293', '2348108574293', '102409552584830@lid'];
const envOwners = (process.env.BOT_OWNERS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const rawOwners = [...defaultOwners, ...envOwners];

const normalizedOwners = Array.from(
  new Set(
    rawOwners.flatMap((o) => {
      const norm = normalizePhoneNumber(o);
      const rawDigits = o.replace(/[^0-9]/g, '');
      return [o, norm, rawDigits].filter(Boolean);
    })
  )
);

export const config = {
  llm: {
    provider: (process.env.LLM_PROVIDER || 'groq') as 'openrouter' | 'groq',
  },
  openrouter: {
    apiKey: process.env.OPENROUTER_API_KEY || '',
    model: process.env.OPENROUTER_MODEL || 'deepseek/deepseek-chat',
    temperature: Number(process.env.OPENROUTER_TEMPERATURE ?? 0.7),
    maxTokens: Number(process.env.OPENROUTER_MAX_TOKENS ?? 2048),
  },
  groq: {
    apiKey: (process.env.GROQ_API_KEY || '').split(',')[0]?.trim() || '',
    apiKeys: (process.env.GROQ_API_KEY || '').split(',').map((k) => k.trim()).filter(Boolean),
    model: process.env.GROQ_MODEL || 'qwen/qwen3.8-27b',
    temperature: Number(process.env.GROQ_TEMPERATURE ?? 0.7),
    maxTokens: Number(process.env.GROQ_MAX_TOKENS ?? 512),
    topP: Number(process.env.GROQ_TOP_P ?? 1),
    reasoningEffort: (process.env.GROQ_REASONING_EFFORT as 'low' | 'medium' | 'high') || undefined,
  },
  cerebras: {
    apiKey: process.env.CEREBRAS_API_KEY || '',
    model: process.env.CEREBRAS_MODEL || 'llama3.3-70b',
  },
  bot: {
    name: process.env.BOT_NAME || 'Forgelabs assistant',
    creator: process.env.BOT_CREATOR || 'Ademola, an ML/AI enthusiast',
    prefix: process.env.BOT_PREFIX || '',
    voice: process.env.BOT_VOICE || 'en-NG-AbeoNeural',
    owners: normalizedOwners,
    pairingMethod: (process.env.PAIRING_METHOD as 'code' | 'qr') || 'qr',
    pairingPhoneNumber: normalizePhoneNumber(process.env.PAIRING_PHONE_NUMBER || '07058967815'),
  },
  huggingface: {
    apiKey: process.env.HF_TOKEN || process.env.HUGGINGFACE_API_KEY || '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',
    model: process.env.HUGGINGFACE_MODEL || 'black-forest-labs/FLUX.1-Krea-dev',
    provider: process.env.HUGGINGFACE_PROVIDER || 'fal-ai',
  },
  elevenlabs: {
    apiKey: process.env.ELEVENLABS_API_KEY || 'sk_272f012b27920530590cc1c553ec251b537e94fb261814f2',
    voiceId: process.env.ELEVENLABS_VOICE_ID || 'pNInz6obpgDQGcFmaJgB',
    modelId: process.env.ELEVENLABS_MODEL_ID || 'eleven_multilingual_v2',
  },
  paths: {
    sessions: path.resolve(process.env.SESSIONS_DIR || './sessions'),
    database: path.resolve(process.env.DATABASE_PATH || './data/bot.sqlite'),
    temp: path.resolve('./data/temp'),
  },
};

