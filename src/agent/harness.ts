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

    // Fast-path detection: Check if message is casual dialogue that doesn't need tool invocation
    const isToolCandidate = this.requiresTools(userMessage);
    const allTools = pluginRegistry.getGroqToolDefinitions();
    const tools = isToolCandidate ? allTools : [];

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
            console.log(`[AgentHarness] 💬 Bot replied to ${context.senderName}: "${message.content.slice(0, 100)}..."`);
            await context.replyText(message.content);

            // Log outbound message in chat_logs so future turns have complete back-and-forth context
            chatLogger.logOutboundMessage(context.chatJid, message.content);
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

  /**
   * Fast-path classifier: determines if a message requires invoking tools.
   * Casual dialogue, greetings, bot identity inquiries, and banter bypass tool overhead (<600ms latency).
   */
  private requiresTools(text: string): boolean {
    const lower = (text || '').toLowerCase().trim();

    // 1. Explicit URLs
    if (/https?:\/\//i.test(lower)) return true;

    // 2. Factual / real-time / price lookups
    if (/\b(price|crypto|stock|btc|eth|sol|bitcoin|ethereum|weather|news|match|score|scoreline|search|lookup|google)\b/i.test(lower)) {
      return true;
    }

    // 3. Media & downloader commands
    if (/\b(download|video|reel|tiktok|mp4|audio|song|music|mp3|voice note)\b/i.test(lower)) {
      return true;
    }

    // 4. Scheduler / Reminders
    if (/\b(remind|reminder|schedule|timer|alarm)\b/i.test(lower)) {
      return true;
    }

    // 5. Document & PDF reading
    if (/\b(read|summarize|pdf|docx?|document|attached file)\b/i.test(lower)) {
      return true;
    }

    // 6. Admin, moderation, contact management
    if (/\b(tag all|tagall|kick|group mode|mute group|unmute group|save contact|get contact|contact card|vcf|generate image|draw|picture of)\b/i.test(lower)) {
      return true;
    }

    // Casual chat, greetings, creator queries, banter do NOT need tools
    return false;
  }
}

export const agentHarness = new AgentHarness();
