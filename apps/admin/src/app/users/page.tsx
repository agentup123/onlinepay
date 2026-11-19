'use client';

import Link from 'next/link';
import { useState } from 'react';
import { dt, useAdminApi } from '@/lib/api';
import { ErrorBox, PageTitle, Table } from '@/components/Table';

interface Row { id: string; fullName: string; email: string; phone: string; status: string; createdAt: string }

export default function Users() {
  const [q, setQ] = useState('');
  const [query, setQuery] = useState('');
  const { data, error } = useAdminApi<Row[]>(`/admin/users${query ? `?q=${encodeURIComponent(query)}` : ''}`);
  return (
    <div>
      <PageTitle>Users</PageTitle>
      <form onSubmit={(e) => { e.preventDefault(); setQuery(q); }} className="mb-4 flex gap-2">
        <input className="w-80 rounded border px-3 py-1.5" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Email, phone, name or user id" />
        <button className="rounded bg-slate-800 px-3 text-sm text-white">Search</button>
      </form>
      <ErrorBox error={error} />
      <Table
        head={['Name', 'Email', 'Phone', 'Status', 'Joined']}
        rows={(data ?? []).map((u) => [
          <Link key="n" className="text-blue-700 underline" href={`/users/${u.id}`}>{u.fullName}</Link>,
          u.email,
          u.phone,
          u.status,
          dt(u.createdAt),
        ])}
      />
    </div>
  );
}
