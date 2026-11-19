import { Injectable, Logger } from '@nestjs/common';
import nodemailer, { Transporter } from 'nodemailer';
import { env } from '../config/env';

/**
 * Email + SMS delivery behind one service. In development SMS is printed to the API log
 * (OTPs are the ONE thing we deliberately print, and only when SMS_PROVIDER=console and
 * NODE_ENV!=production). Emails go to Mailpit at http://localhost:8025.
 */
@Injectable()
export class MessagingService {
  private readonly logger = new Logger(MessagingService.name);
  private readonly mailer: Transporter = nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    secure: env.SMTP_PORT === 465,
  });

  async sendEmail(to: string, subject: string, text: string): Promise<void> {
    try {
      await this.mailer.sendMail({ from: env.SMTP_FROM, to, subject, text });
    } catch (err) {
      this.logger.warn(`Email delivery failed: ${(err as Error).message}`);
    }
  }

  async sendSms(to: string, text: string): Promise<void> {
    switch (env.SMS_PROVIDER) {
      case 'console':
        if (env.NODE_ENV === 'production')
          throw new Error('Console SMS provider disabled in production');
        // Deliberately bypasses redaction so developers can read dev OTPs.
        process.stdout.write(`\n[DEV SMS to ${to}] ${text}\n`);
        // Mirror to Mailpit so SMS codes are readable in the browser and by e2e tests.
        await this.sendEmail(`sms+${to.replace(/\D/g, '')}@onlinepay.local`, `SMS to ${to}`, text);
        return;
      default:
        // TODO: add a UAE SMS provider adapter (sender ID must be registered with the TDRA).
        throw new Error(`Unsupported SMS provider ${String(env.SMS_PROVIDER)}`);
    }
  }
}
