import { schedulerPlugin } from './dist/plugins/scheduler/scheduler-plugin.js';
import { getActiveDailyBroadcasts, cancelScheduledTask, getNextFireAtForTimeOfDay, advanceToNextDay } from './dist/plugins/scheduler/scheduler-db.js';
import { db } from './dist/memory/db.js';

console.log('🧪 Testing Daily Group Reminders & Morning Broadcasts Engine...\n');

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

async function runTests() {
  const testGroup = '120363099999999999@g.us';
  const testSender = '2348011223344@s.whatsapp.net';

  // Clean previous test data
  db.prepare(`DELETE FROM scheduled_tasks WHERE chat_jid = ?`).run(testGroup);

  // 1. Test schedule_daily_broadcast for motivational_quotes
  const scheduleTool = schedulerPlugin.tools.find(t => t.name === 'schedule_daily_broadcast');
  assert('schedule_daily_broadcast tool is registered in schedulerPlugin', !!scheduleTool);

  const res1 = await scheduleTool.execute(
    { topic: 'motivational_quotes', time_of_day: '07:00' },
    { chatJid: testGroup, senderJid: testSender, isGroup: true, sock: null }
  );
  assert('Successfully scheduled daily motivational quotes', res1.success && res1.data.taskId > 0, res1.message);

  // 2. Test schedule_daily_broadcast for bible_verses
  const res2 = await scheduleTool.execute(
    { topic: 'bible_verses', time_of_day: '06:30' },
    { chatJid: testGroup, senderJid: testSender, isGroup: true, sock: null }
  );
  assert('Successfully scheduled daily Bible verses', res2.success && res2.data.taskId > 0, res2.message);

  // 3. Test schedule_daily_broadcast for tech_news / ai_updates
  const res3 = await scheduleTool.execute(
    { topic: 'tech_news', time_of_day: '08:00' },
    { chatJid: testGroup, senderJid: testSender, isGroup: true, sock: null }
  );
  assert('Successfully scheduled daily tech news & AI updates', res3.success && res3.data.taskId > 0, res3.message);

  // 4. Test list_scheduled_broadcasts
  const listTool = schedulerPlugin.tools.find(t => t.name === 'list_scheduled_broadcasts');
  assert('list_scheduled_broadcasts tool is registered', !!listTool);

  const listRes = await listTool.execute(
    { group_jid: testGroup },
    { chatJid: testGroup, senderJid: testSender, isGroup: true, sock: null }
  );
  assert('List broadcasts returns 3 scheduled tasks', listRes.success && listRes.data.broadcasts.length === 3, listRes.message);

  // 5. Verify Next Fire At calculation
  const fire7am = getNextFireAtForTimeOfDay('07:00');
  const d7 = new Date(fire7am);
  assert('getNextFireAtForTimeOfDay correctly targets 7 AM', d7.getHours() === 7 && d7.getMinutes() === 0);

  const advanced = advanceToNextDay(fire7am);
  assert('advanceToNextDay correctly adds 24 hours', advanced - fire7am === 24 * 60 * 60 * 1000);

  // 6. Test cancel_scheduled_broadcast
  const cancelTool = schedulerPlugin.tools.find(t => t.name === 'cancel_scheduled_broadcast');
  assert('cancel_scheduled_broadcast tool is registered', !!cancelTool);

  const cancelRes = await cancelTool.execute({ task_id: res2.data.taskId });
  assert('Successfully cancelled Bible verses task', cancelRes.success, cancelRes.message);

  const listAfterCancel = await listTool.execute(
    { group_jid: testGroup },
    { chatJid: testGroup, senderJid: testSender, isGroup: true, sock: null }
  );
  assert('Active broadcasts count reduced to 2 after cancellation', listAfterCancel.data.broadcasts.length === 2);

  // Clean test data
  db.prepare(`DELETE FROM scheduled_tasks WHERE chat_jid = ?`).run(testGroup);

  console.log(`\n============================================================`);
  console.log(`📊 Result: ${passed}/${total} assertions passed!`);
  console.log(`============================================================\n`);

  if (passed === total) {
    process.exit(0);
  } else {
    process.exit(1);
  }
}

runTests().catch(err => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
