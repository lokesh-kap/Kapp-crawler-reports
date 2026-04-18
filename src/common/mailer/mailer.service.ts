import { Injectable, Logger } from '@nestjs/common';
import * as nodemailer from 'nodemailer';

export interface MailAttachment {
  filename: string;
  content: Buffer | string;
}

export interface SendMailOptions {
  to: string | string[];
  cc?: string | string[];
  subject: string;
  html: string;
  attachments?: MailAttachment[];
}

@Injectable()
export class MailerService {
  private readonly logger = new Logger(MailerService.name);

  private getEnvInt(name: string, defaultValue: number): number {
    const raw = process.env[name];
    if (raw === undefined || raw === '') return defaultValue;
    const n = parseInt(String(raw), 10);
    return Number.isFinite(n) ? n : defaultValue;
  }

  /** True when a short wait + resend may succeed (Gmail often drops mid-send as ECONNRESET). */
  private isTransientSmtpError(err: unknown): boolean {
    const code =
      err && typeof err === 'object' && 'code' in err ? String((err as NodeJS.ErrnoException).code) : '';
    const retryCodes = new Set([
      'ECONNRESET',
      'ETIMEDOUT',
      'ECONNABORTED',
      'EPIPE',
      'ESOCKETTIMEDOUT',
      'ENOTFOUND',
      'EAI_AGAIN',
    ]);
    if (code && retryCodes.has(code)) return true;
    const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
    return (
      msg.includes('econnreset') ||
      msg.includes('etimedout') ||
      msg.includes('socket hang up') ||
      msg.includes('connection closed') ||
      msg.includes('greeting never received')
    );
  }

  private createTransporter() {
    return nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT ?? 465),
      secure: Number(process.env.SMTP_PORT) === 465,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
      connectionTimeout: this.getEnvInt('SMTP_CONNECTION_TIMEOUT_MS', 60000),
      greetingTimeout: this.getEnvInt('SMTP_GREETING_TIMEOUT_MS', 30000),
      socketTimeout: this.getEnvInt('SMTP_SOCKET_TIMEOUT_MS', 120000),
    });
  }

  async sendMail(options: SendMailOptions): Promise<void> {
    const to = Array.isArray(options.to) ? options.to : [options.to];
    const cc = options.cc ? (Array.isArray(options.cc) ? options.cc : [options.cc]) : undefined;
    const maxAttempts = Math.max(1, this.getEnvInt('MAIL_SEND_MAX_ATTEMPTS', 4));
    const baseDelayMs = Math.max(0, this.getEnvInt('MAIL_SEND_RETRY_DELAY_MS', 2000));

    let lastErr: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        await this.createTransporter().sendMail({
          from: process.env.SMTP_FROM,
          to,
          cc,
          subject: options.subject,
          html: options.html,
          attachments: options.attachments,
        });
        if (attempt > 1) {
          this.logger.log(`Mail sent on attempt ${attempt}/${maxAttempts}: ${options.subject}`);
        } else {
          this.logger.log(`Mail sent: ${options.subject}`);
        }
        return;
      } catch (err) {
        lastErr = err;
        const msg = err instanceof Error ? err.message : String(err);
        const transient = this.isTransientSmtpError(err);
        this.logger.warn(
          `Mail send attempt ${attempt}/${maxAttempts} failed for "${options.subject}": ${msg}` +
            (transient ? ' (will retry if attempts remain)' : ''),
        );
        if (attempt >= maxAttempts || !transient) {
          break;
        }
        const delayMs = baseDelayMs * Math.pow(2, attempt - 1);
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }

    const finalMsg = lastErr instanceof Error ? lastErr.message : String(lastErr);
    this.logger.error(`Failed to send mail after ${maxAttempts} attempt(s): ${options.subject}`, finalMsg);
    throw lastErr instanceof Error ? lastErr : new Error(finalMsg);
  }
}
