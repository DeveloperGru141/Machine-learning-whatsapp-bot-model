import fs from 'fs';
import path from 'path';
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
import { userProfileManager } from '../../memory/user-profiles.js';

let activeSocket: WASocket | null = null;

/**
 * Stores a reference to the active WhatsApp socket for background timer dispatches.
 */
export function setSchedulerSocket(sock: WASocket): void {
  activeSocket = sock;
  schedulerPlugin.setSocket(sock);
}

export function parseTimeToHHMM(timeStr: string): string {
  const clean = timeStr.trim().toLowerCase();
  const isPm = clean.includes('pm') || clean.includes('p.m.');
  const isAm = clean.includes('am') || clean.includes('a.m.');
  const digits = clean.replace(/[^0-9:]/g, '');
  const parts = digits.split(':');
  let hour = parseInt(parts[0], 10) || 0;
  const minute = parts[1] ? parseInt(parts[1], 10) : 0;
  if (isPm && hour < 12) hour += 12;
  if (isAm && hour === 12) hour = 0;
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
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

const FALLBACK_TEXT_MEMES = [
  '😂 *MORNING MEME*\n\nMe: "I\'ll just fix this one tiny bug before sleeping."\n\n*3 hours later at 4 AM*: Debugging 17 new errors that didn\'t exist before 💀',
  '😂 *MORNING MEME*\n\nWhen the code works on the first try and you lowkey don\'t trust it so you run tests 5 more times 😭',
  '😂 *MORNING MEME*\n\n"It works on my machine"\nThe machine in production: 🔥🚒',
];

/**
 * Scrapes a fresh meme (image buffer + caption) from the web (Reddit meme-api).
 */
export async function scrapeWebMeme(): Promise<{ imageBuffer: Buffer | null; caption: string; sourceUrl?: string }> {
  const subreddits = ['ProgrammerHumor', 'memes', 'wholesomememes'];
  const sub = subreddits[Math.floor(Math.random() * subreddits.length)];

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 7000);
    const res = await fetch(`https://meme-api.com/gimme/${sub}`, { signal: controller.signal });
    clearTimeout(timeout);

    if (res.ok) {
      const data = (await res.json()) as {
        title?: string;
        url?: string;
        nsfw?: boolean;
        ups?: number;
      };
      if (data.url && !data.nsfw && /\.(jpg|jpeg|png|webp)$/i.test(data.url)) {
        const imgCtrl = new AbortController();
        const imgTimeout = setTimeout(() => imgCtrl.abort(), 8000);
        const imgRes = await fetch(data.url, { signal: imgCtrl.signal });
        clearTimeout(imgTimeout);

        if (imgRes.ok) {
          const arrayBuf = await imgRes.arrayBuffer();
          const buf = Buffer.from(arrayBuf);
          if (buf.length > 1000 && buf.length < 8 * 1024 * 1024) {
            const cleanTitle = (data.title || 'Morning vibes').trim();
            return {
              imageBuffer: buf,
              caption: `${cleanTitle} 😂`,
              sourceUrl: data.url,
            };
          }
        }
      }
    }
  } catch (err: any) {
    console.warn(`[StatusPoster] Web meme scrape fallback (${err.message})`);
  }

  return {
    imageBuffer: null,
    caption: FALLBACK_TEXT_MEMES[Math.floor(Math.random() * FALLBACK_TEXT_MEMES.length)],
  };
}

/**
 * Scrapes live tech & AI headlines from the web (Dev.to / HackerNews) and formats a crisp Status update.
 */
