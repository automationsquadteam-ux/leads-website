import 'server-only';

import nodemailer, { type Transporter } from 'nodemailer';

import type { IntegrationConfig } from '../config';
import { EmailConfigError, type EmailMessage, type EmailProvider, type SendResult, type VerifyResult } from './types';

/**
 * Generic SMTP provider.
 *
 * Also backs Gmail (see gmail.ts), which is SMTP with fixed host settings and
 * an App Password.
 */
export class SmtpProvider implements EmailProvider {
  readonly id = 'smtp' as const;
  readonly label = 'SMTP';

  constructor(
    private readonly options: {
      host: string;
      port: number;
      secure: boolean;
      username: string;
      password: string;
      fromName: string;
      fromAddress: string;
      replyTo?: string;
    },
  ) {
    // Messages name the exact card the field lives on. "Settings → Email" sent
    // people looking for a section that does not exist under that name, which
    // is how a five-second fix turns into a debugging session.
    if (!options.host.trim()) {
      throw new EmailConfigError(
        'SMTP host is not configured. Set it under Settings → Integrations → Email provider.',
      );
    }
    if (!options.fromAddress.trim()) {
      throw new EmailConfigError(
        'No from address configured — the relay settings are fine, but there is nothing to send as. ' +
          'Set "From address" under Settings → Integrations → Email provider and save.',
      );
    }
    if (!options.password) {
      throw new EmailConfigError(
        'No SMTP password stored. Add it under Settings → Integrations → Email provider.',
      );
    }
  }

  private transport(): Transporter {
    return nodemailer.createTransport({
      host: this.options.host,
      port: this.options.port,
      // `secure` means implicit TLS (port 465). Port 587 upgrades via STARTTLS,
      // which nodemailer negotiates automatically when secure is false.
      secure: this.options.secure,
      auth: { user: this.options.username, pass: this.options.password },
      connectionTimeout: 15_000,
      greetingTimeout: 15_000,
      socketTimeout: 30_000,
    });
  }

  private from(): string {
    const name = this.options.fromName.trim();
    return name ? `"${name.replace(/"/g, '')}" <${this.options.fromAddress}>` : this.options.fromAddress;
  }

  async verify(): Promise<VerifyResult> {
    const transport = this.transport();
    try {
      await transport.verify();
      return {
        ok: true,
        message: `Connected to ${this.options.host}:${this.options.port} and authenticated as ${this.options.username}.`,
      };
    } catch (error) {
      return { ok: false, message: describeSmtpError(error, this.options.host, this.options.port) };
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
        message: `Accepted by ${this.options.host}.`,
        detail: typeof info.response === 'string' ? info.response.slice(0, 500) : null,
      };
    } catch (error) {
      return {
        ok: false,
        messageId: null,
        message: describeSmtpError(error, this.options.host, this.options.port),
        detail: error instanceof Error ? error.message.slice(0, 500) : null,
      };
    } finally {
      transport.close();
    }
  }
}

/** Turn common SMTP failures into something an operator can act on. */
export function describeSmtpError(error: unknown, host: string, port: number): string {
  const err = error as { code?: string; responseCode?: number; message?: string };
  const code = err?.code;

  if (code === 'EAUTH' || err?.responseCode === 535) {
    return 'Authentication failed. Check the username and password. Gmail and most providers require an App Password, not your account password.';
  }
  if (code === 'ECONNREFUSED') return `Connection refused by ${host}:${port}. Check the host and port.`;
  if (code === 'ETIMEDOUT' || code === 'ESOCKET') {
    return `Timed out connecting to ${host}:${port}. Check the port and that outbound SMTP is not blocked.`;
  }
  if (code === 'EDNS' || code === 'ENOTFOUND') return `Could not resolve ${host}. Check the hostname.`;
  if (code === 'EENVELOPE') return 'The provider rejected the sender or recipient address.';
  if (err?.responseCode === 550) return 'Rejected (550): the recipient was refused or the sender is not authorised.';

  return err?.message ? `SMTP error: ${err.message}` : 'Unknown SMTP error.';
}

/** Minimal, safe text-to-HTML: escape everything, then honour line breaks. */
export function textToHtml(text: string): string {
  const escaped = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
  return `<div style="font-family:system-ui,-apple-system,'Segoe UI',sans-serif;font-size:14px;line-height:1.6;white-space:pre-wrap">${escaped}</div>`;
}

export function buildSmtpProvider(config: IntegrationConfig, password: string): SmtpProvider {
  return new SmtpProvider({
    host: config.email.smtp.host,
    port: config.email.smtp.port,
    secure: config.email.smtp.secure,
    username: config.email.smtp.username,
    password,
    fromName: config.email.fromName,
    fromAddress: config.email.fromAddress,
    replyTo: config.email.replyTo,
  });
}
