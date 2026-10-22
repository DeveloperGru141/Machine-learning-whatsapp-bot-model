const assert = require('assert');
const { sanitizeAssistantResponse } = require('./dist/agent/harness.js');
const { shouldRespondToMessage } = require('./dist/core/filter.js');

console.log('🧪 Starting Thought Leakage & Mass Broadcast Protection Test Suite...\n');

// ---------------------------------------------------------
// Test 1: The exact user incident (Huawei flyer context leak)
// ---------------------------------------------------------
console.log('▶ Test 1: Verify exact Huawei flyer context leak is sanitized...');
const userIncidentText = 'The context is a group chat where "Ohms hub" shared a Huawei ICT Roadshow flyer and asked people to react if they shared it, and to help trend it. Someone (Crediblefx) just dropped a "?" and Ohms hub said "If you\'re not trending, you\'re wrong." Then OMOTAYO tagged @all';
const sanitizedIncident = sanitizeAssistantResponse(userIncidentText);
assert.strictEqual(sanitizedIncident, '', `Expected empty string for pure meta-reasoning thought leak, got: "${sanitizedIncident}"`);
console.log('✅ Test 1 Passed: Exact user incident thought leak stripped completely.\n');

// ---------------------------------------------------------
// Test 2: Thought tags (<think>, <thought>, [THOUGHT], unclosed tags)
// ---------------------------------------------------------
console.log('▶ Test 2: Verify closed and unclosed thought/scratchpad tags...');
const closedThink = '<think>I should speak casually and use Nigerian pidgin.</think>How far my guy!';
assert.strictEqual(sanitizeAssistantResponse(closedThink), 'How far my guy!');

const closedThought = '<thought>User is greeting me.</thought>Wetin dey happen! 🤝';
assert.strictEqual(sanitizeAssistantResponse(closedThought), 'Wetin dey happen! 🤝');

const bracketThought = '[THOUGHT]Step 1: greet user.[/THOUGHT]Hello! No wahala.';
assert.strictEqual(sanitizeAssistantResponse(bracketThought), 'Hello! No wahala.');

const unclosedThink = '<think>The context is a group discussion about crypto and trading... (truncated due to token limit)';
assert.strictEqual(sanitizeAssistantResponse(unclosedThink), '', 'Unclosed <think> tag must strip everything');

console.log('✅ Test 2 Passed: All thought tags (closed, unclosed, XML, brackets) sanitized cleanly.\n');

// ---------------------------------------------------------
// Test 3: Thinking Process / Thought headers
// ---------------------------------------------------------
console.log('▶ Test 3: Verify Thinking Process / Analysis headers...');
const thinkingProcess = 'Thinking Process: The user wants to know if the bot is online.\n\nI dey active steady! 🤝';
assert.strictEqual(sanitizeAssistantResponse(thinkingProcess), 'I dey active steady! 🤝');

const thoughtHeader = 'Thought: Need to respond in 1 sentence.\n\nEverything set sharp sharp!';
assert.strictEqual(sanitizeAssistantResponse(thoughtHeader), 'Everything set sharp sharp!');

console.log('✅ Test 3 Passed: Thought and analysis headers stripped.\n');

// ---------------------------------------------------------
// Test 4: Multi-paragraph output with meta-reasoning + real response
// ---------------------------------------------------------
console.log('▶ Test 4: Verify multi-paragraph meta-reasoning peeling...');
const mixedOutput = `The context is a group chat where Ohms hub shared a flyer about Huawei.

Omo that Huawei roadshow go make sense! Anyone planning to attend? 🔥`;
const sanitizedMixed = sanitizeAssistantResponse(mixedOutput);
assert(!sanitizedMixed.toLowerCase().includes('the context is'), 'Must strip the context analysis paragraph');
assert(sanitizedMixed.includes('Omo that Huawei roadshow go make sense!'), 'Must preserve the actual chat reply');

const mixedOutput2 = `Based on the chat history, someone asked if we can do 5pm.

5pm works fine for me, let's meet up then!`;
const sanitizedMixed2 = sanitizeAssistantResponse(mixedOutput2);
assert(!sanitizedMixed2.toLowerCase().includes('based on the chat history'), 'Must strip based on chat history');
assert(sanitizedMixed2.includes('5pm works fine for me'), 'Must preserve actual reply');

console.log('✅ Test 4 Passed: Meta-reasoning paragraphs peeled while keeping real replies.\n');

// ---------------------------------------------------------
// Test 5: Group mention & direct trigger filtering
// ---------------------------------------------------------
console.log('▶ Test 5: Verify group mention & direct trigger filtering...');
const botJid = '2347058967815@s.whatsapp.net';
const groupJid = '120363028392182910@g.us';

// Scenario A: Someone types "@all" and tags members including the bot
const massAllMsg = {
  key: { remoteJid: groupJid, fromMe: false },
  message: {
    extendedTextMessage: {
      text: '@all',
      contextInfo: {
        mentionedJid: [
          botJid,
          '2348011111111@s.whatsapp.net',
          '2348022222222@s.whatsapp.net',
        ],
      },
    },
  },
};
const resA = shouldRespondToMessage(massAllMsg, botJid, '@all');
assert.strictEqual(resA.shouldRespond, true, 'Bot should respond when tagged in group (including @all)');

// Scenario B: Someone talks in group without mentioning or naming the bot
const unmentionedMsg = {
  key: { remoteJid: groupJid, fromMe: false },
  message: {
    extendedTextMessage: {
      text: 'meeting in 10 mins',
      contextInfo: {
        mentionedJid: ['2348011111111@s.whatsapp.net'],
      },
    },
  },
};
const resB = shouldRespondToMessage(unmentionedMsg, botJid, 'meeting in 10 mins');
assert.strictEqual(resB.shouldRespond, false, 'Bot should NOT respond when unmentioned in group');

// Scenario C: Someone specifically names the bot in the text: "@all @forgelabs what time is it?"
const namedInAllMsg = {
  key: { remoteJid: groupJid, fromMe: false },
  message: {
    extendedTextMessage: {
      text: '@all @forgelabs what time is it?',
      contextInfo: {
        mentionedJid: [botJid, '2348011111111@s.whatsapp.net'],
      },
    },
  },
};
const resC = shouldRespondToMessage(namedInAllMsg, botJid, '@all @forgelabs what time is it?');
assert.strictEqual(resC.shouldRespond, true, 'Bot SHOULD respond when specifically named in group');

// Scenario D: Normal direct mention to bot only
const directMentionMsg = {
  key: { remoteJid: groupJid, fromMe: false },
  message: {
    extendedTextMessage: {
      text: '@2347058967815 how far?',
      contextInfo: {
        mentionedJid: [botJid],
      },
    },
  },
};
const resD = shouldRespondToMessage(directMentionMsg, botJid, '@2347058967815 how far?');
assert.strictEqual(resD.shouldRespond, true, 'Bot SHOULD respond to normal targeted @mention');

console.log('✅ Test 5 Passed: Group mention and direct trigger filtering verified.\n');

console.log('🎉 ALL 5 THOUGHT LEAKAGE & MASS BROADCAST TESTS PASSED SUCCESSFULLY! 🚀');