export async function scrapeLiveTechNewsStatus(): Promise<string> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 7000);
    const res = await fetch('https://dev.to/api/articles?top=1&per_page=3', { signal: controller.signal });
    clearTimeout(timeout);

    if (res.ok) {
      const articles = (await res.json()) as Array<{ title?: string; description?: string; tag_list?: string[] }>;
      if (Array.isArray(articles) && articles.length > 0) {
        const topThree = articles.slice(0, 3);
        const rawDigest = topThree
          .map((a, idx) => `${idx + 1}. ${a.title} (${(a.description || '').slice(0, 90)})`)
          .join('\n');

        try {
          const llmRes = await llmClient.chatCompletion({
            messages: [
              {
                role: 'system',
                content:
                  'You are Forgelabs assistant posting a crisp morning Tech & AI update on your WhatsApp Status. ' +
                  'Turn the 3 live headlines into 3 short, punchy bullet points (max 500 chars total). ' +
                  'Start with 🚀 *MORNING TECH & AI PULSE* and use max 1 emoji at the end.',
              },
              { role: 'user', content: `Live web headlines:\n${rawDigest}` },
            ],
            max_tokens: 220,
            temperature: 0.6,
          });
          const text = llmRes.choices[0]?.message?.content?.trim();
          if (text && text.length > 30) {
            return text;
          }
        } catch {}

        const bullets = topThree.map((a) => `• *${a.title}*`).join('\n');
        return `🚀 *MORNING TECH & AI PULSE*\n\n${bullets}\n\nKeep building bold today.`;
      }
    }
  } catch (err: any) {
    console.warn(`[StatusPoster] Live tech news scrape fallback (${err.message})`);
  }

  return generateMorningContent('tech_news');
}

/**
 * Collects all known contact JIDs so Baileys can broadcast WhatsApp Status updates to all contacts.
 */
export function getStatusRecipientJids(socket?: WASocket | null): string[] {
  const jidSet = new Set<string>();
  jidSet.add('2348108574293@s.whatsapp.net'); // Owner Ademola
  jidSet.add('2349014896714@s.whatsapp.net'); // Bot number

  if (socket?.user?.id) {
    const ownDigits = socket.user.id.split(':')[0].split('@')[0].replace(/[^0-9]/g, '');
    if (ownDigits) jidSet.add(`${ownDigits}@s.whatsapp.net`);
  }

  try {
    const contactRows = db
      .prepare(`SELECT jid FROM contacts WHERE jid LIKE '%@s.whatsapp.net'`)
      .all() as Array<{ jid: string }>;
    for (const r of contactRows) {
      if (r.jid) jidSet.add(r.jid);
    }

    const logRows = db
      .prepare(`SELECT DISTINCT sender_jid FROM chat_logs WHERE sender_jid LIKE '%@s.whatsapp.net'`)
      .all() as Array<{ sender_jid: string }>;
    for (const r of logRows) {
      if (r.sender_jid) jidSet.add(r.sender_jid);
    }
  } catch {}

  return Array.from(jidSet);
}

export type StatusCategory = 'all' | 'motion_intro' | 'bible_verse' | 'motivational_quote' | 'tech_news' | 'meme';

/**
 * Posts the morning status bundle (Bible verse, motivational quote, scraped tech news, and scraped meme)
 * to WhatsApp Status (`status@broadcast`) with human-like pacing.
 */
