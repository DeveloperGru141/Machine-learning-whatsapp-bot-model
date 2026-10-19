import fs from 'fs';
import path from 'path';
import { IPlugin, BotTool, ExecutionContext, ToolResult } from '../types.js';
import { contactService } from '../../memory/contact-service.js';
import { whatsAppClient } from '../../core/client.js';
import { config } from '../../config/env.js';
import { db, findKnownGroup } from '../../memory/db.js';
import { chatLogger } from '../../memory/chat-logger.js';
import { OutboundSender } from '../../core/sender.js';
import { antiBanEngine } from '../../security/anti-ban.js';
import { userProfileManager } from '../../memory/user-profiles.js';

export class ContactPlugin implements IPlugin {
  name = 'ContactManager';
  version = '1.0.0';
  description = 'Automatic contact saving, vCard digital business cards, and bulk .vcf address book exports';

  tools: BotTool[] = [
    {
      name: 'save_contact',
      description:
        'Saves or updates a contact in the bot address book with a custom name and optional notes. If phone_number is not provided, defaults to the current message sender.',
      parameters: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: 'The full name or nickname to save the contact as (e.g. "David O.", "Tech Support").',
          },
          phone_number: {
            type: 'string',
            description: 'Optional phone number with country code. If omitted, saves the contact of the person speaking.',
          },
          notes: {
            type: 'string',
            description: 'Optional notes or details about the contact (e.g. "Software Engineer", "Met at DevFest").',
          },
        },
        required: ['name'],
      },
      execute: async (
        args: { name: string; phone_number?: string; notes?: string },
        ctx: ExecutionContext
      ): Promise<ToolResult> => {
        try {
          let targetPhone = args.phone_number;
          if (!targetPhone) {
            // Check if a phone number was mentioned in recent messages in this chat
            try {
              const recentInChat = db.prepare(`
                SELECT message_text FROM chat_logs
                WHERE chat_jid = ?
                ORDER BY id DESC LIMIT 6
              `).all(ctx.chatJid) as Array<{ message_text: string | null }>;

              for (const r of recentInChat) {
                const txt = r.message_text || '';
                const phoneMatch = txt.match(/(?:(?:\+|00)?234|0)\s*[789][01]\s*(?:[\s-]?\d{3,4}){2}|\+?\d[\d\s-]{9,}\d/);
                if (phoneMatch) {
                  const extracted = contactService.extractPhoneNumber(phoneMatch[0]);
                  if (extracted) {
                    targetPhone = extracted;
                    break;
                  }
                }
              }
            } catch {}
          }
          if (!targetPhone) {
            targetPhone = ctx.senderJid;
          }
          const result = contactService.saveContact(targetPhone, args.name, args.notes);

          if (!result.success || !result.contact) {
            return { success: false, message: result.message };
          }

          // Send an interactive 1-tap WhatsApp contact card into the chat
          try {
            await ctx.sendContact(args.name.trim(), result.contact.phone_number);
          } catch (err: any) {
            console.warn('[ContactPlugin] Could not send contact card:', err.message);
          }

          return {
            success: true,
            message: `Contact "${args.name}" (+${result.contact.phone_number}) saved successfully and contact card sent!`,
            data: result.contact,
          };
        } catch (err: any) {
          console.error('[ContactPlugin] Error saving contact:', err);
          return { success: false, message: `Failed to save contact: ${err.message}` };
        }
      },
    },
    {
      name: 'get_contact',
      description: 'Looks up a contact in the saved address book by name or phone number.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'The name, nickname, or phone number to search for.',
          },
        },
        required: ['query'],
      },
      execute: async (args: { query: string }, ctx: ExecutionContext): Promise<ToolResult> => {
        try {
          const cleanQuery = (args.query || '').trim();
          const isBossQuery =
            /^(the\s+)?(my\s+)?(your\s+)?(boss|owner|creator|maker|developer|dev|engineer|ademola|hardez)$/i.test(cleanQuery) ||
            /\b(your\s+boss|my\s+boss|the\s+boss|your\s+creator|the\s+creator|your\s+owner|the\s+owner|ademola)\b/i.test(cleanQuery);

          if (isBossQuery) {
            return {
              success: true,
              message: `Found contact: *Ademola (Creator & Boss)*\n📞 Phone: +2348108574293\n📝 Notes: Creator, developer, and owner of Forgelabs assistant`,
              data: {
                phone_number: '2348108574293',
                jid: '2348108574293@s.whatsapp.net',
                display_name: 'Ademola (Creator & Boss)',
                custom_name: 'Ademola (Boss)',
              },
            };
          }

          const isOwner = userProfileManager.isOwner(ctx.senderJid, ctx.senderName);
          if (!isOwner) {
            return {
              success: false,
              message: 'Omo chief, I no fit look up other people contact information give you o! That one na strictly confidential 😂',
            };
          }

          const contact = contactService.getContact(args.query);
          if (!contact) {
            return {
              success: false,
              message: `No saved contact found matching "${args.query}".`,
            };
          }

          const displayName = contact.custom_name || contact.display_name;
          return {
            success: true,
            message: `Found contact: *${displayName}*\n📞 Phone: +${contact.phone_number}\n📝 Notes: ${contact.notes || 'None'}\n🕒 Added: ${new Date(contact.created_at).toLocaleDateString()}`,
            data: contact,
          };
        } catch (err: any) {
          return { success: false, message: `Error searching contacts: ${err.message}` };
        }
      },
    },
    {
      name: 'list_contacts',
      description:
        'Lists saved contacts in the bot address book with names, phone numbers, and notes. Only available to bot owner Ademola.',
      parameters: {
        type: 'object',
        properties: {
          limit: {
            type: 'number',
            description: 'Optional maximum number of contacts to list (default 25).',
          },
          filter: {
            type: 'string',
            description: 'Optional keyword to filter contacts by name or note.',
          },
        },
      },
      execute: async (args: { limit?: number; filter?: string }, ctx: ExecutionContext): Promise<ToolResult> => {
        try {
          const isOwner = userProfileManager.isOwner(ctx.senderJid, ctx.senderName);
          if (!isOwner) {
            return {
              success: false,
              message: 'Omo chief, I no fit release other people contact information give you o! Address book strictly protected 😂',
            };
          }

          const limit = Math.min(Math.max(Number(args.limit) || 25, 1), 100);
          let contacts = contactService.getAllContacts(limit);
          if (args.filter) {
            const f = args.filter.toLowerCase();
            contacts = contacts.filter(
              (c) =>
                (c.custom_name && c.custom_name.toLowerCase().includes(f)) ||
                (c.display_name && c.display_name.toLowerCase().includes(f)) ||
                (c.notes && c.notes.toLowerCase().includes(f)) ||
                c.phone_number.includes(f)
            );
          }
          if (contacts.length === 0) {
            return {
              success: true,
              message: args.filter
                ? `No contacts found matching "${args.filter}".`
                : 'No contacts found in address book.',
              data: [],
            };
          }
          const formatted = contacts.map(
            (c, idx) =>
              `${idx + 1}. *${c.custom_name || c.display_name}* (+${c.phone_number})${c.notes ? ` - ${c.notes}` : ''}`
          );
          return {
            success: true,
            message: `📇 *Address Book Contacts (${contacts.length}):*\n\n${formatted.join('\n')}`,
            data: contacts,
          };
        } catch (err: any) {
          return { success: false, message: `Failed to list contacts: ${err.message}` };
        }
      },
    },
    {
      name: 'send_contact_card',
      description:
        'Generates and sends an interactive 1-tap WhatsApp digital contact card (vCard) for the specified person or current sender so users can save them directly to their phone.',
      parameters: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: 'Name to display on the contact card. If omitted, uses contact book name or sender name.',
          },
          phone_number: {
            type: 'string',
            description: 'Phone number for the contact card. If omitted, uses current sender phone number.',
          },
        },
      },
      execute: async (
        args: { name?: string; phone_number?: string },
        ctx: ExecutionContext
      ): Promise<ToolResult> => {
        try {
          let targetPhone = args.phone_number;
          let targetName = args.name;

          // If phone number omitted, default to sender
          if (!targetPhone) {
            targetPhone = contactService.extractPhoneNumber(ctx.senderJid);
          }

          // If name omitted, look up in contacts or default to senderName
          if (!targetName && targetPhone) {
            const saved = contactService.getContact(targetPhone);
            targetName = saved?.custom_name || saved?.display_name || ctx.senderName;
          }

          let cleanPhone = contactService.extractPhoneNumber(targetPhone);
          const isLid = ctx.senderJid.endsWith('@lid') || (targetPhone && targetPhone.endsWith('@lid')) || !cleanPhone || cleanPhone.length > 15 || /^10\d{13,}$/.test(cleanPhone);
          if (isLid) {
            const saved = contactService.getContact(ctx.senderJid);
            if (saved && saved.phone_number && !saved.jid.endsWith('@lid') && saved.phone_number.length <= 15) {
              cleanPhone = saved.phone_number;
            } else {
              return {
                success: false,
                message: 'No phone number available to create a contact card for this user.',
              };
            }
          }

          const isOwner = userProfileManager.isOwner(ctx.senderJid, ctx.senderName);
          const senderOwnPhone = contactService.extractPhoneNumber(ctx.senderJid);
          if (!isOwner && targetPhone && cleanPhone && cleanPhone !== senderOwnPhone) {
            return {
              success: false,
              message: 'Omo chief, I only fit share your own contact card, not other people contact details abeg 😂',
            };
          }

          const finalName = targetName?.trim() || `User +${cleanPhone}`;

          await ctx.sendContact(finalName, cleanPhone);

          return {
            success: true,
            message: `Sent WhatsApp contact card for *${finalName}* (+${cleanPhone}).`,
            data: { name: finalName, phoneNumber: cleanPhone },
          };
        } catch (err: any) {
          console.error('[ContactPlugin] Error sending contact card:', err);
          return { success: false, message: `Failed to send contact card: ${err.message}` };
        }
      },
    },
    {
      name: 'export_contacts_vcf',
      description:
        'Exports all saved contacts from the bot database into a downloadable .vcf (vCard) file so the user or owner can import all contacts into their phone (Google Contacts, iPhone, Android) with 1 tap.',
      parameters: {
        type: 'object',
        properties: {
          limit: {
            type: 'number',
            description: 'Maximum number of contacts to export (default: 2000).',
          },
        },
      },
      execute: async (args: { limit?: number }, ctx: ExecutionContext): Promise<ToolResult> => {
        try {
          const isOwner = userProfileManager.isOwner(ctx.senderJid, ctx.senderName);
          if (!isOwner) {
            return {
              success: false,
              message: 'Permission denied: Only bot owner Ademola is authorized to export the contact address book.',
            };
          }

          const limit = Math.min(Math.max(Number(args.limit) || 2000, 1), 5000);
          const { vcfContent, count } = contactService.exportVcf(limit);

          if (count === 0 || !vcfContent) {
            return {
              success: false,
              message: 'No contacts found in database to export.',
            };
          }

          const tempDir = config.paths.temp;
          if (!fs.existsSync(tempDir)) {
            fs.mkdirSync(tempDir, { recursive: true });
          }

          const fileName = `contacts_${new Date().toISOString().slice(0, 10)}.vcf`;
          const filePath = path.join(tempDir, fileName);
          fs.writeFileSync(filePath, vcfContent, 'utf-8');

          const buffer = fs.readFileSync(filePath);

          try {
            await ctx.sock.sendMessage(ctx.chatJid, {
              document: buffer,
              mimetype: 'text/vcard',
              fileName,
              caption: `📇 *Address Book Export*\n\nHere is your .vcf contact file containing *${count} saved contacts*.\nOpen this file on your phone to import all contacts directly!`,
            });
            console.log(`[ContactPlugin] Exported ${count} contacts to ${ctx.chatJid} as ${fileName}`);
          } finally {
            try {
              if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
            } catch {}
          }

          return {
            success: true,
            message: `Successfully exported ${count} contacts as ${fileName} and sent to chat.`,
            data: { count, fileName },
          };
        } catch (err: any) {
          console.error('[ContactPlugin] Error exporting contacts:', err);
          return { success: false, message: `Failed to export contacts: ${err.message}` };
        }
      },
    },
    {
      name: 'reply_unreplied_messages',
      description:
        'Scans the bot address book, active sessions, and chat logs to find and reply to any unreplied direct messages or unaddressed contacts.',
      parameters: {
        type: 'object',
        properties: {},
      },
      execute: async (_args: {}, ctx: ExecutionContext): Promise<ToolResult> => {
        try {
          const result = await whatsAppClient.replyUnrepliedMessages();
          return {
            success: true,
            message: result.summary,
            data: result,
          };
        } catch (err: any) {
          return {
            success: false,
            message: `Failed to process unreplied messages: ${err.message}`,
          };
        }
      },
    },
    {
      name: 'send_message_to_contact',
      description:
        'Sends a direct WhatsApp text message to ANY phone number (e.g. "+234 913 191 8009", "09131918009"), contact name, or to the bot\'s boss/creator Ademola (+2348108574293). When asked to message or tell your boss/creator, pass recipient as "boss" or "+2348108574293". Verifies live WhatsApp delivery confirmation.',
      parameters: {
        type: 'object',
        properties: {
          recipient: {
            type: 'string',
            description:
              'The phone number with country code (e.g. "+234 913 191 8009", "09131918009"), contact name, or "boss"/"Ademola". Any phone number can be messaged directly without saving first.',
          },
          phone: {
            type: 'string',
            description:
              'Optional alias for recipient phone number (e.g. "+234 913 191 8009", "09131918009").',
          },
          message: {
            type: 'string',
            description: 'The exact text message to send to the recipient.',
          },
        },
        required: ['message'],
      },
      execute: async (
        args: {
          recipient?: string;
          phone?: string;
          phone_number?: string;
          to?: string;
          name?: string;
          contact?: string;
          message?: string;
          text?: string;
          content?: string;
        },
        ctx: ExecutionContext
      ): Promise<ToolResult> => {
        try {
          let rawRecipient = (
            args.recipient ||
            args.phone ||
            args.phone_number ||
            args.to ||
            args.name ||
            args.contact ||
            ''
          ).trim();
          let rawMessage = (args.message || args.text || args.content || '').trim();
          const isOwner = userProfileManager.isOwner(ctx.senderJid, ctx.senderName);

          let targetJid = '';
          let targetName = args.name?.trim() || rawRecipient;
          let targetPhone = '';

          // -1. Check if recipient refers to the bot's boss / owner / creator / Ademola
          const isBossRecipient =
            /^(the\s+)?(my\s+)?(your\s+)?(boss|owner|creator|maker|developer|dev|engineer|ademola|hardez)$/i.test(rawRecipient) ||
            /\b(your\s+boss|my\s+boss|the\s+boss|your\s+creator|the\s+creator|your\s+owner|the\s+owner|ademola)\b/i.test(rawRecipient);

          if (isBossRecipient) {
            targetPhone = '2348108574293';
            targetJid = '2348108574293@s.whatsapp.net';
            targetName = 'Ademola (Boss)';
          }

          // 0. Check if recipient is a relative reference ("him", "her", "them", "that number", "last guy") or empty
          const isRelativeRef =
            /^(the\s+)?(last|previous)\s+(guy|person|contact|number|one|dude)|(guy\s+(wey|that|u|you))|^(him|her|them|that\s+number)$/i.test(rawRecipient);

          if (!targetJid && (isRelativeRef || !rawRecipient || rawRecipient === 'undefined')) {
            // First check recent messages in THIS chat for any phone number mentioned
            try {
              const recentInChat = db.prepare(`
                SELECT message_text FROM chat_logs
                WHERE chat_jid = ?
                ORDER BY id DESC LIMIT 8
              `).all(ctx.chatJid) as Array<{ message_text: string | null }>;

              for (const r of recentInChat) {
                const txt = r.message_text || '';
                const phoneMatch = txt.match(/(?:(?:\+|00)?234|0)\s*[789][01]\s*(?:[\s-]?\d{3,4}){2}|\+?\d[\d\s-]{9,}\d/);
                if (phoneMatch) {
                  const extracted = contactService.extractPhoneNumber(phoneMatch[0]);
                  if (extracted && extracted.length >= 7 && extracted.length <= 15) {
                    targetPhone = extracted;
                    targetJid = `${extracted}@s.whatsapp.net`;
                    const saved = contactService.getContact(extracted);
                    targetName = saved?.custom_name || saved?.display_name || `+${extracted}`;
                    break;
                  }
                }
              }
            } catch (err) {
              console.warn('[ContactPlugin] Error scanning recent chat for phone number:', err);
            }

            // Fallback: check last outbound contact messaged in another chat (STRICTLY OWNER ONLY)
            if (!targetJid && isOwner) {
              try {
                const lastOutbound = db.prepare(`
                  SELECT chat_jid FROM chat_logs
                  WHERE sender_jid = 'bot' AND is_group = 0 AND chat_jid != ?
                  ORDER BY id DESC LIMIT 1
                `).get(ctx.chatJid) as { chat_jid: string } | undefined;

                if (lastOutbound && lastOutbound.chat_jid) {
                  targetJid = lastOutbound.chat_jid;
                  targetPhone = contactService.extractPhoneNumber(targetJid);
                  const saved = contactService.getContact(targetPhone || targetJid);
                  targetName = saved?.custom_name || saved?.display_name || (targetPhone ? `+${targetPhone}` : targetJid);
                }
              } catch (err) {
                console.warn('[ContactPlugin] Error finding last messaged contact:', err);
              }
            }
          }

          // 1. Direct phone extraction if recipient has digits or matches phone pattern
          if (!targetJid && rawRecipient) {
            // Check if rawRecipient contains a phone number pattern anywhere
            const phoneMatch = rawRecipient.match(/(?:(?:\+|00)?234|0)\s*[789][01]\s*(?:[\s-]?\d{3,4}){2}|\+?\d[\d\s-]{9,}\d/);
            const digits = phoneMatch ? contactService.extractPhoneNumber(phoneMatch[0]) : contactService.extractPhoneNumber(rawRecipient);

            if (digits && digits.length >= 7 && digits.length <= 15) {
              targetPhone = digits;
              targetJid = `${digits}@s.whatsapp.net`;
              const saved = isOwner ? contactService.getContact(digits) : null;
              if (saved) {
                targetName = saved.custom_name || saved.display_name || targetName;
              } else if (isOwner && args.name && args.name.trim() && !/^\+?\d+$/.test(args.name.trim())) {
                contactService.saveContact(digits, args.name.trim());
                targetName = args.name.trim();
              } else {
                targetName = `+${digits}`;
              }
            } else if (isOwner) {
              // 2. Look up in contactService by name or nickname (STRICTLY OWNER ONLY)
              const saved = contactService.getContact(rawRecipient);
              if (saved) {
                targetName = saved.custom_name || saved.display_name || rawRecipient;
                targetPhone = saved.phone_number;
                if (saved.phone_number && saved.phone_number.length <= 15 && !saved.phone_number.startsWith('0')) {
                  targetJid = `${saved.phone_number}@s.whatsapp.net`;
                } else {
                  targetJid = saved.jid;
                }
              } else {
                // 3. Fallback search in SQLite contacts table (exclude accidental Crypto Boss match)
                const row = db.prepare(`
                  SELECT * FROM contacts
                  WHERE (display_name LIKE ? OR custom_name LIKE ? OR notes LIKE ?)
                    AND display_name != 'Crypto Boss😊'
                  ORDER BY CASE WHEN jid LIKE '%@s.whatsapp.net' THEN 0 ELSE 1 END
                  LIMIT 1
                `).get(`%${rawRecipient}%`, `%${rawRecipient}%`, `%${rawRecipient}%`) as any;

                if (row) {
                  targetName = row.custom_name || row.display_name || rawRecipient;
                  targetPhone = row.phone_number;
                  if (row.phone_number && row.phone_number.length <= 15) {
                    targetJid = `${row.phone_number}@s.whatsapp.net`;
                  } else {
                    targetJid = row.jid;
                  }
                }
              }
            }
          }

          // 4. Recover message content if message is empty or generic confirmation ("do that", "send it", "send the message")
          const isGenericMessage = !rawMessage || /^(do that|do it|do so|send it|send am|send the message|send the message to him|proceed|yes|confirm)$/i.test(rawMessage);
          if (isGenericMessage) {
            try {
              const recentInChat = db.prepare(`
                SELECT message_text FROM chat_logs
                WHERE chat_jid = ?
                ORDER BY id DESC LIMIT 8
              `).all(ctx.chatJid) as Array<{ message_text: string | null }>;

              for (const r of recentInChat) {
                const txt = r.message_text || '';
                // Check for quotes: “Ademola said he should greet Amina”
                const quoteMatch = txt.match(/[\u201c"']([^\u201c\u201d"']{3,})[\u201d"']/);
                if (quoteMatch && quoteMatch[1] && !quoteMatch[1].toLowerCase().includes('message')) {
                  rawMessage = quoteMatch[1].trim();
                  break;
                }
                const tellMatch = txt.match(/(?:tell|inform|warn|ask)\s+(?:him|her|them|am)\s+(?:say|that\s+)?(.+)/i);
                if (tellMatch && tellMatch[1]) {
                  rawMessage = tellMatch[1].trim();
                  break;
                }
              }
            } catch {}
          }

          // Clean up leading conversational prefixes from message body
          let cleanMessage = rawMessage
            .replace(/^(?:tell|inform|warn|ask)\s+(?:him|her|them|am)\s+(?:say|that\s+)?/i, '')
            .replace(/^(?:say|that)\s+/i, '')
            .trim();
          if (!cleanMessage) cleanMessage = rawMessage;

          // If relaying a message to the bot's boss Ademola from another user or group, attribute it clearly
          const isTargetAdemola = targetJid === '2348108574293@s.whatsapp.net' || targetPhone === '2348108574293';
          if (!isOwner && isTargetAdemola) {
            const senderPhone = contactService.extractPhoneNumber(ctx.senderJid);
            const senderLabel = ctx.senderName ? `${ctx.senderName} (+${senderPhone || ctx.senderJid.split('@')[0]})` : `+${senderPhone || ctx.senderJid.split('@')[0]}`;
            const originLabel = ctx.isGroup ? `in group chat` : `via DM`;
            cleanMessage = `📩 [Message for Boss from ${senderLabel} ${originLabel}]:\n"${cleanMessage}"`;
          }

          if (!targetJid) {
            // Smart Fallback: Check if the recipient name matches a WhatsApp group!
            const matchedGroup = findKnownGroup(rawRecipient);
            if (matchedGroup && ctx.sock) {
              await ctx.sock.sendMessage(matchedGroup.group_jid, { text: cleanMessage });
              chatLogger.logMessage({
                chatJid: matchedGroup.group_jid,
                senderJid: 'bot',
                senderName: config.bot.name,
                isGroup: true,
                contentType: 'text',
                messageText: cleanMessage,
                timestamp: Date.now(),
              });
              return {
                success: true,
                message: `✅ Message sent to group "${matchedGroup.subject}": "${cleanMessage}"`,
                data: { groupJid: matchedGroup.group_jid, subject: matchedGroup.subject },
              };
            }

            return {
              success: false,
              message: `Could not determine who to message. Please provide their phone number (e.g. +234 913 191 8009) or contact name.`,
            };
          }

          if (!cleanMessage) {
            return {
              success: false,
              message: `Recipient ${targetName} resolved, but no message text was provided to send.`,
            };
          }

          // Pre-validate on WhatsApp to prevent USync 428 connection closure and resolve canonical JID
          const lookupTarget = targetPhone || targetJid.split('@')[0];
          try {
            if (ctx.sock?.onWhatsApp && !targetJid.endsWith('@lid')) {
              const onWa = await ctx.sock.onWhatsApp(lookupTarget);
              if (onWa && onWa.length > 0 && !onWa[0]?.exists) {
                return {
                  success: false,
                  message: `The number +${lookupTarget} is not registered on WhatsApp.`,
                };
              }
              if (onWa && onWa[0]?.jid) {
                targetJid = onWa[0].jid;
              }
            }
          } catch (waErr: any) {
            console.warn(`[ContactPlugin] onWhatsApp check warning for ${lookupTarget}:`, waErr.message);
          }

          // Cold Contact Safety:
          // If recipient is NOT in saved contacts and has never messaged the bot,
          // ensure clear attribution so the stranger does not tap "Block & Report" on WhatsApp.
          let hasInboundHistory = false;
          try {
            const row = db.prepare(`SELECT 1 FROM chat_logs WHERE chat_jid = ? AND sender_jid != 'bot' LIMIT 1`).get(targetJid);
            hasInboundHistory = Boolean(row);
          } catch {}

          const isSavedContact = Boolean(targetPhone && contactService.getContact(targetPhone));
          let finalDispatchMessage = cleanMessage;
          if (!isTargetAdemola && !hasInboundHistory && !isSavedContact && !cleanMessage.toLowerCase().includes('ademola')) {
            finalDispatchMessage = `${cleanMessage}\n\n— Sent on behalf of Ademola via Forgelabs`;
          }

          console.log(`[ContactPlugin] 📨 Sending outbound message to ${targetName} (${targetJid}): "${finalDispatchMessage.slice(0, 60)}..."`);

          // Simulate realistic human typing presence before dispatching to cold/direct contacts
          try {
            await antiBanEngine.simulateTypingPresence(ctx.sock, targetJid, finalDispatchMessage, false, 0, false);
          } catch {}

          // Send message through OutboundSender with explicit command authorization
          const sent = await OutboundSender.replyText(ctx.sock, targetJid, finalDispatchMessage, undefined, true);
          if (!sent) {
            return {
              success: false,
              message: `Delivery failed to ${targetName} (${targetJid}): Socket could not dispatch message.`,
            };
          }

          const stanzaId = sent?.key?.id || `wa_${Date.now()}`;
          const receipt = await whatsAppClient.waitForDeliveryConfirmation(stanzaId, targetJid, 2000);

          const phoneDisplay = targetPhone ? ` (+${targetPhone})` : '';
          return {
            success: true,
            message: `✅ DELIVERY CONFIRMED to ${targetName}${phoneDisplay} | Receipt ID: ${receipt.msgId} | Status: ${receipt.statusLabel} | Message: "${finalDispatchMessage}"`,
            data: {
              recipient: targetName,
              targetJid,
              message: rawMessage,
              receiptId: receipt.msgId,
              deliveryStatus: receipt.statusLabel,
              confirmed: receipt.confirmed,
            },
          };
        } catch (err: any) {
          console.error('[ContactPlugin] Error sending message to contact:', err);
          return {
            success: false,
            message: `Failed to send message: ${err.message}`,
          };
        }
      },
    },
  ];
}

export const contactPlugin = new ContactPlugin();
