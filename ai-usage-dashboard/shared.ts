// Shared types + pure analytics functions. Imported by BOTH server and client,
// so this file must stay dependency-free (no node/dotenv imports).

export type Provider = 'openai' | 'openrouter';

/** Which figure a cost number represents — never conflate these in the UI. */
export type CostBasis =
  | 'provider_reported' // actual billed/reported cost from provider API
  | 'estimated'         // locally computed from tokens × cached price
  | 'demo'              // synthetic demo-mode data, NOT real usage
  | 'unavailable';      // provider does not expose this metric

export interface Totals {
  costUsd: number;
  costBasis: Record<CostBasis, number>; // cost contribution per basis
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  requests: number;
  successRequests: number;
  failedRequests: number;
  avgCostPerRequest: number | null; // null when no cost data at all
}

export interface DailyPoint {
  date: string; // YYYY-MM-DD UTC
  openaiCost: number;
  openrouterCost: number;
  combinedCost: number;
  estimatedCost: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  requests: number;
  successRequests: number;
  failedRequests: number;
}

export interface ModelUsage {
  provider: Provider;
  model: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  requests: number;
  costUsd: number;
  estimatedCostUsd: number;
  costBasis: CostBasis; // dominant basis for this row
  avgCostPerRequest: number | null;
  lastUsed: string | null; // ISO
}

export interface BudgetDef {
  id: string;
  name: string;
  scope: 'combined' | Provider;
  period: 'daily' | 'weekly' | 'monthly';
  limitUsd: number;
  enabled: boolean;
}

export interface BudgetStatus {
  budget: BudgetDef;
  spentUsd: number;
  pct: number;               // 0..∞
  projectedPeriodEndUsd: number;
  daysRemaining: number;
  thresholdsHit: number[];   // e.g. [50,75]
  currentThreshold: number;  // highest crossed, 0 if none
}

export interface AlertItem {
  id: number;
  created_at: string;
  provider: string;
  kind: string;
  message: string;
  acknowledged: number;
}

export interface ProviderStatus {
  connected: boolean;
  keyHint: string | null;    // masked, safe to show
  authMode: 'settings' | 'env' | 'none';
  demoMode: boolean;
  lastSync: { lastSuccessAt: string | null; lastAttemptAt: string | null; lastStatus: string; lastMessage: string | null };
  balance: { amountUsd: number | null; label: string; basis: 'reported_balance' | 'purchased_credits' | 'unavailable'; note?: string } | null;
  rateLimits: { label: string; value: string }[] | null;
  dataAvailability: string[]; // human notes about what the API does/doesn't expose
}

export interface OverviewData {
  range: { start: string; end: string; days: number };
  totals: Totals;
  prevTotals: Totals;          // previous equal-length window
  deltas: { daily: DeltaSet; weekly: DeltaSet; monthly: DeltaSet } | null;
  series: DailyPoint[];
  providers: Record<Provider, Totals>;
  budgets: BudgetStatus[];
  alerts: AlertItem[];
  forecast: ForecastResult | null;
  demoMode: boolean;
  generatedAt: string;
}

export interface DeltaSet {
  costPct: number | null;
  tokensPct: number | null;
  requestsPct: number | null;
}

export interface ForecastResult {
  method: string;
  avgDailyCost: number;
  projectedMonthEndUsd: number;
  confidenceNote: string;
  remainingDays: number;
  historyDays: number;
}

export const MS_DAY = 86_400_000;

