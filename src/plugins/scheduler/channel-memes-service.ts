import fs from 'fs';
import type { WASocket } from '@whiskeysockets/baileys';
import {
  saveChannelMeme,
  getFreshestMemeForPosting,
  markMemePosted,
  getLatestMemePostedTimestamp,
  logAutonomousAction,
  ChannelMeme,
  db,
} from '../../memory/db.js';
import { chatLogger } from '../../memory/chat-logger.js';
import { getStatusRecipientJids, sendStatusOnce } from './scheduler-plugin.js';
import { getStartOfTodayWat } from './scheduler-db.js';
import { getOrGenerateMemeMedia } from './media-card-generator.js';
import {
  downloadNewsletterImage,
  extractNewsletterMessages,
  persistNewsletterImage,
} from './newsletter-media.js';

export const WHATSAPP_MEME_CHANNEL_INVITE_CODE = '0029Vb6oS4LJkK7AvtORyH46';
export const WHATSAPP_MEME_CHANNEL_URL = 'https://whatsapp.com/channel/0029Vb6oS4LJkK7AvtORyH46';
export const WHATSAPP_MEME_CHANNEL_NAME = 'Memes';

export const MEME_COOLDOWN_MS = 2 * 60 * 60 * 1000; // 2 hours
export const STATUS_MEME_DAILY_LIMIT = 2;
export const STATUS_MEME_MIN_INTERVAL_MS = 6 * 60 * 60 * 1000;

/**
 * Seed catalog of hilarious, relatable viral memes matching the Memes channel vibe:
 * "Where logic ends & laughter begins. Daily dose of fun, sarcasm & stupidity."
 */
export const SEED_CHANNEL_MEMES: Array<{
  caption: string;
  media_type: 'image' | 'video' | 'text';
  media_url?: string;
}> = [
  {
    caption: 'My brain at 3 AM: "Hey, remember that embarrassing thing you said in 2017?" 💀😂\n\nMe: "Bro I am trying to sleep!"',
    media_type: 'text',
  },
  {
    caption: 'When you fix one tiny line of code and suddenly the entire backend crashes in 4 different languages 😭💀\n\n#DevLife #TechMeme',
    media_type: 'text',
  },
  {
    caption: 'Account balance: ₦1,250\nMy cravings: Shawarma, ice cream, roasted turkey, and iced caramel macchiato 😭💀\n\nWho do me this thing?',
    media_type: 'text',
  },
  {
    caption: 'Me: "I will start saving money from this month."\n\nMy bank notifications 2 days later: "Debited... Debited... Debited..." 💀💸',
    media_type: 'text',
  },
  {
    caption: 'Interviewer: "What is your biggest strength?"\n\nMe: "I can look busy doing absolutely nothing for 8 straight hours." 😭💀',
    media_type: 'text',
  },
  {
    caption: 'When you finally understand what the lecturer was teaching during the semester, but you\'re already inside the exam hall 💀📚',
    media_type: 'text',
  },
  {
    caption: 'Nobody:\n\nMy phone battery at 1%: Holding on for dear life like a Nollywood action movie hero 🔋😭',
    media_type: 'text',
  },
  {
    caption: 'Alarm: *rings at 6:00 AM*\nMe: "I\'ll just close my eyes for 2 minutes."\n\n*Time when eyes open*: 11:45 AM 💀💀',
    media_type: 'text',
  },
  {
    caption: 'Doctor: "You need 8 hours of sleep."\nMe: "Best I can do is 4 hours of overthinking and 2 hours of staring at the ceiling." 😴💀',
    media_type: 'text',
  },
  {
    caption: 'When your code works on the first try and you spend 30 minutes looking for what is wrong because you don\'t trust it 😭😂',
    media_type: 'text',
  },
  {
    caption: 'Parents: "Go out and make friends!"\n\nThe outside: Hot sun, transport fare, small talk, and people with drama 🚶‍♂️❌\nMe: Back to my bed.',
    media_type: 'text',
  },
  {
    caption: 'Me smiling at my phone:\nPeople: "Aww, who is making you blush?"\n\nThe phone: A video of a goat jumping into a bucket 💀🐐😂',
    media_type: 'text',
  },
  {
    caption: 'That awkward moment when someone waves at you, you wave back with full confidence, then you turn around and see they were waving at someone behind you 💀😭🏃‍♂️💨',
    media_type: 'text',
  },
  {
    caption: 'Adulting is just whispering "What is all this now?" 47 times a day while drinking water 😭🚰',
    media_type: 'text',
  },
  {
    caption: 'Crypto traders after losing 80% in 15 minutes: "We are still early guys, the fundamentals are solid!" 📈💀📉',
    media_type: 'text',
  },
  {
    caption: 'WhatsApp group with 200 members:\n*Complete silence for 4 days*\n\nRandom member at 2 AM: "Hi" 💀',
    media_type: 'text',
  },
  {
    caption: 'Me pretending to understand the math problem on the whiteboard so the teacher doesn\'t call my name 🧠❌😭',
    media_type: 'text',
  },
  {
    caption: 'The Wi-Fi router when I\'m scrolling Twitter: 🚀💨\n\nThe Wi-Fi router the moment I start downloading an urgent 50MB file: 🐌💀',
    media_type: 'text',
  },
  {
    caption: 'I told myself "no junk food today."\n\nThe meatpie and cold malt seeing me enter the supermarket: "Welcome back boss!" 😂🍗',
    media_type: 'text',
  },
  {
    caption: 'When you say "I\'m leaving in 5 minutes" and you haven\'t even entered the bathroom yet 💀🚿',
    media_type: 'text',
  },
];

