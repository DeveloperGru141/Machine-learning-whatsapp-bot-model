import { groq } from './groq.js';
import { config } from '../config/env.js';
import { pluginRegistry } from '../plugins/registry.js';
import { ExecutionContext } from '../plugins/types.js';
import { db } from '../memory/db.js';
import { contextManager } from '../core/context-manager.js';
import { analyticsEngine } from '../core/analytics.js';
import { chatLogger } from '../memory/chat-logger.js';

const EMOJI_SEQUENCE_REGEX =
  /(?:\p{Extended_Pictographic}|\p{Emoji_Presentation})(?:\uFE0F|\p{Emoji_Modifier})?(?:\u200D(?:\p{Extended_Pictographic}|\p{Emoji_Presentation})(?:\uFE0F|\p{Emoji_Modifier})?)*/gu;

export class AgentHarness {
  private modelCooldowns: Map<string, number> = new Map();

  private async callGroq(params: any): Promise<any> {
    const candidateModels = [
      params.model || config.groq.model,
      'openai/gpt-oss-20b',
      'qwen/qwen3.8-27b',
      'openai/gpt-oss-120b',
    ].filter((m, i, arr) => arr.indexOf(m) === i);

    // Prioritize models not currently in cooldown due to 429
    const now = Date.now();
    const sortedCandidates = [...candidateModels].sort((a, b) => {
      const aCd = this.modelCooldowns.get(a) || 0;
      const bCd = this.modelCooldowns.get(b) || 0;
      if (aCd > now && bCd <= now) return 1;
      if (bCd > now && aCd <= now) return -1;
      return 0;
    });

    let lastError: any = null;
    for (const model of sortedCandidates) {
      try {
        return await groq.chat.completions.create({
          ...params,
          model,
        });
      } catch (err: any) {
        lastError = err;
        if (
          err?.status === 429 ||
          err?.message?.includes('Rate limit') ||
          err?.message?.includes('rate_limit_exceeded') ||
          err?.message?.includes('TPD')
        ) {
          this.modelCooldowns.set(model, Date.now() + 60_000);
          console.warn(`[AgentHarness] ⚠️ Model ${model} returned 429 rate limit (cooling down for 60s), switching to next model...`);
          continue;
        }
        if (
          err?.status === 400 ||
          err?.status === 404 ||
          (typeof err?.status === 'number' && err.status >= 500) ||
          err?.message?.includes('tool_use_failed') ||
          err?.message?.includes('model_not_found')
        ) {
          console.warn(`[AgentHarness] ⚠️ Model ${model} returned ${err?.status || 'error'}, switching to next fallback model...`);
          continue;
        }
        throw err;
      }
    }
    throw lastError;
  }

