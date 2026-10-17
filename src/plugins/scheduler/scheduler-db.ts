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
db.exec(`
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
try { db.exec(`ALTER TABLE scheduled_tasks ADD COLUMN topic TEXT DEFAULT 'custom'`); } catch {}
try { db.exec(`ALTER TABLE scheduled_tasks ADD COLUMN time_of_day TEXT DEFAULT '07:00'`); } catch {}
try { db.exec(`ALTER TABLE scheduled_tasks ADD COLUMN custom_prompt TEXT`); } catch {}
try { db.exec(`ALTER TABLE scheduled_tasks ADD COLUMN group_name TEXT`); } catch {}

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
 * Calculates the next timestamp for a given HH:MM string (defaults to 07:00).
 */
export function getNextFireAtForTimeOfDay(timeOfDay: string = '07:00'): number {
  const parts = timeOfDay.split(':');
  const targetHour = parseInt(parts[0], 10) || 7;
  const targetMinute = parseInt(parts[1], 10) || 0;

  const now = new Date();
  const next = new Date(now);
  next.setHours(targetHour, targetMinute, 0, 0);

  if (next.getTime() <= now.getTime()) {
    next.setDate(next.getDate() + 1);
  }
  return next.getTime();
}

/**
 * Advances a fire_at timestamp by 24 hours.
 */
export function advanceToNextDay(currentFireAt: number): number {
  const next = new Date(currentFireAt);
  next.setDate(next.getDate() + 1);
  return next.getTime();
}

/**
 * Inserts a new scheduled task into the database.
 */
export function insertScheduledTask(
  chatJid: string,
  senderJid: string,
  message: string,
  fireAt: number,
  recurringCron?: string | null,
  topic: string = 'custom',
  timeOfDay: string = '07:00',
  customPrompt?: string,
  groupName?: string
): number {
  const result = insertTaskStmt.run(
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
export function rescheduleRecurringTask(id: number, nextFireAt: number): void {
  db.prepare(`
    UPDATE scheduled_tasks
    SET fire_at = ?, status = 'pending'
    WHERE id = ?
  `).run(nextFireAt, id);
}

/**
 * Lists all active recurring daily broadcasts.
 */
export function getActiveDailyBroadcasts(chatJid?: string): ScheduledTask[] {
  if (chatJid) {
    return db.prepare(`
      SELECT id, chat_jid, sender_jid, message, fire_at, recurring_cron, topic, time_of_day, custom_prompt, group_name, status, created_at
      FROM scheduled_tasks
      WHERE recurring_cron = 'daily' AND status = 'pending' AND chat_jid = ?
      ORDER BY fire_at ASC
    `).all(chatJid) as unknown as ScheduledTask[];
  }
  return db.prepare(`
    SELECT id, chat_jid, sender_jid, message, fire_at, recurring_cron, topic, time_of_day, custom_prompt, group_name, status, created_at
    FROM scheduled_tasks
    WHERE recurring_cron = 'daily' AND status = 'pending'
    ORDER BY fire_at ASC
  `).all() as unknown as ScheduledTask[];
}

/**
 * Cancels a scheduled task or recurring broadcast by ID.
 */
export function cancelScheduledTask(id: number): boolean {
  const res = db.prepare(`
    UPDATE scheduled_tasks
    SET status = 'cancelled'
    WHERE id = ? AND status = 'pending'
  `).run(id);
  return res.changes > 0;
}

/**
 * Retrieves all pending tasks that are due to fire up to the given timestamp.
 */
export function getPendingTasks(now: number = Date.now()): ScheduledTask[] {
  return getPendingTasksStmt.all(now) as unknown as ScheduledTask[];
}

/**
 * Marks a task as fired in the database.
 */
export function markTaskFired(id: number): void {
  markTaskFiredStmt.run(id);
}

/**
 * Marks a task as failed so it does not loop infinitely and block the socket.
 */
export function markTaskFailed(id: number): void {
  markTaskFailedStmt.run(id);
}
