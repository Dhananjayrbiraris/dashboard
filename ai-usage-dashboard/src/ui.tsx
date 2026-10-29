import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';
import type { CostBasis } from '../shared';

// ---------- theme ----------
export function useTheme() {
  const [dark, setDark] = useState(() => localStorage.getItem('theme') === 'dark');
  useEffect(() => {
    document.documentElement.classList.toggle('dark', dark);
    localStorage.setItem('theme', dark ? 'dark' : 'light');
  }, [dark]);
  return { dark, toggle: () => setDark((d) => !d) };
}

// ---------- filters (global date range + provider) ----------
export interface Filters { range: string; start: string; end: string; provider: string }
const defaultFilters = (): Filters => ({ range: '30d', start: '', end: new Date().toISOString().slice(0, 10), provider: 'all' });
export const FilterCtx = createContext<{ f: Filters; setF: (f: Partial<Filters>) => void }>({ f: defaultFilters(), setF: () => {} });
export function FilterProvider({ children }: { children: React.ReactNode }) {
  const [f, setFS] = useState<Filters>(defaultFilters);
  const setF = (patch: Partial<Filters>) => setFS((cur) => ({ ...cur, ...patch }));
  const qs = useMemo(() => {
    const p = new URLSearchParams({ range: f.range, provider: f.provider });
    if (f.start) p.set('start', f.start);
    if (f.end) p.set('end', f.end);
    return p.toString();
  }, [f]);
  return <FilterCtx.Provider value={{ f, setF }}>{children}</FilterCtx.Provider>;
}
export function useFiltersQs() {
  const { f } = useContext(FilterCtx);
  return useMemo(() => {
    const p = new URLSearchParams({ range: f.range, provider: f.provider });
    if (f.start) p.set('start', f.start);
    if (f.end) p.set('end', f.end);
    return p.toString();
  }, [f]);
}

// ---------- data hook with loading/error states ----------
export function useApi<T>(fn: () => Promise<T>, deps: any[]): { data: T | null; loading: boolean; error: string | null; reload: () => void } {
  const [state, setState] = useState<{ data: T | null; loading: boolean; error: string | null }>({ data: null, loading: true, error: null });
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    let live = true;
    setState((s) => ({ ...s, loading: true, error: null }));
    fn().then((d) => live && setState({ data: d, loading: false, error: null }))
        .catch((e) => live && setState({ data: null, loading: false, error: String(e?.message ?? e) }));
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce]);
  return { ...state, reload: () => setNonce((n) => n + 1) };
}

// ---------- small UI primitives ----------
export function Card({ title, children, right, className = '' }: { title?: string; children: React.ReactNode; right?: React.ReactNode; className?: string }) {
  return (
    <div className={`card ${className}`}>
      {(title || right) && (
        <div className="mb-3 flex items-center justify-between">
          {title && <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-200">{title}</h3>}
          {right}
        </div>
      )}
      {children}
    </div>
  );
}

export function Skeleton({ h = 16, w = '100%', className = '' }: { h?: number; w?: number | string; className?: string }) {
  return <div className={`animate-pulse rounded bg-slate-200 dark:bg-slate-800 ${className}`} style={{ height: h, width: w }} />;
}

export function ErrorBox({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-700 dark:border-red-800 dark:bg-red-950/40 dark:text-red-300">
      <span className="font-semibold">Error:</span> {message}
      {onRetry && <button onClick={onRetry} className="btn ml-3 !py-0.5">Retry</button>}
    </div>
  );
}

export function EmptyState({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-1 py-10 text-center">
      <div className="text-3xl">📭</div>
      <div className="text-sm font-semibold text-slate-600 dark:text-slate-300">{title}</div>
      {hint && <div className="max-w-md text-xs text-slate-400">{hint}</div>}
    </div>
  );
}

const BASIS_META: Record<CostBasis, { label: string; cls: string }> = {
  provider_reported: { label: 'Actual cost (provider-reported)', cls: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/50 dark:text-emerald-300' },
  estimated: { label: 'Estimated cost', cls: 'bg-amber-100 text-amber-700 dark:bg-amber-900/50 dark:text-amber-300' },
  demo: { label: 'DEMO DATA — not real usage', cls: 'bg-fuchsia-100 text-fuchsia-700 dark:bg-fuchsia-900/50 dark:text-fuchsia-300' },
  unavailable: { label: 'Cost unavailable', cls: 'bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400' },
};
export function CostBasisBadge({ basis }: { basis: CostBasis }) {
  const m = BASIS_META[basis];
  return <span className={`badge ${m.cls}`} title={m.label}>{basis === 'provider_reported' ? 'actual' : basis === 'estimated' ? 'est.' : basis === 'demo' ? 'demo' : 'n/a'}</span>;
}
export function DemoBanner() {
  return (
    <div className="rounded-lg border border-fuchsia-300 bg-fuchsia-50 px-3 py-2 text-xs font-medium text-fuchsia-800 dark:border-fuchsia-800 dark:bg-fuchsia-950/40 dark:text-fuchsia-200">
      ⚠ DEMO MODE is enabled — the figures below are <b>synthetic sample data</b>, not real API usage. Disable it in Settings once you connect your providers.
    </div>
  );
}

export function DeltaPct({ pct, invert = false }: { pct: number | null | undefined; invert?: boolean }) {
  if (pct === null || pct === undefined) return <span className="text-xs text-slate-400" title="No baseline data available for comparison">— vs prev</span>;
  const good = invert ? pct <= 0 : pct >= 0;
  return (
    <span className={`text-xs font-medium ${good ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'}`}>
      {pct > 0 ? '▲' : pct < 0 ? '▼' : '='} {Math.abs(pct).toFixed(1)}%
    </span>
  );
}

export function ProgressBar({ pct, thresholds = [50, 75, 90, 100] }: { pct: number; thresholds?: number[] }) {
  const clamped = Math.min(pct, 100);
  const color = pct >= 100 ? 'bg-red-500' : pct >= 90 ? 'bg-orange-500' : pct >= 75 ? 'bg-amber-500' : pct >= 50 ? 'bg-yellow-400' : 'bg-emerald-500';
  return (
    <div className="relative h-2.5 w-full overflow-hidden rounded-full bg-slate-200 dark:bg-slate-800">
      <div className={`h-full ${color} transition-all`} style={{ width: `${clamped}%` }} />
      {thresholds.map((t) => (
        <div key={t} className="absolute top-0 h-full w-px bg-slate-400/60" style={{ left: `${t}%` }} title={`${t}%`} />
      ))}
    </div>
  );
}
