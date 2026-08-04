import 'server-only';

import nodemailer, { type Transporter } from 'nodemailer';

import type { IntegrationConfig } from '../config';
import { describeSmtpError, textToHtml } from './smtp';
import { EmailConfigError, type EmailMessage, type EmailProvider, type SendResult, type VerifyResult } from './types';

const GMAIL_HOST = 'smtp.gmail.com';
const GMAIL_PORT = 465;

/**
 * Gmail / Google Workspace provider.
 *
 * Uses Gmail's SMTP endpoint with an App Password rather than the Gmail REST
 * API with OAuth2. The App Password route needs no consent screen, no client
 * id/secret and no refresh-token rotation, which for sending from one owned
 * mailbox is the pragmatic choice. (Requires 2-Step Verification on the
 * account; Google removed "less secure app" passwords otherwise.)
 *
 * Swapping to the Gmail REST API later means writing a new class against the
 * same EmailProvider interface — nothing above this file changes.
 */
export class GmailProvider implements EmailProvider {
  readonly id = 'gmail' as const;
  readonly label = 'Gmail';

  constructor(
    private readonly options: {
      user: string;
      appPassword: string;
      fromName: string;
      fromAddress: string;
      replyTo?: string;
    },
  ) {
    if (!options.user.trim()) {
      throw new EmailConfigError('No Gmail address configured. Set it under Settings → Email.');
    }
    if (!options.appPassword) {
      throw new EmailConfigError(
        'No Gmail App Password stored. Create one at myaccount.google.com → Security → App passwords.',
      );
    }
  }

  private transport(): Transporter {
    return nodemailer.createTransport({
      host: GMAIL_HOST,
      port: GMAIL_PORT,
      secure: true,
      auth: {
        user: this.options.user,
        // Google shows App Passwords in groups of four; the spaces are display
        // only and are rejected if sent verbatim.
        pass: this.options.appPassword.replace(/\s+/g, ''),
      },
      connectionTimeout: 15_000,
      greetingTimeout: 15_000,
      socketTimeout: 30_000,
    });
  }

  /**
   * Gmail rewrites the From header to the authenticated account unless the
   * address is a verified alias, so prefer the account address and avoid a
   * silent mismatch between what we log and what the recipient sees.
   */
  private from(): string {
    const address = this.options.fromAddress.trim() || this.options.user;
    const name = this.options.fromName.trim();
    return name ? `"${name.replace(/"/g, '')}" <${address}>` : address;
  }

  async verify(): Promise<VerifyResult> {
    const transport = this.transport();
    try {
      await transport.verify();
      return { ok: true, message: `Authenticated with Gmail as ${this.options.user}.` };
    } catch (error) {
      const base = describeSmtpError(error, GMAIL_HOST, GMAIL_PORT);
      const err = error as { code?: string };
      if (err?.code === 'EAUTH') {
        return {
          ok: false,
          message:
            'Gmail rejected the credentials. Use a 16-character App Password (not your Google password), and make sure 2-Step Verification is enabled on the account.',
        };
      }
      return { ok: false, message: base };
    } finally {
      transport.close();
    }
  }

  async send(message: EmailMessage): Promise<SendResult> {
    const transport = this.transport();
    try {
      const info = await transport.sendMail({
        from: this.from(),
        to: message.to,
        subject: message.subject,
        text: message.text,
        html: message.html ?? textToHtml(message.text),
        replyTo: message.replyTo || this.options.replyTo || undefined,
      });

      return {
        ok: true,
        messageId: info.messageId ?? null,
        message: 'Accepted by Gmail.',
        detail: typeof info.response === 'string' ? info.response.slice(0, 500) : null,
      };
    } catch (error) {
      return {
        ok: false,
        messageId: null,
        message: describeSmtpError(error, GMAIL_HOST, GMAIL_PORT),
        detail: error instanceof Error ? error.message.slice(0, 500) : null,
      };
    } finally {
      transport.close();
    }
  }
}

export function buildGmailProvider(config: IntegrationConfig, appPassword: string): GmailProvider {
  return new GmailProvider({
    user: config.email.gmailUser,
    appPassword,
    fromName: config.email.fromName,
    fromAddress: config.email.fromAddress || config.email.gmailUser,
    replyTo: config.email.replyTo,
  });
}
