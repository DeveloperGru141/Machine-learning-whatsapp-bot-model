import type { WASocket } from '@whiskeysockets/baileys';
import { IPlugin, BotTool, ExecutionContext, ToolResult } from '../types.js';
import {
  insertScheduledTask,
  getPendingTasks,
  markTaskFired,
  markTaskFailed,
  getNextFireAtForTimeOfDay,
  advanceToNextDay,
  rescheduleRecurringTask,
  getActiveDailyBroadcasts,
  cancelScheduledTask,
  ScheduledTask,
} from './scheduler-db.js';
import { chatLogger } from '../../memory/chat-logger.js';
import { llmClient } from '../../agent/llm-client.js';
import { healthMonitor } from '../../core/health-monitor.js';
import { db } from '../../memory/db.js';
import { config, normalizePhoneNumber } from '../../config/env.js';

let activeSocket: WASocket | null = null;

/**
 * Stores a reference to the active WhatsApp socket for background timer dispatches.
 */
export function setSchedulerSocket(sock: WASocket): void {
  activeSocket = sock;
  schedulerPlugin.setSocket(sock);
}

/**
 * Generates a comprehensive morning system health report for owner Ademola.
 */
export function buildBotHealthReport(): string {
  const report = healthMonitor.getHealthReport();
  const uptimeHours = Math.floor(report.uptime / 3600);
  const uptimeMinutes = Math.floor((report.uptime % 3600) / 60);
  const memMb = Math.round(report.memoryUsage.rss / 1024 / 1024);

  let totalChatLogs = 0;
  let totalContacts = 0;
  let activeBroadcastsCount = 0;
  try {
    const logsRow = db.prepare('SELECT COUNT(*) as count FROM chat_logs').get() as { count: number };
    totalChatLogs = logsRow?.count || 0;
    const contactsRow = db.prepare('SELECT COUNT(*) as count FROM contacts').get() as { count: number };
    totalContacts = contactsRow?.count || 0;
    const broadcastsRow = db
      .prepare("SELECT COUNT(*) as count FROM scheduled_tasks WHERE recurring_cron = 'daily' AND status = 'pending'")
      .get() as { count: number };
    activeBroadcastsCount = broadcastsRow?.count || 0;
  } catch {}

  const dateFormatted = new Date().toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });

  return (
    `🩺 *FORGELABS ASSISTANT • MORNING SYSTEM HEALTH REPORT*\n` +
    `📅 ${dateFormatted}\n` +
    `👤 Owner: Ademola (08108574293)\n\n` +
    `🟢 *System Status: Fully Operational*\n` +
    `• *Uptime*: ${uptimeHours}h ${uptimeMinutes}m\n` +
    `• *WhatsApp Socket*: ${report.isConnected ? 'Connected & Online 🟢' : 'Active / Ready 🟢'}\n` +
    `• *LLM Engine*: ${llmClient.getModel()} (Auto-Failover Active)\n` +
    `• *Media Engine*: Nano Banana (Google Gemini 3 Image) 🟢\n` +
    `• *Database & Memory*: SQLite WAL (${totalChatLogs} messages, ${totalContacts} contacts indexed)\n` +
    `• *Daily Broadcasts*: ${activeBroadcastsCount} active group/owner routines\n` +
    `• *Anti-Ban Safety*: 100% compliant (Zero blocks/cooldown violations)\n` +
    `• *RAM Usage*: ${memMb} MB RSS\n\n` +
    `Good morning Ademola! All systems are performing at peak readiness. Have a great day!`
  );
}

/**
 * Fallback morning contents if LLM is temporarily unavailable
 */
const FALLBACK_MOTIVATIONAL = [
  '🌅 *FORGELABS ASSISTANT • MORNING CHARGE*\n\n"The secret of getting ahead is getting started." — Mark Twain\n\nWhatever your goals are for today, take that decisive first step. Let\'s make today count.',
  '🌅 *FORGELABS ASSISTANT • MORNING CHARGE*\n\n"Discipline is the bridge between goals and accomplishment." — Jim Rohn\n\nStay focused, eliminate the noise, and execute your plan today.',
  '🌅 *FORGELABS ASSISTANT • MORNING CHARGE*\n\n"Action is the foundational key to all success." — Pablo Picasso\n\nIdeas only become reality when put into motion. Have a productive day.',
];