  public async handleMessage(
    userMessage: string,
    context: ExecutionContext
  ): Promise<void> {
    if (!config.groq.apiKey) {
      await context.replyText(
        '⚠️ Groq API key is not configured. Please set GROQ_API_KEY in your .env file.'
      );
      return;
    }

    // Token-budgeted context assembly (system prompt, user profiles, older summaries, recent history)
    const { messages, tokenBudgetUsed } = contextManager.buildManagedContext(
      context.chatJid,
      context.senderJid,
      context.isGroup,
      `${context.senderName}: ${userMessage}`
    );

    console.log(`[AgentHarness] Managed context built with ~${tokenBudgetUsed} estimated tokens.`);

    const tools = pluginRegistry.getGroqToolDefinitions();
    const executedTools = new Set<string>();
    const toolOutputs: string[] = [];
    let voiceNoteSentSuccessfully = false;

    try {
      const activeTools = tools.length > 0 ? (tools as any) : undefined;

      const response = await this.callGroq({
        model: config.groq.model,
        messages: messages,
        tools: activeTools,
        tool_choice: activeTools ? 'auto' : undefined,
        temperature: config.groq.temperature,
        max_completion_tokens: config.groq.maxTokens,
        top_p: config.groq.topP,
        reasoning_effort: config.groq.reasoningEffort as any,
      });

      const choice = response.choices[0];
      if (!choice) return;

      const message = choice.message;

      // Check if the model decided to call tools
      if (message.tool_calls && message.tool_calls.length > 0) {
        for (const toolCall of message.tool_calls) {
          const toolName = toolCall.function.name;
          if (executedTools.has(toolName)) {
            continue;
          }
          executedTools.add(toolName);

          let toolArgs: any = {};
          try {
            toolArgs = JSON.parse(toolCall.function.arguments || '{}');
          } catch {
            toolArgs = {};
          }

          console.log(`[Agent] Calling tool: ${toolName}`, toolArgs);
          analyticsEngine.trackEvent('tool_call', toolName, context.chatJid, context.senderJid);
          const toolResult = await pluginRegistry.executeTool(
            toolName,
            toolArgs,
            context
          );

          if (toolName === 'send_voice_note' && toolResult.success) {
            voiceNoteSentSuccessfully = true;
          }

          let outputEntry = `[${toolName} result]: ${toolResult.message || JSON.stringify(toolResult)}`;
          if (
            typeof toolResult.data === 'string' &&
            toolResult.data.trim().length > 0 &&
            !(toolResult.message || '').includes(toolResult.data.slice(0, 60))
          ) {
            outputEntry += `\nExtracted Content:\n${toolResult.data}`;
          }
          toolOutputs.push(outputEntry);
        }

        // When send_voice_note succeeded, the OGG Opus voice note is ALREADY sent and logged!
        if (voiceNoteSentSuccessfully) {
          console.log(`[AgentHarness] ✅ Voice note dispatched via send_voice_note; complete.`);
          analyticsEngine.trackEvent('message_sent', { type: 'voice_note' }, context.chatJid, context.senderJid);
          try {
            await context.sock.sendPresenceUpdate('paused', context.chatJid);
          } catch {}
          return;
        }

        // Synthesize final natural WhatsApp response from the gathered tool results without re-triggering tool calls
        const nowStr = new Date().toUTCString();
        const synthesisSystem = `You are ${config.bot.name}, created by Ademola (${config.bot.creator}), an aspiring ML/AI Engineer. Current Date: ${nowStr}. Reply naturally like a real WhatsApp user chatting with a friend. Strictly max 0-1 emoji, zero robotic AI cliches. If asked about your creator, always mention Ademola is an aspiring ML/AI Engineer. Combine the live tool data below with your own knowledge to answer the user's question directly and confidently in 1-3 sentences. NEVER say "in the search results", "based on the search", or claim you cannot see something in the results—just answer directly like a knowledgeable friend.`;
        const historyContext = messages.slice(1, -1);
        const synthesisRes = await this.callGroq({
          model: config.groq.model,
          messages: [
            { role: 'system', content: synthesisSystem },
            ...historyContext,
            {
              role: 'user',
              content: `${context.senderName}: ${userMessage}\n\n[Live Tool Data]:\n${toolOutputs.join('\n\n')}`,
            },
          ],
          temperature: config.groq.temperature,
          max_completion_tokens: config.groq.maxTokens,
          reasoning_effort: config.groq.reasoningEffort as any,
        });

        const synthMsg = synthesisRes.choices[0]?.message;
        const rawSynth = synthMsg?.content || '';
        if (rawSynth && rawSynth.trim()) {
          const replyText = sanitizeAssistantResponse(rawSynth);
          console.log(`[AgentHarness] 💬 Bot replied (post-tool) to ${context.senderName}: "${replyText.slice(0, 100)}..."`);
          await context.replyText(replyText);
          chatLogger.logOutboundMessage(context.chatJid, replyText);
          analyticsEngine.trackEvent('message_sent', { length: replyText.length }, context.chatJid, context.senderJid);
          this.recordFineTuningPair(
            messages[0]?.content || '',
            userMessage,
            replyText,
            Array.from(executedTools)
          );
        }
      } else {
        // Direct text reply from the LLM
        const rawContent = message.content || '';

        if (rawContent && rawContent.trim()) {
          const replyText = sanitizeAssistantResponse(rawContent);
          console.log(`[AgentHarness] 💬 Bot replied to ${context.senderName}: "${replyText.slice(0, 100)}..."`);
          await context.replyText(replyText);
          chatLogger.logOutboundMessage(context.chatJid, replyText);
          analyticsEngine.trackEvent('message_sent', { length: replyText.length }, context.chatJid, context.senderJid);
          this.recordFineTuningPair(
            messages[0]?.content || '',
            userMessage,
            replyText,
            []
          );
        }
      }
    } catch (err: any) {
      console.error('[AgentHarness] Error in reasoning loop:', err.message || err);

      // Fail-safe fallback: Answer directly from pre-trained knowledge without tools
      try {
        console.log('[AgentHarness] Attempting fail-safe direct knowledge answer...');
        const fallbackSystem = `You are ${config.bot.name}, created by Ademola (${config.bot.creator}), an aspiring ML/AI Engineer. Current Date: ${new Date().toUTCString()}. Reply naturally like a real WhatsApp user chatting with a friend. Max 0-1 emoji, zero robotic AI cliches. If asked about your creator, always mention Ademola is an aspiring ML/AI Engineer. Deliver a direct, crisp reply based on your knowledge.`;
        const fallbackRes = await this.callGroq({
          model: config.groq.model,
          messages: [
            { role: 'system', content: fallbackSystem },
            { role: 'user', content: `${context.senderName}: ${userMessage}` },
          ],
          temperature: config.groq.temperature,
          max_completion_tokens: config.groq.maxTokens,
          reasoning_effort: config.groq.reasoningEffort as any,
        });

        const rawFallbackText = fallbackRes.choices[0]?.message?.content;
        if (rawFallbackText) {
          const fallbackText = sanitizeAssistantResponse(rawFallbackText);
          console.log(`[AgentHarness] 💬 Bot replied via direct fallback to ${context.senderName}: "${fallbackText.slice(0, 100)}..."`);
          await context.replyText(fallbackText);
          chatLogger.logOutboundMessage(context.chatJid, fallbackText);
          this.recordFineTuningPair(
            messages[0]?.content || '',
            userMessage,
            fallbackText,
            []
          );
          return;
        }
      } catch (fbErr: any) {
        console.error('[AgentHarness] Fallback also failed:', fbErr.message);
      }

      await context.replyText('network slow small, abeg try again in a sec');
    } finally {
      try {
        await context.sock.sendPresenceUpdate('paused', context.chatJid);
      } catch {}
    }
  }

