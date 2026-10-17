import { llmClient } from './llm-client.js';
import { config } from '../config/env.js';
import { pluginRegistry } from '../plugins/registry.js';
import { ExecutionContext } from '../plugins/types.js';
import { db } from '../memory/db.js';
import { contextManager } from '../core/context-manager.js';
import { analyticsEngine } from '../core/analytics.js';
import { chatLogger } from '../memory/chat-logger.js';

const EMOJI_SEQUENCE_REGEX =
  /(?:\p{Extended_Pictographic}|\p{Emoji_Presentation})(?:\uFE0F|\p{Emoji_Modifier})?(?:\u200D(?:\p{Extended_Pictographic}|\p{Emoji_Presentation})(?:\uFE0F|\p{Emoji_Modifier})?)*/gu;

export interface ParsedToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

/**
 * Extracts inline <tool_call>...</tool_call>, <function=name>{...}</function>, or raw JSON tool calls
 * emitted in message.content by Qwen / DeepSeek / Llama models, converting them into standard tool_calls.
 */
export function extractInlineToolCalls(rawContent: string): {
  toolCalls: ParsedToolCall[];
  cleanedContent: string;
} {
  if (!rawContent || typeof rawContent !== 'string') {
    return { toolCalls: [], cleanedContent: '' };
  }

  const toolCalls: ParsedToolCall[] = [];
  let working = rawContent.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();

  const normalizeParsedJsonTool = (parsed: any): void => {
    if (!parsed || typeof parsed !== 'object') return;
    if (Array.isArray(parsed)) {
      for (const item of parsed) normalizeParsedJsonTool(item);
      return;
    }

    const fnName =
      typeof parsed.name === 'string'
        ? parsed.name
        : typeof parsed.function === 'string'
          ? parsed.function
          : typeof parsed.tool === 'string'
            ? parsed.tool
            : typeof parsed.function?.name === 'string'
              ? parsed.function.name
              : null;

    if (!fnName) return;

    let rawArgs =
      parsed.arguments ??
      parsed.args ??
      parsed.parameters ??
      parsed.params ??
      parsed.function?.arguments ??
      undefined;

    if (rawArgs === undefined) {
      const rest: Record<string, any> = { ...parsed };
      delete rest.name;
      delete rest.function;
      delete rest.tool;
      rawArgs = rest;
    }

    let argsString = '{}';
    if (typeof rawArgs === 'string') {
      argsString = rawArgs.trim() || '{}';
    } else {
      try {
        argsString = JSON.stringify(rawArgs || {});
      } catch {
        argsString = '{}';
      }
    }

    toolCalls.push({
      id: `inline_call_${Date.now()}_${toolCalls.length}`,
      type: 'function',
      function: {
        name: fnName.trim(),
        arguments: argsString,
      },
    });
  };

  // 1. Match <tool_call>...</tool_call> (and unclosed <tool_call>... at end of message)
  const toolCallTagRegex = /<tool_call>\s*([\s\S]*?)(?:<\/tool_call>|$)/gi;
  working = working.replace(toolCallTagRegex, (_fullMatch, inner: string) => {
    const trimmedInner = (inner || '').trim();
    if (!trimmedInner) return '';
    try {
      const parsed = JSON.parse(trimmedInner);
      normalizeParsedJsonTool(parsed);
    } catch {
      const firstBrace = trimmedInner.indexOf('{');
      const lastBrace = trimmedInner.lastIndexOf('}');
      if (firstBrace >= 0 && lastBrace > firstBrace) {
        try {
          const parsed = JSON.parse(trimmedInner.slice(firstBrace, lastBrace + 1));
          normalizeParsedJsonTool(parsed);
        } catch {}
      }
    }
    return '';
  });

  // 2. Match <function=tool_name>{...}</function> or <function=tool_name({...})></function>
  const fnTagRegex = /<function=([a-zA-Z0-9_]+)\s*>?\s*([\s\S]*?)(?:<\/function>|$)/gi;
  working = working.replace(fnTagRegex, (_fullMatch, fnName: string, inner: string) => {
    const cleanedInner = (inner || '').trim().replace(/^\(/, '').replace(/\)$/, '');
    let argsObj: any = {};
    if (cleanedInner) {
      try {
        argsObj = JSON.parse(cleanedInner);
      } catch {
        const firstBrace = cleanedInner.indexOf('{');
        const lastBrace = cleanedInner.lastIndexOf('}');
        if (firstBrace >= 0 && lastBrace > firstBrace) {
          try {
            argsObj = JSON.parse(cleanedInner.slice(firstBrace, lastBrace + 1));
          } catch {}
        }
      }
    }
    normalizeParsedJsonTool({ name: fnName, arguments: argsObj });
    return '';
  });

  // 3. Match standalone JSON object containing {"function": "...", "arguments": {...}} if no tags were used
  if (toolCalls.length === 0 && (working.includes('"function"') || working.includes('"tool_call"'))) {
    const standaloneJsonRegex = /\{\s*"(?:function|name)"\s*:\s*"([a-zA-Z0-9_]+)"\s*,\s*"(?:arguments|args|parameters)"\s*:\s*(\{[\s\S]*?\})\s*\}/g;
    working = working.replace(standaloneJsonRegex, (fullMatch) => {
      try {
        const parsed = JSON.parse(fullMatch);
        normalizeParsedJsonTool(parsed);
        return '';
      } catch {
        return fullMatch;
      }
    });
  }

  return {
    toolCalls,
    cleanedContent: working.trim(),
  };
}

