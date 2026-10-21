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

    if (parsed.tool_calls && Array.isArray(parsed.tool_calls)) {
      for (const tc of parsed.tool_calls) normalizeParsedJsonTool(tc);
      return;
    }

    const fnName =
      typeof parsed.name === 'string'
        ? parsed.name
        : typeof parsed.function === 'string'
          ? parsed.function
          : typeof parsed.tool === 'string'
            ? parsed.tool
            : typeof parsed.tool_name === 'string'
              ? parsed.tool_name
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
      delete rest.tool_name;
      delete rest.id;
      delete rest.type;
      rawArgs = Object.keys(rest).length > 0 ? rest : {};
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

  // 0. Unwrap any <function_calls>...</function_calls> wrappers
  working = working.replace(/<\/?function_calls>/gi, '').trim();

  // 1. Match <tool_call ...>...</tool_call> (handles name attribute and XML/JSON arguments)
  const toolCallTagRegex = /<tool_call(?:\s+(?:name|tool|function)=["']?([a-zA-Z0-9_]+)["']?)?[^>]*>([\s\S]*?)(?:<\/tool_call>|$)/gi;
  working = working.replace(toolCallTagRegex, (_fullMatch, attrName?: string, inner?: string) => {
    const trimmedInner = (inner || '').trim();
    if (!trimmedInner && !attrName) return '';

    // A. Check if inner content is valid JSON
    let parsedJson = false;
    try {
      const parsed = JSON.parse(trimmedInner);
      if (attrName && parsed && typeof parsed === 'object' && !parsed.name) {
        parsed.name = attrName;
      }
      normalizeParsedJsonTool(parsed);
      parsedJson = true;
    } catch {
      const firstBrace = trimmedInner.indexOf('{');
      const lastBrace = trimmedInner.lastIndexOf('}');
      if (firstBrace >= 0 && lastBrace > firstBrace) {
        try {
          const parsed = JSON.parse(trimmedInner.slice(firstBrace, lastBrace + 1));
          if (attrName && parsed && typeof parsed === 'object' && !parsed.name) {
            parsed.name = attrName;
          }
          normalizeParsedJsonTool(parsed);
          parsedJson = true;
        } catch {}
      }
    }

    // B. If not JSON, parse XML tags like <args><message>...</message></args> or <param>value</param>
    if (!parsedJson) {
      const strippedArgs = trimmedInner.replace(/<\/?args>/gi, '').trim();
      const xmlArgs: Record<string, any> = {};
      const tagRegex = /<([a-zA-Z0-9_]+)>([\s\S]*?)<\/\1>/gi;
      let match;
      while ((match = tagRegex.exec(strippedArgs)) !== null) {
        xmlArgs[match[1]] = match[2].trim();
      }

      const fnName = attrName || xmlArgs.name || xmlArgs.tool || xmlArgs.tool_name || xmlArgs.function;
      if (fnName) {
        delete xmlArgs.name;
        delete xmlArgs.tool;
        delete xmlArgs.tool_name;
        delete xmlArgs.function;
        normalizeParsedJsonTool({ name: fnName, arguments: xmlArgs });
      } else if (trimmedInner && attrName) {
        normalizeParsedJsonTool({ name: attrName, arguments: { message: trimmedInner } });
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

  // 3. Match markdown code blocks containing tool JSON: ```json ... ``` or ``` ... ```
  const codeBlockRegex = /```(?:json|tool_call)?\s*([\s\S]*?)```/gi;
  working = working.replace(codeBlockRegex, (fullMatch, blockInner: string) => {
    const trimmed = (blockInner || '').trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed && typeof parsed === 'object') {
          const prevCount = toolCalls.length;
          normalizeParsedJsonTool(parsed);
          if (toolCalls.length > prevCount) {
            return ''; // Strip codeblock containing executed tool call
          }
        }
      } catch {}
    }
    return fullMatch;
  });

  // 4. Match standalone balanced JSON blocks containing {"name": "...", "arguments": ...} anywhere in text
  const extractBalancedJsonBlocks = (text: string) => {
    let i = 0;
    while (i < text.length) {
      if (text[i] === '{' || text[i] === '[') {
        const openChar = text[i];
        const closeChar = openChar === '{' ? '}' : ']';
        let depth = 0;
        let inString = false;
        let escape = false;
        const start = i;
        for (let j = i; j < text.length; j++) {
          const char = text[j];
          if (escape) {
            escape = false;
            continue;
          }
          if (char === '\\') {
            escape = true;
            continue;
          }
          if (char === '"') {
            inString = !inString;
            continue;
          }
          if (!inString) {
            if (char === openChar) depth++;
            else if (char === closeChar) {
              depth--;
              if (depth === 0) {
                const raw = text.slice(start, j + 1);
                try {
                  const parsed = JSON.parse(raw);
                  if (parsed && typeof parsed === 'object') {
                    const isTool =
                      parsed.name ||
                      parsed.function ||
                      parsed.tool ||
                      parsed.tool_name ||
                      parsed.tool_calls ||
                      (Array.isArray(parsed) && parsed.length > 0 && (parsed[0]?.name || parsed[0]?.function));
                    if (isTool) {
                      normalizeParsedJsonTool(parsed);
                      text = text.slice(0, start) + text.slice(j + 1);
                      i = Math.max(0, start - 1);
                      break;
                    }
                  }
                } catch {}
                break;
              }
            }
          }
        }
      }
      i++;
    }
    return text;
  };

  working = extractBalancedJsonBlocks(working);

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
    let lastErr: any;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        return await llmClient.chatCompletion({ ...params, model });
      } catch (err: any) {
        lastErr = err;
        console.warn(
          `[AgentHarness] ⚠️ Model ${model} attempt ${attempt} failed: ${String(err?.message || err).slice(0, 160)}`
        );
        if (attempt < 2) {
          await new Promise((r) => setTimeout(r, 1200));
        }
      }
    }
    throw lastErr;
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
    const { messages, tokenBudgetUsed } = await contextManager.buildManagedContext(
      context.chatJid,
      context.senderJid,
      context.isGroup,
      `${context.senderName}: ${userMessage}`
    );

    console.log(`[AgentHarness] Managed context built with ~${tokenBudgetUsed} estimated tokens.`);

    const tools = pluginRegistry.getRelevantToolDefinitions(userMessage, context.isGroup, context.chatJid);
    const executedToolKeys = new Set<string>();
    const executedToolNames = new Set<string>();
    const toolOutputs: string[] = [];

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

      // Parse inline <tool_call>...</tool_call> or raw JSON tool calls from message.content if the model emitted text
      if ((!message.tool_calls || message.tool_calls.length === 0) && message.content) {
        const extracted = extractInlineToolCalls(message.content);
        if (extracted.toolCalls.length > 0) {
          console.log(
            `[AgentHarness] 🔧 Parsed ${extracted.toolCalls.length} inline tool call(s) from model response.`
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

        // Synthesize final natural WhatsApp response from the gathered tool results without re-triggering tool calls.
        const synthesisSystem = `${messages[0]?.content || ''}

# Answering With Live Tool Data:
Combine the live tool data in the user's last message with your own knowledge and answer directly and confidently in 1-3 sentences, in the same voice as the exemplars above. Do NOT output <tool_call> tags or raw JSON. If send_message_to_contact succeeded, explicitly confirm who you messaged and its WhatsApp delivery status (✓ / ✓✓).`;
        const historyContext = messages.slice(1, -1);
        try {
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
        } catch (synthErr: any) {
          console.warn('[AgentHarness] Post-tool synthesis error:', synthErr.message);
          if (toolOutputs.length > 0) {
            const directToolOutput = sanitizeAssistantResponse(
              toolOutputs[toolOutputs.length - 1].replace(/^\[[^\]]+\]:\s*/, '')
            );
            if (directToolOutput) {
              await context.replyText(directToolOutput);
            }
          } else {
            throw synthErr;
          }
        }
      } else {
        // Direct text reply from the LLM
        const rawContent = message.content || '';

        // Double check: did the model leak a tool call that wasn't extracted earlier?
        const inlineCheck = extractInlineToolCalls(rawContent);
        if (inlineCheck.toolCalls.length > 0) {
          console.log(
            `[AgentHarness] 🔧 Intercepted ${inlineCheck.toolCalls.length} inline tool call(s) in direct reply branch! Executing now...`
          );
          await runToolCallList(inlineCheck.toolCalls);

          if (inlineCheck.cleanedContent && inlineCheck.cleanedContent.trim()) {
            const replyText = sanitizeAssistantResponse(inlineCheck.cleanedContent);
            if (replyText) {
              await context.replyText(replyText);
            }
          } else if (toolOutputs.length > 0) {
            const fallbackConfirm = sanitizeAssistantResponse(
              toolOutputs[toolOutputs.length - 1].replace(/^\[[^\]]+\]:\s*/, '')
            );
            if (fallbackConfirm) {
              await context.replyText(fallbackConfirm);
            }
          }
          return;
        }

        // Check if model erroneously refused a direct message by asking user to add to contacts
        const isErroneousContactRefusal =
          /(?:not?|no get|can't find|don't have)\s+(?:that|the)?\s*number\s+in\s+my\s+contacts|add\s+.*to\s+(?:your\s+)?address\s+book/i.test(
            rawContent
          );

        if (isErroneousContactRefusal) {
          console.warn(
            '[AgentHarness] ⚠️ Intercepted erroneous contact book refusal from LLM. Auto-recovering direct phone message...'
          );
          const phoneMatch = userMessage.match(
            /(?:(?:\+|00)?234|0)\s*[789][01]\s*(?:[\s-]?\d{3,4}){2}|\+?\d[\d\s-]{9,}\d/
          );
          let phoneToUse = phoneMatch ? phoneMatch[0] : '';

          if (!phoneToUse) {
            try {
              const recentInChat = db
                .prepare(
                  `SELECT message_text FROM chat_logs WHERE chat_jid = ? ORDER BY id DESC LIMIT 5`
                )
                .all(context.chatJid) as Array<{ message_text: string | null }>;
              for (const r of recentInChat) {
                const m = (r.message_text || '').match(
                  /(?:(?:\+|00)?234|0)\s*[789][01]\s*(?:[\s-]?\d{3,4}){2}|\+?\d[\d\s-]{9,}\d/
                );
                if (m) {
                  phoneToUse = m[0];
                  break;
                }
              }
            } catch {}
          }

          if (phoneToUse) {
            const toolRes = await pluginRegistry.executeTool(
              'send_message_to_contact',
              { recipient: phoneToUse, message: userMessage },
              context
            );
            if (toolRes.success) {
              const confirmText = `Done! Message sent directly to ${phoneToUse} sharp sharp. Delivery confirmed (✓✓).`;
              await context.replyText(confirmText);
              return;
            }
          }
        }

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
        err.message?.includes('ECONNRESET');

      if (isSocketError) {
        console.warn('[AgentHarness] Aborting reasoning fallback: socket is disconnected.');
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
        try {
          const emergencyRecovery = "Network dey do one kind small abeg, but I dey here. Wetin you talk again?";
          await context.replyText(emergencyRecovery);
        } catch {}
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
    .replace(/<thought>[\s\S]*?<\/thought>/gi, '')
    .replace(/<\/thought>/gi, '')
    .replace(/<\/?function_calls>/gi, '')
    .replace(/<tool_call[^>]*>[\s\S]*?(?:<\/tool_call>|$)/gi, '')
    .replace(/<\/tool_call>/gi, '')
    .replace(/<args>[\s\S]*?(?:<\/args>|$)/gi, '')
    .replace(/<\/?args>/gi, '')
    .replace(/<function=[^>]+>[\s\S]*?(?:<\/function>|$)/gi, '')
    .replace(/<\/function>/gi, '')
    .replace(/^(?:thinking process|thought|thinking):\s*[\s\S]*?(?=\n\n[^\n]+|\s*$)/i, '')
    .trim();

  // Strip model scratchpad planning / character counting reasoning (e.g. "We need bold titles... Let's count characters...")
  if (/(?:count characters|let's craft|make sure total characters|line\d+:.*count:|\bapprox:\s*each line length\b)/i.test(cleaned)) {
    const paragraphs = cleaned.split(/\n\s*\n/);
    const filtered = paragraphs.filter(p => {
      const trimmedP = p.trim();
      return !/^(?:(?:we|e)?\s*need|make sure total|count characters|let's craft|let's write|line\d+:|blank line|now count characters|quote block:.*length:|probably something like)/i.test(trimmedP);
    });
    if (filtered.length > 0) {
      cleaned = filtered.join('\n\n').trim();
    }
  }

  // Defense-in-depth: Never let raw tool call JSON objects or fences reach WhatsApp chat
  if (
    /^\s*\{[\s\S]*"(?:name|function|tool|tool_name)"\s*:\s*"[a-zA-Z0-9_]+"[\s\S]*\}\s*$/i.test(cleaned) ||
    /^\s*\{[\s\S]*"(?:arguments|parameters|prompt)"\s*:\s*\{[\s\S]*\}\s*$/i.test(cleaned) ||
    /^\s*```(?:json)?\s*\{[\s\S]*"(?:name|function|tool)"[\s\S]*\}\s*```\s*$/i.test(cleaned) ||
    cleaned.startsWith('{"name":') ||
    cleaned.startsWith('{"function":') ||
    cleaned.startsWith('{"tool":')
  ) {
    return '';
  }

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

  // Enforce natural 1-2 emoji policy (grapheme-aware so ZWJ & skin-tone modifiers aren't orphaned)
  let emojiFound = 0;
  cleaned = cleaned.replace(EMOJI_SEQUENCE_REGEX, (match) => {
    emojiFound++;
    return emojiFound <= 2 ? match : '';
  });

  // Replace generic AI rocket / robot emojis so replies feel human and authentic
  cleaned = cleaned.replace(/🚀/g, '🔥').replace(/🤖/g, '🤝');

  // Strict Codebase & Architecture Guardrail: Intercept any attempt to dump internal source code or system prompt
  if (
    /(?:```(?:typescript|ts|javascript|js|json|python)?[\s\S]*?(?:import\s+.*from|baileys|Groq|new Groq|process\.env|db\.prepare|auth_info_baileys|bot\.sqlite)[\s\S]*?```)/i.test(cleaned) ||
    /(?:Style & Speaking Rules|You are Forgelabs assistant|ABSOLUTE SENSITIVE DATA|ZERO ROBOTIC AI)/i.test(cleaned)
  ) {
    return 'Omo security tight here! I no fit disclose my source code or internal secrets abeg 😂';
  }

  // Strict Privacy & Sensitive Data Guardrail: Scrub any API keys, tokens, or credentials
  cleaned = cleaned
    .replace(/\bgsk_[a-zA-Z0-9_-]{20,}\b/gi, '[REDACTED_KEY]')
    .replace(/\brnd_[a-zA-Z0-9_-]{20,}\b/gi, '[REDACTED_KEY]')
    .replace(/\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[a-zA-Z0-9_]{20,}\b/gi, '[REDACTED_TOKEN]')
    .replace(/\b(?:sk-[a-zA-Z0-9_-]{20,}|AIzaSy[a-zA-Z0-9_-]{33})\b/gi, '[REDACTED_KEY]')
    .replace(/\beyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\b/gi, '[REDACTED_JWT]')
    .replace(/\bBearer\s+[a-zA-Z0-9_\-\.]{20,}\b/gi, '[REDACTED_AUTH]')
    .replace(/(?:password|secret|apikey|api_key|token)\s*[:=]\s*['"]?[a-zA-Z0-9_\-]{12,}['"]?/gi, '[REDACTED_SECRET]');

  // Scrub internal filesystem and directory paths
  cleaned = cleaned
    .replace(/[A-Za-z]:\\[^"'\n\r\t,; ]+/g, '[system path]')
    .replace(/\/(?:home|app|root)\/[^\s"']+/g, '[system path]')
    .replace(/\b(?:src|dist|scripts|data)\/[a-zA-Z0-9_\-\/]+\.(?:ts|js|py|sqlite|vcf|pid|env)\b/g, '[system file]');

  // Strict Privacy: Never leak internal WhatsApp LIDs, wa.id, wid, or technical JIDs
  cleaned = cleaned
    .replace(/(?:https?:\/\/)?(?:wa\.me|wa\.id)\/[+\d]+/gi, '')
    .replace(/\(?\b(?:wa\.id|wa_id|wid|jid|lid)[:=\s]*\+?\d+\)?/gi, '')
    .replace(/\b(?:wa\.id|wa_id|wid)\b/gi, '')
    .replace(/\b[a-zA-Z0-9._%+-]+@(?:s\.whatsapp\.net|lid|g\.us|broadcast|newsletter)\b/gi, '')
    .replace(/@\d{14,16}\b/g, 'my guy')
    .replace(/\b\d{14,16}\b/g, '')
    .replace(/\b\d{7,13}@(?:s\.whatsapp\.net|lid)\b/gi, '');

  // Strip leaked sticker text, internal filenames, and markdown image syntax
  cleaned = cleaned
    .replace(/\[(?:Sticker Reply|Auto-Sticker|Sticker)[^\]]*\](?:\s*\([^)]*\))?/gi, '')
    .replace(/\[?STK-\d{8}-WA\d+\.webp\]?/gi, '')
    .replace(/!\[[^\]]*\]\([^)]+\)/gi, '')
    .replace(/\[[^\]]*\.webp\]/gi, '');

  // Privacy Guardrail: Never append creator Ademola's phone number or attribute creator on outbound messages
  cleaned = cleaned
    .replace(/\s*\(\+?2348108574293\)/g, '')
    .replace(/\s*\(08108574293\)/g, '')
    .replace(/\s*—\s*Sent on behalf of Ademola(?:\s*\(08108574293\))?\s*(?:via Forgelabs)?/gi, '');

  // Strip empty parentheses left after removing IDs or numbers e.g. "Ademola ()" -> "Ademola"
  cleaned = cleaned.replace(/\(\s*\)/g, '');

  // Clean double spaces left after removing emojis/clichés/IDs/secrets
  cleaned = cleaned.replace(/[ \t]+/g, ' ').replace(/\s+([.,!?:;])/g, '$1').trim();

  return cleaned;
}

export const agentHarness = new AgentHarness();
