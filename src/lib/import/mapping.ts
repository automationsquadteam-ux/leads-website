import type { LeadInsert, LeadStatus } from '@/lib/supabase/database.types';
import { normaliseDraft } from '@/lib/services/drafts/quality';
import { buildDedupeKey, type KeyMode } from './dedupe';
import {
  cleanMultiline,
  cleanText,
  isAffirmative,
  normalizeDate,
  normalizeEmail,
  normalizePhone,
  normalizeSocialLinks,
  normalizeWebsite,
} from './normalize';
import type { SheetRow } from './workbook';

/**
 * Workbook header -> internal field.
 *
 * Keys are already lower-cased and whitespace-collapsed by normalizeHeader, so
 * the source file's " Niche" and "Email draft Status" both land correctly.
 * Several spellings map to the same field because Sheet1 and Sheet2 disagree.
 */
const HEADER_MAP: Record<string, string> = {
  'business name': 'business_name',
  business: 'business_name',
  name: 'business_name',

  niche: 'niche',
  city: 'city',
  country: 'country',
  website: 'website',
  email: 'email',
  phone: 'phone',
  category: 'category',

  'date added': 'date_added',
  'date sent': 'date_sent',
  reply: 'reply',

  'email sent status': 'sent_status',
  // "Email draft Status" was removed from the sheet (2026-08-04). It was mapped
  // but never read by anything — deriveStatus uses the draft body itself, which
  // is a fact rather than a label someone remembered to update.
  'email data done': 'draft_done',
  'research status': 'research_status',

  'business summary': 'research_summary',
  'website observations': 'website_observations',
  'automation opportunities': 'automation_opportunities',
  'ai chatbot opportunities': 'ai_chatbot_opportunities',
  'website improvement opportunities': 'website_improvement_opportunities',
  'personalization notes': 'personalization',
  'personalisation notes': 'personalization',
  'interesting facts': 'interesting_facts',
  'suggested outreach angle': 'outreach_angle',
  'social links': 'social_links',

  'email header': 'subject_line',
  'email subject': 'subject_line',
  'email body': 'draft_email',
};

function pick(row: SheetRow, field: string): unknown {
  for (const [header, mapped] of Object.entries(HEADER_MAP)) {
    if (mapped === field && header in row) {
      const value = row[header];
      if (value !== null && value !== undefined && String(value).trim() !== '') return value;
    }
  }
  return null;
}

export interface MappedRow {
  lead: LeadInsert;
  warnings: string[];
}

export interface MappingError {
  field: string;
  message: string;
}

export type MapResult =
  | { ok: true; value: MappedRow }
  | { ok: false; errors: MappingError[]; businessName: string | null };

export interface MapOptions {
  source: string;
  keyMode: KeyMode;
  importBatchId: string;
  importedAt: string;
}

/**
 * Where a lead sits in the pipeline, inferred from the workbook's four status
 * columns. Most specific signal wins.
 */
function deriveStatus(row: SheetRow, hasDraft: boolean, hasResearch: boolean): LeadStatus {
  if (isAffirmative(pick(row, 'reply'))) return 'replied';
  if (isAffirmative(pick(row, 'sent_status'))) return 'sent';
  if (hasDraft) return 'ready';
  if (hasResearch || isAffirmative(pick(row, 'research_status'))) return 'researching';
  return 'new';
}

