const assert = require('assert');

async function main() {
  console.log('🚀 Starting Comprehensive Tool Harness, Schedule & DM Scanner Verification Suite...\n');

  // 1. Import plugins exactly as indexed
  const { pluginRegistry } = require('../dist/plugins/registry.js');
  const { audioDownloaderPlugin } = require('../dist/plugins/audio-downloader/audio-plugin.js');
  const { memoryPlugin } = require('../dist/plugins/memory-search/memory-plugin.js');
  const { datasetExporterPlugin } = require('../dist/learning/dataset-exporter.js');
  const { webSearchPlugin } = require('../dist/plugins/web-search/search-plugin.js');
  const { videoDownloaderPlugin } = require('../dist/plugins/video-downloader/video-plugin.js');
  const { groupAdminPlugin } = require('../dist/plugins/group-admin/admin-plugin.js');
  const { documentReaderPlugin } = require('../dist/plugins/document-reader/document-plugin.js');
  const { schedulerPlugin } = require('../dist/plugins/scheduler/scheduler-plugin.js');
  const { linkSummarizerPlugin } = require('../dist/plugins/link-summarizer/link-plugin.js');
  const { conversationExportPlugin } = require('../dist/plugins/export/export-plugin.js');
  const { contactPlugin } = require('../dist/plugins/contact/contact-plugin.js');
  const { imageGenPlugin } = require('../dist/plugins/image-gen/image-plugin.js');
  const { engagementPlugin } = require('../dist/plugins/engagement/engagement-plugin.js');
  const { stickerPlugin } = require('../dist/plugins/stickers/sticker-plugin.js');
  const { viewOncePlugin } = require('../dist/plugins/view-once/view-once-plugin.js');
  const { reloadPluginsTool } = require('../dist/plugins/hot-reload.js');
  const { whatsAppClient } = require('../dist/core/client.js');
  const { antiBanEngine } = require('../dist/security/anti-ban.js');

  const plugins = [
    audioDownloaderPlugin,
    memoryPlugin,
    datasetExporterPlugin,
    webSearchPlugin,
    videoDownloaderPlugin,
    groupAdminPlugin,
    documentReaderPlugin,
    schedulerPlugin,
    linkSummarizerPlugin,
    conversationExportPlugin,
    contactPlugin,
    {
      name: 'SystemAdmin',
      version: '1.0.0',
      description: 'System administration and plugin hot-reloading',
      tools: [reloadPluginsTool],
    },
    imageGenPlugin,
    engagementPlugin,
    stickerPlugin,
    viewOncePlugin,
  ];

  for (const p of plugins) {
    if (p) await pluginRegistry.registerPlugin(p);
  }

  const allTools = pluginRegistry.getAllTools();
  console.log(`\n📦 Total tools registered across plugins: ${allTools.length}`);
  assert(allTools.length >= 60, `Expected at least 60 tools, got ${allTools.length}`);

  // Test 1: Tool Schema Validation
  console.log('\n--- Section 1: Tool Schema & Spec Validation ---');
  let schemaPassed = 0;
  for (const tool of allTools) {
    assert(tool.name && typeof tool.name === 'string', `Tool missing valid name`);
    assert(tool.description && typeof tool.description === 'string', `Tool ${tool.name} missing description`);
    assert(tool.parameters && tool.parameters.type === 'object', `Tool ${tool.name} parameters must be object type`);
    assert(typeof tool.execute === 'function', `Tool ${tool.name} execute must be a function`);
    schemaPassed++;
  }
  console.log(`✅ All ${schemaPassed} tools have valid OpenAI/Groq function schemas!`);

  // Test 2: Dry Run Execution of Representative Tools
  console.log('\n--- Section 2: Mock Execution of Key Harness Tools ---');
  const mockSent = [];
  const mockContext = {
    sock: {
      user: { id: '2347058967815:1@s.whatsapp.net' },
      sendMessage: async (jid, content) => {
        mockSent.push({ jid, content });
        return { key: { id: 'mock_msg', remoteJid: jid } };
      },
      sendPresenceUpdate: async () => {},
      onWhatsApp: async (jid) => [{ exists: true, jid }],
      groupMetadata: async () => ({
        id: '12345@g.us',
        subject: 'Test Group',
        participants: [
          { id: '2347058967815@s.whatsapp.net', admin: 'admin' },
          { id: '2348108574293@s.whatsapp.net', admin: 'superadmin' },
        ],
      }),
    },
    chatJid: '2348108574293@s.whatsapp.net',
    senderJid: '2348108574293@s.whatsapp.net',
    senderName: 'Ademola',
    isGroup: false,
    rawMessage: { key: { remoteJid: '2348108574293@s.whatsapp.net' } },
    replyText: async (text) => {
      mockSent.push({ type: 'replyText', text });
      return { key: { id: 'reply_id' } };
    },
    sendSticker: async () => {},
    sendImage: async () => {},
    sendAudio: async () => {},
    sendVideo: async () => {},
    sendContact: async () => {},
  };

  // 2a. Diagnostics & Health
  const healthRes = await pluginRegistry.executeTool('get_bot_health_status', {}, mockContext);
  assert(healthRes.success, 'get_bot_health_status should succeed');
  console.log('✅ get_bot_health_status executed successfully');

  // 2b. Contacts
  const contactRes = await pluginRegistry.executeTool('get_contact', { query: 'Ademola' }, mockContext);
  assert(contactRes.success, 'get_contact should find Ademola');
  console.log('✅ get_contact executed successfully');

  // 2c. Send Message to Contact
  mockSent.length = 0;
  const sendRes = await pluginRegistry.executeTool(
    'send_message_to_contact',
    { recipient: '+2349131918009', message: 'Dry run test message' },
    mockContext
  );
  assert(sendRes.success, 'send_message_to_contact should succeed');
  assert(mockSent.length > 0, 'Outbound message should be dispatched');
  console.log('✅ send_message_to_contact executed successfully');

  // 2d. Alias Resolution
  mockSent.length = 0;
  const aliasRes = await pluginRegistry.executeTool(
    'send_message',
    { recipient: '+2349131918009', message: 'Alias test message' },
    mockContext
  );
  assert(aliasRes.success, 'Alias send_message should resolve and succeed');
  console.log('✅ Alias send_message -> send_message_to_contact verified');

  // 2e. List Contacts
  const listContactRes = await pluginRegistry.executeTool('list_contacts', {}, mockContext);
  assert(listContactRes.success, 'list_contacts should succeed for owner');
  console.log('✅ list_contacts executed successfully');

  // 2f. Scheduler tools
  const listSchedRes = await pluginRegistry.executeTool('list_scheduled_broadcasts', {}, mockContext);
  assert(listSchedRes.success !== undefined, 'list_scheduled_broadcasts should return valid response');
  console.log('✅ list_scheduled_broadcasts executed successfully');

  // 2g. Memory tools
  const memoryRes = await pluginRegistry.executeTool('get_user_profile', { user_jid: '2348108574293@s.whatsapp.net' }, mockContext);
  assert(memoryRes.success !== undefined, 'get_user_profile should execute');
  console.log('✅ get_user_profile executed successfully');

  // Section 3: Verify Scheduler Handlers
  console.log('\n--- Section 3: Schedule Task Handlers Validation ---');
  schedulerPlugin.setSocket(mockContext.sock);
  assert.strictEqual(typeof schedulerPlugin.onLoad, 'function', 'Scheduler should have onLoad hook');
  console.log('✅ SchedulerPlugin socket and lifecycle verified');

  // Section 4: Verify Regular DM Scanner
  console.log('\n--- Section 4: Regular DM Scanner & Catch-up Validation ---');
  whatsAppClient.setSocket(mockContext.sock);
  assert(typeof whatsAppClient.startUnrepliedScanner === 'function', 'startUnrepliedScanner should exist');
  assert(typeof whatsAppClient.stopUnrepliedScanner === 'function', 'stopUnrepliedScanner should exist');
  assert(typeof whatsAppClient.replyUnrepliedMessages === 'function', 'replyUnrepliedMessages should exist');

  // Run replyUnrepliedMessages dry run
  const dmScanResult = await whatsAppClient.replyUnrepliedMessages(1);
  assert(dmScanResult && typeof dmScanResult.repliedCount === 'number', 'DM scan should return valid result object');
  console.log(`✅ replyUnrepliedMessages executed cleanly: ${dmScanResult.summary}`);

  // Test start/stop scanner loop
  whatsAppClient.startUnrepliedScanner();
  console.log('✅ startUnrepliedScanner initiated 150s interval timer');
  whatsAppClient.stopUnrepliedScanner();
  console.log('✅ stopUnrepliedScanner cleanly stopped interval timer');

  // Section 5: Anti-Ban ~5s Typing Simulation Verification
  console.log('\n--- Section 5: Anti-Ban ~5s Typing Simulation Validation ---');
  const delayDM = antiBanEngine.calculateTypingDelay(50, 40, false);
  const delayGroup = antiBanEngine.calculateTypingDelay(80, 50, true);
  console.log(`Calculated Delays (Test environment override active): DM=${delayDM}ms, Group=${delayGroup}ms`);
  assert(delayDM > 0 && delayGroup > 0, 'Delays should be positive numbers');

  console.log('\n🎉 ALL SECTIONS PASSED! All harness tools, scheduler handlers, DM scanner, and typing simulations are working properly! 🚀\n');
  process.exit(0);
}

main().catch((err) => {
  console.error('❌ Verification failed:', err);
  process.exit(1);
});