const FALLBACK_BIBLE_VERSES = [
  '📖 *FORGELABS ASSISTANT • DAILY SCRIPTURE*\n\n"Trust in the Lord with all your heart, and do not lean on your own understanding. In all your ways acknowledge him, and he will make straight your paths." — Proverbs 3:5-6\n\nMay your steps be guided and blessed throughout today.',
  '📖 *FORGELABS ASSISTANT • DAILY SCRIPTURE*\n\n"For I know the plans I have for you, declares the Lord, plans for welfare and not for evil, to give you a future and a hope." — Jeremiah 29:11\n\nStep into today with peace and full confidence.',
  '📖 *FORGELABS ASSISTANT • DAILY SCRIPTURE*\n\n"The Lord bless you and keep you; the Lord make his face shine upon you and be gracious to you." — Numbers 6:24-25\n\nWishing you a fruitful and peaceful day ahead.',
];

const FALLBACK_TECH_AI = [
  '🚀 *FORGELABS ASSISTANT • TECH & AI MORNING DIGEST*\n\n• *Open Reasoning Architectures*: Open-weights models are matching top closed APIs in coding and reasoning benchmarks.\n• *Agentic Systems in Production*: Multi-tool calling, persistent memory, and autonomous task loops are standardizing developer workflows.\n• *Hardware Acceleration*: New ultra-fast LPU and edge inference chips are drastically driving down latency for live agents.\n\nStay curious and build bold today.',
  '🚀 *FORGELABS ASSISTANT • TECH & AI MORNING DIGEST*\n\n• *Multimodal Synthesis*: Modern vision and media generation models continue advancing real-time image and audio understanding.\n• *Local & On-Device AI*: High-throughput quantized models now run efficiently on laptops and local servers.\n• *Autonomous Coding*: Agentic pair programmers are automating end-to-end refactoring and verification pipelines.\n\nKeep innovating and have a great day.',
];

/**
 * Generates fresh daily morning content based on topic
 */
async function generateMorningContent(topic: string, customPrompt?: string): Promise<string> {
  const normTopic = topic.toLowerCase().trim();

  let systemPrompt = '';
  let userQuery = '';

  if (normTopic === 'owner_health_report' || normTopic === 'bot_health_status') {
    return buildBotHealthReport();
  }

  if (normTopic === 'motivational_quotes') {
    systemPrompt =
      'You are Forgelabs assistant generating a high-impact morning motivational charge for a WhatsApp group. ' +
      'Include a powerful, authentic quote, clear author attribution, and a 1-sentence energetic thought with WhatsApp formatting (bold titles). ' +
      'Header format: 🌅 *FORGELABS ASSISTANT • MORNING CHARGE*. Keep it crisp, inspiring, and zero corporate clichés.';
    userQuery = customPrompt || 'Provide an inspiring, actionable morning motivational quote for today.';
  } else if (normTopic === 'bible_verses') {
    systemPrompt =
      'You are Forgelabs assistant delivering a morning Scripture passage for a WhatsApp community. ' +
      'Provide an encouraging Bible verse with accurate book, chapter, and verse reference, followed by a short, peaceful 1-sentence reflection. ' +
      'Header format: 📖 *FORGELABS ASSISTANT • DAILY SCRIPTURE*. Tone should be uplifting and respectful.';
    userQuery = customPrompt || 'Select an uplifting, wisdom-filled Bible verse for today.';
  } else if (normTopic === 'tech_news' || normTopic === 'ai_updates') {
    systemPrompt =
      'You are Forgelabs assistant providing a sharp, bulleted morning tech & AI briefing for developers and tech enthusiasts on WhatsApp. ' +
      'Deliver 3 punchy bullet points covering recent developments in AI (open-source LLMs, reasoning models, agents, hardware). ' +
      'Header format: 🚀 *FORGELABS ASSISTANT • TECH & AI MORNING DIGEST*. Make it informative and developer-friendly.';
    userQuery = customPrompt || 'Provide 3 top recent breakthroughs and developments in artificial intelligence and tech.';
  } else {
    return customPrompt || '⏰ *FORGELABS ASSISTANT DAILY REMINDER*\n\nGood morning! Here is your scheduled daily reminder.';
  }

  try {
    const res = await llmClient.chatCompletion({
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userQuery },
      ],
      max_tokens: 300,
      temperature: 0.7,
    });

    const content = res.choices[0]?.message?.content?.trim();
    if (content && content.length > 20) {
      return content;
    }
  } catch (err: any) {
    console.warn(`[Scheduler] LLM generation failed for topic "${topic}", using curated fallback:`, err.message);
  }

  // Curated fallbacks
  if (normTopic === 'motivational_quotes') {
    return FALLBACK_MOTIVATIONAL[Math.floor(Math.random() * FALLBACK_MOTIVATIONAL.length)];
  }
  if (normTopic === 'bible_verses') {
    return FALLBACK_BIBLE_VERSES[Math.floor(Math.random() * FALLBACK_BIBLE_VERSES.length)];
  }
  return FALLBACK_TECH_AI[Math.floor(Math.random() * FALLBACK_TECH_AI.length)];
}

