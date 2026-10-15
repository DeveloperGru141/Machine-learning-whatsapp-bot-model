import dotenv from 'dotenv';
import { z } from 'zod';
import path from 'path';

dotenv.config({ override: true });

const envSchema = z.object({
  GROQ_API_KEY: z.string().min(1, 'GROQ_API_KEY is required for the agentic harness'),
  GROQ_MODEL: z.string().default('openai/gpt-oss-120b'),
  GROQ_TEMPERATURE: z.coerce.number().default(1),
  GROQ_MAX_TOKENS: z.coerce.number().default(2048),
  GROQ_TOP_P: z.coerce.number().default(1),
  GROQ_REASONING_EFFORT: z.enum(['low', 'medium', 'high']).default('medium'),
  BOT_NAME: z.string().default('Nova'),
  BOT_CREATOR: z.string().default('ADEMOLA'),
  BOT_PREFIX: z.string().default(''),
  BOT_OWNERS: z.string().default('').transform((val) => 
    val.split(',').map((s) => s.trim()).filter(Boolean)
  ),
  PAIRING_METHOD: z.enum(['code', 'qr']).default('code'),
  PAIRING_PHONE_NUMBER: z.string().default(''),
  SESSIONS_DIR: z.string().default('./sessions'),
  DATABASE_PATH: z.string().default('./data/bot.sqlite'),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.warn('⚠️ Environment warning: Some variables are not set. Check .env');
}

export const config = {
  groq: {
    apiKey: process.env.GROQ_API_KEY || '',
    model: process.env.GROQ_MODEL || 'openai/gpt-oss-120b',
    temperature: Number(process.env.GROQ_TEMPERATURE ?? 0.7),
    maxTokens: Number(process.env.GROQ_MAX_TOKENS ?? 2048),
    topP: Number(process.env.GROQ_TOP_P ?? 1),
    reasoningEffort: process.env.GROQ_REASONING_EFFORT || 'low',
  },
  bot: {
    name: process.env.BOT_NAME || 'Nova',
    creator: process.env.BOT_CREATOR || 'ADEMOLA',
    prefix: process.env.BOT_PREFIX || '',
    owners: (process.env.BOT_OWNERS || '').split(',').map((s) => s.trim()).filter(Boolean),
    pairingMethod: (process.env.PAIRING_METHOD as 'code' | 'qr') || 'code',
    pairingPhoneNumber: process.env.PAIRING_PHONE_NUMBER || '',
  },
  paths: {
    sessions: path.resolve(process.env.SESSIONS_DIR || './sessions'),
    database: path.resolve(process.env.DATABASE_PATH || './data/bot.sqlite'),
    temp: path.resolve('./data/temp'),
  },
};
