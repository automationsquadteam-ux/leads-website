import { PageHeader } from '@/components/shell/app-shell';
import { requireAdmin } from '@/lib/auth/session';
import { getCampaigns, getTemplates } from '@/lib/data/misc';
import { CampaignsClient } from './campaigns-client';

export const metadata = { title: 'Campaigns' };

export default async function CampaignsPage() {
  await requireAdmin();

  const [{ rows: campaigns, error }, { rows: templates }] = await Promise.all([
    getCampaigns(),
    getTemplates(),
  ]);

  return (
    <>
      <PageHeader
        title="Campaigns"
        description="Group leads and control sending pace. Start/pause writes real state; no email is dispatched yet."
      />

      <div className="p-4 sm:p-6">
        {error ? (
          <p className="mb-3 rounded-md border border-danger/30 bg-danger-subtle px-3 py-2.5 text-sm text-danger">
            Could not load campaigns: {error}
          </p>
        ) : null}

        <CampaignsClient
          campaigns={campaigns}
          templates={templates.map((t) => ({ id: t.id, name: t.name }))}
        />
      </div>
    </>
  );
}
