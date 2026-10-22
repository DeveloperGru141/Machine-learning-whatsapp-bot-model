import OpenAI from 'openai';
import Groq from 'groq-sdk';
import { config } from '../config/env.js';

export const geminiClient = new OpenAI({
  apiKey: config.gemini.apiKey || 'dummy_key',
  baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/',
  maxRetries: 0,
  timeout: 5_000,
});

export const openRouterClient = new OpenAI({
  apiKey: config.openrouter.apiKey || 'dummy_key',
  baseURL: 'https://openrouter.ai/api/v1',
  defaultHeaders: {
    'HTTP-Referer': 'https://forgelabs.ai',
    'X-Title': 'Forgelabs Assistant',
  },
  maxRetries: 1,
  timeout: 25_000,
});

export const groqClients: Groq[] = (
  config.groq.apiKeys.length > 0 ? config.groq.apiKeys : [config.groq.apiKey || 'dummy_key']
).map((key) => new Groq({ apiKey: key, maxRetries: 0, timeout: 15_000 }));

export const groqClient = groqClients[0];
export const groq = groqClient;

export const cerebrasClient = new OpenAI({
  apiKey: config.cerebras.apiKey || 'dummy_key',
  baseURL: 'https://api.cerebras.ai/v1',
  maxRetries: 0,
  timeout: 10_000,
});

export interface LLMChatParams {
  messages: any[];
  tools?: any[];
  tool_choice?: any;
  temperature?: number;
  max_tokens?: number;
  model?: string;
  reasoning_effort?: 'low' | 'medium' | 'high';
}

export interface LLMChatResponse {
  choices: Array<{
    message: {
      role: string;
      content: string | null;
      tool_calls?: Array<{
        id: string;
        type: 'function';
        function: {
          name: string;
          arguments: string;
        };
      }>;
    };
    finish_reason: string;
  }>;
  usage?: any;
}

export class LLMClient {
  private geminiQuotaExhaustedUntil: number = 0;
  private qwenQuotaExhaustedUntil: number = 0;
  private groqClientIndex: number = 0;

  public getProvider(): 'gemini' | 'groq' | 'openrouter' {
    if (config.llm.provider === 'groq' && config.groq.apiKey) {
      return 'groq';
    }
    if (config.llm.provider === 'openrouter' && config.openrouter.apiKey) {
      return 'openrouter';
    }
    if (config.gemini.apiKey) {
      if (Date.now() < this.geminiQuotaExhaustedUntil && config.groq.apiKey) {
        return 'groq';
      }
      return 'gemini';
    }
    return 'groq';
  }

  public getModel(): string {
    const provider = this.getProvider();
    if (provider === 'gemini') {
      const model = config.gemini.model;
      if (!model || model.includes('3.5') || model.includes('3.1') || model.includes('2.5-flash-lite')) {
        return 'gemini-flash-latest';
      }
      return model;
    }
    if (provider === 'openrouter') {
      return config.openrouter.model;
    }
    const groqModel = config.groq.model;
    if (groqModel.includes('llama-3.3') || groqModel.includes('llama-3.1')) {
      return 'qwen/qwen3.8-27b';
    }
    return groqModel;
  }

  public async callGeminiInternal(params: LLMChatParams): Promise<LLMChatResponse> {
    if (Date.now() < this.geminiQuotaExhaustedUntil) {
      // Zero sleep: immediately hand off to Groq/Cerebras so DM replies stay snappy
      throw new Error(`Gemini rate limit cooldown active until ${new Date(this.geminiQuotaExhaustedUntil).toLocaleTimeString()}`);
    }

    const candidateGeminiModels = [
      params.model || this.getModel(),
      'gemini-flash-latest',
      'gemini-3.8-flash',
      'gemini-flash-lite-latest',
    ].filter((m, idx, arr) => m && arr.indexOf(m) === idx && !m.includes('3.5') && !m.includes('3.1') && !m.includes('2.5-flash-lite'));

    for (const model of candidateGeminiModels) {
      const payload: any = {
        model,
        messages: params.messages,
        temperature: params.temperature ?? 0.7,
        max_tokens: Math.max(128, Math.min(800, params.max_tokens ?? 600)),
      };

      if (params.tools && params.tools.length > 0) {
        payload.tools = params.tools;
        payload.tool_choice = params.tool_choice || 'auto';
      }

      try {
        const res = await geminiClient.chat.completions.create(payload);
        const choice = res.choices?.[0];
        if (choice && choice.message) {
          if (
            !choice.message.content &&
            (!choice.message.tool_calls || choice.message.tool_calls.length === 0) &&
            (choice.message as any).reasoning
          ) {
            choice.message.content = (choice.message as any).reasoning;
          }
        }
        return res as unknown as LLMChatResponse;
      } catch (err: any) {
        const isQuota =
          err?.status === 429 ||
          String(err?.message || err).includes('429') ||
          String(err?.message || err).includes('quota') ||
          String(err?.message || err).includes('RESOURCE_EXHAUSTED');

        if (isQuota) {
          // Instant failover: mark cooldown for 6 hours so Groq takes over immediately with 0 latency penalty
          this.geminiQuotaExhaustedUntil = Date.now() + 6 * 60 * 60 * 1000;
          console.warn(`[LLMClient] ⚠️ Gemini model ${model} rate-limited (429). Instantly failing over to Groq...`);
          throw new Error('Gemini rate-limited (429)');
        } else {
          console.warn(`[LLMClient] ⚠️ Gemini model ${model} encountered ${err?.status || err?.message || err}. Trying next candidate...`);
        }
      }
    }

    throw new Error('All Gemini candidate models failed to respond.');
  }

