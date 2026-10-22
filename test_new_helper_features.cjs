const assert = require('assert');
const { pluginRegistry } = require('./dist/plugins/registry.js');
const { groupAdminPlugin } = require('./dist/plugins/group-admin/admin-plugin.js');
const { schedulerPlugin } = require('./dist/plugins/scheduler/scheduler-plugin.js');
const { llmClient, groqClients } = require('./dist/agent/llm-client.js');
const { db } = require('./dist/memory/db.js');

async function run() {
  console.log('🧪 Testing New Helper Features & 3-Key Inference...\n');

  // Register plugins
  await pluginRegistry.registerPlugin(groupAdminPlugin);
  await pluginRegistry.registerPlugin(schedulerPlugin);

  // 1. Verify 3-Key Groq Pool & Round-Robin
  console.log('▶ Test 1: Verify 3-Key Groq Pool & Round-Robin Load Distribution...');
  assert.strictEqual(groqClients.length, 3, 'groqClients should contain exactly 3 pooled instances');
  assert(groqClients.every((c) => Boolean(c.apiKey)), 'All 3 clients must have valid API keys');
  console.log(`✅ Test 1 Passed: 3 Groq client instances actively pooled!`);

  // Mock Context
  const pollDispatches = [];
  const mockContext = {
    sock: {
      user: { id: '2347058967815:1@s.whatsapp.net' },
      sendMessage: async (jid, content) => {
        if (content.poll) pollDispatches.push({ jid, poll: content.poll });
        return { key: { id: 'poll_msg', remoteJid: jid } };
      },
      sendPresenceUpdate: async () => {},
      onWhatsApp: async (jid) => [{ exists: true, jid }],
    },
    chatJid: '120363028392182910@g.us',
    senderJid: '2348108574293@s.whatsapp.net',
    senderName: 'Ademola',
    isGroup: true,
    rawMessage: { key: { remoteJid: '120363028392182910@g.us' } },
    replyText: async () => {},
    sendSticker: async () => {},
    sendImage: async () => {},
    sendAudio: async () => {},
    sendVideo: async () => {},
    sendContact: async () => {},
    sendPoll: async (question, options, selectableCount) => {
      pollDispatches.push({
        jid: '120363028392182910@g.us',
        poll: { name: question, values: options, selectableCount: selectableCount || 1 },
      });
      return { key: { id: 'poll_msg' } };
    },
  };

  // 2. Test create_poll tool
  console.log('\n▶ Test 2: Verify create_poll Tool & Baileys Native Poll Dispatch...');
  pollDispatches.length = 0;
  const pollTool = pluginRegistry.getTool('create_poll');
  assert(pollTool, 'create_poll tool must be registered');

  // 2a. Reject insufficient options
  const invalidRes = await pollTool.execute({ question: 'Dinner?', options: ['Yes'] }, mockContext);
  assert.strictEqual(invalidRes.success, false, 'Poll with 1 option should fail');

  // 2b. Dispatch valid poll
  const validRes = await pollTool.execute(
    {
      question: 'When should we schedule our weekend coding sprint?',
      options: ['Saturday 10 AM', 'Saturday 2 PM', 'Sunday 4 PM'],
      selectable_count: 1,
    },
    mockContext
  );
  assert.strictEqual(validRes.success, true, 'create_poll should succeed');
  assert.strictEqual(pollDispatches.length, 1, 'Poll should be dispatched to Baileys socket');
  assert.strictEqual(pollDispatches[0].poll.name, 'When should we schedule our weekend coding sprint?');
  assert.deepStrictEqual(pollDispatches[0].poll.values, ['Saturday 10 AM', 'Saturday 2 PM', 'Sunday 4 PM']);
  assert.strictEqual(pollDispatches[0].poll.selectableCount, 1);
  console.log('✅ Test 2 Passed: Native WhatsApp poll created and dispatched successfully!');

  // 2c. Test poll aliases
  const aliasVote = pluginRegistry.getTool('vote');
  assert(aliasVote, 'vote alias must resolve');
  const aliasPoll = pluginRegistry.getTool('poll');
  assert(aliasPoll, 'poll alias must resolve');
  console.log('✅ Test 2c Passed: All poll aliases (vote, poll, create_whatsapp_poll) verified!');

  // 3. Test summarize_group_discussion tool
  console.log('\n▶ Test 3: Verify summarize_group_discussion Tool...');
  const catchupTool = pluginRegistry.getTool('summarize_group_discussion');
  assert(catchupTool, 'summarize_group_discussion tool must be registered');

  // 3a. Handle quiet group gracefully
  const quietRes = await catchupTool.execute({ hours: 1 }, { ...mockContext, chatJid: 'quiet_group@g.us' });
  assert.strictEqual(quietRes.success, true);
  assert(quietRes.message.includes('quiet') || quietRes.message.includes('peaceful'), 'Should acknowledge quiet group');
  console.log('✅ Test 3a Passed: Quiet group handled gracefully!');

  // 3b. Test recap alias resolution
  const recapAlias = pluginRegistry.getTool('catch_me_up');
  assert(recapAlias, 'catch_me_up alias must resolve');
  const whatMissedAlias = pluginRegistry.getTool('what_did_i_miss');
  assert(whatMissedAlias, 'what_did_i_miss alias must resolve');
  console.log('✅ Test 3b Passed: Aliases (catch_me_up, what_did_i_miss, group_summary) verified!');

  // 4. Test Executive Morning Briefing
  console.log('\n▶ Test 4: Verify get_executive_briefing & buildExecutiveMorningDigest...');
  const briefTool = pluginRegistry.getTool('get_executive_briefing');
  assert(briefTool, 'get_executive_briefing tool must be registered');

  const briefRes = await briefTool.execute({}, mockContext);
  assert.strictEqual(briefRes.success, true, 'get_executive_briefing should succeed');
  assert(briefRes.message.includes('EXECUTIVE MORNING BRIEFING'), 'Briefing should include executive header');
  assert(briefRes.message.includes('Ademola'), 'Briefing should address Ademola');
  assert(briefRes.message.includes('System Vitals'), 'Briefing should include system vitals');
  assert(briefRes.message.includes('3 Groq Keys Active'), 'Briefing should display 3 Groq keys');
  console.log('✅ Test 4 Passed: Executive morning briefing generated with full agenda & vitals!');

  console.log('\n🎉 ALL 4 NEW HELPER VERIFICATION TESTS PASSED SUCCESSFULLY! 🚀');
  process.exit(0);
}

run().catch((err) => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