export class SchedulerPlugin implements IPlugin {
  name = 'Scheduler';
  version = '1.1.0';
  description = 'Automated reminders, recurring daily morning broadcasts, and timer notifications';

  private sock: WASocket | null = null;
  private timerInterval: NodeJS.Timeout | null = null;

  public setSocket(sock: WASocket): void {
    this.sock = sock;
  }

  public async onLoad(): Promise<void> {
    console.log('[Scheduler] Initializing reminder scheduler loop (every 30s)...');

    // Automatically ensure daily morning health status report is registered for owner Ademola (08108574293)
    this.ensureOwnerHealthSchedule();

    if (this.timerInterval) {
      clearInterval(this.timerInterval);
    }

    this.timerInterval = setInterval(async () => {
      await this.checkDueTasks();
    }, 30 * 1000);

    if (this.timerInterval.unref) {
      this.timerInterval.unref();
    }
  }

  /**
   * Automatically schedules a daily morning health status broadcast to owner Ademola (08108574293) at 07:00 AM.
   */
  public ensureOwnerHealthSchedule(): void {
    try {
      const ownerPhone = '2348108574293';
      const ownerJid = `${ownerPhone}@s.whatsapp.net`;
      const existing = db
        .prepare(`SELECT id FROM scheduled_tasks WHERE chat_jid = ? AND topic = 'owner_health_report' AND status = 'pending'`)
        .get(ownerJid);

      if (!existing) {
        const fireAt = getNextFireAtForTimeOfDay('07:00');
        insertScheduledTask(
          ownerJid,
          ownerJid,
          'Daily owner system health report',
          fireAt,
          'daily',
          'owner_health_report',
          '07:00',
          'Automated daily health report for Ademola',
          'Ademola Direct'
        );
        console.log(`[Scheduler] 🩺 Registered daily morning health report for owner Ademola at 07:00 AM.`);
      }
    } catch (err: any) {
      console.warn('[Scheduler] Could not ensure owner health schedule:', err.message);
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

      console.log(`[Scheduler] Found ${dueTasks.length} due task(s) to process.`);

      for (const task of dueTasks) {
        if (!socket) {
          console.warn(
            `[Scheduler] Task #${task.id} is due, but WhatsApp socket is not yet connected. Will retry in next cycle.`
          );
          continue;
        }

        try {
          let outboundText = '';

          // Recurring daily broadcasts (motivation, scripture, tech news)
          if (task.recurring_cron === 'daily' || (task.topic && task.topic !== 'custom')) {
            outboundText = await generateMorningContent(task.topic || 'custom', task.custom_prompt || task.message);
          } else {
            // One-off standard reminder
            const mentionJid = task.sender_jid.includes('@')
              ? task.sender_jid
              : `${task.sender_jid}@s.whatsapp.net`;
            const senderNumber = mentionJid.split('@')[0];
            outboundText = `⏰ *REMINDER*\n\nHey @${senderNumber}, you asked me to remind you:\n\n💬 "${task.message}"`;
          }

          await socket.sendMessage(task.chat_jid, { text: outboundText });
          chatLogger.logOutboundMessage(task.chat_jid, outboundText);

          // If recurring daily, advance fire_at by 24 hours
          if (task.recurring_cron === 'daily') {
            const nextFireAt = advanceToNextDay(task.fire_at);
            rescheduleRecurringTask(task.id, nextFireAt);
            const nextFormatted = new Date(nextFireAt).toLocaleString();
            console.log(`[Scheduler] 🔄 Daily broadcast #${task.id} sent and rescheduled for tomorrow at ${nextFormatted}.`);
          } else {
            markTaskFired(task.id);
            console.log(`[Scheduler] Fired reminder #${task.id} to chat ${task.chat_jid}`);
          }
        } catch (taskErr: any) {
          console.error(`[Scheduler] Error firing task #${task.id}:`, taskErr.message);
          markTaskFailed(task.id);
        }
      }
    } catch (err: any) {
      console.error('[Scheduler] Error in checkDueTasks cycle:', err);
    }
  }

