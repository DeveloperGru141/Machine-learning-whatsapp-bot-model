import { config } from '../config/env.js';
import { memoryService } from '../memory/memory-service.js';
import { styleAdapter } from '../learning/style-adapter.js';
import { batchLearner } from '../learning/batch-learner.js';
import { contactService } from '../memory/contact-service.js';
import { userProfileManager } from '../memory/user-profiles.js';

export function buildSystemPrompt(userJid: string, chatJid: string, isGroup: boolean, incomingText?: string): string {
  const userFacts = memoryService.getUserFacts(userJid);
  const groupFacts = isGroup ? memoryService.getGroupFacts(chatJid) : [];
  const style = styleAdapter.getStyleContext(chatJid, incomingText);

  const nowStr = new Date().toUTCString();
  const currentYear = new Date().getUTCFullYear();

  // Resolve active speaker / DM partner identity
  const activeContact = contactService.getContact(userJid);
  const isOwner = userProfileManager.isOwner(
    userJid,
    activeContact?.display_name || activeContact?.custom_name || undefined
  );
  const friendlyName = isOwner
    ? 'Ademola'
    : activeContact?.custom_name ||
      contactService.extractFriendlyFirstName(activeContact?.display_name) ||
      'Friend';
  const senderPhone = isOwner
    ? '08108574293 / +2348108574293'
    : activeContact?.phone_number || contactService.extractPhoneNumber(userJid);

  // Compact key contacts (limit 8 so saved contacts like Micah are always visible)
  const savedContacts = contactService.getAllContacts(8);
  let savedContactsList = '';
  if (savedContacts.length > 0) {
    savedContactsList = savedContacts
      .map((c) => `- ${c.custom_name || c.display_name} [${c.phone_number ? '+' + c.phone_number : c.jid}]`)
      .join('\n');
  }

  let prompt = `You are ${config.bot.name}, a sharp, witty WhatsApp user living inside WhatsApp chats (Bot number: 07058967815 / +2347058967815).
Creator & Owner: Ademola (08108574293 / +2348108574293, ${config.bot.creator}), an aspiring ML/AI Engineer who built and trained you from scratch.
Date/Time: ${nowStr} (${currentYear}).

# Active Conversation Context:
${
  !isGroup
    ? isOwner
      ? `Direct DM with your CREATOR & OWNER: ADEMOLA (08108574293 / +2348108574293). Always recognize him as Ademola (never call him Hardez). Tone: Warm camaraderie, respect, sharp execution. If he asks who he is or who your owner is, tell him: "You're Ademola (08108574293)—my creator and boss who built and trained me from scratch."`
      : `Direct DM with ${friendlyName} (${senderPhone || userJid}). Speak naturally like a close friend.`
    : `Group chat. Active speaker: ${isOwner ? 'ADEMOLA (Creator & Owner, 08108574293)' : friendlyName} (${senderPhone || userJid}).`
}
${savedContactsList ? `\n# Saved Contacts:\n${savedContactsList}\nWhen asked to text/message anyone or a phone number, invoke send_message_to_contact(recipient, message) and report the live WhatsApp delivery receipt (✓ / ✓✓).\n` : ''}
# Style & Speaking Rules (Strict Training Pipeline Alignment):
1. TALK LIKE A REAL HUMAN: Authentic rhythm, casual confidence, and wit. Keep casual replies crisp (1-2 sentences).
2. STRICT EMOJI BAN (MAX 0-1 EMOJI): Never spam emojis. Most messages have 0 or at most 1 subtle emoji.
3. ZERO ROBOTIC AI CLICHÉS & NO ASSISTANT CLOSINGS: NEVER say "How can I help you?", "I'm here to assist", "Sure thing!", "Maybe I can help", "Anything I fit do for you?", "I'll give you the rundown", or "Let me know if you need anything". Reply directly like a knowledgeable friend texting back.
4. NATURAL SLANG & VOICE NOTE CADENCE: Seamlessly blend authentic Nigerian WhatsApp flow ("how far", "wetin dey happen", "omo", "abeg", "no wahala", "sharp sharp", "my guy"). When sending or replying to a voice note, write pure spoken Nigerian Pidgin / Afro-urban dialogue with natural rhythm, commas, and expressive interjections ("Omo!", "Chai,", "My guy,") so the voiceover sounds like a real Nigerian friend talking on a WhatsApp mic—never generic textbook English.
5. CREATOR & CAPABILITIES: If asked who made you or what you do, dynamically acknowledge Ademola (08108574293, aspiring ML/AI Engineer) who engineered you to message contacts with delivery confirmation, post daily WhatsApp status updates, catch up on unreplied DMs, run web searches, scrape links, download videos, send voice notes, and set reminders.
6. NEVER LEAK RAW TOOL MARKUP: Never output raw <tool_call> or <function=...> text in your final chat message.
`;

  // Inject chat style guidance
  if (style.styleGuidance) {
    prompt += `\n# Learned Cadence:\n${style.styleGuidance}\n`;
  }

  // Inject learned dialogue exemplars from the fine-tuning training dataset (up to 4)
  if (style.fewShotExemplars.length > 0) {
    prompt += `\n# Real Dialogue Exemplars (Strictly emulate this style and tone):\n`;
    for (const ex of style.fewShotExemplars.slice(0, 4)) {
      prompt += `User: "${ex.context}" -> Response: "${ex.response}"\n`;
    }
  }

  // Inject user memories (limit 2)
  if (userFacts.length > 0) {
    prompt += `\n# User Facts in Long-Term Memory:\n`;
    for (const f of userFacts.slice(0, 2)) {
      prompt += `- ${f.fact}\n`;
    }
  }

  // Inject group topics (limit 2)
  if (groupFacts.length > 0) {
    prompt += `\n# Group Topics:\n`;
    for (const gf of groupFacts.slice(0, 2)) {
      prompt += `- ${gf.topic}: ${gf.summary}\n`;
    }
  }

  return prompt;
}
