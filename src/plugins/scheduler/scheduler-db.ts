import { db } from '../../memory/db.js';

export interface ScheduledTask {
  id: number;
  chat_jid: string;
  sender_jid: string;
  message: string;
  fire_at: number;
  recurring_cron?: string | null;
  topic?: string;
  time_of_day?: string;
  custom_prompt?: string | null;
  group_name?: string | null;
  status: string;
  created_at: number;
}

// Initialize scheduled_tasks table with support for recurring broadcasts
await db.exec(`
  CREATE TABLE IF NOT EXISTS scheduled_tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_jid TEXT NOT NULL,
    sender_jid TEXT NOT NULL,
    message TEXT NOT NULL,
    fire_at INTEGER NOT NULL,
    recurring_cron TEXT,
    topic TEXT DEFAULT 'custom',
    time_of_day TEXT DEFAULT '07:00',
    custom_prompt TEXT,
    group_name TEXT,
    status TEXT DEFAULT 'pending',
    created_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_pending ON scheduled_tasks(status, fire_at);
`);

// Safe migrations if table already existed without new columns
try { await db.exec(`ALTER TABLE scheduled_tasks ADD COLUMN topic TEXT DEFAULT 'custom'`); } catch {}
try { await db.exec(`ALTER TABLE scheduled_tasks ADD COLUMN time_of_day TEXT DEFAULT '07:00'`); } catch {}
try { await db.exec(`ALTER TABLE scheduled_tasks ADD COLUMN custom_prompt TEXT`); } catch {}
try { await db.exec(`ALTER TABLE scheduled_tasks ADD COLUMN group_name TEXT`); } catch {}

const insertTaskStmt = db.prepare(`
  INSERT INTO scheduled_tasks (chat_jid, sender_jid, message, fire_at, recurring_cron, topic, time_of_day, custom_prompt, group_name, status, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)
`);

const getPendingTasksStmt = db.prepare(`
  SELECT id, chat_jid, sender_jid, message, fire_at, recurring_cron, topic, time_of_day, custom_prompt, group_name, status, created_at
  FROM scheduled_tasks
  WHERE status = 'pending' AND fire_at <= ?
  ORDER BY fire_at ASC
`);

const markTaskFiredStmt = db.prepare(`
  UPDATE scheduled_tasks
  SET status = 'fired'
  WHERE id = ?
`);

const markTaskFailedStmt = db.prepare(`
  UPDATE scheduled_tasks
  SET status = 'failed'
  WHERE id = ?
`);

/**
 * Resolves local date and time parts in a specific timezone (defaults to Africa/Lagos = WAT = UTC+1).
 */
export function getTimeZoneParts(
  date: Date = new Date(),
  timeZone: string = process.env.BOT_TIMEZONE || 'Africa/Lagos'
): { year: number; month: number; day: number; hour: number; minute: number; second: number } {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
    hour12: false,
  });

  const parts = formatter.formatToParts(date);
  const map: Record<string, number> = {};
  for (const part of parts) {
    if (part.type !== 'literal') {
      map[part.type] = parseInt(part.value, 10);
    }
  }
  if (map.hour === 24) map.hour = 0;
  return {
    year: map.year || date.getUTCFullYear(),
    month: map.month || date.getUTCMonth() + 1,
    day: map.day || date.getUTCDate(),
    hour: map.hour ?? date.getUTCHours(),
    minute: map.minute ?? date.getUTCMinutes(),
    second: map.second ?? date.getUTCSeconds(),
  };
}

/**
 * Calculates the millisecond offset between the specified timezone and UTC at a given reference date.
 */
export function getTimezoneOffsetMs(
  date: Date = new Date(),
  timeZone: string = process.env.BOT_TIMEZONE || 'Africa/Lagos'
): number {
  const utcDate = new Date(date.toLocaleString('en-US', { timeZone: 'UTC' }));
  const tzDate = new Date(date.toLocaleString('en-US', { timeZone }));
  return tzDate.getTime() - utcDate.getTime();
}

/**
 * Converts a year/month/day/hour/minute in the specified timezone into an exact UTC epoch timestamp (ms).
 */