/**
 * Pre-seeds initial meme posts from the Memes channel catalog.
 */
export async function seedChannelMemesIfEmpty(): Promise<void> {
  try {
    // 1. Clean up legacy placeholder references in DB
    try {
      await db.prepare(`UPDATE channel_memes SET image_path = NULL WHERE image_path LIKE '%meme_default.jpg%'`).run();
    } catch {}

    const countRow = await db.prepare('SELECT COUNT(*) as count FROM channel_memes').get() as { count: number };
    if (!countRow || countRow.count === 0) {
      console.log(`[ChannelMemes] 😂 Seeding ${SEED_CHANNEL_MEMES.length} initial memes from ${WHATSAPP_MEME_CHANNEL_NAME}...`);
      for (const item of SEED_CHANNEL_MEMES) {
        await saveChannelMeme(item.caption, 'text', item.media_url, null, WHATSAPP_MEME_CHANNEL_INVITE_CODE);
      }
    }
  } catch (err: any) {
    console.error('[ChannelMemes] Error seeding initial memes:', err?.message || err);
  }
}

/**
 * Checks whether the group meme cooldown has elapsed.
 */
export async function getMemeCooldownStatus(): Promise<{
  canPost: boolean;
  remainingMs: number;
  remainingMinutes: number;
  lastPostedAt: number;
}> {
  const lastPostedAt = await getLatestMemePostedTimestamp();
  const elapsed = Date.now() - lastPostedAt;
  const remainingMs = Math.max(0, MEME_COOLDOWN_MS - elapsed);
  const remainingMinutes = Math.ceil(remainingMs / (60 * 1000));
  const canPost = remainingMs <= 0 || lastPostedAt === 0;

  return {
    canPost,
    remainingMs,
    remainingMinutes,
    lastPostedAt,
  };
}

