/**
 * Email provider contract.
 *
 * Everything above this boundary server actions, the lead page, email
 * logging depends only on these types. Adding Resend or SendGrid later means
 * writing one more implementation and one more line in the factory; no caller
 * changes.
 */

export type ProviderId = 'smtp' | 'gmail';

export interface EmailMessage {
  to: string;
  subject: string;
  /** Plain text body. HTML is derived from this unless `html` is supplied. */
  text: string;
  html?: string;
  replyTo?: string;
}

export interface SendResult {
  ok: boolean;
  /** Provider-side id, used to reconcile webhooks back to the log row. */
  messageId: string | null;
  message: string;
  /** Raw provider response, truncated useful when diagnosing a rejection. */
  detail?: string | null;
}

export interface VerifyResult {
  ok: boolean;
  message: string;
}

export interface EmailProvider {
  readonly id: ProviderId;
  readonly label: string;
  /** Check credentials and reachability without sending anything. */
  verify(): Promise<VerifyResult>;
  send(message: EmailMessage): Promise<SendResult>;
}

export class EmailConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EmailConfigError';
  }
}
