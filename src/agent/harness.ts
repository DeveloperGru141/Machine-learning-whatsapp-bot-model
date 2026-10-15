import { groq } from './groq.js';
import { config } from '../config/env.js';
import { buildSystemPrompt } from './prompt.js';
import { pluginRegistry } from '../plugins/registry.js';
import { ExecutionContext } from '../plugins/types.js';
import { chatLogger } from '../memory/chat-logger.js';
import { db } from '../memory/db.js';

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

    const systemPrompt = buildSystemPrompt(
      context.senderJid,
      context.chatJid,
      context.isGroup
    );

    // Retrieve recent conversation history for multi-turn context
    const recentHistory = chatLogger.getRecentChatHistory(context.chatJid, 8);
    const messages: any[] = [{ role: 'system', content: systemPrompt }];

    for (const h of recentHistory) {
      messages.push({
        role: 'user',
        content: `${h.sender_name}: ${h.message_text || '[Media]'}`,
      });
    }

    // Append the current active prompt
    messages.push({
      role: 'user',
      content: `${context.senderName}: ${userMessage}`,
    });

    const tools = pluginRegistry.getGroqToolDefinitions();
    let currentIteration = 0;
    const maxIterations = 5;

    while (currentIteration < maxIterations) {
      currentIteration++;

      try {
        const response = await groq.chat.completions.create({
          model: config.groq.model,
          messages: messages,
          tools: tools.length > 0 ? tools : undefined,
          tool_choice: tools.length > 0 ? 'auto' : undefined,
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
        if (message.tool_calls && message.tool_calls.length > 0) {
          for (const toolCall of message.tool_calls) {
            const toolName = toolCall.function.name;
            let toolArgs = {};
            try {
              toolArgs = JSON.parse(toolCall.function.arguments || '{}');
            } catch {
              toolArgs = {};
            }

            console.log(`[Agent] Calling tool: ${toolName}`, toolArgs);
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

            // Record this interaction as a fine-tuning pair for continuous ML training
            try {
              db.prepare(`
                INSERT INTO fine_tuning_pairs (system_prompt, user_message, assistant_response, tools_invoked, created_at)
                VALUES (?, ?, ?, ?, ?)
              `).run(systemPrompt, userMessage, message.content, '[]', Date.now());
            } catch {}
          }
          break;
        }
      } catch (err: any) {
        console.error('[AgentHarness] Error in reasoning loop:', err);
        await context.replyText(`⚠️ Error processing request: ${err.message}`);
        break;
      }
    }

    try {
      await context.sock.sendPresenceUpdate('paused', context.chatJid);
    } catch {}
  }
}

export const agentHarness = new AgentHarness();
