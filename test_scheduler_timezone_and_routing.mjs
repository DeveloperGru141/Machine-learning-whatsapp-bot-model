import {
  getNextFireAtForTimeOfDay,
  advanceToNextDay,
  getTimeZoneParts,
  getTargetUtcTimestamp,
  getInitialScheduleFireAt,
  hasFiredToday,
  insertScheduledTask,
  getPendingTasks,
  rescheduleRecurringTask,
} from './dist/plugins/scheduler/scheduler-db.js';
import {
  schedulerPlugin,
  postMorningStatusBundle,
} from './dist/plugins/scheduler/scheduler-plugin.js';
import {
  getMemeCooldownStatus,
  postChannelMemeWithCooldown,
} from './dist/plugins/scheduler/channel-memes-service.js';
import { db, initDatabase } from './dist/memory/db.js';

console.log('🧪 Running Test Suite: Scheduler WAT Timezone, Catch-up Engine & Task Routing\n');

initDatabase();

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

// 1. Test WAT Timezone Parts & Target UTC Calculation
const lagosParts = getTimeZoneParts(new Date(), 'Africa/Lagos');
assert('getTimeZoneParts resolves valid year, month, day, hour', lagosParts.year >= 2026 && lagosParts.month >= 1 && lagosParts.hour >= 0);

// Target 07:00 AM Lagos on a specific date (2026-10-21)
const targetUtc = getTargetUtcTimestamp(2026, 10, 21, 7, 0, 'Africa/Lagos');
const targetDate = new Date(targetUtc);
assert('getTargetUtcTimestamp(2026-10-21 07:00 Lagos) maps to 06:00 UTC', targetDate.toISOString() === '2026-10-21T06:00:00.000Z', `Got ${targetDate.toISOString()}`);

// 2. Test getNextFireAtForTimeOfDay targets 07:00 WAT (06:00 UTC)
const next0700 = getNextFireAtForTimeOfDay('07:00', 'Africa/Lagos');
const nextDate = new Date(next0700);
assert('getNextFireAtForTimeOfDay targets 06:00 UTC (07:00 WAT)', nextDate.getUTCHours() === 6 && nextDate.getUTCMinutes() === 0, `Got UTC ${nextDate.toISOString()}`);

// 3. Test advanceToNextDay adds exactly 24 hours
const dayAfter = advanceToNextDay(next0700, 'Africa/Lagos');
assert('advanceToNextDay advances by exactly 24 hours', dayAfter - next0700 === 24 * 60 * 60 * 1000);

// 4. Test Catch-up Engine: getInitialScheduleFireAt
const unfiredFireAt = getInitialScheduleFireAt('test_topic_unfired', '07:00', 'Africa/Lagos');
const diffSeconds = Math.round((unfiredFireAt - Date.now()) / 1000);
if (lagosParts.hour >= 7 && lagosParts.hour < 11) {
  assert('getInitialScheduleFireAt schedules catch-up in 60s when missed during morning', diffSeconds >= 55 && diffSeconds <= 65, `diff: ${diffSeconds}s`);
} else {
  assert('getInitialScheduleFireAt schedules next 07:00 WAT when outside catch-up window', new Date(unfiredFireAt).getUTCHours() === 6);
}

// 5. Test 2-Hour Meme Cooldown Engine
const cooldown = getMemeCooldownStatus();
assert('getMemeCooldownStatus returns valid status object', typeof cooldown.canPost === 'boolean' && typeof cooldown.remainingMinutes === 'number');

// 6. Test Task Routing Separation in checkDueTasks
// Ensure channel_meme_2hr_post and morning_status_post don't collide
const mockSocket = {
  user: { id: '2347058967815:1@s.whatsapp.net' },
  sendMessage: async (jid, content) => {
    return { key: { id: 'test_msg_id' } };
  },
  newsletterMetadata: async () => ({ id: '120363423071912423@newsletter', name: 'Quotes' }),
};

schedulerPlugin.setSocket(mockSocket);

// Create a test meme task
const testMemeTaskId = insertScheduledTask(
  'status@broadcast',
  '2348108574293@s.whatsapp.net',
  'Test Meme 2hr Task',
  Date.now() - 1000, // already due
  'every_2_hours',
  'channel_meme_2hr_post'
);

const pendingBefore = getPendingTasks(Date.now());
const memeTask = pendingBefore.find(t => t.id === testMemeTaskId);
assert('Inserted test meme task is pending and due', !!memeTask);

// Run checkDueTasks to ensure meme task is handled and rescheduled +2 hours
await schedulerPlugin.checkDueTasks();

const pendingAfter = getPendingTasks(Date.now() + 3 * 60 * 60 * 1000);
const rescheduledMemeTask = pendingAfter.find(t => t.id === testMemeTaskId);
assert('Meme task was rescheduled for ~2 hours in the future without collision', !!rescheduledMemeTask && rescheduledMemeTask.fire_at > Date.now() + 1.8 * 60 * 60 * 1000);

// Clean up test tasks
db.prepare('DELETE FROM scheduled_tasks WHERE id = ?').run(testMemeTaskId);

console.log(`\n============================================================`);
console.log(`📊 Result: ${passed}/${total} assertions passed!`);
console.log(`============================================================\n`);

if (passed === total) {
  process.exit(0);
} else {
  process.exit(1);
}