export function fmtUsd(n: number | null | undefined, digits = 4): string {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  if (n === 0) return '$0.00';
  const abs = Math.abs(n);
  const d = abs >= 100 ? 2 : abs >= 1 ? 2 : digits;
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d })}`;
}

export function fmtInt(n: number | null | undefined): string {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  return n.toLocaleString('en-US');
}

export function fmtCompact(n: number | null | undefined): string {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  if (Math.abs(n) >= 1_000_000_000) return `${(n / 1e9).toFixed(2)}B`;
  if (Math.abs(n) >= 1_000_000) return `${(n / 1e6).toFixed(2)}M`;
  if (Math.abs(n) >= 1_000) return `${(n / 1e3).toFixed(1)}K`;
  return String(Math.round(n));
}

export function utcToday(): string {
  return new Date().toISOString().slice(0, 10);
}

export function addDaysIso(iso: string, days: number): string {
  const t = Date.parse(iso + (iso.length === 10 ? 'T00:00:00Z' : ''));
  return new Date(t + days * MS_DAY).toISOString().slice(0, 10);
}

export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / MS_DAY);
}

function emptyTotals(): Totals {
  return {
    costUsd: 0,
    costBasis: { provider_reported: 0, estimated: 0, demo: 0, unavailable: 0 },
    inputTokens: 0, outputTokens: 0, totalTokens: 0,
    requests: 0, successRequests: 0, failedRequests: 0,
    avgCostPerRequest: null,
  };
}

export interface RawUsageRow {
  provider: string;
  date: string;
  model: string;
  requests: number;
  success_requests: number;
  failed_requests: number;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number | null;
  estimated_cost_usd: number | null;
  cost_source: string;
}

/** Aggregate raw normalized rows into totals. Rows already deduped by sync. */
export function computeTotals(rows: RawUsageRow[]): Totals {
  const t = emptyTotals();
  for (const r of rows) {
    t.requests += r.requests;
    t.successRequests += r.success_requests;
    t.failedRequests += r.failed_requests;
    t.inputTokens += r.input_tokens;
    t.outputTokens += r.output_tokens;
    if (r.cost_usd != null && r.cost_source !== 'estimated') {
      t.costUsd += r.cost_usd;
      (t.costBasis as any)[r.cost_source === 'demo' ? 'demo' : 'provider_reported'] += r.cost_usd;
    } else if (r.estimated_cost_usd != null) {
      t.costUsd += r.estimated_cost_usd;
      t.costBasis.estimated += r.estimated_cost_usd;
    }
  }
  t.totalTokens = t.inputTokens + t.outputTokens;
  t.avgCostPerRequest = t.requests > 0 && t.costUsd > 0 ? t.costUsd / t.requests : null;
  return t;
}

export function computeDeltas(curRows: RawUsageRow[], prevRows: RawUsageRow[]): DeltaSet {
  const c = computeTotals(curRows);
  const p = computeTotals(prevRows);
  const pct = (a: number, b: number): number | null => {
    if (!b) return a ? null : 0; // null = no baseline available
    return ((a - b) / b) * 100;
  };
  return {
    costPct: pct(c.costUsd, p.costUsd),
    tokensPct: pct(c.totalTokens, p.totalTokens),
    requestsPct: pct(c.requests, p.requests),
  };
}

/** Build a continuous daily series (zero-filled) for [start,end]. */
export function buildSeries(rows: RawUsageRow[], start: string, end: string): DailyPoint[] {
  const map = new Map<string, DailyPoint>();
  const days = Math.max(daysBetween(start, end), 0);
  for (let i = 0; i <= days; i++) {
    const d = addDaysIso(start, i);
    map.set(d, {
      date: d, openaiCost: 0, openrouterCost: 0, combinedCost: 0, estimatedCost: 0,
      inputTokens: 0, outputTokens: 0, totalTokens: 0,
      requests: 0, successRequests: 0, failedRequests: 0,
    });
  }
  for (const r of rows) {
    const p = map.get(r.date);
    if (!p) continue;
    const cost = (r.cost_usd != null && r.cost_source !== 'estimated') ? r.cost_usd : (r.estimated_cost_usd ?? 0);
    if (r.provider === 'openai') p.openaiCost += cost; else p.openrouterCost += cost;
    if (r.cost_source === 'estimated') p.estimatedCost += r.estimated_cost_usd ?? cost;
    p.combinedCost += cost;
    p.inputTokens += r.input_tokens;
    p.outputTokens += r.output_tokens;
    p.totalTokens += r.input_tokens + r.output_tokens;
    p.requests += r.requests;
    p.successRequests += r.success_requests;
    p.failedRequests += r.failed_requests;
  }
  return [...map.values()];
}

export function aggregateByModel(rows: RawUsageRow[], lastSeen: Map<string, string>): ModelUsage[] {
  const map = new Map<string, ModelUsage & { _basisCount: Record<string, number> }>();
  for (const r of rows) {
    const key = `${r.provider}|${r.model}`;
    let m = map.get(key);
    if (!m) {
      m = {
        provider: r.provider as Provider, model: r.model,
        inputTokens: 0, outputTokens: 0, totalTokens: 0, requests: 0,
        costUsd: 0, estimatedCostUsd: 0, costBasis: 'unavailable', _basisCount: {},
        avgCostPerRequest: null, lastUsed: null,
      };
      map.set(key, m);
    }
    m.inputTokens += r.input_tokens;
    m.outputTokens += r.output_tokens;
    m.requests += r.requests;
    if (r.cost_usd != null && r.cost_source !== 'estimated') {
      m.costUsd += r.cost_usd;
      m._basisCount[r.cost_source] = (m._basisCount[r.cost_source] ?? 0) + 1;
    } else if (r.estimated_cost_usd != null) {
      m.estimatedCostUsd += r.estimated_cost_usd;
      m.costUsd += r.estimated_cost_usd;
      m._basisCount['estimated'] = (m._basisCount['estimated'] ?? 0) + 1;
    }
  }
  const out = [...map.values()].map((m) => {
    m.totalTokens = m.inputTokens + m.outputTokens;
    m.avgCostPerRequest = m.requests > 0 && m.costUsd > 0 ? m.costUsd / m.requests : null;
    const basis = Object.entries(m._basisCount).sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'unavailable';
    m.costBasis = (basis === 'demo' ? 'demo' : basis === 'estimated' ? 'estimated' : m.costUsd > 0 ? 'provider_reported' : 'unavailable') as CostBasis;
    m.lastUsed = lastSeen.get(`${m.provider}|${m.model}`) ?? null;
    delete (m as any)._basisCount;
    return m as ModelUsage;
  });
  out.sort((a, b) => b.costUsd - a.costUsd);
  return out;
}

/** UTC-based period boundaries for budget windows. */
export function periodWindow(period: BudgetDef['period'], now = new Date()): { start: string; end: string } {
  const iso = now.toISOString().slice(0, 10);
  if (period === 'daily') return { start: iso, end: iso };
  if (period === 'weekly') {
    const dow = now.getUTCDay(); // 0 Sun
    const start = addDaysIso(iso, dow === 0 ? -6 : 1 - dow); // ISO week starts Monday
    return { start, end: addDaysIso(start, 6) };
  }
  const y = now.getUTCFullYear(), m = now.getUTCMonth();
  const start = `${y}-${String(m + 1).padStart(2, '0')}-01`;
  const lastDay = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return { start, end: `${y}-${String(m + 1).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}` };
}

export function evaluateBudget(b: BudgetDef, spentUsd: number, history: DailyPoint[], now = new Date()): BudgetStatus {
  const { start, end } = periodWindow(b.period, now);
  const totalDays = daysBetween(start, end) + 1;
  const elapsedDays = Math.min(daysBetween(start, now.toISOString().slice(0, 10)) + 1, totalDays);
  const recent = history.filter((h) => h.date >= start && h.date <= end);
  const observedDaily = recent.length ? recent.reduce((s, h) => s + h.combinedCost, 0) / recent.length : 0;
  const remainingDays = Math.max(totalDays - elapsedDays, 0);
  const projected = spentUsd + observedDaily * remainingDays;
  const pct = b.limitUsd > 0 ? (spentUsd / b.limitUsd) * 100 : 0;
  const thresholdsHit = [50, 75, 90, 100].filter((t) => pct >= t);
  return {
    budget: b, spentUsd, pct, projectedPeriodEndUsd: projected,
    daysRemaining: remainingDays, thresholdsHit,
    currentThreshold: thresholdsHit.length ? thresholdsHit[thresholdsHit.length - 1] : 0,
  };
}

/** Simple linear-regression + trailing-average blend forecast on daily costs. */
export function forecastMonthEnd(dailyCosts: { date: string; cost: number }[], now = new Date()): ForecastResult | null {
  if (dailyCosts.length < 3) return null;
  const { start, end } = periodWindow('monthly', now);
  const month = dailyCosts.filter((d) => d.date >= start && d.date <= end);
  if (month.length < 3) return null;
  const n = month.length;
  const ys = month.map((m) => m.cost);
  const meanX = (n - 1) / 2;
  const meanY = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0, den = 0;
  ys.forEach((y, i) => { num += (i - meanX) * (y - meanY); den += (i - meanX) ** 2; });
  const slope = den === 0 ? 0 : num / den;
  const todayIso = now.toISOString().slice(0, 10);
  const remainingDays = Math.max(daysBetween(todayIso, end), 0);
  const lastVal = meanY + slope * (n - 1 - meanX);
  let projected = month.reduce((a, b) => a + b.cost, 0);
  for (let i = 1; i <= remainingDays; i++) projected += Math.max(lastVal + slope * i, 0);
  const trailingAvg = meanY;
  const blended = month.reduce((a, b) => a + b.cost, 0) + ((Math.max(lastVal, 0) + trailingAvg) / 2) * remainingDays;
  return {
    method: 'linear trend blended with trailing average (estimate only)',
    avgDailyCost: trailingAvg,
    projectedMonthEndUsd: blended,
    confidenceNote: `Based on ${n} days of stored history. Forecasts are estimates, not provider billing.`,
    remainingDays,
    historyDays: dailyCosts.length,
  };
}

export function pctChange(cur: number, prev: number): number | null {
  if (!prev) return cur ? null : 0;
  return ((cur - prev) / prev) * 100;
}
