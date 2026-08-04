import type { LeadInsert, LeadStatus } from '@/lib/supabase/database.types';
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
  'email draft status': 'draft_status',
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
  const draftEmail = cleanMultiline(pick(row, 'draft_email'));
  const subjectLine = cleanText(pick(row, 'subject_line'));

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

/** Fields refreshed by `--update`. Pipeline and operator-owned state is excluded. */
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
] as const satisfies readonly (keyof LeadInsert)[];
