import nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';
import { MessageChannel, IncomingMessage, MessageCard } from './types';

export interface EmailConfig {
  smtpHost: string;
  smtpPort: number;
  smtpUser: string;
  smtpPass: string;
  fromName: string;
  defaultRecipient: string;
}

export class EmailChannel implements MessageChannel {
  readonly id = 'email';
  readonly name = 'Email';

  private transporter: Transporter;
  private running = false;

  constructor(private config: EmailConfig) {
    this.transporter = nodemailer.createTransport({
      host: config.smtpHost,
      port: config.smtpPort,
      secure: config.smtpPort === 465,
      auth: { user: config.smtpUser, pass: config.smtpPass },
    });
  }

  async start(): Promise<void> {
    await this.transporter.verify();
    this.running = true;
    console.log('[EmailChannel] SMTP connection verified');
  }

  async stop(): Promise<void> {
    this.transporter.close();
    this.running = false;
  }

  isRunning(): boolean {
    return this.running;
  }

  onMessage(_handler: (msg: IncomingMessage) => Promise<void>): void {
    // Email is send-only, no incoming message handling
  }

  async sendText(recipient: string, text: string): Promise<void> {
    const to = recipient || this.config.defaultRecipient;
    if (!to) {
      console.warn('[EmailChannel] No recipient specified');
      return;
    }
    // Extract first line as subject, rest as body
    const lines = text.split('\n');
    const subject = lines[0].replace(/[#*_~`]/g, '').trim().slice(0, 100) || 'DeepSeno Notification';
    await this.transporter.sendMail({
      from: `"${this.config.fromName}" <${this.config.smtpUser}>`,
      to,
      subject,
      text,
    });
  }

  async sendCard(recipient: string, card: MessageCard): Promise<void> {
    const to = recipient || this.config.defaultRecipient;
    if (!to) return;
    const parts = card.sections.map(s =>
      s.header ? `## ${s.header}\n${s.content}` : s.content,
    );
    const body = parts.join('\n\n');
    await this.transporter.sendMail({
      from: `"${this.config.fromName}" <${this.config.smtpUser}>`,
      to,
      subject: card.title,
      text: body,
    });
  }

  async sendFile(recipient: string, filePath: string): Promise<void> {
    const to = recipient || this.config.defaultRecipient;
    if (!to) return;
    await this.transporter.sendMail({
      from: `"${this.config.fromName}" <${this.config.smtpUser}>`,
      to,
      subject: 'DeepSeno File',
      text: `Please find the attached file.`,
      attachments: [{ path: filePath }],
    });
  }

  static async testConnection(config: Omit<EmailConfig, 'fromName' | 'defaultRecipient'>): Promise<{ success: boolean; error?: string }> {
    try {
      const transporter = nodemailer.createTransport({
        host: config.smtpHost,
        port: config.smtpPort,
        secure: config.smtpPort === 465,
        auth: { user: config.smtpUser, pass: config.smtpPass },
      });
      await transporter.verify();
      transporter.close();
      return { success: true };
    } catch (err: any) {
      return { success: false, error: err.message || String(err) };
    }
  }
}
