import type { WASocket } from '@whiskeysockets/baileys';
import { db } from '../memory/db.js';
import { healthMonitor } from './health-monitor.js';

// Initialize the analytics_events table immediately upon module load
db.exec(`
  CREATE TABLE IF NOT EXISTS analytics_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_type TEXT NOT NULL,
    event_data TEXT,
    chat_jid TEXT,
    sender_jid TEXT,
    timestamp INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_analytics_events_ts ON analytics_events(timestamp);
  CREATE INDEX IF NOT EXISTS idx_analytics_events_type ON analytics_events(event_type, timestamp);
`);

export class AnalyticsEngine {
  private insertEventStmt = db.prepare(`
    INSERT INTO analytics_events (event_type, event_data, chat_jid, sender_jid, timestamp)
    VALUES (?, ?, ?, ?, ?)
  `);

  private reportInterval: NodeJS.Timeout | null = null;

  /**
   * Records an analytics event into SQLite
   */
  public trackEvent(type: string, data?: any, chatJid?: string, senderJid?: string): void {
    try {
      const serializedData =
        data !== undefined
          ? typeof data === 'string'
            ? data
            : JSON.stringify(data)
          : null;

      this.insertEventStmt.run(
        type,
        serializedData,
        chatJid ?? null,
        senderJid ?? null,
        Date.now()
      );
    } catch (err) {
      console.error('[AnalyticsEngine] Error tracking event:', err);
    }
  }

  /**
   * Generates a 24-hour summary report of bot usage, activity, and health
   */
  public generateDailySummary(): string {
    const since = Date.now() - 24 * 60 * 60 * 1000;

    // 1. Total Messages Handled
    let totalMessages = 0;
    try {
      const msgRow = db
        .prepare(`SELECT COUNT(*) as count FROM chat_logs WHERE timestamp >= ?`)
        .get(since) as { count: number } | undefined;
      const eventMsgRow = db
        .prepare(
          `SELECT COUNT(*) as count FROM analytics_events 
           WHERE timestamp >= ? AND event_type IN ('message', 'incoming_message', 'message_processed')`
        )
        .get(since) as { count: number } | undefined;

      totalMessages = Math.max(msgRow?.count || 0, eventMsgRow?.count || 0);
    } catch {
      totalMessages = 0;
    }

    // 2. Top 5 Most Active Users
    let topUsers: Array<{ name: string; count: number }> = [];
    try {
      const userRows = db
        .prepare(
          `SELECT COALESCE(sender_name, sender_jid) as name, COUNT(*) as count
           FROM chat_logs
           WHERE timestamp >= ? AND sender_jid IS NOT NULL AND sender_jid != '' AND sender_jid != 'bot'
           GROUP BY sender_jid
           ORDER BY count DESC
           LIMIT 5`
        )
        .all(since) as unknown as Array<{ name: string; count: number }>;

      if (userRows.length > 0) {
        topUsers = userRows;
      } else {
        const eventUserRows = db
          .prepare(
            `SELECT sender_jid as name, COUNT(*) as count
             FROM analytics_events
             WHERE timestamp >= ? AND sender_jid IS NOT NULL AND sender_jid != '' AND sender_jid != 'bot'
             GROUP BY sender_jid
             ORDER BY count DESC
             LIMIT 5`
          )
          .all(since) as unknown as Array<{ name: string; count: number }>;
        topUsers = eventUserRows;
      }
    } catch {
      topUsers = [];
    }

    // 3. Top 5 Most Used Tools / Plugins
    let topTools: Array<{ tool_name: string; count: number }> = [];
    try {
      const toolRows = db
        .prepare(
          `SELECT COALESCE(event_data, event_type) as tool_name, COUNT(*) as count
           FROM analytics_events
           WHERE timestamp >= ? 
             AND (event_type = 'tool_used' OR event_type = 'tool_call' OR event_type = 'tool_execution' OR event_type LIKE 'tool%')
           GROUP BY tool_name
           ORDER BY count DESC
           LIMIT 5`
        )
        .all(since) as unknown as Array<{ tool_name: string; count: number }>;
      topTools = toolRows;
    } catch {
      topTools = [];
    }

    // 4. Error Count
    const healthReport = healthMonitor.getHealthReport();
    let dbErrors = 0;
    try {
      const errRow = db
        .prepare(
          `SELECT COUNT(*) as count FROM analytics_events 
           WHERE timestamp >= ? AND event_type IN ('error', 'exception')`
        )
        .get(since) as { count: number } | undefined;
      dbErrors = errRow?.count || 0;
    } catch {
      dbErrors = 0;
    }
    const errorCount = Math.max(healthReport.errors, dbErrors);

    // 5. Uptime & Resource Stats
    const totalSecs = healthReport.uptime;
    const days = Math.floor(totalSecs / 86400);
    const hours = Math.floor((totalSecs % 86400) / 3600);
    const minutes = Math.floor((totalSecs % 3600) / 60);
    const uptimeStr = `${days > 0 ? `${days}d ` : ''}${hours}h ${minutes}m`;
    const heapMb = (healthReport.memoryUsage.heapUsed / (1024 * 1024)).toFixed(1);
    const rssMb = (healthReport.memoryUsage.rss / (1024 * 1024)).toFixed(1);

    // Build Formatted Output
    const lines: string[] = [
      '📊 *Daily Analytics Summary (Last 24 Hours)*',
      '━━━━━━━━━━━━━━━━━━━━━━━━━━',
      `⏱ *Uptime*: ${uptimeStr} | *Socket*: ${healthReport.isConnected ? '🟢 Connected' : '🔴 Disconnected'}`,
      `💾 *Memory*: Heap ${heapMb} MB / RSS ${rssMb} MB`,
      `📩 *Messages Handled*: ${totalMessages}`,
      `⚠️ *Errors Recorded*: ${errorCount}`,
      '',
      '👥 *Top 5 Active Users*:',
    ];

    if (topUsers.length === 0) {
      lines.push('  _(No user activity recorded in window)_');
    } else {
      topUsers.forEach((u, i) => {
        let displayName = u.name;
        if (displayName.includes('@')) {
          const rawId = displayName.split('@')[0].split(':')[0];
          displayName = rawId.length > 13 ? 'Member' : `@${rawId}`;
        } else if (/^\d{13,}$/.test(displayName)) {
          displayName = 'Member';
        }
        lines.push(`  ${i + 1}. ${displayName} — ${u.count} msgs`);
      });
    }

    lines.push('');
    lines.push('🛠 *Top 5 Tools / Plugins*:');
    if (topTools.length === 0) {
      lines.push('  _(No tool usage recorded in window)_');
    } else {
      topTools.forEach((t, i) => {
        lines.push(`  ${i + 1}. ${t.tool_name} — ${t.count} calls`);
      });
    }

    lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━');
    lines.push(`_Generated at: ${new Date().toISOString().replace('T', ' ').slice(0, 19)} UTC_`);

    return lines.join('\n');
  }

