import { groq } from './groq.js';
import { config } from '../config/env.js';
import { pluginRegistry } from '../plugins/registry.js';
import { ExecutionContext } from '../plugins/types.js';
import { db } from '../memory/db.js';
import { contextManager } from '../core/context-manager.js';
import { analyticsEngine } from '../core/analytics.js';
import { chatLogger } from '../memory/chat-logger.js';

export class AgentHarness {
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

    // Indicate bot is thinking/typing
    try {
      await context.sock.sendPresenceUpdate('composing', context.chatJid);
    } catch {}

    // Token-budgeted context assembly (system prompt, user profiles, older summaries, recent history)
    const { messages, tokenBudgetUsed } = contextManager.buildManagedContext(
      context.chatJid,
      context.senderJid,
      context.isGroup,
      `${context.senderName}: ${userMessage}`
    );

    console.log(`[AgentHarness] Managed context built with ~${tokenBudgetUsed} estimated tokens.`);

    const tools = pluginRegistry.getGroqToolDefinitions();
    let currentIteration = 0;
    const maxIterations = 2; // 1 iteration for tool call, 1 iteration for final text response
    const executedTools = new Set<string>();

    while (currentIteration < maxIterations) {
      currentIteration++;

      try {
        const activeTools = tools.length > 0 ? tools : undefined;

        const response = await groq.chat.completions.create({
          model: config.groq.model,
          messages: messages,
          tools: activeTools,
          tool_choice: activeTools ? 'auto' : undefined,
          temperature: config.groq.temperature,
          max_completion_tokens: config.groq.maxTokens,
          top_p: config.groq.topP,
          reasoning_effort: config.groq.reasoningEffort as any,
        } as any);

        const choice = response.choices[0];
        if (!choice) break;

        const message = choice.message;
        messages.push(message);

        // Check if the model decided to call tools
        if (message.tool_calls && message.tool_calls.length > 0 && currentIteration < maxIterations) {
          for (const toolCall of message.tool_calls) {
            const toolName = toolCall.function.name;
            if (executedTools.has(toolName)) {
              // Prevent duplicate execution of same tool in single turn
              messages.push({
                role: 'tool',
                tool_call_id: toolCall.id,
                content: JSON.stringify({ status: 'done', note: 'Search completed. Answer directly now.' }),
              });
              continue;
            }
            executedTools.add(toolName);

            let toolArgs = {};
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

            messages.push({
              role: 'tool',
              tool_call_id: toolCall.id,
              content: JSON.stringify(toolResult),
            });
          }
        } else {
          // Final text reply from the LLM
          if (message.content) {
            // When send_voice_note was executed, the voice note IS the complete response.
            // Suppress redundant follow-up text like "Voice note sent. Let me know if you need anything else."
            if (executedTools.has('send_voice_note')) {
              console.log(`[AgentHarness] 🔇 Suppressed redundant post-voice-note text: "${message.content}"`);
              break;
            }

            console.log(`[AgentHarness] 💬 Bot replied to ${context.senderName}: "${message.content.slice(0, 100)}..."`);
            await context.replyText(message.content);

            // Log outbound message in chat_logs so future turns have complete back-and-forth context
            chatLogger.logOutboundMessage(context.chatJid, message.content);
            analyticsEngine.trackEvent('message_sent', { length: message.content.length }, context.chatJid, context.senderJid);

            // Record this interaction as a fine-tuning pair for continuous ML training
            this.recordFineTuningPair(
              messages[0]?.content || '',
              userMessage,
              message.content,
              Array.from(executedTools)
            );
          }
          break;
        }
      } catch (err: any) {
        console.error('[AgentHarness] Error in reasoning loop:', err.message || err);

        // Fail-safe fallback: Answer directly from pre-trained knowledge without tools
        try {
          console.log('[AgentHarness] Attempting fail-safe direct knowledge answer...');
          const fallbackRes = await groq.chat.completions.create({
            model: config.groq.model,
            messages: [
              messages[0], // system prompt
              { role: 'user', content: `${context.senderName}: ${userMessage}` },
            ],
            temperature: config.groq.temperature,
            max_completion_tokens: config.groq.maxTokens,
          });

          const fallbackText = fallbackRes.choices[0]?.message?.content;
          if (fallbackText) {
            console.log(`[AgentHarness] 💬 Bot replied via direct fallback to ${context.senderName}: "${fallbackText.slice(0, 100)}..."`);
            await context.replyText(fallbackText);
            chatLogger.logOutboundMessage(context.chatJid, fallbackText);
            this.recordFineTuningPair(
              messages[0]?.content || '',
              userMessage,
              fallbackText,
              []
            );
            break;
          }
        } catch (fbErr: any) {
          console.error('[AgentHarness] Fallback also failed:', fbErr.message);
        }

        await context.replyText('network slow small, abeg try again in a sec');
        break;
      }
    }

    try {
      await context.sock.sendPresenceUpdate('paused', context.chatJid);
    } catch {}
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

      // Guardrail 2: Block error strings, robotic clichés, or generic fallbacks
      const lower = trimmed.toLowerCase();
      if (
        lower.includes('network slow') ||
        lower.includes('abeg try again') ||
        lower.includes('as an ai') ||
        lower.includes('i am an ai') ||
        lower.includes('i am a language model') ||
        lower.includes('i apologize') ||
        lower.includes('rate limit') ||
        lower.includes('an error occurred')
      ) {
        return;
      }

      // Guardrail 3: Block emoji spam (no more than 2 emojis)
      const emojiRegex = /[\p{Emoji_Presentation}\p{Extended_Pictographic}]/gu;
      const emojiCount = (trimmed.match(emojiRegex) || []).length;
      if (emojiCount > 2) return;

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

export const agentHarness = new AgentHarness();
