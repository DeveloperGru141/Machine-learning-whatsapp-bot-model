const assert = require('node:assert/strict');

async function main() {
  const [
    { initDatabase, db, upsertKnownGroup, findKnownGroup, reserveOutboundContent, markOutboundContentSent },
    { normalizeSearchSourceUrl, parseDuckDuckGoResults, webSearchPlugin },
    { stickerEngine },
    { stickerPlugin },
    { pluginRegistry },
    { contactPlugin },
    { groupAdminPlugin },
    { chatLogger },
    { config },
  ] = await Promise.all([
    import('../dist/memory/db.js'),
    import('../dist/plugins/web-search/search-plugin.js'),
    import('../dist/plugins/stickers/sticker-engine.js'),
    import('../dist/plugins/stickers/sticker-plugin.js'),
    import('../dist/plugins/registry.js'),
    import('../dist/plugins/contact/contact-plugin.js'),
    import('../dist/plugins/group-admin/admin-plugin.js'),
    import('../dist/memory/chat-logger.js'),
    import('../dist/config/env.js'),
  ]);

  await initDatabase();
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const safeSuffix = Math.random().toString(36).slice(2, 11);

  // Search result fields must remain paired, redirects must unwrap to the publisher,
  // and non-HTTP / search-engine pages must never be emitted as sources.
  const redirect = normalizeSearchSourceUrl('/l/?uddg=https%3A%2F%2Fpublisher.example%2Fstory%3Fa%3D1%26b%3D2');
  assert.equal(redirect, 'https://publisher.example/story?a=1&b=2');
  assert.equal(normalizeSearchSourceUrl('javascript:alert(1)'), undefined);
  assert.equal(normalizeSearchSourceUrl('https://duckduckgo.com/l/?uddg='), undefined);
  assert.equal(normalizeSearchSourceUrl('https://user:pass@publisher.example/story'), undefined);

  const results = parseDuckDuckGoResults(`
    <div class="result">
      <a class="result__a" href="/l/?uddg=https%3A%2F%2Falpha.example%2Fone">Alpha publisher story</a>
      <a class="result__snippet">Alpha snippet belongs only to the first publisher result.</a>
    </div>
    <div class="result">
      <a class="result__a" href="https://beta.example/two">Beta publisher story</a>
      <a class="result__snippet">Beta snippet belongs only to the second publisher result.</a>
    </div>
  `);
  assert.deepEqual(results.map((row) => row.url), ['https://alpha.example/one', 'https://beta.example/two']);
  assert.match(results[0].snippet, /^Alpha snippet/);
  assert.match(results[1].snippet, /^Beta snippet/);

  // Sticker emoji cues and deployment-relative asset lookup must both work.
  assert.equal(stickerEngine.detectVibeFromText('😂').vibe, 'humor');
  const stickerMatch = stickerEngine.getMatchingSticker('😂');
  assert.ok(stickerMatch, 'Sticker engine should return an indexed sticker.');
  assert.ok(require('node:fs').existsSync(stickerMatch.absolutePath), 'Sticker path should resolve from the compiled module location.');
  let stickerDispatches = 0;
  const stickerTool = stickerPlugin.tools.find((tool) => tool.name === 'send_contextual_sticker');
  const stickerResult = await stickerTool.execute({}, {
    chatJid: `sticker-test-${suffix}@s.whatsapp.net`,
    senderJid: '2347058967815@s.whatsapp.net',
    senderName: 'Owner',
    isGroup: false,
    rawMessage: { message: { conversation: '😂' } },
    sock: {},
    sendSticker: async () => { stickerDispatches++; return { key: { id: `sticker-${suffix}` } }; },
  });
  assert.equal(stickerResult.success, true);
  assert.equal(stickerDispatches, 1);
  const noAckStickerResult = await stickerTool.execute({}, {
    chatJid: `sticker-no-ack-${suffix}@s.whatsapp.net`,
    senderJid: '2347058967815@s.whatsapp.net',
    senderName: 'Owner',
    isGroup: false,
    rawMessage: { message: { conversation: '😂' } },
    sock: {},
    sendSticker: async () => undefined,
  });
  assert.equal(noAckStickerResult.success, false, 'Sticker call must not report success without a WhatsApp message ID.');

  // Group names must resolve exactly or uniquely; stale admin state must be refreshable.
  const groupA = `120363${Date.now()}01@g.us`;
  const groupB = `120363${Date.now()}02@g.us`;
  const subjectA = `Integrity Widget Alpha ${suffix}`;
  const subjectB = `Integrity Widget Beta ${suffix}`;
  await upsertKnownGroup(groupA, subjectA, 12, true);
  await upsertKnownGroup(groupB, subjectB, 18, false);
  assert.equal(await findKnownGroup('Integrity Widget'), null, 'Ambiguous group fragment must not select one group arbitrarily.');
  assert.equal((await findKnownGroup(subjectA)).group_jid, groupA);
  await upsertKnownGroup(groupA, subjectA, 12);
  assert.equal(Number((await findKnownGroup(groupA)).is_admin), 1, 'Metadata refresh without admin state must preserve known admin state.');
  await upsertKnownGroup(groupA, subjectA, 12, false);
  assert.equal(Number((await findKnownGroup(groupA)).is_admin), 0, 'A current non-admin status must clear stale admin state.');
  const groupResolver = await groupAdminPlugin.resolveTargetGroup({
    groupFetchAllParticipating: async () => ({
      [groupA]: { subject: subjectA },
      [groupB]: { subject: subjectB },
    }),
  }, 'Integrity Widget');
  assert.equal(groupResolver, null, 'Live ambiguous group names must not resolve to the first matching group.');

  // Upgrade-time history backfill must preserve the prior no-repeat boundary.
  const legacyStatusQuote = `Historic status quote ${safeSuffix}`;
  const legacyGroupQuote = `Historic group quote ${safeSuffix}`;
  await chatLogger.logOutboundMessage('status@broadcast', `[Status: Motivation] 🌅 *MORNING MOTIVATION*\n\n> "${legacyStatusQuote}"\n— *Quotes📖*`);
  await chatLogger.logOutboundMessage(groupA, `🌅 *GOOD MORNING*\n📜 *Words of the Day:*\n> "${legacyGroupQuote}"\n— Forgelabs Assistant`);
  await db.prepare("DELETE FROM bot_settings WHERE key = 'outbound_content_history_backfill_v1'").run();
  await initDatabase();
  assert.equal(await reserveOutboundContent('status@broadcast', legacyStatusQuote, 'whatsapp_status'), false, 'A prior logged status quote must not be posted again after the upgrade.');
  assert.equal(await reserveOutboundContent(groupA, legacyGroupQuote, 'group_motivation'), false, 'A prior group motivation quote must not be repeated after the upgrade.');

  // Outbound reservations are atomic and apply to every path using the same target/content.
  const groupQuote = `Unique motivation quote ${suffix}`;
  const reservations = await Promise.all([
    reserveOutboundContent(groupA, groupQuote, 'group_motivation'),
    reserveOutboundContent(groupA, groupQuote, 'group_motivation'),
  ]);
  assert.equal(reservations.filter(Boolean).length, 1, 'Overlapping quote sends must reserve content only once.');
  await markOutboundContentSent(groupA, groupQuote);
  const quoteRow = await db.prepare('SELECT status FROM outbound_content_history WHERE target_chat = ?').get(groupA);
  assert.equal(quoteRow.status, 'sent');

  // Status posts share one durable at-most-once gate, including direct scheduler callers.
  const { sendStatusOnce } = await import('../dist/plugins/scheduler/scheduler-plugin.js');
  let statusDispatches = 0;
  const statusText = `Status dedupe regression ${suffix}`;
  const mockSocket = {
    sendMessage: async () => ({ key: { id: `status-${++statusDispatches}` } }),
  };
  const firstStatus = await sendStatusOnce(mockSocket, { text: statusText }, {}, [], statusText, statusText);
  const duplicateStatus = await sendStatusOnce(mockSocket, { text: statusText }, {}, [], statusText, statusText);
  assert.equal(firstStatus, true);
  assert.equal(duplicateStatus, false);
  assert.equal(statusDispatches, 1, 'Repeated status payload must be sent once.');

  // Tool routing must distinguish direct sends, group sends, lookups, and bare confirmations.
  await pluginRegistry.registerPlugin(contactPlugin);
  await pluginRegistry.registerPlugin(groupAdminPlugin);
  await pluginRegistry.registerPlugin({
    name: 'IntegrityBroadcastStub',
    version: '1.0.0',
    description: 'Routing fixture',
    tools: [{
      name: 'broadcast_group_motivation',
      description: 'Routing fixture',
      parameters: { type: 'object', properties: {} },
      execute: async () => ({ success: true }),
    }],
  });
  const chatJid = `routing-test-${suffix}@s.whatsapp.net`;
  const namesFor = async (message) => (await pluginRegistry.getRelevantToolDefinitions(message, false, chatJid))
    .map((tool) => tool.function.name);
  assert((await namesFor('yes')).includes('send_message_to_contact') === false, 'Bare yes must not expose direct message dispatch without a pending send confirmation.');
  await chatLogger.logOutboundMessage(chatJid, 'Would you like me to send the message to Alex now?');
  assert(!(await namesFor('yes')).includes('send_message_to_contact'), 'A generic yes must never infer contact dispatch from earlier chat history.');
  assert(!(await namesFor('send it')).includes('send_message_to_contact'), 'A vague continuation must not infer recipient or message text from earlier history.');
  assert((await namesFor('send a message to alex saying I am running late')).includes('send_message_to_contact'));
  const groupTools = await namesFor('send this update to the Dev Hub group');
  assert(groupTools.includes('send_message_to_group'));
  assert(!groupTools.includes('send_message_to_contact'), 'Group messages must not route through the contact sender.');
  const lookupTools = await namesFor('find the contact Alex');
  assert(lookupTools.includes('get_contact'));
  assert(!lookupTools.includes('send_message_to_contact'), 'Contact lookup must not expose outbound contact messaging.');
  const broadcastTools = await namesFor('send motivational quotes to all groups');
  assert(broadcastTools.includes('broadcast_group_motivation'));
  assert(!broadcastTools.includes('send_message_to_group'));
  assert(!broadcastTools.includes('send_message_to_contact'));

  // A single partial-name contact match is still only a suggestion, never a send target.
  const ownerJid = config.bot.owners.find((jid) => jid && !jid.endsWith('@lid'));
  assert(ownerJid, 'Test environment must configure a phone-based owner identity.');
  const nearbyPhone = `2349${String(Date.now()).slice(-9)}`;
  const nearbyJid = `${nearbyPhone}@s.whatsapp.net`;
  await db.prepare(`
    INSERT INTO contacts (phone_number, jid, display_name, custom_name, notes, tags, is_auto_saved, is_introduced, created_at, updated_at)
    VALUES (?, ?, ?, NULL, NULL, '[]', 0, 1, ?, ?)
    ON CONFLICT(jid) DO UPDATE SET display_name = excluded.display_name, updated_at = excluded.updated_at
  `).run(nearbyPhone, nearbyJid, `Zeta Nearby ${suffix}`, Date.now(), Date.now());
  let contactDispatches = 0;
  const sendContactTool = contactPlugin.tools.find((tool) => tool.name === 'send_message_to_contact');
  const partialContactResult = await sendContactTool.execute({ recipient: 'Zeta Nearby', message: 'Do not send to a fuzzy match.' }, {
    chatJid: ownerJid,
    senderJid: ownerJid,
    senderName: 'Owner',
    isGroup: false,
    sock: { sendMessage: async () => { contactDispatches++; return { key: { id: 'unexpected' } }; } },
  });
  assert.equal(partialContactResult.success, false);
  assert.equal(contactDispatches, 0, 'Fuzzy contact matches must not receive a message.');

  console.log('✅ Tool integrity regressions passed (sticker, group identity, routing, contact sends, status dedupe, web sources).');
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
