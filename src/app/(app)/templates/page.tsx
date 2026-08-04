import { PageHeader } from '@/components/shell/app-shell';
import { requireAdmin } from '@/lib/auth/session';
import { getTemplates } from '@/lib/data/misc';
import { TemplatesClient } from './templates-client';

export const metadata = { title: 'Templates' };

export default async function TemplatesPage() {
  await requireAdmin();
  const { rows, error } = await getTemplates();

  return (
    <>
      <PageHeader
        title="Templates"
        description="Reusable subject and body copy. Placeholders are filled per lead at send time."
      />

      <div className="p-4 sm:p-6">
        {error ? (
          <p className="mb-3 rounded-md border border-danger/30 bg-danger-subtle px-3 py-2.5 text-sm text-danger">
            Could not load templates: {error}
          </p>
        ) : null}

        <TemplatesClient templates={rows} />
      </div>
    </>
  );
}
