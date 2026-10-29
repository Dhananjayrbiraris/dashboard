import { describe, it, expect } from 'vitest';
import {
  computeTotals, buildSeries, aggregateByModel, periodWindow, evaluateBudget,
  forecastMonthEnd, addDaysIso, utcToday, daysBetween, fmtUsd,
} from '../shared';
import type { RawUsageRow, BudgetDef } from '../shared';

const row = (over: Partial<RawUsageRow>): RawUsageRow => ({
  provider: 'openai', date: '2026-10-01', model: 'gpt-4o', requests: 10,
  success_requests: 9, failed_requests: 1, input_tokens: 1000, output_tokens: 500,
  cost_usd: 0.01, estimated_cost_usd: null, cost_source: 'provider_reported', ...over,
});

describe('computeTotals', () => {
  it('sums tokens, requests and provider-reported costs', () => {
    const t = computeTotals([row({}), row({ date: '2026-10-02', cost_usd: 0.03 })]);
    expect(t.requests).toBe(20);
    expect(t.totalTokens).toBe(3000);
    expect(t.costUsd).toBeCloseTo(0.04);
    expect(t.costBasis.provider_reported).toBeCloseTo(0.04);
    expect(t.avgCostPerRequest).toBeCloseTo(0.002);
  });
  it('falls back to estimated cost only when no reported cost exists — never double counts', () => {
    const t = computeTotals([
      row({ cost_usd: 0.05, estimated_cost_usd: 0.07 }),   // actual wins
      row({ provider: 'openrouter', cost_usd: null, estimated_cost_usd: 0.02, cost_source: 'estimated' }),
    ]);
    expect(t.costUsd).toBeCloseTo(0.07); // 0.05 + 0.02, not 0.05+0.07+0.02
    expect(t.costBasis.provider_reported).toBeCloseTo(0.05);
    expect(t.costBasis.estimated).toBeCloseTo(0.02);
  });
  it('null avg when no cost data at all', () => {
    const t = computeTotals([row({ cost_usd: null, estimated_cost_usd: null })]);
    expect(t.avgCostPerRequest).toBeNull();
  });
});

describe('buildSeries', () => {
  it('zero-fills missing days and separates providers', () => {
    const s = buildSeries([row({}), row({ provider: 'openrouter', date: '2026-10-03', cost_usd: 0.02 })], '2026-10-01', '2026-10-04');
    expect(s).toHaveLength(4);
    expect(s[1].combinedCost).toBe(0);
    expect(s[0].openaiCost).toBeCloseTo(0.01);
    expect(s[2].openrouterCost).toBeCloseTo(0.02);
  });
});

describe('aggregateByModel', () => {
  it('groups by provider+model and labels basis', () => {
    const m = aggregateByModel([row({}), row({ model: 'gpt-4o-mini', cost_usd: null, estimated_cost_usd: 0.001, cost_source: 'estimated' })], new Map());
    expect(m).toHaveLength(2);
    expect(m.find((x) => x.model === 'gpt-4o')!.costBasis).toBe('provider_reported');
    expect(m.find((x) => x.model === 'gpt-4o-mini')!.costBasis).toBe('estimated');
  });
});

describe('periodWindow & budgets', () => {
  it('monthly window matches UTC calendar month', () => {
    const w = periodWindow('monthly', new Date('2026-10-15T12:00:00Z'));
    expect(w.start).toBe('2026-10-01'); expect(w.end).toBe('2026-10-31');
  });
  it('weekly window is ISO (Mon–Sun)', () => {
    const w = periodWindow('weekly', new Date('2026-10-15T00:00:00Z')); // Thursday
    expect(w.start).toBe('2026-10-12'); expect(w.end).toBe('2026-10-18');
  });
  it('budget thresholds hit at 50/75/90/100', () => {
    const b: BudgetDef = { id: 'x', name: 'b', scope: 'combined', period: 'monthly', limitUsd: 100, enabled: true };
    const st = evaluateBudget(b, 92, []);
    expect(st.thresholdsHit).toEqual([50, 75, 90]);
    expect(st.currentThreshold).toBe(90);
  });
});

describe('forecastMonthEnd', () => {
  it('returns null with insufficient history', () => {
    expect(forecastMonthEnd([{ date: '2026-10-01', cost: 1 }])).toBeNull();
  });
  it('projects remaining days at observed pace', () => {
    const now = new Date('2026-10-11T00:00:00Z');
    const hist = Array.from({ length: 10 }, (_, i) => ({ date: `2026-10-${String(i + 1).padStart(2, '0')}`, cost: 2 }));
    const f = forecastMonthEnd(hist, now)!;
    // spent 20 so far + 20 remaining days × ~2/day ≈ 60
    expect(f.projectedMonthEndUsd).toBeGreaterThan(55);
    expect(f.projectedMonthEndUsd).toBeLessThan(65);
    expect(f.remainingDays).toBe(20);
  });
});

describe('date utils', () => {
  it('addDaysIso crosses month boundaries in UTC', () => {
    expect(addDaysIso('2026-10-31', 1)).toBe('2026-11-01');
    expect(daysBetween('2026-01-01', '2026-03-01')).toBe(59);
  });
  it('fmtUsd handles nulls', () => { expect(fmtUsd(null)).toBe('—'); });
});
