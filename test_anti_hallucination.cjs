const assert = require('assert');
const { agentHarness } = require('./dist/agent/harness.js');
const { pluginRegistry } = require('./dist/plugins/registry.js');
const { contactPlugin } = require('./dist/plugins/contact/contact-plugin.js');
const { llmClient } = require('./dist/agent/llm-client.js');

async function runTest() {
  console.log('🧪 Testing Anti-Hallucination Messaging Interceptors...');
  await pluginRegistry.registerPlugin(contactPlugin);

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

  // Case 1: Model hallucinates sending a message when a phone number was mentioned
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

    // Verify Case 1: The harness should intercept the hallucination, execute send_message_to_contact, and send real WhatsApp message!
    const sendCalls = mockReplies.filter((r) => r.type === 'sendMessage');
    assert.strictEqual(sendCalls.length, 1, 'Should have executed real WhatsApp message to recipient');
    assert(sendCalls[0].jid.includes('2348123456789'), 'Target JID should be formatted phone');
    const replyCalls = mockReplies.filter((r) => r.type === 'replyText');
    assert(replyCalls[0].text.includes('Delivery confirmed'), 'Reply should confirm real delivery');
    console.log('✅ Case 1 Passed: Intercepted hallucinated text and executed real WhatsApp message to phone number!');

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

    // Verify Case 2: The harness should catch the hallucination and ask for the phone number!
    const sendCalls2 = mockReplies.filter((r) => r.type === 'sendMessage');
    assert.strictEqual(sendCalls2.length, 0, 'Should NOT send any real message without phone');
    const replyCalls2 = mockReplies.filter((r) => r.type === 'replyText');
    assert(replyCalls2[0].text.includes("need the recipient's phone number"), 'Reply should ask for phone number');
    console.log('✅ Case 2 Passed: Intercepted hallucinated text without phone and prompted user for number!');
    
    console.log('🎉 ALL ANTI-HALLUCINATION TESTS PASSED 100%!');
  } finally {
    llmClient.chatCompletion = origChatCompletion;
  }
}

runTest().catch((err) => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
