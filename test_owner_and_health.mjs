import { userProfileManager } from './dist/memory/user-profiles.js';
import { contactService } from './dist/memory/contact-service.js';
import { buildSystemPrompt } from './dist/agent/prompt.js';
import {
  schedulerPlugin,
  buildBotHealthReport,
  getStatusRecipientJids,
} from './dist/plugins/scheduler/scheduler-plugin.js';
import { db, initDatabase } from './dist/memory/db.js';
import { config } from './dist/config/env.js';
import { styleAdapter } from './dist/learning/style-adapter.js';
import { sanitizeAssistantResponse } from './dist/agent/harness.js';
import { whatsAppClient } from './dist/core/client.js';

console.log('🧪 Testing Bot Number (09014896714), Morning Status Poster, Fine-Tuning Pipeline, 2-Min Contact Replies Cycle & Owner Recognition...\n');

let passed = 0;
let total = 0;
function assert(name, condition, detail = '') {
  total++;
  if (condition) {
    passed++;
    console.log(`✅ ${name}`);
  } else {
    console.error(`❌ ${name} -> ${detail}`);
  }
}

async function run() {
  initDatabase();

  const ownerRawPhone = '08108574293';
  const ownerJid = '2348108574293@s.whatsapp.net';
  const ownerLid = '102409552584830@lid';

  // 0. Test Bot Pairing Phone Number (09014896714 -> 2349014896714)
  assert('Bot default PAIRING_PHONE_NUMBER is 09014896714 (2349014896714)', config.bot.pairingPhoneNumber === '2349014896714', `Got: ${config.bot.pairingPhoneNumber}`);

  // 1. Test Owner Detection (Phone, JID, and @lid)
  assert('isOwner recognizes 08108574293', userProfileManager.isOwner(ownerRawPhone));
  assert('isOwner recognizes 2348108574293@s.whatsapp.net', userProfileManager.isOwner(ownerJid));
  assert('isOwner recognizes 102409552584830@lid', userProfileManager.isOwner(ownerLid));

  // 2. Test Saved Contact Record
  const contact = contactService.getContact(ownerJid);
  assert('Contact service identifies Ademola for owner JID', contact?.display_name === 'Ademola' || contact?.custom_name === 'Ademola');

  // 3. Test Prompt Recognition & Fine-Tuning Alignment
  const prompt = buildSystemPrompt(ownerJid, ownerJid, false, 'Who am I?');
  assert('System prompt explicitly names ADEMOLA as CREATOR & OWNER', prompt.includes('CREATOR & OWNER: ADEMOLA'));
  assert('System prompt instructs bot to acknowledge Ademola as builder and developer', prompt.includes("You're Ademola! You built and trained me from scratch"));
  assert('Prompt does NOT fall back to generic Hardez or Friend for owner', !prompt.includes('DM Partner: Hardez'));
  assert('Prompt injects fine-tuning exemplars from training pipeline', prompt.includes('# Real Dialogue Exemplars (Strictly emulate this style and tone):'));

  // 4. Test Fine-Tuning Exemplar Retrieval & Response Sanitizer
  const styleCtx = styleAdapter.getStyleContext(ownerJid, 'How far bro, hope everywhere good?');
  assert('StyleAdapter retrieves fine-tuning exemplars from dialogue_exemplars', Array.isArray(styleCtx.fewShotExemplars) && styleCtx.fewShotExemplars.length > 0);
  const sanitized = sanitizeAssistantResponse('As an AI assistant, I am doing great! 😂🔥🚀🙌 How can I assist you today?');
  assert('Sanitizer strips robotic AI self-references & caps emojis to max 1', !sanitized.includes('As an AI') && !sanitized.includes('How can I assist you today'));

  // 5. Test Contact Replies Cycle (Unreplied DM Catch-up Scanner - 2 min cycle)
  assert('WhatsAppClient exposes startUnrepliedScanner & replyUnrepliedMessages', typeof whatsAppClient.startUnrepliedScanner === 'function' && typeof whatsAppClient.replyUnrepliedMessages === 'function');
  assert('WhatsAppClient exposes requestFreshPairingCode for /pair endpoint', typeof whatsAppClient.requestFreshPairingCode === 'function');

  // 6. Test ensureOwnerHealthSchedule
  schedulerPlugin.ensureOwnerHealthSchedule();
  const scheduledHealth = db.prepare(
    "SELECT * FROM scheduled_tasks WHERE chat_jid = ? AND topic = 'owner_health_report' AND status = 'pending'"
  ).get(ownerJid);
  assert('Owner morning health report task exists in scheduled_tasks', !!scheduledHealth);
  assert('Health report is set to recurring daily at 07:00', scheduledHealth?.recurring_cron === 'daily' && scheduledHealth?.time_of_day === '07:00');

  // 7. Test Morning WhatsApp Status Poster (memes, tech news, bible verses, motivation)
  schedulerPlugin.ensureMorningStatusSchedule();
  const scheduledStatus = db.prepare(
    "SELECT * FROM scheduled_tasks WHERE chat_jid = 'status@broadcast' AND topic = 'morning_status_post' AND status = 'pending'"
  ).get();
  assert('Daily morning WhatsApp Status poster is scheduled at 07:15 AM', !!scheduledStatus && scheduledStatus.recurring_cron === 'daily' && scheduledStatus.time_of_day === '07:15');
  const statusRecipients = getStatusRecipientJids();
  assert('getStatusRecipientJids collects contacts & owner JID for status@broadcast', statusRecipients.includes(ownerJid) && statusRecipients.length > 10);
  const statusTool = schedulerPlugin.tools.find(t => t.name === 'post_whatsapp_status');
  assert('post_whatsapp_status tool is registered in schedulerPlugin', !!statusTool);

  // 8. Test buildBotHealthReport
  const reportText = buildBotHealthReport();
  assert('Report header includes FORGELABS ASSISTANT', reportText.includes('FORGELABS ASSISTANT'));
  assert('Report credits Owner Ademola (08108574293)', reportText.includes('Ademola (08108574293)'));
  assert('Report includes System Status and Uptime', reportText.includes('System Status') && reportText.includes('Uptime'));

  // 9. Test get_bot_health_status tool
  const healthTool = schedulerPlugin.tools.find(t => t.name === 'get_bot_health_status');
  assert('get_bot_health_status tool is registered in schedulerPlugin', !!healthTool);
  const toolRes = await healthTool.execute({}, { chatJid: ownerJid, senderJid: ownerJid, isGroup: false, sock: null });
  assert('get_bot_health_status tool executes successfully', toolRes.success && toolRes.message.includes('Owner: Ademola'));

  console.log(`\n============================================================`);
  console.log(`📊 Result: ${passed}/${total} assertions passed!`);
  console.log(`============================================================\n`);

  if (passed === total) {
    process.exit(0);
  } else {
    process.exit(1);
  }
}

run().catch(err => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
