import type { WASocket, proto } from '@whiskeysockets/baileys';

export interface ExecutionContext {
  sock: WASocket;
  chatJid: string;
  senderJid: string;
  senderName: string;
  isGroup: boolean;
  rawMessage: proto.IWebMessageInfo;
  replyText: (text: string) => Promise<any>;
  sendSticker: (bufferOrPath: Buffer | string) => Promise<any>;
  sendImage: (bufferOrUrl: Buffer | string, caption?: string) => Promise<any>;
  sendAudio: (bufferOrUrl: Buffer | string, isVoiceNote?: boolean) => Promise<any>;
  sendVideo: (bufferOrUrl: Buffer | string, caption?: string) => Promise<any>;
  sendContact: (displayName: string, phoneNumber: string) => Promise<any>;
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