  public async callCerebrasInternal(params: LLMChatParams): Promise<LLMChatResponse> {
    const payload: any = {
      model: config.cerebras.model,
      messages: params.messages,
      temperature: params.temperature ?? 0.7,
      max_tokens: Math.max(64, params.max_tokens ?? 512),
    };

    if (params.tools && params.tools.length > 0) {
      payload.tools = params.tools;
      payload.tool_choice = params.tool_choice || 'auto';
    }

    const res = await cerebrasClient.chat.completions.create(payload);
    return res as unknown as LLMChatResponse;
  }

  public async chatCompletion(params: LLMChatParams): Promise<LLMChatResponse> {
    const provider = this.getProvider();
    const primaryModel = params.model || this.getModel();

    if (provider === 'gemini') {
      try {
        return await this.callGeminiInternal({ ...params, model: primaryModel });
      } catch (err: any) {
        if (config.groq.apiKey) {
          console.log(`[LLMClient] 🔄 Instant failover to Groq model: qwen/qwen3.8-27b`);
          return await this.callGroqInternal({ ...params, model: 'qwen/qwen3.8-27b' });
        }
        throw err;
      }
    } else if (provider === 'openrouter') {
      try {
        const payload: any = {
          model: primaryModel,
          messages: params.messages,
          temperature: params.temperature ?? config.openrouter.temperature,
          max_tokens: params.max_tokens ?? config.openrouter.maxTokens,
        };

        if (params.tools && params.tools.length > 0) {
          payload.tools = params.tools;
          payload.tool_choice = params.tool_choice || 'auto';
        }

        const res = await openRouterClient.chat.completions.create(payload);
        return res as unknown as LLMChatResponse;
      } catch (err: any) {
        console.warn(
          `[LLMClient] ⚠️ OpenRouter model ${primaryModel} failed: ${err.message || err}. Falling back to Groq...`
        );
        if (config.groq.apiKey) {
          return this.callGroqInternal({ ...params, model: this.getModel() });
        }
        if (config.gemini.apiKey && Date.now() >= this.geminiQuotaExhaustedUntil) {
          return this.callGeminiInternal({ ...params, model: config.gemini.model });
        }
        throw err;
      }
    } else {
      return this.callGroqInternal(params);
    }
  }

