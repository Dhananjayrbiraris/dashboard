import { useContext } from 'react';
import { Link } from 'react-router-dom';
import { getOverview } from '../api';
import { useApi, useFiltersQs, Card, Skeleton, ErrorBox, EmptyState, DemoBanner, DeltaPct, ProgressBar, CostBasisBadge, FilterCtx } from '../ui';
import { fmtUsd, fmtInt, fmtCompact } from '../../shared';
import type { Totals } from '../../shared';
import { CostAreaChart, TokensChart, RequestsChart, ProviderPie, ModelCostBarChart, BudgetBurnChart } from './charts';
import { getModels } from '../api';

function dominantBasis(t: Totals) {
  const e = Object.entries(t.costBasis).sort((a, b) => b[1] - a[1])[0];
  if (!e || e[1] === 0) return 'unavailable' as const;
  return e[0] as keyof Totals['costBasis'];
}

function MetricCard({ label, value, sub, delta }: { label: string; value: React.ReactNode; sub?: React.ReactNode; delta?: React.ReactNode }) {
  return (
    <div className="card">
      <div className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">{label}</div>
      <div className="mt-1 text-2xl font-bold tabular-nums">{value}</div>
      <div className="mt-1 flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400">{sub}{delta}</div>
    </div>
  );
}