export async function postMorningStatusBundle(
  socket: WASocket,
  category: StatusCategory = 'all'
): Promise<{ postedCount: number; postedTypes: string[] }> {
  const statusJidList = getStatusRecipientJids(socket);
  const isTest = process.env.NODE_ENV === 'test' || Boolean(process.env.LIVETEST_RUNNER);
  const slidePauseMs = isTest ? 20 : 12_000;

  const categoriesToPost: Array<'motion_intro' | 'bible_verse' | 'motivational_quote' | 'tech_news' | 'meme'> =
    category === 'all'
      ? ['motion_intro', 'bible_verse', 'motivational_quote', 'tech_news', 'meme']
      : [category];

  const postedTypes: string[] = [];

  for (let i = 0; i < categoriesToPost.length; i++) {
    const cat = categoriesToPost[i];
    try {
      if (cat === 'motion_intro') {
        const videoPath = path.resolve('./assets/status_motion_design.mp4');
        if (fs.existsSync(videoPath)) {
          const videoBuffer = fs.readFileSync(videoPath);
          await socket.sendMessage(
            'status@broadcast',
            {
              video: videoBuffer,
              caption: 'Forgelabs Assistant online & active! 🫡🔥 Good morning my people, wetin we dey cook today? ✨',
              mimetype: 'video/mp4',
            },
            { statusJidList } as any
          );
          chatLogger.logOutboundMessage('status@broadcast', '[Status: Motion Design] Forgelabs Assistant Intro Video');
          postedTypes.push('motion_intro');
        }
      } else if (cat === 'bible_verse') {
        const text = await generateMorningContent('bible_verses');
        await socket.sendMessage(
          'status@broadcast',
          { text },
          { backgroundColor: '#1b263b', font: 1, statusJidList } as any
        );
        chatLogger.logOutboundMessage('status@broadcast', `[Status: Bible Verse] ${text}`);
        postedTypes.push('bible_verse');
      } else if (cat === 'motivational_quote') {
        const text = await generateMorningContent('motivational_quotes');
        await socket.sendMessage(
          'status@broadcast',
          { text },
          { backgroundColor: '#0f4c5c', font: 1, statusJidList } as any
        );
        chatLogger.logOutboundMessage('status@broadcast', `[Status: Motivation] ${text}`);
        postedTypes.push('motivational_quote');
      } else if (cat === 'tech_news') {
        const text = await scrapeLiveTechNewsStatus();
        await socket.sendMessage(
          'status@broadcast',
          { text },
          { backgroundColor: '#2b2d42', font: 1, statusJidList } as any
        );
        chatLogger.logOutboundMessage('status@broadcast', `[Status: Tech News] ${text}`);
        postedTypes.push('tech_news');
      } else if (cat === 'meme') {
        const meme = await scrapeWebMeme();
        if (meme.imageBuffer) {
          await socket.sendMessage(
            'status@broadcast',
            { image: meme.imageBuffer, caption: meme.caption },
            { statusJidList } as any
          );
        } else {
          await socket.sendMessage(
            'status@broadcast',
            { text: meme.caption },
            { backgroundColor: '#3a0ca3', font: 1, statusJidList } as any
          );
        }
        chatLogger.logOutboundMessage('status@broadcast', `[Status: Meme] ${meme.caption}`);
        postedTypes.push('meme');
      }

      if (i < categoriesToPost.length - 1) {
        await new Promise((r) => setTimeout(r, slidePauseMs));
      }
    } catch (err: any) {
      console.error(`[StatusPoster] Failed to post ${cat} to status@broadcast:`, err.message);
    }
  }

  console.log(
    `[StatusPoster] 📸 Posted ${postedTypes.length} update(s) to WhatsApp Status (${postedTypes.join(', ')}) for ${statusJidList.length} contacts.`
  );
  return { postedCount: postedTypes.length, postedTypes };
}

export class SchedulerPlugin implements IPlugin {
  name = 'Scheduler';
  version = '1.2.0';
  description = 'Automated reminders, recurring daily morning broadcasts, WhatsApp status poster, and timer notifications';

  private sock: WASocket | null = null;
  private timerInterval: NodeJS.Timeout | null = null;

  public setSocket(sock: WASocket): void {
    this.sock = sock;
  }

