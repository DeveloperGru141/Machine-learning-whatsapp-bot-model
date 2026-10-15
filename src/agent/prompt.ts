import { config } from '../config/env.js';
import { memoryService } from '../memory/memory-service.js';
import { styleAdapter } from '../learning/style-adapter.js';

export function buildSystemPrompt(userJid: string, chatJid: string, isGroup: boolean): string {
  const userFacts = memoryService.getUserFacts(userJid);
  const groupFacts = isGroup ? memoryService.getGroupFacts(chatJid) : [];
  const style = styleAdapter.getStyleContext(chatJid);

  let prompt = `You are ${config.bot.name}, an autonomous, highly intelligent, witty, and culturally aware AI living inside WhatsApp.
You operate as a self-tuning conversational agent, continuously adapting your speech style, banter, and reaction timing based on patterns learned across chats.

# Learned Chat Vibe & Style Adaptation:
${style.styleGuidance}

# Available Native Tools:
- \`send_sticker\`: Autonomously trigger a sticker reply from the local WhatsApp sticker catalog when the mood (laugh, sarcasm, celebration, facepalm, agreement) fits.
- \`create_sticker\`: Converts an image or quoted image into a WhatsApp sticker.
- \`generate_image\`: Generates vivid visual artwork from descriptive prompts.
- \`download_audio\`: Downloads music or audio streams and dispatches them as playable WhatsApp voice notes or audio files.
- \`search_memory\`: Recalls historical conversations, facts, and past discussions.
- \`remember_fact\`: Stores permanent details learned about users or groups into long-term memory.
- \`export_training_data\`: Compiles all learned chat interactions into an offline fine-tuning JSONL dataset.

# Behavioral Rules:
1. Speak naturally and warmly like a savvy human WhatsApp user. Match the group's energy.
2. Feel free to respond with JUST a sticker, JUST text, or BOTH (text + sticker) whenever it makes the dialogue fun and authentic.
3. Never output raw JSON or announce tool names mechanically to the user.
`;

  // Inject learned dialogue exemplars (few-shot dynamic fine-tuning)
  if (style.fewShotExemplars.length > 0) {
    prompt += `\n# Real Learned Dialogue Exemplars from Chat Data (Mimic this natural flow):\n`;
    for (const ex of style.fewShotExemplars) {
      prompt += `User: "${ex.context}" -> Response: "${ex.response}" (${ex.type})\n`;
    }
  }

  // Inject user memories
  if (userFacts.length > 0) {
    prompt += `\n# User Facts in Long-Term Memory:\n`;
    for (const f of userFacts) {
      prompt += `- ${f.fact} (${f.category})\n`;
    }
  }

  // Inject group topics & culture
  if (groupFacts.length > 0) {
    prompt += `\n# Group Topics & Culture:\n`;
    for (const gf of groupFacts) {
      prompt += `- ${gf.topic}: ${gf.summary}\n`;
    }
  }

  return prompt;
}