export function OverviewPage() {
  const qs = useFiltersQs();
  const { data, loading, error, reload } = useApi(() => getOverview(qs), [qs]);
  const models = useApi(() => getModels(qs), [qs]);
  const { setF } = useContext(FilterCtx);

  if (loading) return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">{Array.from({ length: 8 }).map((_, i) => <Skeleton key={i} h={92} />)}</div>
      <Skeleton h={280} /><Skeleton h={240} />
    </div>
  );
  if (error) return <ErrorBox message={error} onRetry={reload} />;
  if (!data) return null;

  const t = data.totals;
  const basis = dominantBasis(t);
  const hasData = t.requests > 0 || t.costUsd > 0 || t.totalTokens > 0;
  const monthlyBudget = data.budgets.find((b) => b.budget.period === 'monthly' && b.budget.enabled);
  const monthStart = data.range.end.slice(0, 8) + '01';
  const mtdSeries = data.series.filter((s) => s.date >= monthStart);

  return (
    <div className="space-y-4">
      {data.demoMode && <DemoBanner />}
      {!hasData && !data.demoMode && (
        <EmptyState title="No usage data yet"
          hint="Connect OpenAI and/or OpenRouter in Settings, then press Sync. You can also enable Demo Mode in Settings to explore the dashboard with clearly-labeled synthetic data." />
      )}

      {/* Summary metric cards */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <MetricCard label="Total API Cost"
          value={<span className="flex items-center gap-2">{fmtUsd(t.costUsd)}<CostBasisBadge basis={basis} /></span>}
          sub={`OpenAI ${fmtUsd(data.providers.openai.costUsd)} · OR ${fmtUsd(data.providers.openrouter.costUsd)}`}
          delta={<DeltaPct pct={data.deltas?.monthly.costPct} invert />} />
        <MetricCard label="Total Tokens"
          value={fmtCompact(t.totalTokens)}
          sub={<span>In {fmtCompact(t.inputTokens)} · Out {fmtCompact(t.outputTokens)}</span>}
          delta={<DeltaPct pct={data.deltas?.monthly.tokensPct} />} />
        <MetricCard label="API Requests"
          value={fmtInt(t.requests)}
          sub={<span><span className="text-emerald-600 dark:text-emerald-400">{fmtInt(t.successRequests)} ok</span> · <span className="text-red-500">{fmtInt(t.failedRequests)} failed</span></span>}
          delta={<DeltaPct pct={data.deltas?.monthly.requestsPct} />} />
        <MetricCard label="Avg Cost / Request"
          value={t.avgCostPerRequest == null ? '—' : fmtUsd(t.avgCostPerRequest)}
          sub={<>OA {data.providers.openai.avgCostPerRequest == null ? '—' : fmtUsd(data.providers.openai.avgCostPerRequest)} · OR {data.providers.openrouter.avgCostPerRequest == null ? '—' : fmtUsd(data.providers.openrouter.avgCostPerRequest)}</>} />
        <MetricCard label="This Month (MTD)"
          value={fmtUsd(mtdSeries.reduce((s, d) => s + d.combinedCost, 0))}
          sub={<>vs prev period <DeltaPct pct={data.deltas?.monthly.costPct} invert /></>} />
        <MetricCard label="Budget Usage"
          value={monthlyBudget ? `${monthlyBudget.pct.toFixed(0)}%` : '—'}
          sub={monthlyBudget ? <>{fmtUsd(monthlyBudget.spentUsd)} of {fmtUsd(monthlyBudget.budget.limitUsd, 2)}</> : 'No monthly budget configured'}
          delta={!monthlyBudget ? <Link to="/budgets" className="text-indigo-500 hover:underline text-xs">Configure →</Link> : undefined} />
        <MetricCard label="Projected Month End"
          value={data.forecast ? fmtUsd(data.forecast.projectedMonthEndUsd, 2) : '—'}
          sub={<span className="italic">{data.forecast ? 'estimate — see Cost Analysis' : 'needs ≥3 days of history'}</span>} />
        <MetricCard label="Active Alerts"
          value={data.alerts.filter((a) => !a.acknowledged).length}
          sub={<Link to="/budgets" className="text-indigo-500 hover:underline">View budgets & alerts →</Link>} />
      </div>

      {/* Charts */}
      <div className="grid gap-4 xl:grid-cols-3">
        <Card title={`Daily cost by provider (${data.range.start} → ${data.range.end}, UTC)`} className="xl:col-span-2">
          <CostAreaChart data={data.series} />
        </Card>
        <Card title="Cost share by provider">
          <ProviderPie openaiCost={data.providers.openai.costUsd} openrouterCost={data.providers.openrouter.costUsd} />
          <div className="mt-2 space-y-1 text-xs text-slate-500 dark:text-slate-400">
            <div className="flex justify-between"><span>OpenAI requests</span><span>{fmtInt(data.providers.openai.requests)}</span></div>
            <div className="flex justify-between"><span>OpenRouter requests</span><span>{fmtInt(data.providers.openrouter.requests)}</span></div>
            <p className="pt-1 text-[11px] italic">Click a provider below to filter the whole dashboard.</p>
            <div className="flex gap-2 pt-1">
              <button className="btn !py-0.5 text-xs" onClick={() => setF({ provider: 'openai' })}>OpenAI</button>
              <button className="btn !py-0.5 text-xs" onClick={() => setF({ provider: 'openrouter' })}>OpenRouter</button>
              <button className="btn !py-0.5 text-xs" onClick={() => setF({ provider: 'all' })}>All</button>
            </div>
          </div>
        </Card>
        <Card title="Token consumption over time (input vs output)" className="xl:col-span-2">
          <TokensChart data={data.series} />
        </Card>
        <Card title="API requests over time">
          <RequestsChart data={data.series} />
        </Card>
        {monthlyBudget && (
          <Card title={`Budget burn-down (${monthlyBudget.budget.name})`} className="xl:col-span-2">
            <BudgetBurnChart data={mtdSeries.length > 1 ? mtdSeries : data.series} limit={monthlyBudget.budget.limitUsd} />
            <div className="mt-2"><ProgressBar pct={monthlyBudget.pct} /></div>
          </Card>
        )}
        <Card title="Top models by cost" className={monthlyBudget ? '' : 'xl:col-span-2'}>
          {models.data?.models?.length
            ? <ModelCostBarChart models={models.data.models.map((m) => ({ name: `${m.provider === 'openai' ? 'OA' : 'OR'} · ${m.model}`, cost: m.costUsd, provider: m.provider }))} />
            : <EmptyState title="No model data" hint="Sync providers or enable demo mode." />}
        </Card>
      </div>

      <p className="text-[11px] text-slate-400">
        Data generated {new Date(data.generatedAt).toLocaleString()} (UTC). Costs labeled <CostBasisBadge basis="provider_reported" /> come from provider billing/usage APIs;
        {' '}<CostBasisBadge basis="estimated" /> are computed locally from cached list prices and may differ from billed amounts.
      </p>
    </div>
  );
}