/** Returns status-only meme limits based on posts actually logged to WhatsApp Status. */
export async function getStatusMemePostingStatus(now = Date.now()): Promise<{
  canPost: boolean;
  postedToday: number;
  dailyLimit: number;
  lastPostedAt: number;
  remainingCooldownMs: number;
  remainingMinutes: number;
}> {
  const todayStart = getStartOfTodayWat();
  const statusMemeFilter = `
    chat_jid = 'status@broadcast'
    AND sender_jid = 'bot'
    AND (message_text LIKE '[Status: Meme]%' OR message_text LIKE '%MEME OF THE MOMENT%')
  `;

  try {
    const todayRow = await db.prepare(
      `SELECT COUNT(*) AS posted_today FROM chat_logs WHERE ${statusMemeFilter} AND timestamp >= ? AND timestamp <= ?`
    ).get(todayStart, now) as { posted_today: number } | undefined;
    const latestRow = await db.prepare(
      `SELECT MAX(timestamp) AS last_posted_at FROM chat_logs WHERE ${statusMemeFilter} AND timestamp <= ?`
    ).get(now) as { last_posted_at: number | null } | undefined;
    const reservations = await db.prepare(`
      SELECT COUNT(*) AS reserved_today, MAX(reserved_at) AS last_reserved_at
      FROM status_meme_reservations
      WHERE reserved_at >= ? AND reserved_at <= ? AND reserved_at >= ?
    `).get(todayStart, now, now - 30 * 60 * 1000) as { reserved_today: number; last_reserved_at: number | null };
    const postedToday = Number(todayRow?.posted_today || 0) + Number(reservations?.reserved_today || 0);
    const lastPostedAt = Math.max(Number(latestRow?.last_posted_at || 0), Number(reservations?.last_reserved_at || 0));
    const remainingCooldownMs = Math.max(0, STATUS_MEME_MIN_INTERVAL_MS - (now - lastPostedAt));

    return {
      canPost: postedToday < STATUS_MEME_DAILY_LIMIT && remainingCooldownMs === 0,
      postedToday,
      dailyLimit: STATUS_MEME_DAILY_LIMIT,
      lastPostedAt,
      remainingCooldownMs,
      remainingMinutes: Math.ceil(remainingCooldownMs / 60_000),
    };
  } catch (err: any) {
    console.warn(`[ChannelMemes] Could not read status meme limits: ${err?.message || err}`);
    return {
      canPost: false,
      postedToday: 0,
      dailyLimit: STATUS_MEME_DAILY_LIMIT,
      lastPostedAt: 0,
      remainingCooldownMs: 0,
      remainingMinutes: 0,
    };
  }
}

/** Reserve a daily status slot before async media preparation or send operations. */
export async function reserveStatusMemePost(now = Date.now()): Promise<string | null> {
  const reservationId = `status-meme-${now}-${Math.random().toString(36).slice(2, 10)}`;
  try {
    return await db.transaction(async () => {
      await db.prepare('DELETE FROM status_meme_reservations WHERE reserved_at < ?').run(now - 30 * 60 * 1000);
      if (!(await getStatusMemePostingStatus(now)).canPost) return null;
      await db.prepare('INSERT INTO status_meme_reservations (reservation_id, reserved_at) VALUES (?, ?)').run(reservationId, now);
      return reservationId;
    });
  } catch (err) {
    console.warn('[ChannelMemes] Could not reserve status meme slot:', err);
    return null;
  }
}

export async function releaseStatusMemePost(reservationId: string): Promise<void> {
  try { await db.prepare('DELETE FROM status_meme_reservations WHERE reservation_id = ?').run(reservationId); } catch {}
}

/**
 * Live Scraper: Resolves the WhatsApp Meme Channel via Baileys and fetches recent memes.
 */
