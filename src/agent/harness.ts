import { groq } from './groq.js';
import { config } from '../config/env.js';
import { pluginRegistry } from '../plugins/registry.js';
import { ExecutionContext } from '../plugins/types.js';
import { db } from '../memory/db.js';
import { contextManager } from '../core/context-manager.js';
import { analyticsEngine } from '../core/analytics.js';

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
    const maxIterations = 2; // Strict limit: 1 iteration for tool call, 1 iteration for final text response
    const executedTools = new Set<string>();

    while (currentIteration < maxIterations) {
      currentIteration++;

      try {
        // Only provide tools on the first iteration to prevent infinite search loops
        const activeTools = currentIteration === 1 && tools.length > 0 ? tools : undefined;

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
            await context.replyText(message.content);
            analyticsEngine.trackEvent('message_sent', { length: message.content.length }, context.chatJid, context.senderJid);

            // Record this interaction as a fine-tuning pair for continuous ML training
            try {
              const systemPrompt = messages[0]?.content || '';
              db.prepare(`
                INSERT INTO fine_tuning_pairs (system_prompt, user_message, assistant_response, tools_invoked, created_at)
                VALUES (?, ?, ?, ?, ?)
              `).run(systemPrompt, userMessage, message.content, '[]', Date.now());
            } catch {}
          }
          break;
        }
      } catch (err: any) {
        console.error('[AgentHarness] Error in reasoning loop:', err.message || err);
        await context.replyText('network slow small, abeg try again in a sec');
        break;
      }
    }

    try {
      await context.sock.sendPresenceUpdate('paused', context.chatJid);
    } catch {}
  }
}

export const agentHarness = new AgentHarness();
