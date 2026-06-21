import nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';
import { loadSettings } from '../settings';

export class EmailService {
  private transporter: Transporter | null = null;

  /** Initialize the SMTP transporter from current settings */
  init(): void {
    const s = loadSettings();
    if (!s.emailEnabled || !s.smtpHost) return;
    this.transporter = nodemailer.createTransport({
      host: s.smtpHost,
      port: s.smtpPort || 587,
      secure: (s.smtpPort || 587) === 465,
      auth: { user: s.smtpUser, pass: s.smtpPass },
    });
    console.log(`[EmailService] Initialized (${s.smtpHost}:${s.smtpPort})`);
  }

  /** Re-initialize with fresh settings */
  reinit(): void {
    this.transporter = null;
    this.init();
  }

  /** Check if email is configured and ready */
  isReady(): boolean {
    return this.transporter !== null;
  }

  /** Send meeting notes email */
  async sendMeetingNotes(to: string[], subject: string, htmlBody: string): Promise<void> {
    if (!this.transporter) return;
    const s = loadSettings();
    await this.transporter.sendMail({
      from: `"${s.smtpFromName || 'DeepSeno'}" <${s.smtpUser}>`,
      to: to.join(', '),
      subject,
      html: htmlBody,
    });
    console.log(`[EmailService] Meeting notes sent to ${to.length} recipients`);
  }

  /** Send reminder email */
  async sendReminder(to: string, subject: string, htmlBody: string): Promise<void> {
    if (!this.transporter) return;
    const s = loadSettings();
    await this.transporter.sendMail({
      from: `"${s.smtpFromName || 'DeepSeno'}" <${s.smtpUser}>`,
      to,
      subject,
      html: htmlBody,
    });
    console.log(`[EmailService] Reminder sent to ${to}`);
  }

  /** Send a general email */
  async send(to: string, subject: string, htmlBody: string): Promise<void> {
    if (!this.transporter) return;
    const s = loadSettings();
    await this.transporter.sendMail({
      from: `"${s.smtpFromName || 'DeepSeno'}" <${s.smtpUser}>`,
      to,
      subject,
      html: htmlBody,
    });
  }

  /** Test SMTP connection */
  static async testConnection(
    host: string, port: number, user: string, pass: string,
  ): Promise<{ success: boolean; error?: string }> {
    try {
      const t = nodemailer.createTransport({
        host,
        port,
        secure: port === 465,
        auth: { user, pass },
      });
      await t.verify();
      return { success: true };
    } catch (err: any) {
      return { success: false, error: err.message || String(err) };
    }
  }
}
