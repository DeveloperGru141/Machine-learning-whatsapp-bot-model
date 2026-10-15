import type { WASocket } from '@whiskeysockets/baileys';
import { IPlugin, BotTool, ExecutionContext, ToolResult } from '../types.js';
import {
  insertScheduledTask,
  getPendingTasks,
  markTaskFired,
  ScheduledTask,
} from './scheduler-db.js';

let activeSocket: WASocket | null = null;

/**
 * Stores a reference to the active WhatsApp socket for background timer dispatches.
 */
export function setSchedulerSocket(sock: WASocket): void {
  activeSocket = sock;
  schedulerPlugin.setSocket(sock);
}

export class SchedulerPlugin implements IPlugin {
  name = 'Scheduler';
  version = '1.0.0';
  description = 'Automated reminders, scheduled messages, and timer notifications';

  private sock: WASocket | null = null;
  private timerInterval: NodeJS.Timeout | null = null;

  public setSocket(sock: WASocket): void {
    this.sock = sock;
  }

  public async onLoad(): Promise<void> {
    console.log('[Scheduler] Initializing reminder scheduler loop (every 30s)...');

    // Clear any existing interval
    if (this.timerInterval) {
      clearInterval(this.timerInterval);
    }

    // Check every 30 seconds
    this.timerInterval = setInterval(async () => {
      await this.checkDueTasks();
    }, 30 * 1000);

    if (this.timerInterval.unref) {
      this.timerInterval.unref();
    }
  }

  public async onUnload(): Promise<void> {
    if (this.timerInterval) {
      clearInterval(this.timerInterval);
      this.timerInterval = null;
      console.log('[Scheduler] Stopped reminder scheduler loop.');
    }
  }

  /**
   * Scans the database for due tasks and sends reminder messages to the respective chats.
   */
  public async checkDueTasks(): Promise<void> {
    try {
      const socket = this.sock || activeSocket;
      const now = Date.now();
      const dueTasks = getPendingTasks(now);

      if (dueTasks.length === 0) return;

      console.log(`[Scheduler] Found ${dueTasks.length} due reminder(s) to process.`);

      for (const task of dueTasks) {
        if (!socket) {
          console.warn(
            `[Scheduler] Reminder #${task.id} is due, but WhatsApp socket is not yet connected. Will retry in next cycle.`
          );
          continue;
        }

        try {
          // Normalize sender JID for mention
          const mentionJid = task.sender_jid.includes('@')
            ? task.sender_jid
            : `${task.sender_jid}@s.whatsapp.net`;
          const senderNumber = mentionJid.split('@')[0];

          const reminderBody = `⏰ *REMINDER*\n\nHey @${senderNumber}, you asked me to remind you:\n\n💬 "${task.message}"`;

          await socket.sendMessage(task.chat_jid, {
            text: reminderBody,
            mentions: [mentionJid],
          });

          markTaskFired(task.id);
          console.log(`[Scheduler] Fired reminder #${task.id} to chat ${task.chat_jid}`);
        } catch (taskErr: any) {
          console.error(`[Scheduler] Error firing reminder #${task.id}:`, taskErr.message);
        }
      }
    } catch (err: any) {
      console.error('[Scheduler] Error in checkDueTasks cycle:', err);
    }
  }

  tools: BotTool[] = [
    {
      name: 'set_reminder',
      description:
        'Schedules a reminder or message to be sent to this chat after a specified number of minutes.',
      parameters: {
        type: 'object',
        properties: {
          message: {
            type: 'string',
            description: 'The reminder content or message to deliver.',
          },
          delay_minutes: {
            type: 'number',
            description: 'How many minutes from now the reminder should trigger (e.g. 5, 10, 60).',
          },
        },
        required: ['message', 'delay_minutes'],
      },
      execute: async (
        args: { message: string; delay_minutes: number },
        ctx: ExecutionContext
      ): Promise<ToolResult> => {
        try {
          // Cache the execution socket if not yet set
          if (!this.sock && ctx.sock) {
            this.sock = ctx.sock;
            activeSocket = ctx.sock;
          }

          if (!args.message || args.message.trim().length === 0) {
            return {
              success: false,
              message: 'Reminder message cannot be empty.',
            };
          }

          const delayMinutes = Number(args.delay_minutes);
          if (isNaN(delayMinutes) || delayMinutes <= 0) {
            return {
              success: false,
              message: 'delay_minutes must be a positive number greater than 0.',
            };
          }

          const now = Date.now();
          const fireAt = now + Math.round(delayMinutes * 60 * 1000);
          const taskId = insertScheduledTask(ctx.chatJid, ctx.senderJid, args.message.trim(), fireAt);

          const scheduledDate = new Date(fireAt);
          const timeFormatted = scheduledDate.toLocaleTimeString([], {
            hour: '2-digit',
            minute: '2-digit',
          });

          console.log(
            `[Scheduler] Scheduled reminder #${taskId} for ${ctx.chatJid} at ${timeFormatted} (+${delayMinutes}m): "${args.message}"`
          );

          return {
            success: true,
            message: `Reminder set! I will remind you about "${args.message.trim()}" in ${delayMinutes} minute${
              delayMinutes === 1 ? '' : 's'
            } (at ${timeFormatted}).`,
            data: {
              taskId,
              message: args.message.trim(),
              delayMinutes,
              fireAt,
              timeFormatted,
            },
          };
        } catch (err: any) {
          console.error('[Scheduler] Error setting reminder:', err);
          return {
            success: false,
            message: `Failed to set reminder: ${err.message}`,
          };
        }
      },
    },
  ];
}

export const schedulerPlugin = new SchedulerPlugin();
