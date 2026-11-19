'use client';

import { useState } from 'react';
import { dt, useAdminApi } from '@/lib/api';
import { ErrorBox, PageTitle, Table } from '@/components/Table';

/* eslint-disable @typescript-eslint/no-explicit-any */
export default function Audit() {
  const [target, setTarget] = useState('');
  const [query, setQuery] = useState('');
  const { data, error } = useAdminApi<any[]>(
    `/admin/audit${query ? `?targetId=${encodeURIComponent(query)}` : ''}`,
  );
  return (
    <div>
      <PageTitle>Audit log</PageTitle>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          setQuery(target);
        }}
        className="mb-4 flex gap-2"
      >
        <input
          className="w-96 rounded border px-3 py-1.5"
          value={target}
          onChange={(e) => setTarget(e.target.value)}
          placeholder="Filter by target id (card, user, purchase…)"
        />
        <button className="rounded bg-slate-800 px-3 text-sm text-white">Filter</button>
      </form>
      <ErrorBox error={error} />
      <Table
        head={['When', 'Actor', 'Action', 'Target', 'Change', 'IP']}
        rows={(data ?? []).map((a) => [
          dt(a.createdAt),
          `${a.actorType}${a.actorId ? `:${a.actorId.slice(0, 8)}` : ''}`,
          a.action,
          a.targetType ? `${a.targetType}:${String(a.targetId).slice(0, 8)}` : '',
          <code key="c" className="text-xs">
            {JSON.stringify({ before: a.before, after: a.after, meta: a.metadata })}
          </code>,
          a.ip ?? '',
        ])}
      />
    </div>
  );
}
