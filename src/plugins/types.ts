import type { WASocket, WAMessage } from '@whiskeysockets/baileys';

export interface ExecutionContext {
  sock: WASocket;
  chatJid: string;
  senderJid: string;
  senderName: string;
  isGroup: boolean;
  rawMessage?: WAMessage;
  replyText: (text: string) => Promise<any>;
  sendSticker?: (bufferOrPath: Buffer | string, mentions?: string[]) => Promise<any>;
  sendImage: (bufferOrUrl: Buffer | string, caption?: string) => Promise<any>;
  sendAudio: (bufferOrUrl: Buffer | string, isVoiceNote?: boolean) => Promise<any>;
  sendVideo: (bufferOrUrl: Buffer | string, caption?: string) => Promise<any>;
  sendContact: (displayName: string, phoneNumber: string) => Promise<any>;
  sendPoll?: (question: string, options: string[], selectableCount?: number) => Promise<any>;
}

export interface ToolResult {
  success: boolean;
  message?: string;
  data?: any;
}

export interface BotTool {
  name: string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, any>;
    required?: string[];
  };
  execute: (args: any, context: ExecutionContext) => Promise<ToolResult>;
}

export interface IPlugin {
  name: string;
  version: string;
  description: string;
  tools?: BotTool[];
  onLoad?: () => Promise<void>;
  onUnload?: () => Promise<void>;
}
