import type { ReactNode } from 'react';

export function Table({
  head,
  rows,
  empty = 'Nothing here.',
}: {
  head: string[];
  rows: ReactNode[][];
  empty?: string;
}) {
  if (rows.length === 0) return <p className="py-6 text-sm text-slate-500">{empty}</p>;
  return (
    <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
      <table className="min-w-full text-sm">
        <thead className="bg-slate-50 text-left text-xs uppercase text-slate-500">
          <tr>
            {head.map((h) => (
              <th key={h} className="px-3 py-2">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {rows.map((r, i) => (
            <tr key={i}>
              {r.map((c, j) => (
                <td key={j} className="px-3 py-2 align-top">
                  {c}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function Btn(
  props: React.ButtonHTMLAttributes<HTMLButtonElement> & { tone?: 'danger' | 'default' },
) {
  const { tone = 'default', className = '', ...rest } = props;
  return (
    <button
      {...rest}
      className={`rounded-md px-2.5 py-1 text-xs font-semibold ${tone === 'danger' ? 'bg-red-600 text-white hover:bg-red-700' : 'bg-slate-800 text-white hover:bg-slate-900'} disabled:opacity-50 ${className}`}
    />
  );
}

export function PageTitle({ children }: { children: ReactNode }) {
  return <h1 className="mb-4 text-xl font-bold">{children}</h1>;
}

export function ErrorBox({ error }: { error: string | null }) {
  return error ? <p className="mb-3 rounded bg-red-50 p-2 text-sm text-red-700">{error}</p> : null;
}
