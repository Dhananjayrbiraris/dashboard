import { useMemo, useState } from 'react';
import { getModels, getProvidersStatus, runSync, getSyncRuns } from '../api';
import { useApi, useFiltersQs, Card, Skeleton, ErrorBox, EmptyState, DemoBanner, CostBasisBadge } from '../ui';
import { fmtUsd, fmtInt, fmtCompact } from '../../shared';
import type { ModelUsage } from '../../shared';

// ---------- Providers page ----------
function StatusDot({ ok }: { ok: boolean | null }) {
  return <span className={`inline-block h-2.5 w-2.5 rounded-full ${ok === null ? 'bg-slate-400' : ok ? 'bg-emerald-500' : 'bg-red-500'}`} />;
}

export function ProvidersPage() {
  const { data, loading, error, reload } = useApi(() => getProvidersStatus(), []);
  const runs = useApi(() => getSyncRuns(), []);
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState<string | null>(null);

  async function doSync(backfill?: number) {
    setSyncing(true); setSyncMsg(null);
    try {
      const r = await runSync(backfill);
      setSyncMsg(JSON.stringify(r).slice(0, 300));
      reload(); runs.reload();
    } catch (e: any) { setSyncMsg(`Sync failed: ${e.message}`); }
    finally { setSyncing(false); }
  }

  if (loading) return <div className="space-y-4"><Skeleton h={200} /><Skeleton h={200} /></div>;
  if (error) return <ErrorBox message={error} onRetry={reload} />;
  if (!data) return null;

  const renderProvider = (p: any, name: string) => (
    <Card title={<span className="flex items-center gap-2"><StatusDot ok={p?.connected} /> {name}</span> as any}>
      {!p || !p.connected ? (
        <EmptyState title={`${name} not connected`} hint={`Add your ${name} API key in Settings. Keys are stored encrypted on the server only.`} />
      ) : (
        <div className="space-y-3 text-sm">
          <div className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-3">
            <div><div className="text-slate-400">Key (masked)</div><div className="mono">{p.keyHint ?? '—'}</div></div>
            <div><div className="text-slate-400">Credential source</div>{p.authMode}</div>
            <div><div className="text-slate-400">Last successful sync</div>{p.lastSync?.lastSuccessAt ? new Date(p.lastSync.lastSuccessAt).toLocaleString() : 'never'}</div>
            <div><div className="text-slate-400">Last attempt</div>{p.lastSync?.lastAttemptAt ? new Date(p.lastSync.lastAttemptAt).toLocaleString() : 'never'} ({p.lastSync?.lastStatus})</div>
            {p.keyLabel !== undefined && <div><div className="text-slate-400">Key label</div>{p.keyLabel ?? '—'}</div>}
            {p.keyUsageUsd != null && <div><div className="text-slate-400">Key lifetime usage (reported)</div>{fmtUsd(p.keyUsageUsd, 2)}</div>}
          </div>
          {p.lastSync?.lastMessage && <div className="rounded bg-amber-50 p-2 text-xs text-amber-800 dark:bg-amber-950/40 dark:text-amber-200">Sync notes: {p.lastSync.lastMessage}</div>}
          {p.error && <div className="rounded bg-red-50 p-2 text-xs text-red-700 dark:bg-red-950/40 dark:text-red-300">Live status fetch failed: {p.error}</div>}
          <div>
            <div className="label">Balance / credits</div>
            {p.balance?.amountUsd != null ? (
              <div className="text-lg font-semibold tabular-nums">{fmtUsd(p.balance.amountUsd, 2)}
                <span className="badge ml-2 bg-sky-100 text-sky-700 dark:bg-sky-900/50 dark:text-sky-300">{p.balance.basis.replace('_', ' ')}</span>
              </div>
            ) : <div className="text-xs italic text-slate-400">{p.balance?.label ?? 'Unavailable'}{p.balance?.note ? ` — ${p.balance.note}` : ''}</div>}
            {p.balance?.note && p.balance.amountUsd != null && <div className="text-[11px] italic text-slate-400">{p.balance.note}</div>}
          </div>
          {p.rateLimits?.length > 0 && (
            <div>
              <div className="label">Provider-imposed limits (hard limits, enforced by {name})</div>
              <ul className="list-disc pl-4 text-xs text-slate-600 dark:text-slate-300">
                {p.rateLimits.map((r: any, i: number) => <li key={i}><b>{r.label}:</b> {r.value}</li>)}
              </ul>
            </div>
          )}
          <div>
            <div className="label">Data availability notes</div>
            <ul className="list-disc pl-4 text-xs text-slate-500 dark:text-slate-400">
              {(p.dataAvailability ?? []).map((s: string, i: number) => <li key={i}>{s}</li>)}
            </ul>
          </div>
        </div>
      )}
    </Card>
  );

  return (
    <div className="space-y-4">
      {data.demoMode && <DemoBanner />}
      <div className="flex flex-wrap items-center gap-2">
        <button className="btn-primary" onClick={() => doSync()} disabled={syncing}>{syncing ? 'Syncing…' : '⟳ Sync now'}</button>
        <button className="btn" onClick={() => doSync(90)} disabled={syncing}>Backfill 90 days</button>
        <span className="text-xs text-slate-400">Incremental sync re-fetches the last synced day ±2 to catch provider-side late updates; upserts prevent duplicates.</span>
      </div>
      {syncMsg && <div className="card text-xs mono whitespace-pre-wrap">{syncMsg}</div>}
      <div className="grid gap-4 lg:grid-cols-2">
        {renderProvider(data.openai, 'OpenAI')}
        {renderProvider(data.openrouter, 'OpenRouter')}
      </div>
      <Card title="Recent sync runs">
        {runs.loading ? <Skeleton h={120} /> : (runs.data?.length ?? 0) === 0 ? <EmptyState title="No sync runs recorded yet" /> : (
          <div className="overflow-x-auto"><table className="table-base">
            <thead><tr><th>Started (UTC)</th><th>Provider</th><th>Status</th><th>Rows</th><th>Message</th></tr></thead>
            <tbody>{runs.data!.map((r) => (
              <tr key={r.id}>
                <td className="mono text-xs">{r.started_at}</td><td>{r.provider}</td>
                <td><span className={`badge ${r.status === 'success' ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/50 dark:text-emerald-300' : r.status === 'partial' ? 'bg-amber-100 text-amber-700 dark:bg-amber-900/50 dark:text-amber-300' : 'bg-red-100 text-red-700 dark:bg-red-900/50 dark:text-red-300'}`}>{r.status}</span></td>
                <td>{r.rows_upserted}</td><td className="max-w-md truncate text-xs text-slate-500" title={r.message ?? ''}>{r.message}</td>
              </tr>))}
            </tbody>
          </table></div>
        )}
      </Card>
    </div>
  );
}