  public async callGroqInternal(params: LLMChatParams): Promise<LLMChatResponse> {
    const configuredModel = params.model || this.getModel();
    const hasTools = Boolean(params.tools && params.tools.length > 0);
    const candidateModels = [
      configuredModel,
      'qwen/qwen3.8-27b',
      'openai/gpt-oss-120b',
      'openai/gpt-oss-20b',
      ...(hasTools ? [] : ['allam-2-7b']),
    ].filter((m, idx, arr) => m && arr.indexOf(m) === idx && !m.includes('llama-3.3') && !m.includes('llama-3.1'));

    const buildPayload = (modelName: string) => {
      const isOss = modelName.includes('oss');
      const payload: any = {
        model: modelName,
        messages: params.messages,
        temperature: params.temperature ?? config.groq.temperature,
        max_completion_tokens: isOss ? 600 : Math.max(64, params.max_tokens ?? config.groq.maxTokens),
        top_p: config.groq.topP,
      };

      if (params.tools && params.tools.length > 0 && !modelName.includes('allam')) {
        payload.tools = params.tools;
        payload.tool_choice = params.tool_choice || 'auto';
      }

      if (config.groq.reasoningEffort && !isOss) {
        payload.reasoning_effort = config.groq.reasoningEffort;
      }

      return payload;
    };

    // 1. Try Groq clients pool across all candidate models with round-robin load distribution
    const totalClients = groqClients.length;
    const startIndex = totalClients > 0 ? this.groqClientIndex % totalClients : 0;
    this.groqClientIndex = totalClients > 0 ? (this.groqClientIndex + 1) % totalClients : 0;
    const orderedClients = totalClients > 1
      ? [...groqClients.slice(startIndex), ...groqClients.slice(0, startIndex)]
      : groqClients;

    for (const client of orderedClients) {
      for (const modelName of candidateModels) {
        if (modelName === 'qwen/qwen3.8-27b' && Date.now() < this.qwenQuotaExhaustedUntil) {
          console.log(`[LLMClient] ⏳ Qwen in brief cooldown (${Math.ceil((this.qwenQuotaExhaustedUntil - Date.now()) / 1000)}s remaining), trying fallback models...`);
          continue;
        }

        try {
          const res = await client.chat.completions.create(buildPayload(modelName));
          const choice = res.choices[0];
          if (choice?.message) {
            if (
              !choice.message.content &&
              (!choice.message.tool_calls || choice.message.tool_calls.length === 0) &&
              (choice.message as any).reasoning
            ) {
              choice.message.content = (choice.message as any).reasoning;
            }
          }

          if (
            choice?.message &&
            !choice.message.content &&
            (!choice.message.tool_calls || choice.message.tool_calls.length === 0)
          ) {
            console.warn(`[LLMClient] ⚠️ Groq model ${modelName} returned empty content with finish_reason: ${choice.finish_reason}. Trying next candidate...`);
            continue;
          }

          return res as unknown as LLMChatResponse;
        } catch (err: any) {
          const failedGen =
            err?.error?.failed_generation ||
            err?.error?.error?.failed_generation ||
            (typeof err?.message === 'string' && err.message.includes('failed_generation')
              ? (() => {
                  try {
                    const jsonStart = err.message.indexOf('{');
                    if (jsonStart >= 0) {
                      const parsed = JSON.parse(err.message.slice(jsonStart));
                      return parsed?.error?.failed_generation || parsed?.failed_generation;
                    }
                  } catch {}
                  return null;
                })()
              : null);

          if (failedGen && typeof failedGen === 'string') {
            console.log(
              `[LLMClient] 🛠️ Recovered inline tool generation from ${modelName}: ${failedGen.slice(0, 120)}`
            );
            return {
              choices: [
                {
                  message: {
                    role: 'assistant',
                    content: failedGen,
                  },
                  finish_reason: 'stop',
                },
              ],
            };
          }

          const isRateLimit =
            err?.status === 429 ||
            String(err?.message || err).includes('429') ||
            String(err?.message || err).includes('Rate limit') ||
            String(err?.message || err).includes('TPD');

          if (modelName.startsWith('qwen/') && isRateLimit) {
            const isDailyLimit =
              String(err?.message || err).includes('TPD') ||
              String(err?.message || err).includes('tokens per day');
            // Brief cooldown: 45 seconds for daily token limit retry, 15 seconds for transient TPM spike
            this.qwenQuotaExhaustedUntil = Date.now() + (isDailyLimit ? 45 * 1000 : 15 * 1000);
          }

          console.warn(
            `[LLMClient] ⚠️ Groq model ${modelName} unavailable (${err?.status || err?.message || err}). Trying next candidate...`
          );
        }
      }
    }

    // 2. Try Cerebras if configured (1,000,000 free tokens/day!)
    if (config.cerebras.apiKey) {
      console.warn(`[LLMClient] 🔄 Falling back to Cerebras model: ${config.cerebras.model}...`);
      try {
        return await this.callCerebrasInternal(params);
      } catch (cerErr: any) {
        console.warn(`[LLMClient] ⚠️ Cerebras fallback failed: ${cerErr.message || cerErr}`);
      }
    }

    // 3. Fallback to Gemini if configured
    if (config.gemini.apiKey && Date.now() >= this.geminiQuotaExhaustedUntil) {
      console.warn(`[LLMClient] 🔄 Falling back to Gemini model: ${config.gemini.model}...`);
      try {
        return await this.callGeminiInternal({ ...params, model: config.gemini.model });
      } catch (gemErr: any) {
        console.warn(`[LLMClient] ⚠️ Gemini fallback also failed: ${gemErr.message || gemErr}`);
      }
    }

    throw new Error('All LLM providers (Groq primary, Groq backup, Gemini) failed to generate response.');
  }
}

export const llmClient = new LLMClient();
