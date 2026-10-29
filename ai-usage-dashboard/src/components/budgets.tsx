import { useState } from 'react';
import { getOverview, putBudgets, getAlerts, ackAlert } from '../api';
import { useApi, Card, Skeleton, ErrorBox, ProgressBar, CostBasisBadge } from '../ui';
import { fmtUsd } from '../../shared';
import type { BudgetDef } from '../../shared';

export function BudgetsPage() {
  const ov = useApi(() => getOverview('range=30d'), []);
  const alerts = useApi(() => getAlerts(), []);
  const [draft, setDraft] = useState<BudgetDef[] | null>(null);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  if (ov.loading) return <Skeleton h={400} />;
  if (ov.error) return <ErrorBox message={ov.error} onRetry={ov.reload} />;
  if (!ov.data) return null;

  const statuses = ov.data.budgets;
  const budgets = draft ?? statuses.map((s) => s.budget);

  const update = (i: number, patch: Partial<BudgetDef>) => {
    const next = budgets.map((b, j) => (j === i ? { ...b, ...patch } : b));
    setDraft(next);
  };

  async function save() {
    if (!draft) return;
    setSaving(true); setMsg(null);
    try { await putBudgets(draft); setDraft(null); ov.reload(); alerts.reload(); setMsg('Budgets saved. Alerts re-evaluate on each sync.'); }
    catch (e: any) { setMsg(`Save failed: ${e.message}`); }
    finally { setSaving(false); }
  }

  return (
    <div className="space-y-4">
      <Card title="Budget status" right={<span className="text-[11px] text-slate-400">Windows are UTC-based</span>}>
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {statuses.map((s) => (
            <div key={s.budget.id} className="rounded-lg border border-slate-200 p-3 dark:border-slate-800">
              <div className="flex items-center justify-between">
                <div className="text-sm font-semibold">{s.budget.name}</div>
                <span className={`badge ${!s.budget.enabled ? 'bg-slate-200 text-slate-500' : s.pct >= 100 ? 'bg-red-100 text-red-700 dark:bg-red-900/50 dark:text-red-300' : s.pct >= 90 ? 'bg-orange-100 text-orange-700 dark:bg-orange-900/50 dark:text-orange-300' : s.pct >= 75 ? 'bg-amber-100 text-amber-700 dark:bg-amber-900/50 dark:text-amber-300' : 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/50 dark:text-emerald-300'}`}>
                  {s.budget.enabled ? `${s.pct.toFixed(0)}%` : 'disabled'}
                </span>
              </div>
              <div className="mt-1 text-xs text-slate-500">{s.budget.period} · scope: {s.budget.scope}</div>
              <div className="mt-2"><ProgressBar pct={s.pct} /></div>
              <div className="mt-2 grid grid-cols-2 gap-1 text-xs text-slate-500 dark:text-slate-400">
                <div>Spent <b className="tabular-nums text-slate-800 dark:text-slate-200">{fmtUsd(s.spentUsd)}</b></div>
                <div>Limit <b>{fmtUsd(s.budget.limitUsd, 2)}</b></div>
                <div>Projected period end <b title="Estimate based on observed daily pace">{fmtUsd(s.projectedPeriodEndUsd)}</b>*</div>
                <div>Days left <b>{s.daysRemaining}</b></div>
              </div>
              {s.thresholdsHit.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1">{s.thresholdsHit.map((t) => (
                  <span key={t} className={`badge ${t >= 100 ? 'bg-red-100 text-red-700 dark:bg-red-900/50 dark:text-red-300' : 'bg-amber-100 text-amber-700 dark:bg-amber-900/50 dark:text-amber-300'}`}>{t}% reached</span>
                ))}</div>
              )}
            </div>
          ))}
          {!statuses.length && <div className="text-sm text-slate-400">No budgets configured — add one below.</div>}
        </div>
        <p className="mt-3 text-[11px] italic text-slate-400">
          * Dashboard budgets are monitoring/alerting thresholds only. They do NOT block or cap API spending — actual enforcement is done by provider-side hard limits
          (see Providers page). Projected figures are estimates. Cost basis shown per underlying data: <CostBasisBadge basis="provider_reported" /> actual / <CostBasisBadge basis="estimated" /> estimated / <CostBasisBadge basis="demo" /> demo.
        </p>
      </Card>

      <Card title="Configure budgets & alert thresholds">
        <div className="space-y-2">
          {budgets.map((b, i) => (
            <div key={b.id} className="flex flex-wrap items-end gap-2 rounded-lg border border-slate-200 p-2 dark:border-slate-800">
              <label className="flex items-center gap-1 text-xs"><input type="checkbox" checked={b.enabled} onChange={(e) => update(i, { enabled: e.target.checked })} /> Enabled</label>
              <div><label className="label">Name</label><input className="input w-44" value={b.name} onChange={(e) => update(i, { name: e.target.value })} /></div>
              <div><label className="label">Scope</label>
                <select className="input" value={b.scope} onChange={(e) => update(i, { scope: e.target.value as BudgetDef['scope'] })}>
                  <option value="combined">Combined</option><option value="openai">OpenAI only</option><option value="openrouter">OpenRouter only</option>
                </select></div>
              <div><label className="label">Period</label>
                <select className="input" value={b.period} onChange={(e) => update(i, { period: e.target.value as BudgetDef['period'] })}>
                  <option value="daily">Daily</option><option value="weekly">Weekly</option><option value="monthly">Monthly</option>
                </select></div>
              <div><label className="label">Limit USD</label><input type="number" min="0" step="1" className="input w-28 tabular-nums" value={b.limitUsd} onChange={(e) => update(i, { limitUsd: Number(e.target.value) || 0 })} /></div>
              <button className="btn text-xs" onClick={() => setDraft(budgets.filter((_, j) => j !== i))}>Remove</button>
            </div>
          ))}
          <div className="flex gap-2">
            <button className="btn" onClick={() => setDraft([...budgets, { id: `b-${Date.now()}`, name: 'New budget', scope: 'combined', period: 'monthly', limitUsd: 50, enabled: true }])}>+ Add budget</button>
            {draft && <button className="btn-primary" disabled={saving} onClick={save}>{saving ? 'Saving…' : 'Save budgets'}</button>}
          </div>
          {msg && <div className="text-xs text-slate-500">{msg}</div>}
        </div>
      </Card>

      <Card title="Alerts history" right={<button className="btn !py-0.5 text-xs" onClick={() => alerts.reload()}>Refresh</button>}>
        {alerts.loading ? <Skeleton h={100} /> : !(alerts.data?.length) ? <div className="text-sm text-slate-400">No alerts yet. Alerts fire at 50/75/90/100% of budgets, on sync errors, spending spikes, and low OpenRouter credits (&lt;$5).</div> : (
          <table className="table-base">
            <thead><tr><th>Created (UTC)</th><th>Scope</th><th>Kind</th><th>Message</th><th /></tr></thead>
            <tbody>{alerts.data.map((a) => (
              <tr key={a.id} className={a.acknowledged ? 'opacity-50' : ''}>
                <td className="mono whitespace-nowrap text-xs">{a.created_at.slice(0, 19).replace('T', ' ')}</td>
                <td>{a.provider}</td>
                <td><span className={`badge ${a.kind.startsWith('budget_1') ? 'bg-red-100 text-red-700 dark:bg-red-900/50 dark:text-red-300' : a.kind === 'sync_error' || a.kind === 'spike' || a.kind === 'low_credits' ? 'bg-orange-100 text-orange-700 dark:bg-orange-900/50 dark:text-orange-300' : 'bg-amber-100 text-amber-700 dark:bg-amber-900/50 dark:text-amber-300'}`}>{a.kind}</span></td>
                <td className="text-xs">{a.message}</td>
                <td>{!a.acknowledged && <button className="btn !py-0.5 text-xs" onClick={() => ackAlert(a.id).then(() => alerts.reload())}>Acknowledge</button>}</td>
              </tr>))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}