// ---------- Models page ----------
type SortKey = keyof Pick<ModelUsage, 'model' | 'inputTokens' | 'outputTokens' | 'totalTokens' | 'requests' | 'costUsd' | 'avgCostPerRequest' | 'lastUsed'>;

export function ModelsPage() {
  const qs = useFiltersQs();
  const { data, loading, error, reload } = useApi(() => getModels(qs), [qs]);
  const [search, setSearch] = useState('');
  const [providerFilter, setProviderFilter] = useState('all');
  const [sortKey, setSortKey] = useState<SortKey>('costUsd');
  const [dir, setDir] = useState<1 | -1>(-1);
  const [page, setPage] = useState(0);
  const pageSize = 15;
  const [detail, setDetail] = useState<ModelUsage | null>(null);

  const filtered = useMemo(() => {
    let rows = data?.models ?? [];
    if (providerFilter !== 'all') rows = rows.filter((m) => m.provider === providerFilter);
    if (search) rows = rows.filter((m) => m.model.toLowerCase().includes(search.toLowerCase()));
    return [...rows].sort((a, b) => {
      const av = a[sortKey], bv = b[sortKey];
      const cmp = typeof av === 'number' && typeof bv === 'number' ? av - bv : String(av ?? '').localeCompare(String(bv ?? ''));
      return cmp * dir;
    });
  }, [data, search, providerFilter, sortKey, dir]);

  const header = (key: SortKey, label: string) => (
    <th className="cursor-pointer select-none" onClick={() => { if (sortKey === key) setDir((d) => (d === 1 ? -1 : 1)); else { setSortKey(key); setDir(-1); } }}>
      {label}{sortKey === key ? (dir === -1 ? ' ↓' : ' ↑') : ''}
    </th>
  );

  if (loading) return <Skeleton h={400} />;
  if (error) return <ErrorBox message={error} onRetry={reload} />;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <input className="input w-56" placeholder="Search model…" value={search} onChange={(e) => { setSearch(e.target.value); setPage(0); }} />
        <select className="input" value={providerFilter} onChange={(e) => { setProviderFilter(e.target.value); setPage(0); }}>
          <option value="all">All providers</option><option value="openai">OpenAI</option><option value="openrouter">OpenRouter</option>
        </select>
        <span className="text-xs text-slate-400">{filtered.length} models · range {data?.start} → {data?.end} (UTC)</span>
      </div>
      <div className="card overflow-x-auto" style={{ padding: 0 }}>
        <table className="table-base">
          <thead><tr>
            {header('model', 'Model')}<th>Provider</th>
            {header('inputTokens', 'Input Tokens')}{header('outputTokens', 'Output Tokens')}{header('totalTokens', 'Total Tokens')}
            {header('requests', 'Requests')}{header('costUsd', 'Total Cost')}{header('avgCostPerRequest', 'Avg Cost/Req')}
            {header('lastUsed', 'Last Used')}<th>Basis</th>
          </tr></thead>
          <tbody>
            {filtered.slice(page * pageSize, page * pageSize + pageSize).map((m) => (
              <tr key={`${m.provider}|${m.model}`} className="cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-800/50" onClick={() => setDetail(m)}>
                <td className="mono text-xs">{m.model}</td>
                <td><span className={`badge ${m.provider === 'openai' ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/50 dark:text-emerald-300' : 'bg-violet-100 text-violet-700 dark:bg-violet-900/50 dark:text-violet-300'}`}>{m.provider}</span></td>
                <td className="tabular-nums">{fmtInt(m.inputTokens)}</td>
                <td className="tabular-nums">{fmtInt(m.outputTokens)}</td>
                <td className="tabular-nums">{fmtCompact(m.totalTokens)}</td>
                <td className="tabular-nums">{fmtInt(m.requests)}</td>
                <td className="tabular-nums">{fmtUsd(m.costUsd)}</td>
                <td className="tabular-nums">{m.avgCostPerRequest == null ? '—' : fmtUsd(m.avgCostPerRequest)}</td>
                <td className="text-xs">{m.lastUsed ?? '—'}</td>
                <td><CostBasisBadge basis={m.costBasis} /></td>
              </tr>
            ))}
            {!filtered.length && <tr><td colSpan={10}><EmptyState title="No models match" hint="Adjust filters or sync data first." /></td></tr>}
          </tbody>
        </table>
      </div>
      <div className="flex items-center gap-2 text-sm">
        <button className="btn" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>← Prev</button>
        <span className="text-xs text-slate-400">Page {page + 1} of {Math.max(1, Math.ceil(filtered.length / pageSize))}</span>
        <button className="btn" disabled={(page + 1) * pageSize >= filtered.length} onClick={() => setPage((p) => p + 1)}>Next →</button>
      </div>
      {detail && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => setDetail(null)}>
          <div className="card max-w-lg w-full" onClick={(e) => e.stopPropagation()}>
            <h3 className="mono mb-2 break-all text-sm font-bold">{detail.provider} / {detail.model}</h3>
            <div className="grid grid-cols-2 gap-2 text-sm">
              <div>Input tokens<b className="block tabular-nums">{fmtInt(detail.inputTokens)}</b></div>
              <div>Output tokens<b className="block tabular-nums">{fmtInt(detail.outputTokens)}</b></div>
              <div>Requests<b className="block tabular-nums">{fmtInt(detail.requests)}</b></div>
              <div>Total cost<b className="block tabular-nums">{fmtUsd(detail.costUsd)} <CostBasisBadge basis={detail.costBasis} /></b></div>
              <div>Avg cost/request<b className="block">{detail.avgCostPerRequest == null ? '—' : fmtUsd(detail.avgCostPerRequest)}</b></div>
              <div>Last used<b className="block">{detail.lastUsed ?? '—'}</b></div>
            </div>
            {detail.costBasis === 'estimated' && <p className="mt-2 text-xs italic text-amber-600">This cost is estimated from cached list prices, not billed amounts.</p>}
            {detail.costBasis === 'demo' && <p className="mt-2 text-xs italic text-fuchsia-600">DEMO DATA — synthetic, not real usage.</p>}
            <button className="btn mt-3" onClick={() => setDetail(null)}>Close</button>
          </div>
        </div>
      )}
    </div>
  );
}
