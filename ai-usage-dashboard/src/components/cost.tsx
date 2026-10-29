import { useState } from 'react';
import { getOverview, getPrices, costCalc } from '../api';
import type { PriceRow } from '../api';
import { useApi, Card, Skeleton, ErrorBox, DemoBanner, CostBasisBadge } from '../ui';
import { fmtUsd } from '../../shared';
import { ForecastChart } from './charts';

export function CostPage() {
  const qs = 'range=90d&provider=all';
  const ov = useApi(() => getOverview(qs), []);
  const [search, setSearch] = useState('');
  const prices = useApi(() => getPrices(search), [search]);
  const [calcModel, setCalcModel] = useState('');
  const [calcProvider, setCalcProvider] = useState('openrouter');
  const [inTok, setInTok] = useState(1_000_000);
  const [outTok, setOutTok] = useState(200_000);
  const [calcResult, setCalcResult] = useState<any>(null);
  const [calcErr, setCalcErr] = useState<string | null>(null);

  if (ov.loading) return <Skeleton h={400} />;
  if (ov.error) return <ErrorBox message={ov.error} onRetry={ov.reload} />;
  const f = ov.data?.forecast ?? null;

  async function runCalc() {
    setCalcErr(null); setCalcResult(null);
    try { setCalcResult(await costCalc({ model: calcModel, provider: calcProvider, inputTokens: inTok, outputTokens: outTok })); }
    catch (e: any) { setCalcErr(e.message); }
  }

  // most cost-effective models by observed usage mix
  const models = ov.data ? null : null;
  return (
    <div className="space-y-4">
      {ov.data?.demoMode && <DemoBanner />}
      <div className="grid gap-4 lg:grid-cols-3">
        <Card title="Projected end-of-month spend" className="lg:col-span-2">
          {f ? (
            <>
              <div className="flex items-baseline gap-3">
                <div className="text-3xl font-bold tabular-nums">{fmtUsd(f.projectedMonthEndUsd, 2)}</div>
                <span className="badge bg-amber-100 text-amber-700 dark:bg-amber-900/50 dark:text-amber-300">estimate</span>
              </div>
              <p className="mt-1 text-xs text-slate-500">Avg daily ${f.avgDailyCost.toFixed(4)} · {f.remainingDays} days left in month (UTC) · {f.historyDays} history days. {f.confidenceNote}</p>
              <div className="mt-3"><ForecastChart data={ov.data!.series} projectedDaily={f.avgDailyCost} /></div>
            </>
          ) : <div className="text-sm text-slate-400">Need at least 3 days of current-month history after syncing to forecast.</div>}
        </Card>
        <Card title="Reconciliation notes">
          <ul className="list-disc space-y-2 pl-4 text-xs text-slate-500 dark:text-slate-400">
            <li><b>Actual billed costs</b> <CostBasisBadge basis="provider_reported" /> come straight from OpenAI Costs API and OpenRouter activity "usage" fields — these are authoritative.</li>
            <li><b>Estimated costs</b> <CostBasisBadge basis="estimated" /> are computed locally as tokens × cached list price. They reconcile against actuals but are never added together for the same row (no double counting).</li>
            <li><b>Purchased credits / balance</b> (OpenRouter) is money you bought, not money spent — shown only on the Providers page.</li>
            <li>OpenRouter activity timestamps are day-bucketed by the provider; intra-day precision is unavailable.</li>
            <li>Price catalog below is <i>cached list pricing</i> from OpenRouter's public /models endpoint — verify before relying on it.</li>
          </ul>
        </Card>
      </div>

      <Card title="Hypothetical cost calculator">
        <div className="flex flex-wrap items-end gap-3 text-sm">
          <div><label className="label">Provider</label>
            <select className="input" value={calcProvider} onChange={(e) => setCalcProvider(e.target.value)}>
              <option value="openrouter">OpenRouter</option><option value="openai">OpenAI (needs synced price cache)</option>
            </select></div>
          <div><label className="label">Model (from price catalog)</label>
            <input className="input w-72 mono" list="model-list" value={calcModel} onChange={(e) => setCalcModel(e.target.value)} placeholder="e.g. anthropic/claude-sonnet-4.5" />
            <datalist id="model-list">{prices.data?.prices.filter((p) => p.provider === calcProvider).slice(0, 80).map((p) => <option key={p.model_id} value={p.model_id} />)}</datalist>
          </div>
          <div><label className="label">Input tokens</label><input type="number" min="0" className="input w-36 tabular-nums" value={inTok} onChange={(e) => setInTok(Number(e.target.value) || 0)} /></div>
          <div><label className="label">Output tokens</label><input type="number" min="0" className="input w-36 tabular-nums" value={outTok} onChange={(e) => setOutTok(Number(e.target.value) || 0)} /></div>
          <button className="btn-primary" onClick={runCalc}>Calculate</button>
        </div>
        {calcErr && <div className="mt-2 text-xs text-red-500">{calcErr}</div>}
        {calcResult && (
          <div className="mt-3 rounded-lg border border-slate-200 p-3 text-sm dark:border-slate-800">
            <div className="flex items-center gap-2 text-lg font-bold tabular-nums">≈ {fmtUsd(calcResult.estimatedCostUsd)} <span className="badge bg-amber-100 text-amber-700 dark:bg-amber-900/50 dark:text-amber-300">estimated</span></div>
            <div className="mt-1 grid grid-cols-2 gap-1 text-xs text-slate-500 sm:grid-cols-4">
              <div>Input $/1M: <b>{fmtUsd(calcResult.inputPerM, 4)}</b></div>
              <div>Output $/1M: <b>{fmtUsd(calcResult.outputPerM, 4)}</b></div>
              <div>Input share: <b>{fmtUsd((calcResult.inputTokens * (calcResult.inputPerM ?? 0)) / 1e6)}</b></div>
              <div>Output share: <b>{fmtUsd((calcResult.outputTokens * (calcResult.outputPerM ?? 0)) / 1e6)}</b></div>
            </div>
            <p className="mt-1 text-[11px] italic text-slate-400">{calcResult.note}</p>
          </div>
        )}
      </Card>

      <Card title={`Model price comparison (per 1M tokens, USD)${prices.data ? ` — ${prices.data.prices.length} cached` : ''}`} right={
        <input className="input w-52" placeholder="Filter models…" value={search} onChange={(e) => setSearch(e.target.value)} />
      }>
        {prices.loading ? <Skeleton h={200} /> : prices.error ? <ErrorBox message={prices.error} /> : (
          <div className="max-h-[420px] overflow-auto rounded">
            <table className="table-base">
              <thead><tr><th>Model</th><th>Context</th><th>Input $/1M</th><th>Output $/1M</th><th>Blended* $/1M</th></tr></thead>
              <tbody>
                {prices.data?.prices.slice(0, 200).map((p: PriceRow) => {
                  const blend = p.input_per_musd != null && p.output_per_musd != null ? p.input_per_musd * 0.7 + p.output_per_musd * 0.3 : null;
                  return (
                    <tr key={`${p.provider}/${p.model_id}`} className="cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-800/50" onClick={() => { setCalcModel(p.model_id); setCalcProvider(p.provider); }}>
                      <td className="mono max-w-[320px] truncate text-xs" title={p.name ?? p.model_id}>{p.model_id}</td>
                      <td className="text-xs tabular-nums">{p.context_length?.toLocaleString() ?? '—'}</td>
                      <td className="tabular-nums text-xs">{p.input_per_musd == null ? 'free/n/a' : fmtUsd(p.input_per_musd, 4)}</td>
                      <td className="tabular-nums text-xs">{p.output_per_musd == null ? 'free/n/a' : fmtUsd(p.output_per_musd, 4)}</td>
                      <td className="tabular-nums text-xs">{blend == null ? '—' : fmtUsd(blend, 4)}</td>
                    </tr>
                  );
                })}
                {!prices.data?.prices.length && <tr><td colSpan={5} className="py-6 text-center text-xs text-slate-400">Price cache empty — sync OpenRouter once to populate it (public endpoint, no key needed).</td></tr>}
              </tbody>
            </table>
          </div>
        )}
        <p className="mt-2 text-[11px] text-slate-400">*Blended assumes a 70% input / 30% output token mix as a rough cross-model comparator. Cached list prices — not your billed amounts. Click a row to load it into the calculator.</p>
      </Card>
    </div>
  );
}