export async function scrapeWhatsAppChannelMemes(
  socket: WASocket
): Promise<{ channelJid: string | null; newMemesSaved: number }> {
  await seedChannelMemesIfEmpty();
  let newMemesSaved = 0;
  let channelJid: string | null = null;

  try {
    console.log(`[ChannelMemes] 🔍 Querying WhatsApp Channel metadata for invite code: ${WHATSAPP_MEME_CHANNEL_INVITE_CODE}...`);
    const metadata: any = await (socket as any).newsletterMetadata?.('invite', WHATSAPP_MEME_CHANNEL_INVITE_CODE);

    if (metadata?.id) {
      channelJid = metadata.id;
      console.log(`[ChannelMemes] ✅ Resolved meme channel JID: ${channelJid} (${metadata.name || WHATSAPP_MEME_CHANNEL_NAME})`);

      try { await (socket as any).newsletterFollow?.(channelJid); } catch {}
      try { await (socket as any).subscribeNewsletterUpdates?.(channelJid); } catch {}

      try {
        const fetchPromise = (socket as any).newsletterFetchMessages?.(channelJid, 25);
        const timeoutPromise = new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Channel meme fetch timed out after 5s')), 5000)
        );
        const queryRes: any = await Promise.race([fetchPromise, timeoutPromise]);
        if (queryRes) {
          const messages = extractNewsletterMessages(queryRes, channelJid!);
          let imageAttempts = 0;
          for (const msg of messages) {
            if (msg.id) {
              const exists = await db.prepare(
                'SELECT 1 AS found FROM channel_memes WHERE channel_source = ? AND channel_message_id = ? LIMIT 1'
              ).get(WHATSAPP_MEME_CHANNEL_INVITE_CODE, msg.id) as { found: number } | undefined;
              if (exists) continue;
            }

            let imagePath: string | null = null;
            if (msg.hasImage && imageAttempts < 8) {
              imageAttempts++;
              const imageBuffer = await downloadNewsletterImage(msg.message);
              if (imageBuffer) {
                imagePath = await persistNewsletterImage(
                  imageBuffer,
                  channelJid!,
                  msg.id
                );
              }
            }

            const caption = msg.text.trim() || (imagePath ? '😂 Meme from the Memes WhatsApp channel' : '');
            if (caption.length < 5) continue;
            const saved = await saveChannelMeme(
              caption,
              imagePath ? 'image' : 'text',
              null,
              imagePath,
              WHATSAPP_MEME_CHANNEL_INVITE_CODE,
              msg.id
            );
            if (saved) newMemesSaved++;
          }
        }
      } catch (err: any) {
        console.warn(`[ChannelMemes] newsletterFetchMessages note: ${err.message}`);
      }
    }
  } catch (err: any) {
    console.warn(`[ChannelMemes] Protocol query note: ${err.message}`);
  }

  console.log(`[ChannelMemes] 📦 Meme scrape complete. New memes added: ${newMemesSaved}.`);
  return { channelJid, newMemesSaved };
}

/**
 * Formats a meme post for WhatsApp Status or groups.
 */
export function formatMemeBroadcast(meme: ChannelMeme): string {
  return (
    `😂 *MEME OF THE MOMENT • FORGELABS ASSISTANT*\n` +
    `*(From WhatsApp Channel: Memes)*\n\n` +
    `${meme.caption}\n\n` +
    `— *Forgelabs Assistant* 🫡`
  );
}

/**
 * Posts the freshest meme with a group cooldown or status-specific daily policy.
 */
