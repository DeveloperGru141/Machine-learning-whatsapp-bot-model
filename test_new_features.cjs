const assert = require('assert');
const { BOT_WELCOME_MESSAGE, BOT_GROUP_INTRO } = require('./dist/security/anti-ban.js');
const { groupAdminPlugin } = require('./dist/plugins/group-admin/admin-plugin.js');
const { sanitizeAssistantResponse } = require('./dist/agent/harness.js');
const { buildSystemPrompt } = require('./dist/agent/prompt.js');
const { llmClient } = require('./dist/agent/llm-client.js');

console.log('🧪 Starting Verification Test Suite for New Fixes & Features...\n');

// Test 1: Introduction messages start with plain English first, followed by Pidgin/slang, no phone number
console.log('▶ Test 1: Verify Welcome & Intro Messages...');
assert(
  BOT_WELCOME_MESSAGE.startsWith('Hello! I am Forgelabs Assistant'),
  `Expected BOT_WELCOME_MESSAGE to start with plain English, got: ${BOT_WELCOME_MESSAGE}`
);
assert(
  BOT_WELCOME_MESSAGE.includes('I dey here to run things sharp sharp'),
  'Expected BOT_WELCOME_MESSAGE to continue in Pidgin'
);
assert(!BOT_WELCOME_MESSAGE.includes('08108574293'), 'Welcome message must not leak creator phone number');

assert(
  BOT_GROUP_INTRO.startsWith('Hello everyone! I am Forgelabs Assistant'),
  `Expected BOT_GROUP_INTRO to start with plain English, got: ${BOT_GROUP_INTRO}`
);
assert(
  BOT_GROUP_INTRO.includes('I dey here with full energy'),
  'Expected BOT_GROUP_INTRO to continue in Pidgin'
);
assert(!BOT_GROUP_INTRO.includes('08108574293'), 'Group intro must not leak creator phone number');
console.log('✅ Test 1 Passed: Intro messages use plain English first then Pidgin without phone numbers.\n');

// Test 2: System prompt rules for creator number and intro sequence
console.log('▶ Test 2: Verify System Prompt Creator Rules...');
const prompt = buildSystemPrompt('1234567890@s.whatsapp.net', '1234567890@s.whatsapp.net', false);
assert(
  prompt.includes("NEVER add or append Ademola's phone number to messages, introductions, or anywhere else unless the user EXPLICITLY asks"),
  'System prompt must strictly forbid adding Ademola phone number without explicit request'
);
assert(
  prompt.includes('ALWAYS start your introduction in plain English first'),
  'System prompt must require plain English introduction first'
);
assert(
  prompt.includes('OWNER KICK & DEMOTE IMMUNITY'),
  'System prompt must contain owner kick & demote immunity rule'
);
console.log('✅ Test 2 Passed: System prompt enforces plain English intro, zero unsolicited phone numbers, and immunity.\n');

// Test 3: Owner Kick Immunity in Group Admin
console.log('▶ Test 3: Verify Owner Kick Immunity...');
const kickTool = groupAdminPlugin.tools.find((t) => t.name === 'kick_member');
assert(kickTool, 'kick_member tool must exist');

const mockCtxAdmin = {
  isGroup: true,
  chatJid: '120363024829104812@g.us',
  senderJid: '9876543210@s.whatsapp.net',
  senderName: 'Group Admin',
  sock: {
    groupMetadata: async () => ({
      participants: [
        { id: 'bot@s.whatsapp.net', admin: 'admin' },
        { id: '9876543210@s.whatsapp.net', admin: 'admin' },
        { id: '2348108574293@s.whatsapp.net', admin: 'admin' },
      ],
    }),
  },
};