  /**
   * Starts periodic dispatch of the analytics summary to the bot owner every 6 hours
   */
  public startPeriodicReports(sock: WASocket, ownerJid: string): void {
    if (this.reportInterval) {
      clearInterval(this.reportInterval);
    }

    let cleanOwner = (ownerJid || '').trim();
    if (!cleanOwner) {
      console.warn('[AnalyticsEngine] No valid ownerJid provided. Periodic reports will not be sent.');
      return;
    }

    if (!cleanOwner.includes('@')) {
      let digits = cleanOwner.replace(/[^0-9]/g, '');
      if (digits.startsWith('0') && digits.length === 11 && /^0[789][01]\d{8}$/.test(digits)) {
        digits = '234' + digits.slice(1);
      }
      cleanOwner = digits;
    }

    const targetJid = cleanOwner.includes('@') ? cleanOwner : `${cleanOwner}@s.whatsapp.net`;
    console.log(`[AnalyticsEngine] Starting periodic analytics reports every 6 hours to ${targetJid}`);

    // Every 6 hours (6 * 60 * 60 * 1000 ms)
    this.reportInterval = setInterval(async () => {
      try {
        const summary = this.generateDailySummary();
        await sock.sendMessage(targetJid, { text: summary });
        console.log(`[AnalyticsEngine] Successfully sent periodic analytics report to ${targetJid}`);
      } catch (err: any) {
        console.error('[AnalyticsEngine] Failed to send periodic report to owner:', err.message);
      }
    }, 6 * 60 * 60 * 1000);

    this.reportInterval.unref();
  }

  public stopPeriodicReports(): void {
    if (this.reportInterval) {
      clearInterval(this.reportInterval);
      this.reportInterval = null;
    }
  }
}

export const analyticsEngine = new AnalyticsEngine();