export class AgentHarness {
  /**
   * Conversational turns run through the active pinned model (DeepSeek V3 on OpenRouter or Qwen 3.8 on Groq)
   * to ensure a single, consistent persona that strictly adheres to the learned exemplars and rules.
   */
  private async callLLM(params: any): Promise<any> {
    const model = llmClient.getModel();
    try {
      return await llmClient.chatCompletion({ ...params, model });
    } catch (err: any) {
      console.warn(
        `[AgentHarness] ⚠️ Model ${model} execution failed: ${String(err?.message || err).slice(0, 160)}`
      );
      throw err;
    }
  }

  public async handleMessage(
    userMessage: string,
    context: ExecutionContext
  ): Promise<void> {
    const hasKey = config.groq.apiKey || config.gemini.apiKey || config.openrouter.apiKey;
    if (!hasKey) {
      await context.replyText(
        '⚠️ No LLM API key (GROQ_API_KEY or GEMINI_API_KEY) is configured in your .env file.'
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

    const tools = pluginRegistry.getRelevantToolDefinitions(userMessage, context.isGroup);
    const executedToolKeys = new Set<string>();
    const executedToolNames = new Set<string>();
    const toolOutputs: string[] = [];
    let voiceNoteSentSuccessfully = false;

    try {
      const activeTools = tools.length > 0 ? (tools as any) : undefined;

      const response = await this.callLLM({
        messages: messages,
        tools: activeTools,
        tool_choice: activeTools ? 'auto' : undefined,
      });

      const choice = response.choices[0];
      if (!choice) return;

      const message = choice.message;

      // Parse inline <tool_call>...</tool_call> or <function=...> from message.content if the model emitted XML/JSON tags
      if ((!message.tool_calls || message.tool_calls.length === 0) && message.content) {
        const extracted = extractInlineToolCalls(message.content);
        if (extracted.toolCalls.length > 0) {
          console.log(
            `[AgentHarness] 🔧 Parsed ${extracted.toolCalls.length} inline <tool_call> block(s) from model response.`
          );
          message.tool_calls = extracted.toolCalls;
          message.content = extracted.cleanedContent;
        }
      }

      const runToolCallList = async (callsToRun: any[]) => {
        for (const toolCall of callsToRun) {
          const toolName = toolCall.function?.name;
          if (!toolName) continue;
          const rawArgStr = toolCall.function?.arguments || '{}';
          const dedupKey = `${toolName}:${rawArgStr}`;
          if (executedToolKeys.has(dedupKey)) {
            continue;
          }
          executedToolKeys.add(dedupKey);
          executedToolNames.add(toolName);

          let toolArgs: any = {};
          try {
            toolArgs = typeof rawArgStr === 'string' ? JSON.parse(rawArgStr) : rawArgStr;
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
      };

      // Check if the model decided to call tools
      if (message.tool_calls && message.tool_calls.length > 0) {
        await runToolCallList(message.tool_calls);

        // When send_voice_note succeeded, the OGG Opus voice note is ALREADY sent and logged!
        if (voiceNoteSentSuccessfully) {
          console.log(`[AgentHarness] ✅ Voice note dispatched via send_voice_note; complete.`);
          analyticsEngine.trackEvent('message_sent', { type: 'voice_note' }, context.chatJid, context.senderJid);
          try {
            await context.sock.sendPresenceUpdate('paused', context.chatJid);
          } catch {}
          return;
        }

        // Synthesize final natural WhatsApp response from the gathered tool results without re-triggering tool calls.
        const synthesisSystem = `${messages[0]?.content || ''}

# Answering With Live Tool Data:
Combine the live tool data in the user's last message with your own knowledge and answer directly and confidently in 1-3 sentences, in the same voice as the exemplars above. Do NOT output <tool_call> tags. If send_message_to_contact succeeded, explicitly confirm who you messaged and its WhatsApp delivery status (✓ / ✓✓).`;
        const historyContext = messages.slice(1, -1);
        const synthesisRes = await this.callLLM({
          messages: [
            { role: 'system', content: synthesisSystem },
            ...historyContext,
            {
              role: 'user',
              content: `${context.senderName}: ${userMessage}\n\n[Live Tool Data]:\n${toolOutputs.join('\n\n')}`,
            },
          ],
          tools: undefined,
          tool_choice: undefined,
        });

        const synthMsg = synthesisRes.choices[0]?.message;
        let rawSynth = synthMsg?.content || '';

        // If synthesis step emitted a follow-up inline tool call (e.g. save_contact followed by send_message_to_contact), execute it!
        const followUpInline = extractInlineToolCalls(rawSynth);
        if (followUpInline.toolCalls.length > 0) {
          await runToolCallList(followUpInline.toolCalls);
          rawSynth = followUpInline.cleanedContent;
        }

        const replyText = sanitizeAssistantResponse(rawSynth);
        if (replyText && replyText.trim()) {
          console.log(`[AgentHarness] 💬 Bot replied (post-tool) to ${context.senderName}: "${replyText.slice(0, 100)}..."`);
          await context.replyText(replyText);
          analyticsEngine.trackEvent('message_sent', { length: replyText.length }, context.chatJid, context.senderJid);
          this.recordFineTuningPair(
            messages[0]?.content || '',
            userMessage,
            replyText,
            Array.from(executedToolNames)
          );
        } else if (toolOutputs.length > 0) {
          const fallbackConfirm = sanitizeAssistantResponse(
            toolOutputs[toolOutputs.length - 1].replace(/^\[[^\]]+\]:\s*/, '')
          );
          if (fallbackConfirm) {
            await context.replyText(fallbackConfirm);
          }
        }
      } else {
        // Direct text reply from the LLM
        const rawContent = message.content || '';

        if (rawContent && rawContent.trim()) {
          const replyText = sanitizeAssistantResponse(rawContent);
          if (!replyText) return;
          console.log(`[AgentHarness] 💬 Bot replied to ${context.senderName}: "${replyText.slice(0, 100)}..."`);
          await context.replyText(replyText);
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

      const isSocketError =
        err.message?.includes('Closed') ||
        err.message?.includes('Terminated') ||
        err.message?.includes('1006') ||
        err.message?.includes('ECONNRESET') ||
        err.message?.includes('timed out');

      if (isSocketError) {
        console.warn('[AgentHarness] Aborting reasoning fallback: socket is disconnected or task timed out.');
        return;
      }

      // Fail-safe fallback: Answer directly from pre-trained knowledge without tools
      try {
        console.log('[AgentHarness] Attempting fail-safe direct knowledge answer...');
        const fallbackSystem = `${messages[0]?.content || ''}\n\nTools are unavailable for this turn. Deliver a direct, crisp reply from your own knowledge without any <tool_call> tags.`;
        const fallbackRes = await this.callLLM({
          messages: [
            { role: 'system', content: fallbackSystem },
            { role: 'user', content: `${context.senderName}: ${userMessage}` },
          ],
          tools: undefined,
          tool_choice: undefined,
        });

        const rawFallbackText = fallbackRes.choices[0]?.message?.content;
        if (rawFallbackText) {
          const extracted = extractInlineToolCalls(rawFallbackText);
          if (extracted.toolCalls.length > 0) {
            for (const tc of extracted.toolCalls) {
              try {
                const args = JSON.parse(tc.function.arguments || '{}');
                const res = await pluginRegistry.executeTool(tc.function.name, args, context);
                if (res.message) {
                  await context.replyText(sanitizeAssistantResponse(res.message));
                  return;
                }
              } catch {}
            }
          }

          const fallbackText = sanitizeAssistantResponse(extracted.cleanedContent || rawFallbackText);
          if (fallbackText) {
            console.log(`[AgentHarness] 💬 Bot replied via direct fallback to ${context.senderName}: "${fallbackText.slice(0, 100)}..."`);
            await context.replyText(fallbackText);
            this.recordFineTuningPair(
              messages[0]?.content || '',
              userMessage,
              fallbackText,
              []
            );
          }
          return;
        }
      } catch (fbErr: any) {
        console.error('[AgentHarness] Fallback also failed:', fbErr.message);
      }
    } finally {
      try {
        await context.sock.sendPresenceUpdate('paused', context.chatJid);
      } catch {}
    }
  }

  /**
   * Continuous learning guardrail:
   * Only persists high-quality, authentic interactions into the fine-tuning database.
   * Discards error messages, raw tool call markup, robotic clichés, and emoji spam.
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

      // Guardrail 2: Block error strings, raw tool tags, robotic clichés, generic fallbacks, or outdated names
      const lower = trimmed.toLowerCase();
      if (
        lower.includes('<tool_call>') ||
        lower.includes('</tool_call>') ||
        lower.includes('<function=') ||
        lower.includes('<think>') ||
        lower.includes('</think>') ||
        lower.includes('"arguments":') ||
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
 * 1. Zero raw <tool_call>, <function=...>, or <think> tags leaked to WhatsApp
 * 2. Strict max 0-1 emoji policy (strips subsequent emojis including ZWJ/modifiers)
 * 3. Ban robotic AI clichés at beginning/end of messages
 */
export function sanitizeAssistantResponse(text: string): string {
  if (!text) return '';
  let cleaned = text
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<\/think>/gi, '')
    .replace(/<tool_call>[\s\S]*?(?:<\/tool_call>|$)/gi, '')
    .replace(/<\/tool_call>/gi, '')
    .replace(/<function=[^>]+>[\s\S]*?(?:<\/function>|$)/gi, '')
    .trim();

  // Strip robotic preamble clichés (peel chained preambles like "Sure thing! As an AI, ...")
  const preambleRegex =
    /^(?:as an ai(?:\s+language\s+model)?|as a language model|certainly|sure thing|sure|of course|alright|no problem|i'd be happy to(?:\s+assist|\s+help)?|i would be happy to(?:\s+assist|\s+help)?|i'm here to assist(?:\s+you)?|i am here to assist(?:\s+you)?|i'm here to help|i am here to help|happy to help|glad to help|i am happy to help|i'm happy to help)[\s,.:;!-]+/i;
  while (preambleRegex.test(cleaned)) {
    cleaned = cleaned.replace(preambleRegex, '').trim();
  }

  // Strip trailing robotic closing clichés & assistant offers (preserving previous sentence punctuation)
  cleaned = cleaned
    .replace(/(?:\s+)(?:(?:how|what)\s+can\s+i\s+(?:help|assist)\s+(?:you\s+)?(?:with|today)?\??|is there anything else i can assist (?:you with\??|with\??)|is there anything else i can do(?: for you)?\??|feel free to (?:ask|reach out)[^.!?]*[.!?]?|i hope this helps\.?)$/i, '')
    .replace(/(?:\s+)(?:if you (?:ever )?hit a snag[^.!?]*[.!?]?|if you need a quick tool run[^.!?]*[.!?]?|anything specific you wanna dive into[^.!?]*\??|don't hesitate to (?:ask|reach out)[^.!?]*[.!?]?)$/i, '')
    .replace(/(?:\s+)(?:(?:just\s+)?let\s+me\s+know[^.!?]*[.!?]?|anything (?:i|we) fit do for you\??|anything else you need sorted\??|anything you need sorted\??|maybe i can help\.?|i'm here(?:—|--|-|\s+)maybe i can help\.?|wetin you want make i do for you\??)$/i, '')
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

  return cleaned;
}

export const agentHarness = new AgentHarness();