(async () => {
  // Attempt 1: Target "Ademola"
  const res1 = await kickTool.execute({ target: 'Ademola' }, mockCtxAdmin);
  assert.strictEqual(res1.success, false);
  assert(
    res1.message.includes('I fit NEVER kick my creator & owner Ademola'),
    `Expected refusal to kick Ademola, got: ${res1.message}`
  );

  // Attempt 2: Target phone number "08108574293"
  const res2 = await kickTool.execute({ target: '08108574293' }, mockCtxAdmin);
  assert.strictEqual(res2.success, false);
  assert(
    res2.message.includes('I fit NEVER kick my creator & owner Ademola'),
    `Expected refusal to kick owner phone number, got: ${res2.message}`
  );

  // Attempt 3: Target "Hardez"
  const res3 = await kickTool.execute({ target: 'Hardez' }, mockCtxAdmin);
  assert.strictEqual(res3.success, false);
  assert(
    res3.message.includes('I fit NEVER kick my creator & owner Ademola'),
    `Expected refusal to kick Hardez, got: ${res3.message}`
  );

  console.log('✅ Test 3 Passed: Group admin kick_member strictly protects Ademola.\n');

  // Test 4: Owner Demote Immunity in Group Admin
  console.log('▶ Test 4: Verify Owner Demote Immunity...');
  const demoteTool = groupAdminPlugin.tools.find((t) => t.name === 'demote_member');
  assert(demoteTool, 'demote_member tool must exist');

  const resDemote = await demoteTool.execute({ target: 'Ademola' }, mockCtxAdmin);
  assert.strictEqual(resDemote.success, false);
  assert(
    resDemote.message.includes('I fit NEVER demote my creator & owner Ademola'),
    `Expected refusal to demote Ademola, got: ${resDemote.message}`
  );
  console.log('✅ Test 4 Passed: Group admin demote_member strictly protects Ademola.\n');

  // Test 5: Sanitizer scrubs WIDs, wa.id, LIDs, JIDs, and creator number
  console.log('▶ Test 5: Verify Sanitizer Scrubs WIDs, JIDs & Creator Number...');
  const dirty1 = 'Hello Ademola (08108574293), your wa.id is 102409552584830 and JID is 2348108574293@s.whatsapp.net!';
  const clean1 = sanitizeAssistantResponse(dirty1);
  assert(!clean1.includes('08108574293'), `Expected no 08108574293, got: ${clean1}`);
  assert(!clean1.includes('wa.id'), `Expected no wa.id, got: ${clean1}`);
  assert(!clean1.includes('102409552584830'), `Expected no LID 102409552584830, got: ${clean1}`);
  assert(!clean1.includes('@s.whatsapp.net'), `Expected no @s.whatsapp.net, got: ${clean1}`);

  const dirty2 = 'Check wid: 102409552584830 or wa.id: 2348108574293 or wa.me/2348108574293 in 120363024829104812@g.us';
  const clean2 = sanitizeAssistantResponse(dirty2);
  assert(!clean2.includes('wid:'), `Expected no wid:, got: ${clean2}`);
  assert(!clean2.includes('wa.id:'), `Expected no wa.id:, got: ${clean2}`);
  assert(!clean2.includes('wa.me'), `Expected no wa.me, got: ${clean2}`);
  assert(!clean2.includes('@g.us'), `Expected no @g.us, got: ${clean2}`);

  const dirty3 = 'Hello! — Sent on behalf of Ademola (08108574293) via Forgelabs';
  const clean3 = sanitizeAssistantResponse(dirty3);
  assert(!clean3.includes('(08108574293)'), `Expected no phone number in attribution, got: ${clean3}`);
  assert(!clean3.includes('Sent on behalf of Ademola'), `Expected no creator attribution, got: ${clean3}`);
  assert.strictEqual(clean3, 'Hello!', `Expected clean message without attribution, got: ${clean3}`);

  console.log('✅ Test 5 Passed: All WID/wa.id leaks, JIDs, and creator attributions scrubbed.\n');

  // Test 6: LLM Client configuration
  console.log('▶ Test 6: Verify LLM Client Resilience Config...');
  assert.strictEqual(llmClient.getProvider(), 'gemini', 'LLM Provider should resolve to gemini');
  assert.strictEqual(llmClient.getModel(), 'gemini-flash-latest', 'Model should be gemini-flash-latest');
  console.log('✅ Test 6 Passed: LLM provider and model configured correctly.\n');

  // Test 7: Training Pipeline Distillation & Anti-Generic Guardrails
  console.log('▶ Test 7: Verify Training Pipeline Distillation & Anti-Generic Guardrails...');
  const { styleAdapter } = require('./dist/learning/style-adapter.js');
  const techCtx = styleAdapter.getStyleContext('test@s.whatsapp.net', 'How do I fix a bug in my typescript code?');
  assert(techCtx.fewShotExemplars.length > 0, 'Must retrieve few-shot exemplars');
  const hasTechExemplar = techCtx.fewShotExemplars.some(e => e.context.toLowerCase().includes('recursion') || e.context.toLowerCase().includes('async') || e.context.toLowerCase().includes('api'));
  assert(hasTechExemplar, 'Technical queries must match distilled technical/programming exemplars');

  // Sanitizer must strip generic preambles and generic closings
  const genericInput1 = 'Great question! An API is simply a bridge that lets two apps communicate. Hope this helps!';
  const sanitized1 = sanitizeAssistantResponse(genericInput1);
  assert(!sanitized1.toLowerCase().includes('great question'), 'Must strip Great question preamble');
  assert(!sanitized1.toLowerCase().includes('hope this helps'), 'Must strip Hope this helps closing');
  assert.strictEqual(sanitized1, 'An API is simply a bridge that lets two apps communicate.');

  const genericInput2 = 'Certainly! Here is an overview of how it works: You connect to the database directly.';
  const sanitized2 = sanitizeAssistantResponse(genericInput2);
  assert(!sanitized2.toLowerCase().includes('certainly'), 'Must strip Certainly preamble');
  assert(!sanitized2.toLowerCase().includes('overview of'), 'Must strip overview of preamble');
  assert.strictEqual(sanitized2, 'You connect to the database directly.');
  console.log('✅ Test 7 Passed: Training pipeline exemplars and anti-generic response distillation verified.\n');

  console.log('🎉 ALL 7 VERIFICATION TESTS PASSED SUCCESSFULLY! 🚀');
})();
