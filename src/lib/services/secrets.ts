import 'server-only';

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

import { createServiceClient } from '@/lib/supabase/service-client';

/**
 * Encrypted credential storage.
 *
 * Secrets are encrypted here, in the application, before they reach Postgres —
 * so a database dump alone discloses nothing without APP_ENCRYPTION_KEY. The
 * `integration_secrets` table additionally has every grant revoked from anon
 * and authenticated, so no browser token can read the ciphertext either.
 *
 * AES-256-GCM is authenticated encryption: tampering with the stored value
 * makes decryption fail rather than silently returning corrupted bytes.
 *
 * Wire format (base64): [12-byte IV][16-byte auth tag][ciphertext]
 */

const IV_LENGTH = 12;
const TAG_LENGTH = 16;

export type SecretKey = 'smtp.password' | 'gmail.app_password';

export const SECRET_KEYS: SecretKey[] = ['smtp.password', 'gmail.app_password'];

function getKey(): Buffer {
  const raw = process.env.APP_ENCRYPTION_KEY;
  if (!raw) {
    throw new Error(
      'APP_ENCRYPTION_KEY is not set. Generate one with:\n' +
        '  node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))"',
    );
  }

  const key = Buffer.from(raw, 'base64');
  if (key.length !== 32) {
    throw new Error(
      `APP_ENCRYPTION_KEY must decode to exactly 32 bytes (got ${key.length}). It should be base64 of 32 random bytes.`,
    );
  }
  return key;
}

export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv('aes-256-gcm', getKey(), iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64');
}

export function decryptSecret(payload: string): string {
  const buffer = Buffer.from(payload, 'base64');
  if (buffer.length <= IV_LENGTH + TAG_LENGTH) {
    throw new Error('Stored secret is malformed.');
  }

  const iv = buffer.subarray(0, IV_LENGTH);
  const tag = buffer.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
  const data = buffer.subarray(IV_LENGTH + TAG_LENGTH);

  const decipher = createDecipheriv('aes-256-gcm', getKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}

/** Non-reversible preview so the UI can show which credential is stored. */
function hintFor(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length <= 4) return '••••';
  return `••••${trimmed.slice(-4)}`;
}

export async function setSecret(key: SecretKey, plaintext: string, userId?: string): Promise<void> {
  const admin = createServiceClient();
  const { error } = await admin.from('integration_secrets').upsert(
    {
      key,
      ciphertext: encryptSecret(plaintext),
      hint: hintFor(plaintext),
      updated_by: userId ?? null,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'key' },
  );
  if (error) throw new Error(`Could not store ${key}: ${error.message}`);
}

export async function deleteSecret(key: SecretKey): Promise<void> {
  const admin = createServiceClient();
  const { error } = await admin.from('integration_secrets').delete().eq('key', key);
  if (error) throw new Error(`Could not delete ${key}: ${error.message}`);
}

/** Returns null when unset. Never call this from anything that renders. */
export async function getSecret(key: SecretKey): Promise<string | null> {
  const admin = createServiceClient();
  const { data, error } = await admin
    .from('integration_secrets')
    .select('ciphertext')
    .eq('key', key)
    .maybeSingle();

  if (error || !data) return null;

  try {
    return decryptSecret(data.ciphertext);
  } catch {
    // Wrong key, or the row was tampered with. Treat as unset rather than
    // crashing the caller the UI reports the credential as not configured.
    return null;
  }
}

export interface SecretStatus {
  key: SecretKey;
  configured: boolean;
  hint: string | null;
  updatedAt: string | null;
}

/**
 * Which secrets exist, without decrypting any of them.
 * This is the only secret-related data allowed anywhere near the client.
 */
export async function listSecretStatus(): Promise<SecretStatus[]> {
  const admin = createServiceClient();
  const { data } = await admin.from('integration_secrets').select('key, hint, updated_at');
  const byKey = new Map((data ?? []).map((row) => [row.key, row]));

  return SECRET_KEYS.map((key) => {
    const row = byKey.get(key);
    return {
      key,
      configured: Boolean(row),
      hint: row?.hint ?? null,
      updatedAt: row?.updated_at ?? null,
    };
  });
}

/** True when APP_ENCRYPTION_KEY is present and valid surfaced in the UI. */
export function encryptionAvailable(): boolean {
  try {
    getKey();
    return true;
  } catch {
    return false;
  }
}
