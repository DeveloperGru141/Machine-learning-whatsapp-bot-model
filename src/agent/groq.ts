import Groq from 'groq-sdk';
import { config } from '../config/env.js';

export const groq = new Groq({
  apiKey: config.groq.apiKey || 'dummy_key',
});