/** Validate and convert one worksheet row into a leads insert payload. */
export function mapRow(row: SheetRow, options: MapOptions): MapResult {
  const errors: MappingError[] = [];
  const warnings: string[] = [];

  const businessName = cleanText(pick(row, 'business_name'));
  if (!businessName) {
    errors.push({ field: 'business_name', message: 'Business name is required.' });
  } else if (businessName.length > 300) {
    errors.push({ field: 'business_name', message: 'Business name exceeds 300 characters.' });
  }

  const { email, warning: emailWarning } = normalizeEmail(pick(row, 'email'));
  if (emailWarning) warnings.push(emailWarning);

  const { website, warning: websiteWarning } = normalizeWebsite(pick(row, 'website'));
  if (websiteWarning) warnings.push(websiteWarning);

  if (errors.length > 0) {
    return { ok: false, errors, businessName };
  }

  const city = cleanText(pick(row, 'city'));
  const researchSummary = cleanMultiline(pick(row, 'research_summary'));

  /*
   * Drafts arrive from the upstream Ollama pipeline as a JSON payload:
   *
   *     {"header": "Quick idea", "body": "Hi,\n\nI came across..."}
   *
   * Unwrapping it here means the CRM stores an email rather than a payload, and
   * every downstream consumer — the review screen, the sender, the Sheets
   * write-back — deals in prose. Cleaning it later, per feature, would mean
   * remembering to do it in each one.
   *
   * A draft that is already plain prose passes through untouched, and anything
   * that cannot be parsed is kept verbatim rather than discarded: an unreadable
   * draft is still a draft someone can fix, and inspectDraft() will flag it.
   */
  const rawDraft = cleanMultiline(pick(row, 'draft_email'));
  const rawSubject = cleanText(pick(row, 'subject_line'));
  const normalised = normaliseDraft(rawDraft, rawSubject);

  const draftEmail = normalised.content.trim() === '' ? null : normalised.content;
  const subjectLine = normalised.subject?.trim() || rawSubject;

  const hasResearch = researchSummary !== null;
  const hasDraft = draftEmail !== null;

  const dedupeKey = buildDedupeKey(
    { email, website, businessName: businessName as string, city },
    options.keyMode,
  );

  // "Date Added" is when the lead was sourced; using it as created_at keeps the
  // intake charts meaningful instead of showing one spike on import day.
  const createdAt = normalizeDate(pick(row, 'date_added'));
  const dateSent = normalizeDate(pick(row, 'date_sent'));

  const lead: LeadInsert = {
    business_name: businessName as string,
    website,
    email,
    phone: normalizePhone(pick(row, 'phone')),
    city,
    country: cleanText(pick(row, 'country')),
    niche: cleanText(pick(row, 'niche')),
    category: cleanText(pick(row, 'category')),
    source: options.source,
    status: deriveStatus(row, hasDraft, hasResearch),

    research_summary: researchSummary,
    website_observations: cleanMultiline(pick(row, 'website_observations')),
    automation_opportunities: cleanMultiline(pick(row, 'automation_opportunities')),
    ai_chatbot_opportunities: cleanMultiline(pick(row, 'ai_chatbot_opportunities')),
    website_improvement_opportunities: cleanMultiline(
      pick(row, 'website_improvement_opportunities'),
    ),
    personalization: cleanMultiline(pick(row, 'personalization')),
    interesting_facts: cleanMultiline(pick(row, 'interesting_facts')),
    outreach_angle: cleanMultiline(pick(row, 'outreach_angle')),
    social_links: normalizeSocialLinks(pick(row, 'social_links')),

    // researched_at / drafted_at stay null: the workbook records that the work
    // happened, not when, and inventing a timestamp would be worse than a gap.
    subject_line: subjectLine,
    draft_email: draftEmail,

    last_contacted_at: dateSent,
    dedupe_key: dedupeKey,
    import_batch_id: options.importBatchId,
    imported_at: options.importedAt,
    ...(createdAt ? { created_at: createdAt } : {}),
  };

  return { ok: true, value: { lead, warnings } };
}

/**
 * Fields refreshed by `--update`. Pipeline and operator-owned state is excluded.
 *
 * `last_contacted_at` is the one deliberate exception. It carries the sheet's
 * "Date Sent", and for emails sent by the upstream n8n pipeline the sheet is
 * the ONLY record of when that happened — the CRM has no email_logs row for
 * them. Without it here, a corrected Date Sent would sync into nothing and the
 * follow-up schedule would stay anchored to the import date instead of the real
 * send date.
 *
 * Safe because diffFields() skips blank incoming cells, so an empty Date Sent
 * never erases a send the CRM recorded itself.
 */
export const REFRESHABLE_FIELDS = [
  'business_name',
  'website',
  'email',
  'phone',
  'city',
  'country',
  'niche',
  'category',
  'research_summary',
  'website_observations',
  'automation_opportunities',
  'ai_chatbot_opportunities',
  'website_improvement_opportunities',
  'personalization',
  'interesting_facts',
  'outreach_angle',
  'social_links',
  'subject_line',
  'draft_email',
  'last_contacted_at',
] as const satisfies readonly (keyof LeadInsert)[];
