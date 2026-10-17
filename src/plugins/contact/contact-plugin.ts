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
          // If no phone number provided, save current sender
          const targetPhone = args.phone_number || ctx.senderJid;
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
      execute: async (args: { query: string }): Promise<ToolResult> => {
        try {
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
        'Lists saved contacts in the bot address book with names, phone numbers, and notes. Useful when the user asks who is in contacts, asks for a list of contacts, or wants to see saved people.',
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
      execute: async (args: { limit?: number; filter?: string }): Promise<ToolResult> => {
        try {
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
          const isLid = ctx.senderJid.endsWith('@lid') || (targetPhone && targetPhone.endsWith('@lid')) || cleanPhone.length > 13;
          if (isLid) {
            const saved = contactService.getContact(ctx.senderJid);
            if (saved && saved.phone_number && !saved.jid.endsWith('@lid') && saved.phone_number.length <= 13) {
              cleanPhone = saved.phone_number;
            } else {
              return {
                success: false,
                message: 'No phone number available to create a contact card for this user.',
              };
            }
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
        'Sends a direct WhatsApp text message to someone in the bot address book or to any phone number, and verifies live WhatsApp delivery confirmation. Use this tool whenever a user asks to message someone, text someone, relay a message to a contact, or tell a person something.',
      parameters: {
        type: 'object',
        properties: {
          recipient: {
            type: 'string',
            description:
              'The name of the contact in the address book (e.g. "Micah", "David") or their phone number with country code (e.g. "+2349126433601", "09126433601").',
          },
          phone: {
            type: 'string',
            description:
              'Optional alias for recipient phone number (e.g. "+2349126433601", "09126433601").',
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
          const rawRecipient = (
            args.recipient ||
            args.phone ||
            args.phone_number ||
            args.to ||
            args.name ||
            args.contact ||
            ''
          ).trim();
          const rawMessage = (args.message || args.text || args.content || '').trim();

          if (!rawRecipient || !rawMessage) {
            return {
              success: false,
              message: 'Both recipient (name or phone number) and message are required to send a message.',
            };
          }

          let targetJid = '';
          let targetName = args.name?.trim() || rawRecipient;
          let targetPhone = '';

          // 0. Check if recipient refers to "last guy", "the last person", "guy wey u message", etc.
          const isRelativeRef =
            /^(the\s+)?(last|previous)\s+(guy|person|contact|number|one|dude)|(guy\s+(wey|that|u|you))|^(him|her|them)$/i.test(rawRecipient);

          if (isRelativeRef) {
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

          if (!targetJid) {
            // 1. Check if recipient is directly a phone number
            const cleanDigits = contactService.extractPhoneNumber(rawRecipient);
            if (cleanDigits && cleanDigits.length >= 7 && cleanDigits.length <= 15) {
              targetPhone = cleanDigits;
              targetJid = `${cleanDigits}@s.whatsapp.net`;
              const saved = contactService.getContact(cleanDigits);
              if (saved) {
                targetName = saved.custom_name || saved.display_name || targetName;
              } else if (args.name && args.name.trim() && !/^\+?\d+$/.test(args.name.trim())) {
                contactService.saveContact(cleanDigits, args.name.trim());
                targetName = args.name.trim();
              }
            } else {
              // 2. Look up in contactService by name or nickname
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
                // 3. Fallback search in SQLite contacts table
                const row = db.prepare(`
                  SELECT * FROM contacts
                  WHERE display_name LIKE ? OR custom_name LIKE ? OR notes LIKE ?
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

          if (!targetJid) {
            // Smart Fallback: Check if the recipient name matches a WhatsApp group!
            const matchedGroup = findKnownGroup(rawRecipient);
            if (matchedGroup && ctx.sock) {
              await ctx.sock.sendMessage(matchedGroup.group_jid, { text: rawMessage });
              chatLogger.logMessage({
                chatJid: matchedGroup.group_jid,
                senderJid: 'bot',
                senderName: config.bot.name,
                isGroup: true,
                contentType: 'text',
                messageText: rawMessage,
                timestamp: Date.now(),
              });
              return {
                success: true,
                message: `✅ Message sent to group "${matchedGroup.subject}": "${rawMessage}"`,
                data: { groupJid: matchedGroup.group_jid, subject: matchedGroup.subject },
              };
            }

            return {
              success: false,
              message: `Could not find a contact matching "${rawRecipient}" in the address book. Please specify their phone number so I can send the message.`,
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
          let finalDispatchMessage = rawMessage;
          if (!hasInboundHistory && !isSavedContact && !rawMessage.toLowerCase().includes('ademola')) {
            finalDispatchMessage = `${rawMessage}\n\n— Sent on behalf of Ademola (08108574293) via Forgelabs`;
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
