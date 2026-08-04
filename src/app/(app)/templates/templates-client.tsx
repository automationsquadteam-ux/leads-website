'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { useActionState } from 'react';
import { FileText, Plus, Trash2 } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Dialog } from '@/components/ui/dialog';
import { Field, Input, Textarea } from '@/components/ui/input';
import { EmptyState } from '@/components/empty-state';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { useToast } from '@/components/ui/toast';
import { deleteTemplate, saveTemplate } from '@/lib/actions/misc';
import { TEMPLATE_PLACEHOLDERS } from '@/lib/templates/placeholders';
import type { ActionResult } from '@/lib/actions/leads';
import type { Template } from '@/lib/supabase/database.types';
import { formatDate, truncate } from '@/lib/utils';

const initialState: ActionResult = { ok: false, message: '' };

export function TemplatesClient({ templates }: { templates: Template[] }) {
  const router = useRouter();
  const { toast } = useToast();
  const [editing, setEditing] = React.useState<Template | 'new' | null>(null);
  const [deleting, setDeleting] = React.useState<Template | null>(null);

  return (
    <>
      <div className="mb-4 flex justify-end">
        <Button variant="primary" onClick={() => setEditing('new')}>
          <Plus className="size-4" aria-hidden="true" />
          New template
        </Button>
      </div>

      {templates.length === 0 ? (
        <Card>
          <EmptyState
            icon={FileText}
            title="No templates yet"
            description="Templates hold the reusable subject and body used to generate drafts."
            action={
              <Button variant="primary" onClick={() => setEditing('new')}>
                <Plus className="size-4" aria-hidden="true" />
                Create template
              </Button>
            }
          />
        </Card>
      ) : (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {templates.map((template) => (
            <Card key={template.id} className="flex flex-col">
              <CardContent className="flex flex-1 flex-col gap-2">
                <div className="flex items-start justify-between gap-2">
                  <h3 className="text-sm font-semibold">{template.name}</h3>
                  {template.is_active ? <Badge tone="success">Active</Badge> : <Badge>Inactive</Badge>}
                </div>

                <p className="text-xs font-medium text-muted-foreground">{template.subject}</p>

                <p className="flex-1 whitespace-pre-line text-xs leading-relaxed text-muted-foreground">
                  {truncate(template.body, 180)}
                </p>

                {template.variables.length > 0 ? (
                  <ul className="flex flex-wrap gap-1">
                    {template.variables.map((variable) => (
                      <li key={variable}>
                        <code className="rounded border border-border bg-muted px-1 py-0.5 font-mono text-[10px] text-muted-foreground">
                          {`{{${variable}}}`}
                        </code>
                      </li>
                    ))}
                  </ul>
                ) : null}

                <div className="flex items-center gap-2 border-t border-border pt-2.5">
                  <span className="tabular text-[11px] text-muted-foreground">
                    {formatDate(template.created_at)}
                  </span>
                  <div className="flex-1" />
                  <Button size="sm" variant="ghost" onClick={() => setEditing(template)}>
                    Edit
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setDeleting(template)}
                    aria-label={`Delete ${template.name}`}
                    className="text-danger hover:bg-danger-subtle hover:text-danger"
                  >
                    <Trash2 className="size-3.5" aria-hidden="true" />
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {editing ? (
        <TemplateDialog
          template={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            router.refresh();
          }}
        />
      ) : null}

      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={`Delete "${deleting?.name ?? ''}"?`}
        description="This cannot be undone. Campaigns using this template will fall back to no template."
        confirmLabel="Delete"
        destructive
        onConfirm={async () => {
          if (!deleting) return;
          const result = await deleteTemplate(deleting.id);
          toast(result.message, result.ok ? 'success' : 'error');
          if (result.ok) router.refresh();
        }}
      />
    </>
  );
}

function TemplateDialog({
  template,
  onClose,
  onSaved,
}: {
  template: Template | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { toast } = useToast();
  const [state, formAction, pending] = useActionState(saveTemplate, initialState);
  const bodyRef = React.useRef<HTMLTextAreaElement>(null);

  React.useEffect(() => {
    if (!state.message) return;
    toast(state.message, state.ok ? 'success' : 'error');
    if (state.ok) onSaved();
  }, [state, toast, onSaved]);

  /** Insert a placeholder at the caret so users never have to type the braces. */
  function insertPlaceholder(token: string) {
    const el = bodyRef.current;
    if (!el) return;
    const start = el.selectionStart ?? el.value.length;
    const end = el.selectionEnd ?? start;
    el.value = `${el.value.slice(0, start)}${token}${el.value.slice(end)}`;
    el.focus();
    el.setSelectionRange(start + token.length, start + token.length);
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title={template ? 'Edit template' : 'New template'}
      className="max-w-2xl"
    >
      <form action={formAction} className="space-y-4">
        {template ? <input type="hidden" name="id" value={template.id} /> : null}

        <Field label="Name" htmlFor="template-name" required>
          <Input id="template-name" name="name" defaultValue={template?.name ?? ''} required maxLength={120} />
        </Field>

        <Field label="Subject" htmlFor="template-subject" required>
          <Input
            id="template-subject"
            name="subject"
            defaultValue={template?.subject ?? ''}
            required
            maxLength={300}
            placeholder="Quick idea for {{business_name}}"
          />
        </Field>

        <Field
          label="Body"
          htmlFor="template-body"
          required
          hint="Click a placeholder below to insert it at the cursor."
        >
          <Textarea
            id="template-body"
            name="body"
            ref={bodyRef}
            defaultValue={template?.body ?? ''}
            required
            rows={12}
            className="font-mono text-xs leading-relaxed"
          />
        </Field>

        <div className="flex flex-wrap gap-1.5">
          {TEMPLATE_PLACEHOLDERS.map((token) => (
            <button
              key={token}
              type="button"
              onClick={() => insertPlaceholder(token)}
              className="cursor-pointer rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground transition-colors hover:border-primary hover:text-primary"
            >
              {token}
            </button>
          ))}
        </div>

        {state.message && !state.ok ? (
          <p role="alert" className="text-xs text-danger">
            {state.message}
          </p>
        ) : null}

        <div className="flex justify-end gap-2 border-t border-border pt-4">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" loading={pending}>
            {template ? 'Save changes' : 'Create template'}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