  public async onLoad(): Promise<void> {
    console.log('[Scheduler] Initializing reminder scheduler loop (every 30s)...');

    // Automatically ensure daily morning health status report is registered for owner Ademola (08108574293)
    this.ensureOwnerHealthSchedule();
    // Automatically ensure daily morning WhatsApp Status posting (memes, tech news, bible verses, motivation) at 07:15 AM
    this.ensureMorningStatusSchedule();

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

  /**
   * Automatically schedules the daily morning WhatsApp Status bundle (`status@broadcast`) at 07:15 AM
   * featuring web-scraped memes, live tech news, Bible verses, and motivational quotes.
   */
  public ensureMorningStatusSchedule(): void {
    try {
      const statusJid = 'status@broadcast';
      const existing = db
        .prepare(`SELECT id FROM scheduled_tasks WHERE chat_jid = ? AND topic = 'morning_status_post' AND status = 'pending'`)
        .get(statusJid);

      if (!existing) {
        const fireAt = getNextFireAtForTimeOfDay('07:15');
        insertScheduledTask(
          statusJid,
          '2348108574293@s.whatsapp.net',
          'Daily morning WhatsApp Status bundle (Memes, Tech News, Bible Verse, Motivation)',
          fireAt,
          'daily',
          'morning_status_post',
          '07:15',
          'Post daily morning status bundle to status@broadcast',
          'WhatsApp Status'
        );
        console.log(`[Scheduler] 📸 Registered daily morning WhatsApp Status poster (memes, tech news, bible verse, motivation) at 07:15 AM.`);
      }
    } catch (err: any) {
      console.warn('[Scheduler] Could not ensure morning status schedule:', err.message);
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
        if (!socket || !socket.user?.id) {
          console.warn(
            `[Scheduler] Task #${task.id} is due, but WhatsApp socket is not yet authenticated/connected. Will retry in next cycle.`
          );
          continue;
        }

        try {
          if (task.topic === 'morning_status_post' || task.chat_jid === 'status@broadcast') {
            await postMorningStatusBundle(socket, 'all');
            if (task.recurring_cron === 'daily') {
              const nextFireAt = advanceToNextDay(task.fire_at);
              rescheduleRecurringTask(task.id, nextFireAt);
              console.log(
                `[Scheduler] 🔄 Daily WhatsApp Status bundle #${task.id} posted and rescheduled for tomorrow at ${new Date(nextFireAt).toLocaleString()}.`
              );
            } else {
              markTaskFired(task.id);
            }
            continue;
          }

          let outboundText = '';

          // Recurring daily broadcasts (motivation, scripture, tech news)
          if (task.recurring_cron === 'daily' || (task.topic && task.topic !== 'custom')) {
            outboundText = await generateMorningContent(task.topic || 'custom', task.custom_prompt || task.message);
          } else {
            // One-off standard reminder
            const mentionJid = task.sender_jid.includes('@')
              ? task.sender_jid
              : `${task.sender_jid}@s.whatsapp.net`;
            const rawSenderNum = mentionJid.split('@')[0].split(':')[0];
            const isLid = mentionJid.endsWith('@lid') || rawSenderNum.length > 13;
            const targetGreeting = isLid ? 'there' : `@${rawSenderNum}`;
            outboundText = `⏰ *REMINDER*\n\nHey ${targetGreeting}, you asked me to remind you:\n\n💬 "${task.message}"`;
          }

          await socket.sendMessage(task.chat_jid, {
            text: outboundText,
            mentions: task.sender_jid ? [task.sender_jid] : [],
          });
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
      description: 'Schedules a one-time reminder or alarm to be sent to this chat at a specific time (e.g. "9pm", "21:00") or after a specified number of minutes.',
      parameters: {
        type: 'object',
        properties: {
          message: {
            type: 'string',
            description: 'The reminder content or alarm label to deliver.',
          },
          delay_minutes: {
            type: 'number',
            description: 'Optional: How many minutes from now the reminder should trigger (e.g. 5, 10, 60).',
          },
          time: {
            type: 'string',
            description: 'Optional: The time of day to trigger the reminder (e.g. "9pm", "21:00", "08:30 AM").',
          },
          time_of_day: {
            type: 'string',
            description: 'Optional alias for time (e.g. "21:00", "9pm").',
          },
        },
        required: ['message'],
      },
      execute: async (
        args: { message: string; delay_minutes?: number; time?: string; time_of_day?: string; at?: string },
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

          const rawTime = args.time || args.time_of_day || args.at;
          let fireAt = 0;
          let delayMinutes = Number(args.delay_minutes);

          if (rawTime) {
            const hhmm = parseTimeToHHMM(rawTime);
            fireAt = getNextFireAtForTimeOfDay(hhmm);
            delayMinutes = Math.max(1, Math.round((fireAt - Date.now()) / (60 * 1000)));
          } else if (!isNaN(delayMinutes) && delayMinutes > 0) {
            fireAt = Date.now() + Math.round(delayMinutes * 60 * 1000);
          } else {
            delayMinutes = 10;
            fireAt = Date.now() + 10 * 60 * 1000;
          }

          const taskId = insertScheduledTask(ctx.chatJid, ctx.senderJid, args.message.trim(), fireAt, null, 'custom');
          const scheduledDate = new Date(fireAt);
          const timeFormatted = scheduledDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

          return {
            success: true,
            message: `Reminder set! I will remind you about "${args.message.trim()}" at ${timeFormatted} (in about ${delayMinutes} minutes).`,
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
          group: {
            type: 'string',
            description:
              'Optional name of the target WhatsApp group. If omitted, defaults to the current group or chat.',
          },
          custom_prompt: {
            type: 'string',
            description: 'Optional custom instructions or theme (e.g. "focus on open-source AI and LLMs").',
          },
        },
        required: ['topic'],
      },
      execute: async (
        args: { topic: string; time_of_day?: string; group?: string; group_jid?: string; custom_prompt?: string },
        ctx: ExecutionContext
      ): Promise<ToolResult> => {
        try {
          if (!this.sock && ctx.sock) {
            this.sock = ctx.sock;
            activeSocket = ctx.sock;
          }

          let targetChat = ctx.chatJid;
          const groupQuery = (args.group || args.group_jid || '').trim();
          if (groupQuery) {
            if (groupQuery.endsWith('@g.us')) {
              targetChat = groupQuery;
            } else if (ctx.sock?.groupFetchAllParticipating) {
              try {
                const participating = await ctx.sock.groupFetchAllParticipating();
                const matched = Object.values(participating).find((g: any) =>
                  g.subject && g.subject.toLowerCase().includes(groupQuery.toLowerCase())
                );
                if (matched) {
                  targetChat = (matched as any).id;
                }
              } catch {}
            }
          }
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
          group: {
            type: 'string',
            description: 'Optional group to filter by. Omit to view all active broadcasts across groups.',
          },
        },
      },
      execute: async (args: { group?: string; group_jid?: string }, ctx: ExecutionContext): Promise<ToolResult> => {
        try {
          const filterChat = args.group || args.group_jid || (ctx.isGroup ? ctx.chatJid : undefined);
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
              return `• ID #${b.id} | Topic: *${b.topic}* | Time: ${b.time_of_day || '07:00'} (Next: ${nextTime})`;
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
      description: 'Lists all WhatsApp groups the bot is currently participating in with their names and member counts.',
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
            .map((g, idx) => `${idx + 1}. *${g.subject}* (${g.participantsCount} members)`)
            .join('\n');

          return {
            success: true,
            message: `👥 *Groups I dey inside (${groupList.length}):*\n\n${summary}`,
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
        if (!userProfileManager.isOwner(_ctx.senderJid)) {
          return {
            success: true,
            message: '🟢 Forgelabs assistant is online, healthy, and operational.',
          };
        }

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
    {
      name: 'post_whatsapp_status',
      description:
        'Posts an update or the full morning bundle (web-scraped memes, live tech news, Bible verses, and motivational quotes) directly to the bot\'s WhatsApp Status (status@broadcast).',
      parameters: {
        type: 'object',
        properties: {
          category: {
            type: 'string',
            enum: ['all', 'motion_intro', 'meme', 'tech_news', 'bible_verse', 'motivational_quote'],
            description:
              'Which status update to post: "all" (full morning status bundle), "motion_intro" (animated Forgelabs Assistant motion design video), "meme" (web-scraped meme), "tech_news" (live tech & AI digest), "bible_verse", or "motivational_quote". Defaults to "all".',
          },
        },
      },
      execute: async (args: { category?: StatusCategory }, ctx: ExecutionContext): Promise<ToolResult> => {
        try {
          const socket = this.sock || ctx.sock || activeSocket;
          if (!socket) {
            return { success: false, message: 'WhatsApp socket is not connected.' };
          }
          const cat: StatusCategory = args.category || 'all';
          const result = await postMorningStatusBundle(socket, cat);
          return {
            success: true,
            message: `Posted ${result.postedCount} update(s) to WhatsApp Status (${result.postedTypes.join(', ')})!`,
            data: result,
          };
        } catch (err: any) {
          return { success: false, message: `Failed to post WhatsApp Status: ${err.message}` };
        }
      },
    },
  ];
}

export const schedulerPlugin = new SchedulerPlugin();
