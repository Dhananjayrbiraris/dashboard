import { useState } from 'react';
import { getLogs, api } from '../api';
import { useApi, Card, Skeleton, ErrorBox, EmptyState, DemoBanner } from '../ui';
import { fmtUsd, fmtInt } from '../../shared';

export function LogsPage() {
  const [provider, setProvider] = useState('all');
  const [model, setModel] = useState('');
  const [status, setStatus] = useState('all');
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [page, setPage] = useState(1);
  const pageSize = 50;

  const q = new URLSearchParams({ page: String(page), pageSize: String(pageSize), provider, status });
  if (model) q.set('model', model);
  if (start) q.set('start', start);
  if (end) q.set('end', end);

  const { data, loading, error, reload } = useApi(() => getLogs(q.toString()), [provider, model, status, start, end, page]);
  const demo = useApi(() => api<{ demoMode: boolean }>('/providers/status'), []);

  const pages = Math.max(1, Math.ceil((data?.total ?? 0) / pageSize));
  return (
    <div className="space-y-3">
      {demo.data?.demoMode && <DemoBanner />}
      <Card>
        <div className="flex flex-wrap items-end gap-2 text-sm">
          <div><label className="label">Provider</label>
            <select className="input" value={provider} onChange={(e) => { setProvider(e.target.value); setPage(1); }}>
              <option value="all">All</option><option value="openai">OpenAI</option><option value="openrouter">OpenRouter</option>
            </select></div>
          <div><label className="label">Model contains</label>
            <input className="input w-44" value={model} onChange={(e) => { setModel(e.target.value); setPage(1); }} placeholder="e.g. gpt-4o" /></div>
          <div><label className="label">Status</label>
            <select className="input" value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }}>
              <option value="all">All</option><option value="success">Success</option><option value="error">Error</option>
            </select></div>
          <div><label className="label">From (UTC)</label><input type="date" className="input" value={start} onChange={(e) => { setStart(e.target.value); setPage(1); }} /></div>
          <div><label className="label">To (UTC)</label><input type="date" className="input" value={end} onChange={(e) => { setEnd(e.target.value); setPage(1); }} /></div>
          <a className="btn" href="/api/logs/export.csv">&#8681; Export CSV</a>
        </div>
        <p className="mt-2 text-[11px] text-slate-400">
          Per-request logs come from the OpenRouter Activity API (daily-bucketed timestamps). OpenAI does not expose per-request logs via its public Usage API —
          request counts appear in the Models table instead. Prompt/response content and credentials are never stored or displayed.
        </p>
      </Card>
      {loading && <Skeleton h={400} />}
      {error && <ErrorBox message={error} onRetry={reload} />}
      {data && (
        <>
          <div className="card overflow-x-auto" style={{ padding: 0 }}>
            <table className="table-base">
              <thead><tr>
                <th>Timestamp (UTC)</th><th>Provider</th><th>Model</th><th>Upstream</th>
                <th>In Tok</th><th>Out Tok</th><th>Cost</th><th>Latency</th><th>Status</th><th>Request ID</th>
              </tr></thead>
              <tbody>
                {data.items.map((r) => (
                  <tr key={r.id}>
                    <td className="mono whitespace-nowrap text-xs">{r.timestamp.slice(0, 19).replace('T', ' ')}</td>
                    <td><span className={`badge ${r.provider === 'openai' ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/50 dark:text-emerald-300' : 'bg-violet-100 text-violet-700 dark:bg-violet-900/50 dark:text-violet-300'}`}>{r.provider}</span></td>
                    <td className="mono max-w-[220px] truncate text-xs" title={r.model ?? ''}>{r.model ?? '—'}</td>
                    <td className="text-xs">{r.upstream_provider ?? '—'}</td>
                    <td className="tabular-nums text-xs">{fmtInt(r.input_tokens)}</td>
                    <td className="tabular-nums text-xs">{fmtInt(r.output_tokens)}</td>
                    <td className="tabular-nums text-xs">{r.cost_usd == null ? '—' : fmtUsd(r.cost_usd)}</td>
                    <td className="tabular-nums text-xs">{r.latency_ms == null ? '—' : `${Math.round(r.latency_ms)}ms`}</td>
                    <td><span className={`badge ${r.status === 'success' ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/50 dark:text-emerald-300' : 'bg-red-100 text-red-700 dark:bg-red-900/50 dark:text-red-300'}`} title={r.error_message ?? undefined}>{r.status}</span></td>
                    <td className="mono max-w-[180px] truncate text-[11px] text-slate-400" title={r.request_id}>{r.request_id}</td>
                  </tr>
                ))}
                {!data.items.length && <tr><td colSpan={10}><EmptyState title="No request logs found" hint="Sync OpenRouter to import activity rows, or enable demo mode." /></td></tr>}
              </tbody>
            </table>
          </div>
          <div className="flex items-center gap-2 text-sm">
            <button className="btn" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>← Prev</button>
            <span className="text-xs text-slate-400">Page {page} / {pages} · {fmtInt(data.total)} records</span>
            <button className="btn" disabled={page >= pages} onClick={() => setPage((p) => p + 1)}>Next →</button>
          </div>
        </>
      )}
    </div>
  );
}
