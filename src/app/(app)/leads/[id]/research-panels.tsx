'use client';

import * as React from 'react';
import { useActionState } from 'react';
import { Save, Sparkles, StickyNote } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Field, Textarea } from '@/components/ui/input';
import {
  EMPTY_ACTION_RESULT,
  PanelError,
  useActionFeedback,
} from '@/components/action-form';
import { saveNotes, savePersonalization, saveResearch } from '@/lib/actions/review';
import type { Lead } from '@/lib/supabase/database.types';

/**
 * Research, personalization and notes.
 *
 * Three independent forms rather than one. Each commits to Supabase on its own
 * save, and each pushes through the sync layer on its own, so an admin editing
 * the notes never re-submits research they were still working on.
 */

export function ResearchPanel({ lead }: { lead: Lead }) {
  const [state, formAction, saving] = useActionState(saveResearch, EMPTY_ACTION_RESULT);
  useActionFeedback(state);

  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle>Research</CardTitle>
          <CardDescription>What we know about this business. Feeds every draft.</CardDescription>
        </div>
      </CardHeader>
      <CardContent>
        <form action={formAction} className="space-y-4">
          <input type="hidden" name="leadId" value={lead.id} />

          <Field
            label="Research summary"
            htmlFor="research_summary"
            hint="The paragraph the generator leans on hardest. Concrete beats comprehensive."
          >
            <Textarea
              id="research_summary"
              name="research_summary"
              defaultValue={lead.research_summary ?? ''}
              rows={7}
            />
          </Field>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Website observations" htmlFor="website_observations">
              <Textarea
                id="website_observations"
                name="website_observations"
                defaultValue={lead.website_observations ?? ''}
                rows={4}
              />
            </Field>
            <Field label="Automation opportunities" htmlFor="automation_opportunities">
              <Textarea
                id="automation_opportunities"
                name="automation_opportunities"
                defaultValue={lead.automation_opportunities ?? ''}
                rows={4}
              />
            </Field>
            <Field label="AI chatbot opportunities" htmlFor="ai_chatbot_opportunities">
              <Textarea
                id="ai_chatbot_opportunities"
                name="ai_chatbot_opportunities"
                defaultValue={lead.ai_chatbot_opportunities ?? ''}
                rows={4}
              />
            </Field>
            <Field label="Website improvements" htmlFor="website_improvement_opportunities">
              <Textarea
                id="website_improvement_opportunities"
                name="website_improvement_opportunities"
                defaultValue={lead.website_improvement_opportunities ?? ''}
                rows={4}
              />
            </Field>
            <Field label="Interesting facts" htmlFor="interesting_facts">
              <Textarea
                id="interesting_facts"
                name="interesting_facts"
                defaultValue={lead.interesting_facts ?? ''}
                rows={3}
              />
            </Field>
            <Field
              label="Suggested outreach angle"
              htmlFor="outreach_angle"
              hint="One sentence. Follow-ups reuse this when nothing better exists."
            >
              <Textarea
                id="outreach_angle"
                name="outreach_angle"
                defaultValue={lead.outreach_angle ?? ''}
                rows={3}
              />
            </Field>
          </div>

          <PanelError state={state} />

          <div className="flex justify-end">
            <Button type="submit" variant="primary" loading={saving}>
              <Save className="size-4" aria-hidden="true" />
              Save research
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

export function PersonalizationPanel({ lead }: { lead: Lead }) {
  const [state, formAction, saving] = useActionState(savePersonalization, EMPTY_ACTION_RESULT);
  useActionFeedback(state);

  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle className="flex items-center gap-1.5">
            <Sparkles className="size-3.5 text-violet" aria-hidden="true" />
            Personalization
          </CardTitle>
          <CardDescription>
            The specific detail that proves this is not a mass mail. Available to drafts as{' '}
            <code className="font-mono text-[11px]">{'{{personalization}}'}</code>.
          </CardDescription>
        </div>
      </CardHeader>
      <CardContent>
        <form action={formAction} className="space-y-3">
          <input type="hidden" name="leadId" value={lead.id} />
          <Field label="Personalization notes" htmlFor="personalization">
            <Textarea
              id="personalization"
              name="personalization"
              defaultValue={lead.personalization ?? ''}
              rows={5}
            />
          </Field>

          <PanelError state={state} />

          <div className="flex justify-end">
            <Button type="submit" variant="primary" loading={saving}>
              <Save className="size-4" aria-hidden="true" />
              Save personalization
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

export function NotesPanel({ lead }: { lead: Lead }) {
  const [state, formAction, saving] = useActionState(saveNotes, EMPTY_ACTION_RESULT);
  useActionFeedback(state);

  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle className="flex items-center gap-1.5">
            <StickyNote className="size-3.5 text-muted-foreground" aria-hidden="true" />
            Internal notes
          </CardTitle>
          <CardDescription>Administrators only. Never sent, never shown publicly.</CardDescription>
        </div>
      </CardHeader>
      <CardContent>
        <form action={formAction} className="space-y-3">
          <input type="hidden" name="leadId" value={lead.id} />
          <Field label="Notes" htmlFor="notes">
            <Textarea id="notes" name="notes" defaultValue={lead.notes ?? ''} rows={4} />
          </Field>

          <PanelError state={state} />

          <div className="flex justify-end">
            <Button type="submit" variant="secondary" loading={saving}>
              <Save className="size-4" aria-hidden="true" />
              Save notes
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
