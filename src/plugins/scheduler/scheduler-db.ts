import { db } from '../../memory/db.js';

export interface ScheduledTask {
  id: number;
  chat_jid: string;
  sender_jid: string;
  message: string;
  fire_at: number;
  recurring_cron?: string | null;
  status: string;
  created_at: number;
}

// Initialize scheduled_tasks table
db.exec(`
  CREATE TABLE IF NOT EXISTS scheduled_tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_jid TEXT NOT NULL,
    sender_jid TEXT NOT NULL,
    message TEXT NOT NULL,
    fire_at INTEGER NOT NULL,
    recurring_cron TEXT,
    status TEXT DEFAULT 'pending',
    created_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_pending ON scheduled_tasks(status, fire_at);
`);

const insertTaskStmt = db.prepare(`
  INSERT INTO scheduled_tasks (chat_jid, sender_jid, message, fire_at, recurring_cron, status, created_at)
  VALUES (?, ?, ?, ?, ?, 'pending', ?)
`);

const getPendingTasksStmt = db.prepare(`
  SELECT id, chat_jid, sender_jid, message, fire_at, recurring_cron, status, created_at
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
 * Inserts a new scheduled task into the database.
 */
export function insertScheduledTask(
  chatJid: string,
  senderJid: string,
  message: string,
  fireAt: number,
  recurringCron?: string | null
): number {
  const result = insertTaskStmt.run(
    chatJid,
    senderJid,
    message,
    fireAt,
    recurringCron || null,
    Date.now()
  );
  return Number(result.lastInsertRowid);
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
