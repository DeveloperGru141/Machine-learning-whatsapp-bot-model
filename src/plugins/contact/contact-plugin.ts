import fs from 'fs';
import path from 'path';
import { IPlugin, BotTool, ExecutionContext, ToolResult } from '../types.js';
import { contactService } from '../../memory/contact-service.js';
import { config } from '../../config/env.js';

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

          const cleanPhone = contactService.extractPhoneNumber(targetPhone);
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
  ];
}

export const contactPlugin = new ContactPlugin();
