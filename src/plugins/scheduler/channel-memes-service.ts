import fs from 'fs';
import path from 'path';
import type { WASocket } from '@whiskeysockets/baileys';
import {
  saveChannelMeme,
  getFreshestMemeForPosting,
  markMemePosted,
  getLatestMemePostedTimestamp,
  getChannelMemesStats,
  getAllChannelMemes,
  logAutonomousAction,
  ChannelMeme,
  db,
} from '../../memory/db.js';
import { chatLogger } from '../../memory/chat-logger.js';
import { getStatusRecipientJids, safeSendStatus } from './scheduler-plugin.js';

export const WHATSAPP_MEME_CHANNEL_INVITE_CODE = '0029Vb6oS4LJkK7AvtORyH46';
export const WHATSAPP_MEME_CHANNEL_URL = 'https://whatsapp.com/channel/0029Vb6oS4LJkK7AvtORyH46';
export const WHATSAPP_MEME_CHANNEL_NAME = 'Memes';

export const MEME_COOLDOWN_MS = 2 * 60 * 60 * 1000; // 2 hours

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
export function seedChannelMemesIfEmpty(): void {
  try {
    const countRow = db.prepare('SELECT COUNT(*) as count FROM channel_memes').get() as { count: number };
    if (!countRow || countRow.count === 0) {
      console.log(`[ChannelMemes] 😂 Seeding ${SEED_CHANNEL_MEMES.length} initial memes from ${WHATSAPP_MEME_CHANNEL_NAME}...`);
      for (const item of SEED_CHANNEL_MEMES) {
        saveChannelMeme(item.caption, item.media_type, item.media_url, null, WHATSAPP_MEME_CHANNEL_INVITE_CODE);
      }
    }
  } catch (err: any) {
    console.error('[ChannelMemes] Error seeding initial memes:', err?.message || err);
  }
}

/**
 * Checks if the 2-hour cooldown has elapsed since the last meme was posted.
 */
export function getMemeCooldownStatus(): {
  canPost: boolean;
  remainingMs: number;
  remainingMinutes: number;
  lastPostedAt: number;
} {
  const lastPostedAt = getLatestMemePostedTimestamp();
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

/**
 * Live Scraper: Resolves the WhatsApp Meme Channel via Baileys and fetches recent memes.
 */
export async function scrapeWhatsAppChannelMemes(
  socket: WASocket
): Promise<{ channelJid: string | null; newMemesSaved: number }> {
  seedChannelMemesIfEmpty();
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
          const messages = extractMessagesFromNode(queryRes);
          for (const msg of messages) {
            if (msg.text && msg.text.trim().length > 10) {
              const saved = saveChannelMeme(
                msg.text.trim(),
                msg.mediaUrl ? 'image' : 'text',
                msg.mediaUrl,
                null,
                WHATSAPP_MEME_CHANNEL_INVITE_CODE,
                msg.id
              );
              if (saved) newMemesSaved++;
            }
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

function extractMessagesFromNode(node: any): Array<{ id?: string; text: string; mediaUrl?: string }> {
  const results: Array<{ id?: string; text: string; mediaUrl?: string }> = [];
  if (!node) return results;

  const inspect = (item: any) => {
    if (!item) return;
    if (typeof item === 'string' && item.length > 15) {
      results.push({ text: item });
      return;
    }
    if (item.tag === 'message' || item.tag === 'message_updates') {
      const msgId = item.attrs?.id || item.attrs?.server_id;
      if (item.content) {
        if (Array.isArray(item.content)) {
          for (const c of item.content) inspect(c);
        } else if (typeof item.content === 'string') {
          results.push({ id: msgId, text: item.content });
        }
      }
    }
    if (Array.isArray(item.content)) {
      for (const child of item.content) inspect(child);
    }
  };

  inspect(node);
  return results;
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
 * Posts the freshest meme with strict 2-hour cooldown enforcement.
 */
export async function postChannelMemeWithCooldown(
  socket: WASocket,
  force = false,
  targetChat = 'status@broadcast'
): Promise<{ success: boolean; message: string; meme?: ChannelMeme; cooldown?: any }> {
  seedChannelMemesIfEmpty();

  const cooldown = getMemeCooldownStatus();
  if (!cooldown.canPost && !force) {
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

  const meme = getFreshestMemeForPosting();
  if (!meme) {
    return { success: false, message: 'No memes found in the channel meme bank.', cooldown };
  }

  const isStatus = targetChat === 'status@broadcast';
  const outboundText = formatMemeBroadcast(meme);

  try {
    if (isStatus) {
      const statusJidList = getStatusRecipientJids(socket);
      await safeSendStatus(
        socket,
        { text: outboundText },
        { backgroundColor: '#2b2d42', font: 3 },
        statusJidList
      );
      chatLogger.logOutboundMessage('status@broadcast', outboundText);
      console.log(`[ChannelMemes] 📸 Posted meme #${meme.id} to WhatsApp Status (broadcast to ${statusJidList.length} contacts).`);
    } else {
      await socket.sendMessage(targetChat, { text: outboundText });
      chatLogger.logOutboundMessage(targetChat, outboundText);
      console.log(`[ChannelMemes] 💬 Posted meme #${meme.id} to chat ${targetChat}.`);
    }

    markMemePosted(meme.id);
    logAutonomousAction('channel_meme_post', targetChat, 'WhatsApp Status/Group', `Posted meme #${meme.id} (2hr cooldown set)`);

    return {
      success: true,
      message: `Posted meme #${meme.id} to ${isStatus ? 'WhatsApp Status' : targetChat}! 2-hour cooldown active until ${new Date(Date.now() + MEME_COOLDOWN_MS).toLocaleTimeString()}.`,
      meme,
      cooldown: getMemeCooldownStatus(),
    };
  } catch (err: any) {
    console.error(`[ChannelMemes] Failed to post meme:`, err.message);
    return { success: false, message: `Failed to post meme: ${err.message}`, cooldown };
  }
}