  /**
   * Continuous learning guardrail:
   * Only persists high-quality, authentic interactions into the fine-tuning database.
   * Discards error messages, robotic clichés, and emoji spam.
   */
  private recordFineTuningPair(
    systemPrompt: string,
    userMessage: string,
    assistantResponse: string,
    tools: string[]
  ): void {
    try {
      const trimmed = assistantResponse.trim();
      // Guardrail 1: Minimum length requirement
      if (trimmed.length < 5) return;

      // Guardrail 2: Block error strings, robotic clichés, generic fallbacks, or outdated names
      const lower = trimmed.toLowerCase();
      if (
        lower.includes('network slow') ||
        lower.includes('abeg try again') ||
        lower.includes('as an ai') ||
        lower.includes('i am an ai') ||
        lower.includes('i am a language model') ||
        lower.includes('i apologize') ||
        lower.includes('rate limit') ||
        lower.includes('an error occurred') ||
        lower.includes('how can i help') ||
        lower.includes('what can i help') ||
        lower.includes('can i help you') ||
        lower.includes("i'm here to help") ||
        lower.includes("i'm here to assist") ||
        lower.includes('i am here to assist') ||
        lower.includes('feel free') ||
        lower.includes('certainly!') ||
        lower.includes('certainly,') ||
        lower.includes('sure thing!') ||
        lower.includes('i hope this helps') ||
        lower.includes('let me know if you need') ||
        lower.includes('let me know if you want') ||
        lower.includes('is there anything else i can assist') ||
        lower.includes('nova')
      ) {
        return;
      }

      // Guardrail 3: Block emoji spam (strictly max 0-1 emoji)
      const emojiCount = (trimmed.match(EMOJI_SEQUENCE_REGEX) || []).length;
      if (emojiCount > 1) return;

      // Guardrail 4: Valid user message
      if (!userMessage || userMessage.trim().length < 2) return;

      db.prepare(`
        INSERT INTO fine_tuning_pairs (system_prompt, user_message, assistant_response, tools_invoked, created_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(
        systemPrompt || '',
        userMessage.trim(),
        trimmed,
        JSON.stringify(tools),
        Date.now()
      );
    } catch (err: any) {
      // Non-critical logging
    }
  }
}

/**
 * Normalizes outbound assistant replies to enforce:
 * 1. Strict max 0-1 emoji policy (strips subsequent emojis including ZWJ/modifiers)
 * 2. Ban robotic AI clichés at beginning/end of messages
 */
export function sanitizeAssistantResponse(text: string): string {
  if (!text) return text;
  let cleaned = text.trim();

  // Strip robotic preamble clichés (peel chained preambles like "Sure thing! As an AI, ...")
  const preambleRegex = /^(?:as an ai(?:\s+language\s+model)?|as a language model|certainly|sure thing|i'm here to assist(?:\s+you)?|i am here to assist(?:\s+you)?|i'm here to help|i am here to help|happy to help|glad to help|i am happy to help|i'm happy to help)[\s,.:;!-]+/i;
  while (preambleRegex.test(cleaned)) {
    cleaned = cleaned.replace(preambleRegex, '').trim();
  }

  // Strip trailing robotic closing clichés & assistant offers (preserving previous sentence punctuation)
  cleaned = cleaned
    .replace(/(?:\s+)(?:(?:how|what)\s+can\s+i\s+(?:help|assist)\s+(?:you\s+)?(?:with|today)?\??|is there anything else i can assist (?:you with\??|with\??)|let me know if you (?:need|want) (?:anything|more|any)[^.!?]*[.!?]?|feel free to (?:ask|reach out)[^.!?]*[.!?]?|i hope this helps\.?)$/i, '')
    .replace(/(?:\s+)(?:if you (?:ever )?hit a snag[^.!?]*[.!?]?|if you need a quick tool run[^.!?]*[.!?]?|anything specific you wanna dive into[^.!?]*\??|just let me know if you need anything[^.!?]*[.!?]?)$/i, '')
    .replace(/^(?:how can i help you today\??|what can i help you with\??|how can i assist you\??)$/i, '')
    .trim();

  // Enforce max 0-1 emoji policy (grapheme-aware so ZWJ & skin-tone modifiers aren't orphaned)
  let emojiFound = 0;
  cleaned = cleaned.replace(EMOJI_SEQUENCE_REGEX, (match) => {
    emojiFound++;
    return emojiFound <= 1 ? match : '';
  });

  // Clean double spaces left after removing emojis/clichés
  cleaned = cleaned.replace(/[ \t]+/g, ' ').replace(/\s+([.,!?:;])/g, '$1').trim();

  return cleaned || text.trim();
}

export const agentHarness = new AgentHarness();
