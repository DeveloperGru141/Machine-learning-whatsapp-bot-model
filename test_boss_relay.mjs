import { initDatabase, db } from './dist/memory/db.js';
import { contactService } from './dist/memory/contact-service.js';
import { contactPlugin } from './dist/plugins/contact/contact-plugin.js';
import { buildSystemPrompt } from './dist/agent/prompt.js';

console.log('🧪 Testing Boss Recognition & Messaging Relay...\n');

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
  await initDatabase();

  // 1. Check getContact for boss keywords
  const bossContact = await contactService.getContact('boss');
  assert('contactService.getContact("boss") returns Ademola', bossContact?.phone_number === '2348108574293', `Got: ${JSON.stringify(bossContact)}`);
  assert('contactService.getContact("boss") is NOT Crypto Boss', bossContact?.display_name !== 'Crypto Boss😊' && bossContact?.phone_number !== '2348129109255');

  const yourBossContact = await contactService.getContact('your boss');
  assert('contactService.getContact("your boss") returns Ademola', yourBossContact?.phone_number === '2348108574293');

  const creatorContact = await contactService.getContact('creator');
  assert('contactService.getContact("creator") returns Ademola', creatorContact?.phone_number === '2348108574293');

  // 2. Test get_contact tool for non-owner
  const getContactTool = contactPlugin.tools.find(t => t.name === 'get_contact');
  const mockCtxNonOwner = {
    senderJid: '2348161220611@s.whatsapp.net',
    senderName: 'TestUser',
    chatJid: '120363028392182910@g.us',
    isGroup: true,
    sock: null,
  };

  const getBossResult = await getContactTool.execute({ query: 'boss' }, mockCtxNonOwner);
  assert('get_contact identifies Ademola when a non-owner searches for boss', getBossResult.success && getBossResult.message.includes('Ademola'));
  assert('get_contact does not disclose either private phone number', !getBossResult.message.includes('+2348108574293') && !getBossResult.message.includes('Crypto Boss') && !getBossResult.message.includes('2348129109255'));

  // 3. Test send_message_to_contact tool with mock socket
  let interceptedTargetJid = '';
  let interceptedMessage = '';
  const mockSock = {
    sendMessage: async (jid, content) => {
      interceptedTargetJid = jid;
      interceptedMessage = content.text || '';
      return { key: { id: 'MOCK_MSG_ID_123' } };
    },
    onWhatsApp: async (num) => [{ jid: `${num}@s.whatsapp.net`, exists: true }],
    sendPresenceUpdate: async () => {},
  };

  const sendMsgTool = contactPlugin.tools.find(t => t.name === 'send_message_to_contact');
  const sendBossResult = await sendMsgTool.execute(
    { recipient: 'boss', message: 'Good afternoon boss Ademola' },
    { ...mockCtxNonOwner, chatJid: '2348161220611@s.whatsapp.net', isGroup: false, sock: mockSock }
  );

  assert('send_message_to_contact succeeds for recipient: "boss"', sendBossResult.success, `Result: ${JSON.stringify(sendBossResult)}`);
  assert('Target JID is Ademola (2348108574293@s.whatsapp.net)', interceptedTargetJid === '2348108574293@s.whatsapp.net', `Got: ${interceptedTargetJid}`);
  assert('Message includes sender attribution relay', interceptedMessage.includes('Message for Boss from') && interceptedMessage.includes('Good afternoon boss Ademola'), `Message: ${interceptedMessage}`);
  assert('Message does NOT ask user for phone number', !sendBossResult.message.includes('Please provide their phone number'));

  // 4. Test "tell your boss" query
  const tellBossResult = await sendMsgTool.execute(
    { recipient: 'your boss', message: 'The server is running smoothly' },
    { ...mockCtxNonOwner, chatJid: '2348161220611@s.whatsapp.net', isGroup: false, sock: mockSock }
  );
  assert('send_message_to_contact succeeds for recipient: "your boss"', tellBossResult.success);
  assert('Target JID for "your boss" is Ademola', interceptedTargetJid === '2348108574293@s.whatsapp.net');

  // 5. Test system prompt instructions
  const prompt = await buildSystemPrompt('2348161220611@s.whatsapp.net', '120363028392182910@g.us', true, 'tell your boss hello');
  assert('Prompt contains Boss messaging instructions', prompt.includes('MESSAGING YOUR BOSS / CREATOR / OWNER (ADEMOLA)'));
  assert('Prompt instructs never to ask for boss phone number', prompt.toLowerCase().includes("never ask for the owner's phone number"));
  assert('Prompt instructs never to match Crypto Boss', prompt.toLowerCase().includes('never match or display "crypto boss"'));
  assert('Prompt contains rule 17 for Boss recognition', prompt.includes('17. RECOGNIZE BOSS & INSTANT RELAY'));

  console.log(`\nResults: ${passed}/${total} tests passed!`);
  process.exit(passed === total ? 0 : 1);
}

run().catch(err => {
  console.error('Test execution failed:', err);
  process.exit(1);
});
