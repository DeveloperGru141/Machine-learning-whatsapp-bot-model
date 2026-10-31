import fs from 'fs';
import path from 'path';
import { IPlugin, BotTool, ExecutionContext, ToolResult } from '../types.js';
import { contactService } from '../../memory/contact-service.js';
import { whatsAppClient } from '../../core/client.js';
import { config } from '../../config/env.js';
import { db, findKnownGroup, recordRelaySession } from '../../memory/db.js';
import { chatLogger } from '../../memory/chat-logger.js';
import { OutboundSender } from '../../core/sender.js';
import { antiBanEngine } from '../../security/anti-ban.js';
import { userProfileManager } from '../../memory/user-profiles.js';
import { contactReminderService } from './contact-reminder-service.js';

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
          const isOwner = userProfileManager.isOwner(ctx.senderJid, ctx.senderName);
          if (args.phone_number && !isOwner) {
            return {
              success: false,
              message: 'Only the bot owner can add another person’s phone number to the shared address book. You can save your own contact without providing a number.',
            };
          }
          let targetPhone = args.phone_number;
          if (!targetPhone) {
            targetPhone = ctx.senderJid;
          }
          const result = await contactService.saveContact(targetPhone, args.name, args.notes);

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
          const explicitlyRequestsPhone = /\b(phone|number|contact details|contact info)\b/i.test(cleanQuery);

          if (isBossQuery) {
            const isOwner = userProfileManager.isOwner(ctx.senderJid, ctx.senderName);
            const ownerContact = await contactService.getContact('boss');
            const includePhone = isOwner && explicitlyRequestsPhone && !ctx.isGroup && Boolean(ownerContact?.phone_number);
            return {
              success: true,
              message: `Found contact: *Ademola (Creator & Boss)*${includePhone ? `\n📞 Phone: +${ownerContact!.phone_number}` : ''}\n📝 Notes: Creator, developer, and owner of Forgelabs assistant`,
              data: {
                ...(includePhone ? { phone_number: ownerContact!.phone_number, jid: ownerContact!.jid } : {}),
                display_name: 'Ademola (Creator & Boss)',
                custom_name: 'Ademola (Boss)',
              },
            };
          }

          if (ctx.isGroup) {
            return { success: false, message: 'Saved address book lookups are available only in a private chat.' };
          }

          const isOwner = userProfileManager.isOwner(ctx.senderJid, ctx.senderName);
          if (!isOwner) {
            return {
              success: false,
              message: 'Omo chief, I no fit look up other people contact information give you o! That one na strictly confidential 😂',
            };
          }

          const contact = await contactService.getContact(args.query);
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
          if (ctx.isGroup) {
            return { success: false, message: 'The saved contact directory can only be listed in a private chat.' };
          }

          const isOwner = userProfileManager.isOwner(ctx.senderJid, ctx.senderName);
          if (!isOwner) {
            return {
              success: false,
              message: 'Omo chief, I no fit release other people contact information give you o! Address book strictly protected 😂',
            };
          }

          const limit = Math.min(Math.max(Number(args.limit) || 25, 1), 100);
          let contacts = await contactService.getAllContacts(limit);
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
            const saved = await contactService.getContact(targetPhone);
            targetName = saved?.custom_name || saved?.display_name || ctx.senderName;
          }

          let cleanPhone = contactService.extractPhoneNumber(targetPhone);
          const isLid = ctx.senderJid.endsWith('@lid') || (targetPhone && targetPhone.endsWith('@lid')) || !cleanPhone || cleanPhone.length > 15 || /^10\d{13,}$/.test(cleanPhone);
          if (isLid) {
            const saved = await contactService.getContact(ctx.senderJid);
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
          if (ctx.isGroup) {
            return { success: false, message: 'Contact exports can only be sent in a private chat.' };
          }

          const isOwner = userProfileManager.isOwner(ctx.senderJid, ctx.senderName);
          if (!isOwner) {
            return {
              success: false,
              message: 'Permission denied: Only bot owner Ademola is authorized to export the contact address book.',
            };
          }

          const limit = Math.min(Math.max(Number(args.limit) || 2000, 1), 5000);
          const { vcfContent, count } = await contactService.exportVcf(limit);

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
        if (ctx.isGroup) {
          return { success: false, message: 'The unreplied-DM scan can only be managed in a private chat.' };
        }
        if (!userProfileManager.isOwner(ctx.senderJid, ctx.senderName)) {
          return {
            success: false,
            message: 'Permission denied: only the bot owner can run the cross-chat unreplied-message scan.',
          };
        }
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
        'Lets the owner send a direct WhatsApp text to an explicitly named recipient. Other users can only ask for a message to be relayed to the configured owner from a private chat. Requires the exact recipient and exact message text; never infers either from recent chat history.',
      parameters: {
        type: 'object',
        properties: {
          recipient: {
            type: 'string',
            maxLength: 100,
            description:
              'The exact phone number/contact name (owner only), or "boss"/"Ademola" when asking to relay to the configured owner.',
          },
          phone: {
            type: 'string',
            description:
              'Optional alias for recipient phone number (e.g. "+234 913 191 8009", "09131918009").',
          },
          message: {
            type: 'string',
            description: 'The exact text message to send to the recipient.',
            minLength: 1,
            maxLength: 2000,
          },
        },
        required: ['recipient', 'message'],
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
          const isOwner = await userProfileManager.isConfiguredOwnerAlias(ctx.senderJid);

          let targetJid = '';
          let targetName = args.name?.trim() || rawRecipient;
          let targetPhone = '';

          // -1. Check if recipient refers to the bot's boss / owner / creator / Ademola
          const isBossRecipient =
            /^(the\s+)?(my\s+)?(your\s+)?(boss|owner|creator|maker|developer|dev|engineer|ademola|hardez)$/i.test(rawRecipient) ||
            /\b(your\s+boss|my\s+boss|the\s+boss|your\s+creator|the\s+creator|your\s+owner|the\s+owner|ademola)\b/i.test(rawRecipient);

          if (isBossRecipient) {
            const ownerContact = await contactService.getContact('boss');
            if (!ownerContact?.jid) {
              return { success: false, message: 'The bot owner contact is not configured.' };
            }
            targetPhone = ownerContact.phone_number || '';
            targetJid = ownerContact.jid;
            targetName = 'Ademola (Boss)';
          }

          if (!isOwner && !isBossRecipient) {
            return {
              success: false,
              message: 'Permission denied: only the bot owner can message arbitrary contacts. You can ask me to relay a message to the owner in a private chat.',
            };
          }
          if (!isOwner && ctx.isGroup && isBossRecipient) {
            return {
              success: false,
              message: 'For privacy, ask me to relay a message to the owner in a private chat.',
            };
          }

          // 1. Direct phone extraction if recipient has digits or matches phone pattern
          if (!targetJid && rawRecipient) {
            // Check if rawRecipient contains a phone number pattern anywhere
            const phoneMatch = rawRecipient.match(/(?:(?:\+|00)?234|0)\s*[789][01]\s*(?:[\s-]?\d{3,4}){2}|\+?\d[\d\s-]{9,}\d/);
            const digits = phoneMatch ? contactService.extractPhoneNumber(phoneMatch[0]) : contactService.extractPhoneNumber(rawRecipient);

            if (digits && digits.length >= 7 && digits.length <= 15) {
              targetPhone = digits;
              targetJid = `${digits}@s.whatsapp.net`;
              const saved = isOwner ? await contactService.getContact(digits) : null;
              if (saved) {
                targetName = saved.custom_name || saved.display_name || targetName;
              } else if (isOwner && args.name && args.name.trim() && !/^\+?\d+$/.test(args.name.trim())) {
                await contactService.saveContact(digits, args.name.trim());
                targetName = args.name.trim();
              } else {
                targetName = `+${digits}`;
              }
            } else if (isOwner) {
              // 2. Look up in contactService by name or nickname (STRICTLY OWNER ONLY)
              const saved = await contactService.getContact(rawRecipient);
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
                const row = await db.prepare(`
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

          // Never reconstruct outbound text from previous messages or generic confirmations.
          if (!rawMessage || /^(do that|do it|do so|send it|send am|send the message|send the message to him|proceed|yes|confirm)$/i.test(rawMessage)) {
            return {
              success: false,
              message: 'Please provide the exact text you want me to send.',
            };
          }

          // Clean up leading conversational prefixes from message body
          let cleanMessage = rawMessage
            .replace(/^(?:tell|inform|warn|ask)\s+(?:him|her|them|am)\s+(?:say|that\s+)?/i, '')
            .replace(/^(?:say|that)\s+/i, '')
            .trim();
          if (!cleanMessage) cleanMessage = rawMessage;

          // If relaying a message to the bot's boss Ademola from another user or group, attribute it clearly
          const isTargetAdemola = userProfileManager.isOwner(targetJid);
          if (!isOwner && isTargetAdemola) {
            const senderPhone = contactService.extractPhoneNumber(ctx.senderJid);
            const senderLabel = ctx.senderName ? `${ctx.senderName} (+${senderPhone || ctx.senderJid.split('@')[0]})` : `+${senderPhone || ctx.senderJid.split('@')[0]}`;
            const originLabel = ctx.isGroup ? `in group chat` : `via DM`;
            cleanMessage = `📩 [Message for Boss from ${senderLabel} ${originLabel}]:\n"${cleanMessage}"`;
          }

          if (!targetJid) {
            // Smart Fallback: Check if the recipient name matches a WhatsApp group!
            const matchedGroup = await findKnownGroup(rawRecipient);
            if (matchedGroup && ctx.sock) {
              if (!isOwner) {
                try {
                  const meta = await ctx.sock.groupMetadata(matchedGroup.group_jid);
                  const senderPhone = contactService.extractPhoneNumber(ctx.senderJid);
                  const normalizedSender = `${ctx.senderJid.split(':')[0].split('@')[0]}@${ctx.senderJid.split('@')[1] || 's.whatsapp.net'}`;
                  const requesterIsAdmin = meta.participants?.some((participant: any) => {
                    const participantId = participant.id
                      ? `${participant.id.split(':')[0].split('@')[0]}@${participant.id.split('@')[1] || 's.whatsapp.net'}`
                      : '';
                    const participantPhone = contactService.extractPhoneNumber(participant.id || '');
                    const matchesRequester = participant.id === ctx.senderJid ||
                      participantId === normalizedSender ||
                      (senderPhone && participantPhone === senderPhone);
                    return matchesRequester && (participant.admin === 'admin' || participant.admin === 'superadmin');
                  });
                  if (!requesterIsAdmin) {
                    return { success: false, message: 'Permission denied: only the bot owner or a target-group admin can send a message there.' };
                  }
                } catch {
                  return { success: false, message: 'Permission denied: target-group admin status could not be verified.' };
                }
              }
              await ctx.sock.sendMessage(matchedGroup.group_jid, { text: cleanMessage });
              await chatLogger.logMessage({
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

          const checkOutbound = () => antiBanEngine.canSendOutbound({ chatJid: targetJid, isGroup: false }, true);
          const outboundCheck = isOwner
            ? await antiBanEngine.runOwnerAuthorizedOutbound(checkOutbound)
            : await checkOutbound();
          if (!outboundCheck.allowed) {
            return {
              success: false,
              message: `Message not sent to ${targetName}: ${outboundCheck.reason}`,
            };
          }
          let finalDispatchMessage = cleanMessage;

          console.log(`[ContactPlugin] 📨 Sending outbound message to ${targetName} (${targetJid}): "${finalDispatchMessage.slice(0, 60)}..."`);

          // Show presence only after the recipient has passed the recent-interaction policy.
          try {
            await antiBanEngine.simulateTypingPresence(ctx.sock, targetJid, finalDispatchMessage, false, 0, false);
          } catch {}

          const dispatchMessage = () => OutboundSender.replyText(ctx.sock, targetJid, finalDispatchMessage);
          const sent = isOwner
            ? await antiBanEngine.runOwnerAuthorizedOutbound(dispatchMessage)
            : await dispatchMessage();
          if (!sent) {
            return {
              success: false,
              message: `Delivery failed to ${targetName} (${targetJid}): Socket could not dispatch message.`,
            };
          }

          // Record dispatch in contact_relay_sessions so any inbound reply from this contact
          // is automatically forwarded back to whoever requested it (or to the group where the request was made),
          // NEVER blindly to the owner Ademola.
          try {
            await recordRelaySession({
              requesterJid: ctx.senderJid,
              requesterName: ctx.senderName,
              originChatJid: ctx.chatJid,
              originIsGroup: ctx.isGroup,
              targetJid: targetJid,
              targetPhone: targetPhone || contactService.extractPhoneNumber(targetJid),
              dispatchedText: finalDispatchMessage,
            });
            console.log(`[ContactPlugin] 📋 Registered relay session for recipient ${targetJid} -> requester ${ctx.senderJid} (${ctx.chatJid})`);
          } catch (relayErr: any) {
            console.warn('[ContactPlugin] Warning recording relay session:', relayErr.message);
          }

          const stanzaId = sent?.key?.id || `wa_${Date.now()}`;
          const receipt = await whatsAppClient.waitForDeliveryConfirmation(stanzaId, targetJid, 2000);

          const phoneDisplay = targetPhone ? ` (+${targetPhone})` : '';
          return {
            success: true,
            message: `Message dispatched to ${targetName}${phoneDisplay}. WhatsApp status: ${receipt.statusLabel}. Device delivery confirmed: ${receipt.confirmed ? 'yes' : 'no'}.`,
            data: {
              recipient: targetName,
              targetJid,
              message: rawMessage,
              receiptId: receipt.msgId,
              deliveryStatus: receipt.statusLabel,
              confirmed: receipt.confirmed,
              serverAcknowledged: receipt.serverAcknowledged,
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
    {
      name: 'start_contact_save_reminders',
      description:
        'Initiates a safe, human-paced, anti-ban contact outreach campaign that messages contacts in the bot address book and chat history with a polite, non-spam reminder to save the bot\'s number (+234 705 896 7815) so they can view WhatsApp status posts. STRICTLY OWNER ONLY. Employs 10 randomized conversational templates, 35-75s human delays, typing presence simulation, and one-time deduplication to prevent bans.',
      parameters: {
        type: 'object',
        properties: {
          batch_size: {
            type: 'number',
            description: 'Number of contacts to message in this safe batch (default 20, max 50).',
          },
          delay_seconds_min: {
            type: 'number',
            description: 'Minimum delay in seconds between messages (default 35s).',
          },
          delay_seconds_max: {
            type: 'number',
            description: 'Maximum delay in seconds between messages (default 75s).',
          },
          only_interacted: {
            type: 'boolean',
            description: 'Must remain true: only contacts who messaged the bot within the last 30 days are eligible. Cold contact outreach is disabled.',
          },
          dry_run: {
            type: 'boolean',
            description: 'If true, simulates the campaign and previews recipients without sending any real messages.',
          },
        },
      },
      execute: async (
        args: {
          batch_size?: number;
          delay_seconds_min?: number;
          delay_seconds_max?: number;
          only_interacted?: boolean;
          dry_run?: boolean;
        },
        ctx: ExecutionContext
      ): Promise<ToolResult> => {
        if (ctx.isGroup) {
          return { success: false, message: 'Contact reminder campaigns can only be managed in a private chat.' };
        }
        if (args.only_interacted === false) {
          return {
            success: false,
            message: 'Contact campaigns require only_interacted=true and are limited to people who messaged the bot in the last 30 days.',
          };
        }
        const isOwner = userProfileManager.isOwner(ctx.senderJid, ctx.senderName);
        if (!isOwner) {
          return {
            success: false,
            message: 'Permission denied: Only bot owner Ademola can initiate a contact save reminder broadcast.',
          };
        }

        const sock = ctx.sock || whatsAppClient.getSocket();
        if (!sock) {
          return {
            success: false,
            message: 'WhatsApp socket is not connected. Please ensure bot is online.',
          };
        }

        const result = await contactReminderService.start(sock, {
          batchSize: args.batch_size,
          delayMinSec: args.delay_seconds_min,
          delayMaxSec: args.delay_seconds_max,
          onlyInteracted: args.only_interacted,
          dryRun: args.dry_run,
        });

        return {
          success: result.success,
          message: result.message,
          data: result.data,
        };
      },
    },
    {
      name: 'get_contact_save_reminder_status',
      description:
        'Retrieves live progress and metrics for the contact save reminder campaign (total eligible, messaged so far, remaining, active status, last recipient, next scheduled dispatch).',
      parameters: {
        type: 'object',
        properties: {},
      },
      execute: async (_args: {}, ctx: ExecutionContext): Promise<ToolResult> => {
        if (ctx.isGroup) {
          return { success: false, message: 'Contact campaign status is available only in a private chat.' };
        }
        if (!userProfileManager.isOwner(ctx.senderJid, ctx.senderName)) {
          return { success: false, message: 'Permission denied: contact campaign details are private to the bot owner.' };
        }
        const status = await contactReminderService.getStatus();
        const stateDesc = status.isRunning
          ? `🟢 Active (Pacing: dispatching next in ~${status.nextScheduledInSec || 30}s)`
          : status.isPaused
          ? '⏸️ Paused'
          : '⚪ Idle / Completed';

        const summary = `📊 *Contact Save Reminder Status*:
- Status: ${stateDesc}
- Current Batch: ${status.currentBatchSent} / ${status.currentBatchGoal} sent
- All-Time Contacts Reminded: ${status.totalSentHistory}
- Remaining Pending Contacts: ${status.totalEligible}
${status.lastRecipient ? `- Last Recipient: ${status.lastRecipient}` : ''}`;

        return {
          success: true,
          message: summary,
          data: status,
        };
      },
    },
    {
      name: 'pause_contact_save_reminders',
      description: 'Immediately pauses an ongoing contact save reminder campaign.',
      parameters: {
        type: 'object',
        properties: {},
      },
      execute: async (_args: {}, ctx: ExecutionContext): Promise<ToolResult> => {
        if (ctx.isGroup) {
          return { success: false, message: 'Contact reminder campaigns can only be managed in a private chat.' };
        }
        const isOwner = userProfileManager.isOwner(ctx.senderJid, ctx.senderName);
        if (!isOwner) {
          return {
            success: false,
            message: 'Permission denied: Only bot owner Ademola can pause the contact save reminder campaign.',
          };
        }
        const result = contactReminderService.pause();
        return {
          success: result.success,
          message: result.message,
        };
      },
    },
    {
      name: 'preview_contact_save_reminders',
      description:
        'Previews warm contacts who messaged the bot recently; owner-only and never sends messages.',
      parameters: {
        type: 'object',
        properties: {
          count: {
            type: 'number',
            description: 'Number of upcoming contacts to preview (default 5, max 10).',
          },
          only_interacted: {
            type: 'boolean',
            description: 'Legacy option; preview is always limited to recent, warm contacts.',
          },
        },
      },
      execute: async (
        args: { count?: number; only_interacted?: boolean },
        ctx: ExecutionContext
      ): Promise<ToolResult> => {
        if (ctx.isGroup) {
          return { success: false, message: 'Contact reminders can only be previewed in a private chat.' };
        }
        if (!userProfileManager.isOwner(ctx.senderJid, ctx.senderName)) {
          return { success: false, message: 'Permission denied: only the bot owner can preview contact records.' };
        }
        const count = Math.min(args.count || 5, 10);
        const previews = await contactReminderService.preview(count, true);

        if (previews.length === 0) {
          return {
            success: true,
            message: 'No pending contacts found to preview. All eligible contacts have already received reminders!',
          };
        }

        const lines = previews.map(
          (p, i) =>
            `*${i + 1}. ${p.displayName}* (+${p.phoneNumber}) [${p.isWarm ? '🔥 Warm Chat' : '📇 Address Book'}] (Template #${p.templateIndex + 1}):\n"${p.sampleMessage}"`
        );

        return {
          success: true,
          message: `👀 *Previewing Next ${previews.length} Contact Save Reminders*:\n\n${lines.join('\n\n')}`,
          data: previews,
        };
      },
    },
  ];
}

export const contactPlugin = new ContactPlugin();
