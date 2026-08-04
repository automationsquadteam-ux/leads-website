import 'server-only';

import { createServiceClient } from '@/lib/supabase/service-client';
import type {
  EmailType,
  EmailVersion,
  EmailVersionStatus,
} from '@/lib/supabase/database.types';

/**
 * The version store.
 *
 * The one rule the whole feature rests on: **drafts are never overwritten**.
 * Editing produces a new version, regenerating produces a new version, and the
 * old rows stay readable and re-activatable forever. Nothing in this file
 * UPDATEs `content` or `subject`.
 *
 * `active` is what the UI shows and what the sender uses. A partial unique
 * index guarantees at most one active row per (lead, type); a BEFORE trigger
 * clears the previous one, so activating is a single insert or update here.
 */

export interface CreateVersionInput {
  leadId: string;
  type: EmailType;
  subject: string | null;
  content: string;
  /** 'manual' | 'import' | 'template' | 'ollama:<model>' */
  generatedBy: string;
  createdBy: string | null;
  /** Make this the version shown and sent. Defaults to true. */
  activate?: boolean;
  status?: EmailVersionStatus;
}

export interface VersionResult {
  ok: boolean;
  message: string;
  version: EmailVersion | null;
}

export async function createEmailVersion(input: CreateVersionInput): Promise<VersionResult> {
  if (input.content.trim() === '') {
    return { ok: false, message: 'A draft cannot be empty.', version: null };
  }

  const admin = createServiceClient();

  const { data, error } = await admin
    .from('email_versions')
    .insert({
      lead_id: input.leadId,
      type: input.type,
      // Omitted on purpose: the set_email_version_number trigger assigns it, so
      // two concurrent saves cannot both compute the same max()+1.
      subject: input.subject,
      content: input.content,
      generated_by: input.generatedBy,
      created_by: input.createdBy,
      active: input.activate ?? true,
      status: input.status ?? 'draft',
    })
    .select('*')
    .single();

  if (error || !data) {
    return { ok: false, message: error?.message ?? 'Could not save the draft.', version: null };
  }

  return {
    ok: true,
    message: `Saved as version ${data.version_number}.`,
    version: data,
  };
}

/** Every version for a lead, newest first within each type. */
export async function getVersions(leadId: string): Promise<EmailVersion[]> {
  const admin = createServiceClient();
  const { data } = await admin
    .from('email_versions')
    .select('*')
    .eq('lead_id', leadId)
    .order('type', { ascending: true })
    .order('version_number', { ascending: false });
  return data ?? [];
}

/** Group versions by type, so the review UI can render one tab per step. */
export function groupVersions(versions: EmailVersion[]): Record<EmailType, EmailVersion[]> {
  const grouped: Record<EmailType, EmailVersion[]> = { initial: [], followup1: [], followup2: [] };
  for (const version of versions) grouped[version.type].push(version);
  return grouped;
}

export function activeVersion(versions: EmailVersion[], type: EmailType): EmailVersion | null {
  return versions.find((v) => v.type === type && v.active) ?? null;
}

/** Promote an older version back to active. Content is untouched. */
export async function setActiveVersion(versionId: string): Promise<VersionResult> {
  const admin = createServiceClient();

  const { data, error } = await admin
    .from('email_versions')
    .update({ active: true })
    .eq('id', versionId)
    .select('*')
    .single();

  if (error || !data) {
    return { ok: false, message: error?.message ?? 'Could not activate that version.', version: null };
  }

  return { ok: true, message: `Version ${data.version_number} is now active.`, version: data };
}

/**
 * Approve or reject a version.
 *
 * Rejecting keeps the row and its content — the audit value of versioning is
 * precisely that a rejected draft can be read back later. It does clear
 * `active` for a rejection, because a rejected draft must not be sendable.
 */
export async function reviewVersion(
  versionId: string,
  status: Extract<EmailVersionStatus, 'approved' | 'rejected'>,
  reviewerId: string | null,
  note: string | null,
): Promise<VersionResult> {
  const admin = createServiceClient();

  const { data, error } = await admin
    .from('email_versions')
    .update({
      status,
      active: status === 'approved' ? true : false,
      reviewed_by: reviewerId,
      reviewed_at: new Date().toISOString(),
      review_note: note,
    })
    .eq('id', versionId)
    .select('*')
    .single();

  if (error || !data) {
    return { ok: false, message: error?.message ?? 'Could not record the review.', version: null };
  }

  return {
    ok: true,
    message: status === 'approved'
      ? `Version ${data.version_number} approved.`
      : `Version ${data.version_number} rejected. It stays in the history and can be reactivated.`,
    version: data,
  };
}

/** Active drafts keyed by type — what the sender and the sheet mirror read. */
export async function getActiveVersions(
  leadId: string,
): Promise<Partial<Record<EmailType, EmailVersion>>> {
  const admin = createServiceClient();
  const { data } = await admin
    .from('email_versions')
    .select('*')
    .eq('lead_id', leadId)
    .eq('active', true);

  const map: Partial<Record<EmailType, EmailVersion>> = {};
  for (const version of data ?? []) map[version.type] = version;
  return map;
}
