import { initDatabase, db, upsertKnownGroup, findKnownGroup, setGroupAdminStatus } from './dist/memory/db.js';
import { groupAdminPlugin } from './dist/plugins/group-admin/admin-plugin.js';
import { setupGroupWelcome } from './dist/plugins/group-admin/welcome.js';
import { pluginRegistry } from './dist/plugins/registry.js';
import { buildSystemPrompt } from './dist/agent/prompt.js';
import { chatLogger } from './dist/memory/chat-logger.js';

console.log('🧪 Testing Elevated Group Admin Privileges Suite...\n');

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

  const groupJid = '120363028392182910@g.us';
  const ownerJid = '2348108574293@s.whatsapp.net';
  const botJid = '2347058967815@s.whatsapp.net';
  const adminJid = '2348011112222@s.whatsapp.net';
  const regularUserJid = '2348099998888@s.whatsapp.net';
  const spammerJid = '2348077776666@s.whatsapp.net';

  // Seed known group in database
  upsertKnownGroup(groupJid, 'Dev & Banter Hub', 25, true);

  // Mock Baileys Socket
  let lastAction = null;
  let lastDeleteKey = null;
  let lastGroupSetting = null;
  let lastEphemeralSeconds = null;
  let lastSentMessage = null;

  const mockSock = {
    user: { id: `${botJid}:14`, lid: '2347058967815@lid' },
    groupMetadata: async (jid) => ({
      id: jid,
      subject: 'Dev & Banter Hub',
      creation: 1672531199,
      announce: false,
      restrict: false,
      ephemeralDuration: 0,
      desc: 'Official group for test & banters',
      participants: [
        { id: botJid, admin: 'admin' },
        { id: adminJid, admin: 'admin' },
        { id: ownerJid, admin: 'superadmin' },
        { id: regularUserJid, admin: null },
        { id: spammerJid, admin: null },
      ],
    }),
    groupParticipantsUpdate: async (jid, participants, action) => {
      lastAction = { jid, participants, action };
      return [{ status: '200', jid: participants[0] }];
    },
    groupSettingUpdate: async (jid, mode) => {
      lastGroupSetting = { jid, mode };
    },
    groupToggleEphemeral: async (jid, seconds) => {
      lastEphemeralSeconds = { jid, seconds };
    },
    groupInviteCode: async () => 'K7x9PqLmNoRtUv',
    groupRevokeInvite: async () => 'NewInviteCode99',
    groupRequestParticipantsList: async () => [
      { jid: '2348055554444@s.whatsapp.net' },
      { jid: '2348066665555@s.whatsapp.net' },
    ],
    groupRequestParticipantsUpdate: async (jid, participants, action) => {
      return participants.map((p) => ({ status: '200', jid: p }));
    },
    sendMessage: async (jid, content) => {
      if (content.delete) {
        lastDeleteKey = content.delete;
      } else {
        lastSentMessage = { jid, text: content.text };
      }
      return { key: { id: 'WA_SENT_1001', remoteJid: jid } };
    },
  };

  const adminCtx = {
    sock: mockSock,
    chatJid: groupJid,
    senderJid: adminJid,
    senderName: 'Group Admin',
    isGroup: true,
    rawMessage: null,
  };

  const ownerCtx = {
    ...adminCtx,
    senderJid: ownerJid,
    senderName: 'Ademola',
  };

  const nonAdminCtx = {
    ...adminCtx,
    senderJid: regularUserJid,
    senderName: 'Regular Guy',
  };

  // 1. Test isBotAdmin and isUserAdmin
  assert('isBotAdmin returns true when bot is admin in group', await groupAdminPlugin.isBotAdmin(mockSock, groupJid));
  assert('isUserAdmin returns true for Owner Ademola', await groupAdminPlugin.isUserAdmin(mockSock, groupJid, ownerJid));
  assert('isUserAdmin returns true for group admin', await groupAdminPlugin.isUserAdmin(mockSock, groupJid, adminJid));
  assert('isUserAdmin returns false for regular non-admin member', !(await groupAdminPlugin.isUserAdmin(mockSock, groupJid, regularUserJid)));

  // 2. Test add_member
  const addMemberTool = groupAdminPlugin.tools.find((t) => t.name === 'add_member');
  assert('add_member tool exists', Boolean(addMemberTool));

  const addResult = await addMemberTool.execute({ target: '+234 913 191 8009' }, adminCtx);
  assert('add_member succeeds when called by admin', addResult.success && addResult.message.includes('Successfully added'));
  assert('Baileys groupParticipantsUpdate called with action "add"', lastAction?.action === 'add' && lastAction?.participants[0] === '2349131918009@s.whatsapp.net');

  const addNonAdminResult = await addMemberTool.execute({ target: '+234 913 191 8009' }, nonAdminCtx);
  assert('add_member denies non-admin member', !addNonAdminResult.success && addNonAdminResult.message.includes('Permission denied'));

  // 3. Test delete_group_message (Admin Revoke)
  const delMsgTool = groupAdminPlugin.tools.find((t) => t.name === 'delete_group_message');
  assert('delete_group_message tool exists', Boolean(delMsgTool));

  // Test via quoted message stanzaId
  const quotedCtx = {
    ...adminCtx,
    rawMessage: {
      message: {
        extendedTextMessage: {
          contextInfo: {
            stanzaId: 'SPAM_STZ_777',
            participant: spammerJid,
          },
        },
      },
    },
  };
  const delQuotedResult = await delMsgTool.execute({ reason: 'spam link' }, quotedCtx);
  assert('delete_group_message deletes quoted message for everyone', delQuotedResult.success && delQuotedResult.message.includes('deleted for everyone'));
  assert('Baileys delete key remoteJid, id, and participant match', lastDeleteKey?.id === 'SPAM_STZ_777' && lastDeleteKey?.participant === spammerJid);

  // Test via chat_logs lookup
  chatLogger.logMessage({
    chatJid: groupJid,
    senderJid: spammerJid,
    senderName: 'Spam Bot',
    isGroup: true,
    contentType: 'text',
    messageText: 'Free Bitcoin scam at link',
    messageId: 'LOGGED_SPAM_ID_999',
    timestamp: Date.now(),
  });
  const delLookupResult = await delMsgTool.execute({ target: '2348077776666' }, adminCtx);
  assert('delete_group_message deletes recent message from target in chat_logs', delLookupResult.success);
  assert('Delete key matches logged message id', lastDeleteKey?.id === 'LOGGED_SPAM_ID_999');

  // 4. Test kick_member with guardrails
  const kickTool = groupAdminPlugin.tools.find((t) => t.name === 'kick_member');
  const kickOwnerResult = await kickTool.execute({ target: ownerJid }, adminCtx);
  assert('kick_member guardrail protects owner Ademola from being kicked', !kickOwnerResult.success && kickOwnerResult.message.includes('cannot kick my creator & owner Ademola'));

  const kickBotResult = await kickTool.execute({ target: botJid }, adminCtx);
  assert('kick_member guardrail protects bot from kicking itself', !kickBotResult.success && kickBotResult.message.includes('Why would I kick myself'));

  const kickSpammerResult = await kickTool.execute({ target: spammerJid, reason: 'unauthorized link' }, adminCtx);
  assert('kick_member successfully kicks spammer', kickSpammerResult.success && kickSpammerResult.message.includes('removed from the group'));
  assert('groupParticipantsUpdate called with "remove"', lastAction?.action === 'remove');

  // 5. Test promote_member and demote_member
  const promoteTool = groupAdminPlugin.tools.find((t) => t.name === 'promote_member');
  const demoteTool = groupAdminPlugin.tools.find((t) => t.name === 'demote_member');
  const demoteOwnerResult = await demoteTool.execute({ target: ownerJid }, adminCtx);
  assert('demote_member guardrail protects owner Ademola from being demoted', !demoteOwnerResult.success && demoteOwnerResult.message.includes('cannot demote Ademola'));

  await promoteTool.execute({ target: regularUserJid }, adminCtx);
  assert('promote_member calls action "promote"', lastAction?.action === 'promote');

  // 6. Test set_group_mode (announcement, not_announcement, locked, unlocked)
  const modeTool = groupAdminPlugin.tools.find((t) => t.name === 'set_group_mode');
  await modeTool.execute({ mode: 'announcement' }, adminCtx);
  assert('set_group_mode updates to announcement mode', lastGroupSetting?.mode === 'announcement');
  await modeTool.execute({ mode: 'locked' }, adminCtx);
  assert('set_group_mode updates to locked settings mode', lastGroupSetting?.mode === 'locked');

  // 7. Test set_disappearing_messages
  const ephemeralTool = groupAdminPlugin.tools.find((t) => t.name === 'set_disappearing_messages');
  const ephResult = await ephemeralTool.execute({ duration: '24h' }, adminCtx);
  assert('set_disappearing_messages sets 24 hours (86400s)', ephResult.success && lastEphemeralSeconds?.seconds === 86400);

  // 8. Test list_join_requests, approve_join_request, reject_join_request
  const listReqTool = groupAdminPlugin.tools.find((t) => t.name === 'list_join_requests');
  const approveReqTool = groupAdminPlugin.tools.find((t) => t.name === 'approve_join_request');
  const listReqResult = await listReqTool.execute({}, adminCtx);
  assert('list_join_requests finds pending requests', listReqResult.success && listReqResult.message.includes('Pending Join Requests (2)'));

  const approveResult = await approveReqTool.execute({ target: 'all' }, adminCtx);
  assert('approve_join_request approves all pending participants', approveResult.success && approveResult.message.includes('Approved 2'));

  // 9. Test get_group_info
  const infoTool = groupAdminPlugin.tools.find((t) => t.name === 'get_group_info');
  const infoResult = await infoTool.execute({}, adminCtx);
  assert('get_group_info returns metadata, member counts, and admin list', infoResult.success && infoResult.message.includes('GROUP DETAILS') && infoResult.message.includes('ACTIVE ADMIN'));

  // 10. Test handleAntiLink deletes link for non-admins
  const spamLinkMsg = {
    key: { id: 'SPAM_LINK_MSG_1', remoteJid: groupJid, fromMe: false },
  };
  lastDeleteKey = null;
  const linkHandled = await groupAdminPlugin.handleAntiLink(
    mockSock,
    spamLinkMsg,
    groupJid,
    spammerJid,
    'Join our free promo here: https://chat.whatsapp.com/JklMnoPqrStUvwXyz12345'
  );
  assert('handleAntiLink intercepts unauthorized link', linkHandled === true);
  assert('handleAntiLink issues delete stanza to revoke spam link', lastDeleteKey?.id === 'SPAM_LINK_MSG_1');

  // 11. Test prompt elevated status injection
  const promptAdmin = buildSystemPrompt(adminJid, groupJid, true, 'kick that guy');
  assert('System prompt injects ELEVATED STATUS when bot is group admin', promptAdmin.includes('ELEVATED STATUS: YOU ARE AN ACTIVE ADMIN IN THIS GROUP'));
  assert('System prompt lists all elevated tools', promptAdmin.includes('kick_member') && promptAdmin.includes('add_member') && promptAdmin.includes('delete_group_message') && promptAdmin.includes('set_disappearing_messages'));

  // 12. Test tool aliases in pluginRegistry
  await pluginRegistry.registerPlugin(groupAdminPlugin);
  const kickAliasResult = await pluginRegistry.executeTool('kick', { target: spammerJid }, adminCtx);
  assert('Alias "kick" maps to kick_member', kickAliasResult.success);

  const addAliasResult = await pluginRegistry.executeTool('add_participant', { target: '+234 913 191 8009' }, adminCtx);
  assert('Alias "add_participant" maps to add_member', addAliasResult.success);

  const delAliasResult = await pluginRegistry.executeTool('delete_message', { reason: 'spam' }, quotedCtx);
  assert('Alias "delete_message" maps to delete_group_message', delAliasResult.success);

  const lockAliasResult = await pluginRegistry.executeTool('lock_group', { mode: 'announcement' }, adminCtx);
  assert('Alias "lock_group" maps to set_group_mode', lockAliasResult.success);

  const infoAliasResult = await pluginRegistry.executeTool('group_info', {}, adminCtx);
  assert('Alias "group_info" maps to get_group_info', infoAliasResult.success);

  console.log(`\n🎉 Results: ${passed}/${total} elevated group admin tests passed!`);
  process.exit(passed === total ? 0 : 1);
}

run().catch((err) => {
  console.error('Test suite failed:', err);
  process.exit(1);
});