export function getTargetUtcTimestamp(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string = process.env.BOT_TIMEZONE || 'Africa/Lagos'
): number {
  const naiveUtc = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
  const offset = getTimezoneOffsetMs(new Date(naiveUtc), timeZone);
  return naiveUtc - offset;
}

/**
 * Calculates the next UTC epoch timestamp for a given HH:MM string in Nigeria / Africa/Lagos (WAT, UTC+1).
 * If the target time has already passed today in the target timezone, it schedules for tomorrow at that time.
 */
export function getNextFireAtForTimeOfDay(
  timeOfDay: string = '07:00',
  timeZone: string = process.env.BOT_TIMEZONE || 'Africa/Lagos'
): number {
  const parts = timeOfDay.split(':');
  const targetHour = parseInt(parts[0], 10) || 7;
  const targetMinute = parseInt(parts[1], 10) || 0;

  const now = new Date();
  const nowParts = getTimeZoneParts(now, timeZone);

  let fireAt = getTargetUtcTimestamp(nowParts.year, nowParts.month, nowParts.day, targetHour, targetMinute, timeZone);

  if (fireAt <= now.getTime()) {
    const tomorrowDate = new Date(Date.UTC(nowParts.year, nowParts.month - 1, nowParts.day + 1));
    const tomParts = getTimeZoneParts(tomorrowDate, timeZone);
    fireAt = getTargetUtcTimestamp(tomParts.year, tomParts.month, tomParts.day, targetHour, targetMinute, timeZone);
  }

  return fireAt;
}

/**
 * Advances a fire_at timestamp by 1 day in the target timezone.
 */
export function advanceToNextDay(
  currentFireAt: number,
  timeZone: string = process.env.BOT_TIMEZONE || 'Africa/Lagos'
): number {
  const currentDate = new Date(currentFireAt);
  const parts = getTimeZoneParts(currentDate, timeZone);
  const nextDay = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + 1));
  const tomParts = getTimeZoneParts(nextDay, timeZone);
  return getTargetUtcTimestamp(tomParts.year, tomParts.month, tomParts.day, parts.hour, parts.minute, timeZone);
}

/**
 * Returns UTC timestamp for start of today (00:00:00) in Nigeria / WAT.
 */
export function getStartOfTodayWat(timeZone: string = process.env.BOT_TIMEZONE || 'Africa/Lagos'): number {
  const now = new Date();
  const nowParts = getTimeZoneParts(now, timeZone);
  return getTargetUtcTimestamp(nowParts.year, nowParts.month, nowParts.day, 0, 0, timeZone);
}

/**
 * Checks if a specific daily task has already successfully fired/posted today in Nigeria / Africa/Lagos.
 */
export async function hasFiredToday(
  topic: string,
  timeZone: string = process.env.BOT_TIMEZONE || 'Africa/Lagos'
): Promise<boolean> {
  const startOfDayUtc = getStartOfTodayWat(timeZone);

  try {
    if (topic === 'morning_status_post') {
      const row = await db
        .prepare(
          `SELECT COUNT(*) as count FROM chat_logs WHERE chat_jid = 'status@broadcast' AND message_text LIKE '%[Status: Motion Design]%' AND timestamp >= ?`
        )
        .get(startOfDayUtc) as { count: number } | undefined;
      return (row?.count || 0) > 0;
    }

    if (topic === 'morning_group_motivation') {
      const row = await db
        .prepare(
          `SELECT COUNT(*) as count FROM chat_logs WHERE sender_jid = 'bot' AND (message_text LIKE '%Morning Charge%' OR message_text LIKE '%GOOD MORNING%' OR message_text LIKE '%Words of the Day%') AND timestamp >= ?`
        )
        .get(startOfDayUtc) as { count: number } | undefined;
      return (row?.count || 0) > 0;
    }

    if (topic === 'owner_health_report') {
      const row = await db
        .prepare(
          `SELECT COUNT(*) as count FROM chat_logs WHERE chat_jid LIKE '2348108574293%' AND (message_text LIKE '%Health Report%' OR message_text LIKE '%SYSTEM STATUS%') AND timestamp >= ?`
        )
        .get(startOfDayUtc) as { count: number } | undefined;
      return (row?.count || 0) > 0;
    }

    const row = await db
      .prepare(
        `SELECT COUNT(*) as count FROM scheduled_tasks WHERE topic = ? AND status = 'fired' AND fire_at >= ?`
      )
      .get(topic, startOfDayUtc) as { count: number } | undefined;
    return (row?.count || 0) > 0;
  } catch {
    return false;
  }
}

