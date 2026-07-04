export interface IncomingMessage {
  channelId: string;
  userId: string;
  userName: string;
  chatId: string;
  type: 'text' | 'voice' | 'file';
  content: string;
  audioUrl?: string;
  fileUrl?: string;
  timestamp: number;
  raw?: any;
}

export interface MessageCard {
  title: string;
  sections: Array<{
    header?: string;
    content: string;
    actions?: Array<{ label: string; action: string }>;
  }>;
}

export interface MessageChannel {
  readonly id: string;
  readonly name: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  isRunning(): boolean;
  onMessage(handler: (msg: IncomingMessage) => Promise<void>): void;
  sendText(chatId: string, text: string): Promise<void>;
  sendCard(chatId: string, card: MessageCard): Promise<void>;
  sendFile(chatId: string, filePath: string): Promise<void>;
  sendImage?(chatId: string, imageData: Buffer, mimeType: string): Promise<void>;
}
