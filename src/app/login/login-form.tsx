'use client';

import { useActionState } from 'react';
import { useFormStatus } from 'react-dom';
import { AlertCircle } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/input';
import { signIn, type LoginState } from './actions';

const initialState: LoginState = { error: null };

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" variant="primary" size="lg" loading={pending} className="w-full">
      {pending ? 'Signing in…' : 'Sign in'}
    </Button>
  );
}

export function LoginForm({ next }: { next?: string }) {
  const [state, formAction] = useActionState(signIn, initialState);

  return (
    <form action={formAction} className="space-y-4">
      {next ? <input type="hidden" name="next" value={next} /> : null}

      <Field label="Email" htmlFor="email" required>
        <Input
          id="email"
          name="email"
          type="email"
          inputMode="email"
          autoComplete="email"
          required
          autoFocus
          placeholder="you@company.com"
        />
      </Field>

      <Field label="Password" htmlFor="password" required>
        <Input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
        />
      </Field>

      {state.error ? (
        <p
          role="alert"
          className="flex items-start gap-2 rounded-md border border-danger/30 bg-danger-subtle px-3 py-2 text-sm text-danger"
        >
          <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          {state.error}
        </p>
      ) : null}

      <SubmitButton />
    </form>
  );
}