/**
 * Calculates initial fire_at for recurring morning tasks.
 * If today's post was missed and it is still morning (between targetHour and 11:00 AM WAT),
 * triggers catch-up in 60 seconds (Date.now() + 60_000).
 * Otherwise, schedules for the next occurrence of timeOfDay (tomorrow 07:00 WAT).
 */
export async function getInitialScheduleFireAt(
  topic: string,
  timeOfDay: string = '07:00',
  timeZone: string = process.env.BOT_TIMEZONE || 'Africa/Lagos'
): Promise<number> {
  const parts = timeOfDay.split(':');
  const targetHour = parseInt(parts[0], 10) || 7;
  const now = new Date();
  const nowParts = getTimeZoneParts(now, timeZone);

  const firedToday = await hasFiredToday(topic, timeZone);

  // If it hasn't fired yet today and current time is between targetHour and 11:00 AM WAT, trigger catchup in 60s
  if (!firedToday && nowParts.hour >= targetHour && nowParts.hour < 11) {
    return now.getTime() + 60_000;
  }

  return getNextFireAtForTimeOfDay(timeOfDay, timeZone);
}

/**
 * Inserts a new scheduled task into the database.
 */
export async function insertScheduledTask(
  chatJid: string,
  senderJid: string,
  message: string,
  fireAt: number,
  recurringCron?: string | null,
  topic: string = 'custom',
  timeOfDay: string = '07:00',
  customPrompt?: string,
  groupName?: string
): Promise<number> {
  const result = await insertTaskStmt.run(
    chatJid,
    senderJid,
    message,
    fireAt,
    recurringCron || null,
    topic,
    timeOfDay,
    customPrompt || null,
    groupName || null,
    Date.now()
  );
  return Number(result.lastInsertRowid);
}

/**
 * Reschedules a recurring broadcast to the next day's timestamp.
 */
export async function rescheduleRecurringTask(id: number, nextFireAt: number): Promise<void> {
  await db.prepare(`
    UPDATE scheduled_tasks
    SET fire_at = ?, status = 'pending'
    WHERE id = ?
  `).run(nextFireAt, id);
}

/**
 * Lists all active recurring daily broadcasts.
 */
export async function getActiveDailyBroadcasts(chatJid?: string): Promise<ScheduledTask[]> {
  if (chatJid) {
    return await db.prepare(`
      SELECT id, chat_jid, sender_jid, message, fire_at, recurring_cron, topic, time_of_day, custom_prompt, group_name, status, created_at
      FROM scheduled_tasks
      WHERE recurring_cron = 'daily' AND status = 'pending' AND chat_jid = ?
      ORDER BY fire_at ASC
    `).all(chatJid) as unknown as ScheduledTask[];
  }
  return await db.prepare(`
    SELECT id, chat_jid, sender_jid, message, fire_at, recurring_cron, topic, time_of_day, custom_prompt, group_name, status, created_at
    FROM scheduled_tasks
    WHERE recurring_cron = 'daily' AND status = 'pending'
    ORDER BY fire_at ASC
  `).all() as unknown as ScheduledTask[];
}

/**
 * Cancels a scheduled task or recurring broadcast by ID.
 */
export async function cancelScheduledTask(id: number): Promise<boolean> {
  const res = await db.prepare(`
    UPDATE scheduled_tasks
    SET status = 'cancelled'
    WHERE id = ? AND status = 'pending'
  `).run(id);
  return res.changes > 0;
}

/**
 * Retrieves all pending tasks that are due to fire up to the given timestamp.
 */
export async function getPendingTasks(now: number = Date.now()): Promise<ScheduledTask[]> {
  return await getPendingTasksStmt.all(now) as unknown as ScheduledTask[];
}

/**
 * Marks a task as fired in the database.
 */
export async function markTaskFired(id: number): Promise<void> {
  await markTaskFiredStmt.run(id);
}

/**
 * Marks a task as failed so it does not loop infinitely and block the socket.
 */
export async function markTaskFailed(id: number): Promise<void> {
  await markTaskFailedStmt.run(id);
}
