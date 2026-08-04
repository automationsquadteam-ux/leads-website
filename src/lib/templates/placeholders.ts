/**
 * Placeholder tokens a template body may reference.
 *
 * A plain module, deliberately. This list used to live in
 * `lib/actions/misc.ts`, which carries `'use server'` and a `'use server'`
 * file may export **async functions only**. Exporting an array from one makes
 * Next refuse to evaluate the entire module, which takes down every Server
 * Action defined in it (and therefore every action on every page that imports
 * it) with:
 *
 *   A "use server" file can only export async functions, found object.
 *
 * The failure is nasty because it points at the action loader rather than at
 * the offending export, and the symptom in the browser is an unrelated-looking
 * "Could not reach the server".
 *
 * Values shared between a Server Action module and a client component belong in
 * a plain module like this one, imported by both.
 *
 * The renderer that resolves these lives in `lib/services/email/render.ts`.
 */
export const TEMPLATE_PLACEHOLDERS = [
  '{{business_name}}',
  '{{city}}',
  '{{country}}',
  '{{industry}}',
  '{{website}}',
  '{{first_name}}',
  '{{personalization}}',
  '{{signature}}',
] as const;

export type TemplatePlaceholder = (typeof TEMPLATE_PLACEHOLDERS)[number];