export async function postChannelMemeWithCooldown(
  socket: WASocket,
  force = false,
  targetChat = 'status@broadcast'
): Promise<{
  success: boolean;
  message: string;
  meme?: ChannelMeme;
  cooldown?: Awaited<ReturnType<typeof getMemeCooldownStatus>>;
  statusPolicy?: Awaited<ReturnType<typeof getStatusMemePostingStatus>>;
}> {
  await seedChannelMemesIfEmpty();

  const isStatus = targetChat === 'status@broadcast';
  const cooldown = await getMemeCooldownStatus();
  const statusPolicy = isStatus ? await getStatusMemePostingStatus() : undefined;
  if (isStatus && statusPolicy && !statusPolicy.canPost) {
    const reason = statusPolicy.postedToday >= statusPolicy.dailyLimit
      ? `Daily status meme limit reached (${statusPolicy.postedToday}/${statusPolicy.dailyLimit}).`
      : `Status meme spacing active; try again in ${statusPolicy.remainingMinutes} minute(s).`;
    return { success: false, message: `⏳ ${reason}`, cooldown, statusPolicy };
  }

  if (!isStatus && !cooldown.canPost && !force) {
    const msg = `⏳ 2-Hour Meme Cooldown Active! Next meme can be posted in ${cooldown.remainingMinutes} minute(s).`;
    console.log(`[ChannelMemes] ${msg}`);
    return { success: false, message: msg, cooldown };
  }

  // Try scraping fresh memes first if online
  if (socket) {
    try {
      await scrapeWhatsAppChannelMemes(socket);
    } catch {}
  }

  const meme = await getFreshestMemeForPosting();
  if (!meme) {
    return { success: false, message: 'No memes found in the channel meme bank.', cooldown };
  }

  const outboundText = formatMemeBroadcast(meme);

  let statusReservation: string | null = null;
  try {
    const imagePath = await getOrGenerateMemeMedia(meme.id, meme.caption, meme.image_path);
    const hasImage = Boolean(imagePath && fs.existsSync(imagePath));
    if (isStatus) {
      statusReservation = await reserveStatusMemePost();
      if (!statusReservation) {
        return { success: false, message: 'Status meme limit or spacing became active before sending.', cooldown, statusPolicy: await getStatusMemePostingStatus() };
      }
      const statusJidList = await getStatusRecipientJids(socket);
      const sent = await sendStatusOnce(
        socket,
        hasImage ? { image: fs.readFileSync(imagePath), caption: outboundText } : { text: outboundText },
        hasImage ? {} : { backgroundColor: '#2b2d42', font: 3 },
        statusJidList,
        outboundText,
        `[Status: Meme] ${outboundText}`
      );
      if (!sent) {
        await releaseStatusMemePost(statusReservation);
        statusReservation = null;
        return { success: false, message: 'This meme was already posted or WhatsApp did not confirm the status send.', cooldown, statusPolicy: await getStatusMemePostingStatus() };
      }
      await releaseStatusMemePost(statusReservation);
      statusReservation = null;
      console.log(`[ChannelMemes] 📸 Posted meme #${meme.id} (${hasImage ? 'IMAGE' : 'TEXT'}) to WhatsApp Status (broadcast to ${statusJidList.length} contacts).`);
    } else {
      if (hasImage) {
        await socket.sendMessage(targetChat, { image: fs.readFileSync(imagePath), caption: outboundText });
      } else {
        await socket.sendMessage(targetChat, { text: outboundText });
      }
      await chatLogger.logOutboundMessage(targetChat, outboundText);
      console.log(`[ChannelMemes] 💬 Posted meme #${meme.id} (${hasImage ? 'IMAGE' : 'TEXT'}) to chat ${targetChat}.`);
    }

    await markMemePosted(meme.id);
    await logAutonomousAction('channel_meme_post', targetChat, 'WhatsApp Status/Group', `Posted meme #${meme.id} (2hr cooldown set)`);

    return {
      success: true,
      message: isStatus
        ? `Posted meme #${meme.id} to WhatsApp Status; daily and spacing limits remain active.`
        : `Posted meme #${meme.id} to ${targetChat}; the two-hour group cooldown is active until ${new Date(Date.now() + MEME_COOLDOWN_MS).toLocaleTimeString()}.`,
      meme,
      cooldown: await getMemeCooldownStatus(),
      statusPolicy: isStatus ? await getStatusMemePostingStatus() : undefined,
    };
  } catch (err: any) {
    if (statusReservation) await releaseStatusMemePost(statusReservation);
    console.error(`[ChannelMemes] Failed to post meme:`, err.message);
    return { success: false, message: `Failed to post meme: ${err.message}`, cooldown };
  }
}
