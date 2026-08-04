'use client';

import * as React from 'react';

import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';

/**
 * Confirmation gate for destructive or irreversible actions.
 * `onConfirm` may be async; the button shows a loading state until it settles.
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  destructive = false,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
  onConfirm: () => void | Promise<void>;
}) {
  const [pending, setPending] = React.useState(false);

  async function handleConfirm() {
    setPending(true);
    try {
      await onConfirm();
      onOpenChange(false);
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog
      open={open}
      onClose={() => (pending ? undefined : onOpenChange(false))}
      title={title}
      description={description}
      className="max-w-md"
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)} disabled={pending}>
            {cancelLabel}
          </Button>
          <Button
            variant={destructive ? 'danger' : 'primary'}
            onClick={handleConfirm}
            loading={pending}
          >
            {confirmLabel}
          </Button>
        </>
      }
    />
  );
}
