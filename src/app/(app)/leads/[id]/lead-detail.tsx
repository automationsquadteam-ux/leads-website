'use client';

import * as React from 'react';
import { useActionState } from 'react';
import { useRouter } from 'next/navigation';
import { Archive, ArchiveRestore, Ban, Mail, Pencil, Save, Trash2, X } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Field, Input, Select } from '@/components/ui/input';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { StatusBadge, LEAD_STATUS_LABELS } from '@/components/status-badge';
import {
  EMPTY_ACTION_RESULT,
  PanelError,
  useActionFeedback,
  useAsyncAction,
} from '@/components/action-form';
import { useToast } from '@/components/ui/toast';
import { archiveLead, deleteLeads, markInvalid, unarchiveLead, updateLead } from '@/lib/actions/leads';
import { LEAD_STATUSES, type Lead } from '@/lib/supabase/database.types';

/**
 * Business information and the lead-level actions.
 *
 * Research, personalization, drafts and pipeline each live in their own panel
 * with their own save, so this form covers only the identity fields it owns.
 * Editing is behind an explicit Edit toggle: this is reference data an admin
 * reads far more often than they change, and a page of live inputs invites
 * accidental edits.
 */
export function LeadDetail({ lead }: { lead: Lead }) {
  const [editing, setEditing] = React.useState(false);
  const [confirmArchive, setConfirmArchive] = React.useState(false);
  const [confirmDelete, setConfirmDelete] = React.useState(false);
  const { busy, run } = useAsyncAction();
  const { toast } = useToast();
  const router = useRouter();

  const [state, formAction, saving] = useActionState(updateLead, EMPTY_ACTION_RESULT);
  const [handledState, setHandledState] = React.useState(state);

  useActionFeedback(state);

  // Leave edit mode when a save succeeds. Done during render rather than in an
  // effect: setState inside an effect triggers an extra cascading render.
  if (state !== handledState) {
    setHandledState(state);
    if (state.ok) setEditing(false);
  }

  const archived = lead.status === 'archived';

  return (
    <Card>
      <CardHeader className="flex-wrap gap-2">
        <CardTitle className="flex items-center gap-2">
          Business information
          <StatusBadge status={lead.status} />
        </CardTitle>

        <div className="flex flex-wrap items-center gap-2">
          {archived ? (
            <Button
              type="button"
              size="sm"
              variant="secondary"
              loading={busy === 'restore'}
              onClick={() => run('restore', () => unarchiveLead(lead.id))}
            >
              <ArchiveRestore className="size-3.5" aria-hidden="true" />
              Restore
            </Button>
          ) : (
            <>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                loading={busy === 'invalid'}
                onClick={() => run('invalid', () => markInvalid(lead.id))}
                title="Unusable record bad address, closed business"
              >
                <Ban className="size-3.5" aria-hidden="true" />
                Mark invalid
              </Button>
              <Button type="button" size="sm" variant="ghost" onClick={() => setConfirmArchive(true)}>
                <Archive className="size-3.5" aria-hidden="true" />
                Archive
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="text-danger hover:bg-danger-subtle hover:text-danger"
                onClick={() => setConfirmDelete(true)}
                title="Permanent. For duplicates and junk — archive instead if you might want it back."
              >
                <Trash2 className="size-3.5" aria-hidden="true" />
                Delete
              </Button>
            </>
          )}

          {!editing ? (
            <Button type="button" size="sm" variant="secondary" onClick={() => setEditing(true)}>
              <Pencil className="size-3.5" aria-hidden="true" />
              Edit
            </Button>
          ) : null}
        </div>
      </CardHeader>

      <CardContent>
        <form action={formAction} className="space-y-4">
          <input type="hidden" name="id" value={lead.id} />

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Business name" htmlFor="business_name" required className="sm:col-span-2">
              <Input
                id="business_name"
                name="business_name"
                defaultValue={lead.business_name}
                readOnly={!editing}
                required
                maxLength={300}
              />
            </Field>

            <Field label="Email" htmlFor="email">
              <Input
                id="email"
                name="email"
                type="email"
                inputMode="email"
                defaultValue={lead.email ?? ''}
                readOnly={!editing}
                className="font-mono text-xs"
              />
            </Field>

            <Field label="Phone" htmlFor="phone">
              <Input
                id="phone"
                name="phone"
                type="tel"
                inputMode="tel"
                defaultValue={lead.phone ?? ''}
                readOnly={!editing}
              />
            </Field>

            <Field label="Website" htmlFor="website" className="sm:col-span-2">
              <Input
                id="website"
                name="website"
                type="url"
                defaultValue={lead.website ?? ''}
                readOnly={!editing}
              />
            </Field>

            <Field label="City" htmlFor="city">
              <Input id="city" name="city" defaultValue={lead.city ?? ''} readOnly={!editing} />
            </Field>

            <Field label="Country" htmlFor="country">
              <Input id="country" name="country" defaultValue={lead.country ?? ''} readOnly={!editing} />
            </Field>

            <Field label="Niche" htmlFor="niche">
              <Input id="niche" name="niche" defaultValue={lead.niche ?? ''} readOnly={!editing} />
            </Field>

            <Field label="Category" htmlFor="category">
              <Input id="category" name="category" defaultValue={lead.category ?? ''} readOnly={!editing} />
            </Field>

            <Field
              label="Status"
              htmlFor="status"
              hint="Set automatically as the lead moves through the pipeline."
            >
              <Select id="status" name="status" defaultValue={lead.status} disabled={!editing}>
                {LEAD_STATUSES.map((status) => (
                  <option key={status} value={status}>
                    {LEAD_STATUS_LABELS[status]}
                  </option>
                ))}
              </Select>
            </Field>
          </div>

          {/*
            The research fields this form still owns are edited in their own
            panel, but the update action validates the whole lead shape so
            they ride along as hidden inputs rather than being blanked on save.
          */}
          <input type="hidden" name="research_summary" value={lead.research_summary ?? ''} />
          <input type="hidden" name="personalization" value={lead.personalization ?? ''} />
          <input type="hidden" name="outreach_angle" value={lead.outreach_angle ?? ''} />
          <input type="hidden" name="subject_line" value={lead.subject_line ?? ''} />
          <input type="hidden" name="draft_email" value={lead.draft_email ?? ''} />
          <input type="hidden" name="notes" value={lead.notes ?? ''} />

          <PanelError state={state} />

          {editing ? (
            <div className="flex justify-end gap-2">
              <Button type="button" variant="ghost" onClick={() => setEditing(false)} disabled={saving}>
                <X className="size-4" aria-hidden="true" />
                Cancel
              </Button>
              <Button type="submit" variant="primary" loading={saving}>
                <Save className="size-4" aria-hidden="true" />
                Save changes
              </Button>
            </div>
          ) : null}
        </form>
      </CardContent>

      <ConfirmDialog
        open={confirmArchive}
        onOpenChange={setConfirmArchive}
        title="Archive this lead?"
        description="It will be hidden from the working list. Nothing is deleted and you can restore it at any time."
        confirmLabel="Archive"
        onConfirm={() => run('archive', () => archiveLead(lead.id)).then(() => undefined)}
      />

      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={`Permanently delete ${lead.business_name}?`}
        description="This cannot be undone. Its drafts, send history and any replies are deleted with it. Archive instead if you only want it out of the way."
        confirmLabel="Delete permanently"
        destructive
        onConfirm={async () => {
          const result = await deleteLeads([lead.id]);
          toast(result.message, result.ok ? 'success' : 'error');
          // The lead no longer exists, so staying on its page would 404 on the
          // next render. Go back to the list.
          if (result.ok) router.replace('/leads');
        }}
      />
    </Card>
  );
}

/** Enrichment fields the importer captured, shown read-only alongside research. */
export function EnrichmentDetail({ lead }: { lead: Lead }) {
  const social = lead.social_links as Record<string, string> | null;
  const socialEntries = Object.entries(social ?? {}).filter(
    ([key, value]) => key !== '_raw' && typeof value === 'string' && value.startsWith('http'),
  );

  if (socialEntries.length === 0) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Social links</CardTitle>
      </CardHeader>
      <CardContent>
        <ul className="space-y-1">
          {socialEntries.map(([platform, url]) => (
            <li key={platform}>
              <a
                href={url}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
              >
                <Mail className="size-3" aria-hidden="true" />
                {platform}
              </a>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
