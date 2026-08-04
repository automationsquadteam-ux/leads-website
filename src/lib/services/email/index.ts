import 'server-only';

import { getIntegrationConfig } from '../config';
import { getSecret } from '../secrets';
import { buildGmailProvider } from './gmail';
import { buildSmtpProvider } from './smtp';
import { EmailConfigError, type EmailProvider, type ProviderId } from './types';

export type { EmailMessage, EmailProvider, ProviderId, SendResult, VerifyResult } from './types';
export { EmailConfigError } from './types';

export const PROVIDERS: Array<{ id: ProviderId; label: string; description: string }> = [
  { id: 'smtp', label: 'SMTP', description: 'Any SMTP relay — Mailgun, Postmark, your own server.' },
  { id: 'gmail', label: 'Gmail', description: 'Gmail or Google Workspace, using an App Password.' },
];

/**
 * Resolve the single active provider.
 *
 * Exactly one is active at a time, chosen by the `email.provider` setting.
 * Credentials are pulled from encrypted storage here so no caller ever handles
 * a plaintext password.
 *
 * Throws EmailConfigError with an actionable message when configuration is
 * incomplete — callers turn that into a UI message rather than a stack trace.
 */
export async function getActiveProvider(): Promise<EmailProvider> {
  const config = await getIntegrationConfig();

  if (config.email.provider === 'gmail') {
    const appPassword = await getSecret('gmail.app_password');
    if (!appPassword) {
      throw new EmailConfigError(
        'Gmail is the active provider but no App Password is stored. Add it under Settings → Integrations.',
      );
    }
    return buildGmailProvider(config, appPassword);
  }

  const password = await getSecret('smtp.password');
  if (!password) {
    throw new EmailConfigError(
      'SMTP is the active provider but no password is stored. Add it under Settings → Integrations.',
    );
  }
  return buildSmtpProvider(config, password);
}

/** Which provider is active and whether it is fully configured, for the UI. */
export async function getProviderStatus(): Promise<{
  provider: ProviderId;
  configured: boolean;
  reason: string | null;
}> {
  const config = await getIntegrationConfig();
  try {
    await getActiveProvider();
    return { provider: config.email.provider, configured: true, reason: null };
  } catch (error) {
    return {
      provider: config.email.provider,
      configured: false,
      reason: error instanceof Error ? error.message : 'Not configured.',
    };
  }
}
