import type { Lead } from '@/lib/supabase/database.types';

/**
 * Placeholder substitution for template bodies and drafts.
 *
 * Lives in its own module with no `server-only` marker and no imports beyond
 * types because both the sender and the draft generator need it. Keeping it
 * next to either one would drag that module's dependencies (nodemailer, the
 * service-role client) into the other.
 */

/** Tokens a template body may reference, resolved from the lead. */
export function placeholderValues(lead: Lead, signature: string): Record<string, string> {
  return {
    business_name: lead.business_name,
    city: lead.city ?? '',
    country: lead.country ?? '',
    industry: lead.niche ?? '',
    niche: lead.niche ?? '',
    website: lead.website ?? '',
    personalization: lead.personalization ?? '',
    // No contact-name column exists yet, so this resolves to empty rather than
    // to a fake name. A template that opens "Hi {{first_name}}," therefore
    // renders "Hi ," visible in review, which is the point: a silent
    // "Hi [Business Owner]" is what actually goes out and embarrasses you.
    first_name: '',
    signature,
  };
}

/**
 * Replace `{{token}}` occurrences. An unknown token is left verbatim rather
 * than blanked, so a typo is obvious in the draft instead of silently deleting
 * a sentence.
 */
export function renderPlaceholders(template: string, lead: Lead, signature: string): string {
  const values = placeholderValues(lead, signature);

  return template.replace(/\{\{\s*([a-z_]+)\s*\}\}/gi, (match, token: string) => {
    const key = token.toLowerCase();
    return key in values ? values[key]! : match;
  });
}

/**
 * Find placeholders that would reach the recipient as literal text.
 *
 * This exists because it actually happened: the imported drafts were full of
 * `[Business Owner's Name]` and `[Business Name]`. The renderer only substitutes
 * the `{{token}}` form, so a square-bracket placeholder is not a placeholder to
 * this system at all it is ordinary prose, and it would have been mailed to a
 * real business verbatim.
 *
 * Two categories are caught, both AFTER rendering:
 *
 *   `{{unknown}}`  a token the renderer left alone because it has no value for
 *                  it (a typo, or a template written against fields we do not
 *                  have). renderPlaceholders leaves these verbatim on purpose,
 *                  so a mistake is visible rather than silently deleting a line.
 *   `[Anything]`   the AI/human convention for "fill this in".
 *
 * The bracket rule is shaped by what the real drafts actually contained
 * (measured over 698 of them): placeholders are either Title Case —
 * `[Business Owner]`, `[Your Name]`, `[City]` or a single lower-case token,
 * `[niche]`. A bracketed prose aside like "[and Karachi too]" is lower-case
 * *and* multi-word, so requiring one of those two shapes keeps every real
 * placeholder and drops the aside. Numeric citations such as `[1]` never match.
 *
 * Returns the offending strings, de-duplicated, in the order found.
 *
 * `knownValues` is the lead's own real field values (business_name, niche,
 * city, country) ,text that is legitimately IN the draft because it was
 * merged in, not a placeholder nobody filled. Found live: leads whose actual
 * name carries a bracketed tag —
 *
 *     Emirates Dermatology & Cosmetology Center [EDCC]
 *     [UNEC] United Engineering Construction Company
 *     Shiny Smile Aesthetic Dental Clinic [Pasang Behel dan Implan Gigi]
 *
 * ,trip the `[Title Case]` rule below on every field it appears in,
 * indistinguishable from a genuine `[Business Owner]`. Blocking is
 * unconditional and every send path goes through it, so these three leads
 * failed their follow-up on EVERY cron tick, forever, with no way to fix the
 * data (the bracket is the business's real name) and no send attempted to
 * even reach `email_logs` ,the block fires before that write. A match is
 * only excluded when its bracket CONTENT (not the brackets) appears
 * case-insensitively inside one of the known values, so a coincidental
 * one-word overlap cannot mask an unrelated genuine placeholder.
 */
export function findUnresolvedPlaceholders(rendered: string, knownValues: string[] = []): string[] {
  const found: string[] = [];
  const haystacks = knownValues.filter((v) => v.trim() !== '').map((v) => v.toLowerCase());

  const push = (value: string) => {
    const trimmed = value.trim();
    if (trimmed === '' || found.includes(trimmed)) return;
    found.push(trimmed);
  };

  for (const match of rendered.matchAll(/\{\{\s*[^}\n]{1,60}\s*\}\}/g)) push(match[0]);

  /*
   * Title Case of any length, or one bare lower-case word. Single line only.
   *
   * `\p{Lu}` / `\p{Ll}` (Unicode letter-case properties, not `[A-Z]`/`[a-z]`),
   * because the native-language outreach (0046) writes placeholders in the
   * lead's own script: `[İsim]` (Turkish) and `[Αγαπητέ Πελάτη]` (Greek) both
   * start with an uppercase letter outside ASCII, and `[A-Z]` treats a letter
   * it cannot recognise as not a letter at all ,so the "Title Case" branch
   * silently failed to match, the guard this comment block calls
   * "unconditional, every send path goes through it" was not unconditional
   * for any non-Latin script, and one such draft reached `approved` before
   * this was caught. `[Prénom]` was never affected ,only the FIRST character
   * decides which branch a bracket takes, and an accented ASCII letter after
   * the first position was always inside `[^\]\n]` regardless.
   */
  for (const match of rendered.matchAll(/\[(?:\p{Lu}[^\]\n]{0,60}|[\p{Ll}_]{1,30})\]/gu)) {
    const inner = match[0].slice(1, -1).trim().toLowerCase();
    if (inner !== '' && haystacks.some((h) => h.includes(inner))) continue;
    push(match[0]);
  }

  return found;
}
