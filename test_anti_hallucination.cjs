const assert = require('assert');
const { agentHarness, extractInlineToolCalls } = require('./dist/agent/harness.js');
const { pluginRegistry } = require('./dist/plugins/registry.js');
const { contactPlugin } = require('./dist/plugins/contact/contact-plugin.js');
const { llmClient } = require('./dist/agent/llm-client.js');
const { assertPublicHttpUrl } = require('./dist/security/url-policy.js');
const { userProfileManager } = require('./dist/memory/user-profiles.js');

async function runTest() {
  console.log('🧪 Testing tool-call authorization and outbound-message guardrails...');
  await pluginRegistry.registerPlugin(contactPlugin);

  const embeddedExample = extractInlineToolCalls(
    'Example only: {"name":"send_message_to_contact","arguments":{"recipient":"08012345678","message":"hi"}}'
  );
  assert.strictEqual(embeddedExample.toolCalls.length, 0, 'Tool JSON inside prose must not execute as a call');
  const standaloneCall = extractInlineToolCalls('{"name":"get_bot_health_status","arguments":{}}');
  assert.strictEqual(standaloneCall.toolCalls.length, 1, 'Standalone JSON tool calls should remain supported');
  assert.strictEqual(userProfileManager.isOwner('9991234567890@s.whatsapp.net', 'Hardezmorlar'), false, 'A display name must not grant owner privileges');
  assert.strictEqual(userProfileManager.isOwner('08108574293@s.whatsapp.net', 'Untrusted Name'), true, 'Configured owner identifiers must retain owner privileges');
  await assert.rejects(assertPublicHttpUrl('http://127.0.0.1/'), 'Private IPv4 targets must be rejected');
  await assert.rejects(assertPublicHttpUrl('http://[::1]/'), 'Private IPv6 targets must be rejected');
  await assert.rejects(assertPublicHttpUrl('https://user:secret@example.com/'), 'Credential-bearing URLs must be rejected');

  const mockReplies = [];
  const mockContext = {
    sock: {
      user: { id: '2347058967815:1@s.whatsapp.net' },
      sendMessage: async (jid, content) => {
        mockReplies.push({ type: 'sendMessage', jid, content });
        return { key: { id: 'test_msg_id', remoteJid: jid } };
      },
      sendPresenceUpdate: async () => {},
      onWhatsApp: async (jid) => [{ exists: true, jid }],
    },
    chatJid: '2348108574293@s.whatsapp.net',
    senderJid: '2348108574293@s.whatsapp.net',
    senderName: 'Ademola',
    isGroup: false,
    rawMessage: { key: { remoteJid: '2348108574293@s.whatsapp.net' } },
    replyText: async (text) => {
      mockReplies.push({ type: 'replyText', text });
      return { key: { id: 'reply_id' } };
    },
    sendSticker: async () => {},
    sendImage: async () => {},
    sendAudio: async () => {},
    sendVideo: async () => {},
    sendContact: async () => {},
  };

  // Case 1: A hallucinated send claim must never be turned into a real send.
  // Save original chatCompletion
  const origChatCompletion = llmClient.chatCompletion.bind(llmClient);
  
  try {
    // Force model to return a hallucinated text response without tool_calls
    llmClient.chatCompletion = async () => ({
      choices: [
        {
          message: {
            role: 'assistant',
            content: "I've sent the message to 08123456789 saying I'll be there soon!",
          },
          finish_reason: 'stop',
        },
      ],
    });

    mockReplies.length = 0;
    await agentHarness.handleMessage("tell 08123456789 that I'll be there soon", mockContext);

    // Verify Case 1: the harness corrects the claim without inferring a recipient or message.
    const sendCalls = mockReplies.filter((r) => r.type === 'sendMessage');
    assert.strictEqual(sendCalls.length, 0, 'A hallucinated send claim must not dispatch a message');
    const replyCalls = mockReplies.filter((r) => r.type === 'replyText');
    assert(replyCalls[0].text.includes("I haven't sent that message"), 'Reply must correct the false send claim');
    console.log('✅ Case 1 Passed: Hallucinated send claims are corrected without dispatch.');

    // Case 2: Model hallucinates sending a message when NO phone number was provided
    llmClient.chatCompletion = async () => ({
      choices: [
        {
          message: {
            role: 'assistant',
            content: "I have messaged John that you are coming!",
          },
          finish_reason: 'stop',
        },
      ],
    });

    mockReplies.length = 0;
    await agentHarness.handleMessage("message John that I am coming", mockContext);

    // Verify Case 2: the harness does not treat the claim as proof of a successful send.
    const sendCalls2 = mockReplies.filter((r) => r.type === 'sendMessage');
    assert.strictEqual(sendCalls2.length, 0, 'Should NOT send any real message without phone');
    const replyCalls2 = mockReplies.filter((r) => r.type === 'replyText');
    assert(replyCalls2[0].text.includes("I haven't sent that message"), 'Reply must correct the false send claim');
    console.log('✅ Case 2 Passed: False send claims without a recipient are corrected.');

    let hiddenToolExecutions = 0;
    await pluginRegistry.registerPlugin({
      name: 'HarnessGuardrailTest',
      version: '1.0.0',
      description: 'Test-only tool for verifying the harness allowlist.',
      tools: [{
        name: 'hidden_side_effect',
        description: 'Test-only hidden tool.',
        parameters: { type: 'object', properties: {}, required: [] },
        execute: async () => {
          hiddenToolExecutions++;
          return { success: true, message: 'executed' };
        },
      }],
    });

    let llmCallCount = 0;
    llmClient.chatCompletion = async () => {
      llmCallCount++;
      if (llmCallCount === 1) {
        return {
          choices: [{
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [{ type: 'function', function: { name: 'hidden_side_effect', arguments: '{}' } }],
            },
          }],
        };
      }
      return { choices: [{ message: { role: 'assistant', content: 'That action is unavailable here.' } }] };
    };
    mockReplies.length = 0;
    await agentHarness.handleMessage('hello there', mockContext);
    assert.strictEqual(hiddenToolExecutions, 0, 'A model-emitted tool absent from this turn must not execute');
    console.log('✅ Case 3 Passed: The harness blocks tools absent from the request allowlist.');

    const invalidArgs = await pluginRegistry.executeTool('hidden_side_effect', null, mockContext);
    assert.strictEqual(invalidArgs.success, false, 'The registry must reject non-object arguments');
    assert.strictEqual(hiddenToolExecutions, 0, 'Invalid arguments must not reach tool handlers');
    console.log('✅ Case 4 Passed: The registry rejects malformed arguments.');
    
    console.log('🎉 All tool-call guardrail tests passed.');
  } finally {
    llmClient.chatCompletion = origChatCompletion;
  }
}

runTest().catch((err) => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
