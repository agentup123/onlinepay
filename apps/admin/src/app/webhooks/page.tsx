'use client';

import { api, dt, useAdminApi } from '@/lib/api';
import { Btn, ErrorBox, PageTitle, Table } from '@/components/Table';

/* eslint-disable @typescript-eslint/no-explicit-any */
export default function Webhooks() {
  const { data, error, reload } = useAdminApi<any[]>('/admin/webhooks/failed');
  return (
    <div>
      <PageTitle>Unprocessed webhooks</PageTitle>
      <ErrorBox error={error} />
      <Table
        head={['Provider', 'Type', 'Attempts', 'Last error', 'Received', '']}
        empty="All webhooks processed."
        rows={(data ?? []).map((w) => [
          w.provider,
          w.eventType,
          w.attempts,
          <code key="e" className="text-xs">
            {w.lastError}
          </code>,
          dt(w.receivedAt),
          <Btn
            key="r"
            onClick={async () => {
              await api(`/admin/webhooks/${w.id}/retry`, { body: {} });
              await reload();
            }}
          >
            Retry
          </Btn>,
        ])}
      />
    </div>
  );
}
