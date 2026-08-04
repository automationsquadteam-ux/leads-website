'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Check, KeyRound, Trash2 } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input, Textarea, Label } from '@/components/ui/input';
import { useToast } from '@/components/ui/toast';
import { removeSecret, saveSecret } from '@/lib/actions/integrations';

/**
 * Write-only credential input.
 *
 * The stored value is never sent to the browser — the server provides only a
 * `configured` flag and a masked hint. Re-entering a value overwrites it; there
 * is deliberately no way to read one back out through the UI.
 *
 * Deliberately NOT a <form>. These fields are rendered inside the configuration
 * form on the settings page, and HTML forbids nesting one form in another — it
 * is a hydration error and the inner form's submit behaviour is undefined. The
 * server action is called directly from a click handler instead, which also
 * keeps the credential out of the outer form's FormData.
 */
export function SecretField({
  secretKey,
  label,
  hint,
  configured,
  maskedHint,
  multiline = false,
  placeholder,
}: {
  secretKey: string;
  label: string;
  hint?: string;
  configured: boolean;
  maskedHint: string | null;
  multiline?: boolean;
  placeholder?: string;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [editing, setEditing] = React.useState(!configured);
  const [value, setValue] = React.useState('');
  const [pending, setPending] = React.useState(false);

  const fieldId = `secret-${secretKey.replace(/\./g, '-')}`;

  async function save() {
    if (value.trim() === '') {
      toast('Enter a value, or use Remove to clear it.', 'error');
      return;
    }
    setPending(true);
    try {
      const result = await saveSecret(secretKey, value);
      toast(result.message, result.ok ? 'success' : 'error');
      if (result.ok) {
        // Clear immediately so the plaintext does not sit in component state.
        setValue('');
        setEditing(false);
        router.refresh();
      }
    } catch {
      toast('Could not reach the server. The credential was not saved.', 'error');
    } finally {
      setPending(false);
    }
  }

  async function remove() {
    setPending(true);
    try {
      const result = await removeSecret(secretKey);
      toast(result.message, result.ok ? 'success' : 'error');
      if (result.ok) {
        setValue('');
        setEditing(true);
        router.refresh();
      }
    } catch {
      toast('Could not reach the server.', 'error');
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <Label htmlFor={fieldId}>{label}</Label>
        {configured ? (
          <Badge tone="success">
            <Check className="size-3" aria-hidden="true" />
            {maskedHint ?? 'Stored'}
          </Badge>
        ) : (
          <Badge tone="neutral">Not set</Badge>
        )}
      </div>

      {editing ? (
        <div className="space-y-2">
          {multiline ? (
            <Textarea
              id={fieldId}
              rows={5}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder={placeholder}
              autoComplete="off"
              spellCheck={false}
              className="font-mono text-xs"
            />
          ) : (
            <Input
              id={fieldId}
              type="password"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => {
                // Enter would otherwise submit the surrounding config form.
                if (e.key === 'Enter') {
                  e.preventDefault();
                  void save();
                }
              }}
              placeholder={placeholder}
              autoComplete="new-password"
              spellCheck={false}
            />
          )}

          <div className="flex items-center gap-2">
            <Button type="button" size="sm" variant="primary" loading={pending} onClick={save}>
              <KeyRound className="size-3.5" aria-hidden="true" />
              Save
            </Button>
            {configured ? (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={pending}
                onClick={() => {
                  setValue('');
                  setEditing(false);
                }}
              >
                Cancel
              </Button>
            ) : null}
          </div>
        </div>
      ) : (
        <div className="flex items-center gap-2">
          <Button type="button" size="sm" variant="secondary" onClick={() => setEditing(true)}>
            Replace
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            loading={pending}
            className="text-danger hover:bg-danger-subtle hover:text-danger"
            onClick={remove}
          >
            <Trash2 className="size-3.5" aria-hidden="true" />
            Remove
          </Button>
        </div>
      )}

      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}