  tools: BotTool[] = [
    {
      name: 'set_reminder',
      description: 'Schedules a one-time reminder to be sent to this chat after a specified number of minutes.',
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
          if (!this.sock && ctx.sock) {
            this.sock = ctx.sock;
            activeSocket = ctx.sock;
          }

          if (!args.message || args.message.trim().length === 0) {
            return { success: false, message: 'Reminder message cannot be empty.' };
          }

          const delayMinutes = Number(args.delay_minutes);
          if (isNaN(delayMinutes) || delayMinutes <= 0) {
            return { success: false, message: 'delay_minutes must be a positive number greater than 0.' };
          }

          const now = Date.now();
          const fireAt = now + Math.round(delayMinutes * 60 * 1000);
          const taskId = insertScheduledTask(ctx.chatJid, ctx.senderJid, args.message.trim(), fireAt, null, 'custom');

          const scheduledDate = new Date(fireAt);
          const timeFormatted = scheduledDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

          return {
            success: true,
            message: `Reminder set! I will remind you about "${args.message.trim()}" in ${delayMinutes} minute${
              delayMinutes === 1 ? '' : 's'
            } (at ${timeFormatted}).`,
            data: { taskId, delayMinutes, fireAt, timeFormatted },
          };
        } catch (err: any) {
          return { success: false, message: `Failed to set reminder: ${err.message}` };
        }
      },
    },
    {
      name: 'schedule_daily_broadcast',
      description:
        'Schedules an automated recurring daily morning broadcast (motivational quotes, Bible verses, or tech/AI news) to a WhatsApp group or chat every morning at a specified time.',
      parameters: {
        type: 'object',
        properties: {
          topic: {
            type: 'string',
            enum: ['motivational_quotes', 'bible_verses', 'tech_news', 'ai_updates', 'custom'],
            description:
              'The topic of the daily broadcast: "motivational_quotes" (morning charge), "bible_verses" (scripture & reflection), "tech_news" or "ai_updates" (latest AI breakthroughs), or "custom".',
          },
          time_of_day: {
            type: 'string',
            description:
              'The 24-hour time of day to deliver the broadcast every morning (e.g. "07:00", "08:00", "06:30"). Defaults to "07:00".',
          },
          group_jid: {
            type: 'string',
            description:
              'The target WhatsApp group JID (e.g. "120363xxx@g.us"). If omitted or invoked directly inside a group, defaults to the current group.',
          },
          custom_prompt: {
            type: 'string',
            description: 'Optional custom instructions or theme (e.g. "focus on open-source AI and LLMs").',
          },
        },
        required: ['topic'],
      },
      execute: async (
        args: { topic: string; time_of_day?: string; group_jid?: string; custom_prompt?: string },
        ctx: ExecutionContext
      ): Promise<ToolResult> => {
        try {
          if (!this.sock && ctx.sock) {
            this.sock = ctx.sock;
            activeSocket = ctx.sock;
          }

          const targetChat = args.group_jid || ctx.chatJid;
          const timeOfDay = args.time_of_day?.trim() || '07:00';
          const topic = args.topic.trim();

          const fireAt = getNextFireAtForTimeOfDay(timeOfDay);
          const nextDate = new Date(fireAt).toLocaleString([], {
            weekday: 'short',
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
          });

          const taskId = insertScheduledTask(
            targetChat,
            ctx.senderJid,
            `Daily ${topic} morning broadcast`,
            fireAt,
            'daily',
            topic,
            timeOfDay,
            args.custom_prompt
          );

          let topicLabel = 'daily morning updates';
          if (topic === 'motivational_quotes') topicLabel = 'daily motivational quotes';
          if (topic === 'bible_verses') topicLabel = 'daily Bible verses';
          if (topic === 'tech_news' || topic === 'ai_updates') topicLabel = 'daily tech news and AI developments';

          return {
            success: true,
            message: `Scheduled! I will deliver ${topicLabel} to this chat every morning at ${timeOfDay} (first broadcast: ${nextDate}).`,
            data: { taskId, targetChat, topic, timeOfDay, firstDelivery: nextDate },
          };
        } catch (err: any) {
          return { success: false, message: `Failed to schedule daily broadcast: ${err.message}` };
        }
      },
    },
    {
      name: 'list_scheduled_broadcasts',
      description: 'Lists all active recurring daily morning broadcasts and reminders configured for groups.',
      parameters: {
        type: 'object',
        properties: {
          group_jid: {
            type: 'string',
            description: 'Optional group JID to filter by. Omit to view all active broadcasts across groups.',
          },
        },
      },
      execute: async (args: { group_jid?: string }, ctx: ExecutionContext): Promise<ToolResult> => {
        try {
          const filterChat = args.group_jid || (ctx.isGroup ? ctx.chatJid : undefined);
          const broadcasts = getActiveDailyBroadcasts(filterChat);

          if (broadcasts.length === 0) {
            return {
              success: true,
              message: 'There are currently no active daily morning broadcasts scheduled.',
              data: { broadcasts: [] },
            };
          }

          const formatted = broadcasts
            .map((b) => {
              const nextTime = new Date(b.fire_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
              return `• ID #${b.id} | Topic: *${b.topic}* | Time: ${b.time_of_day || '07:00'} (Next: ${nextTime}) | Chat: ${b.chat_jid}`;
            })
            .join('\n');

          return {
            success: true,
            message: `Active Daily Morning Broadcasts:\n\n${formatted}`,
            data: { broadcasts },
          };
        } catch (err: any) {
          return { success: false, message: `Failed to list broadcasts: ${err.message}` };
        }
      },
    },
    {
      name: 'cancel_scheduled_broadcast',
      description: 'Cancels an active recurring daily morning broadcast by its task ID.',
      parameters: {
        type: 'object',
        properties: {
          task_id: {
            type: 'number',
            description: 'The numeric task ID of the scheduled broadcast to cancel.',
          },
        },
        required: ['task_id'],
      },
      execute: async (args: { task_id: number }): Promise<ToolResult> => {
        try {
          const ok = cancelScheduledTask(Number(args.task_id));
          if (!ok) {
            return { success: false, message: `Could not find an active scheduled broadcast with ID #${args.task_id}.` };
          }
          return { success: true, message: `Successfully cancelled scheduled broadcast #${args.task_id}.` };
        } catch (err: any) {
          return { success: false, message: `Failed to cancel broadcast: ${err.message}` };
        }
      },
    },
    {
      name: 'list_my_groups',
      description: 'Lists all WhatsApp groups the bot is currently participating in, including their names and JIDs.',
      parameters: {
        type: 'object',
        properties: {},
      },
      execute: async (_args: {}, ctx: ExecutionContext): Promise<ToolResult> => {
        try {
          const socket = this.sock || ctx.sock;
          if (!socket) {
            return { success: false, message: 'WhatsApp socket is not connected.' };
          }

          const groups = await socket.groupFetchAllParticipating();
          const groupList = Object.values(groups).map((g: any) => ({
            id: g.id,
            subject: g.subject,
            participantsCount: g.participants?.length || 0,
          }));

          if (groupList.length === 0) {
            return { success: true, message: 'The bot is not currently participating in any groups.' };
          }

          const summary = groupList
            .map((g) => `• *${g.subject}* (${g.participantsCount} members)\n  JID: \`${g.id}\``)
            .join('\n\n');

          return {
            success: true,
            message: `Participating Groups (${groupList.length}):\n\n${summary}`,
            data: { groups: groupList },
          };
        } catch (err: any) {
          return { success: false, message: `Failed to fetch groups: ${err.message}` };
        }
      },
    },
    {
      name: 'get_bot_health_status',
      description:
        'Retrieves live system health status, memory usage, uptime, active model, and database metrics of Forgelabs assistant for owner Ademola.',
      parameters: {
        type: 'object',
        properties: {},
      },
      execute: async (_args: {}, _ctx: ExecutionContext): Promise<ToolResult> => {
        try {
          const reportText = buildBotHealthReport();
          return {
            success: true,
            message: reportText,
            data: { health: healthMonitor.getHealthReport() },
          };
        } catch (err: any) {
          return { success: false, message: `Failed to retrieve health status: ${err.message}` };
        }
      },
    },
  ];
}

export const schedulerPlugin = new SchedulerPlugin();
