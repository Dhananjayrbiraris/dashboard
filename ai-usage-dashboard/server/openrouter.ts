// OpenRouter integration — official API endpoints only:
//  * GET /api/v1/key            → own key info: limits, usage (USD spent), is_free_tier, rate limit
//  * GET /api/v1/credits        → total purchased credits + total usage → remaining balance
//  * GET /api/v1/activity       → per-request generation log (model, tokens, cost, timestamps)
//  * GET /api/v1/models         → public catalog with per-token pricing (no auth needed)
import { getDb, settingGet } from './db.js';
import { decrypt } from './crypto.js';
import type { NormalizedUsage } from './openai.js';
import { upsertUsage } from './openai.js';

const BASE = 'https://openrouter.ai';

export function orKey(): string | null {
  const enc = settingGet('openrouter.api_key_enc');
  if (enc) return decrypt(enc, process.env.DATA_DIR ?? 'data');
  return process.env.OPENROUTER_API_KEY ?? null;
}

async function orFetch(pathWithQuery: string, opts?: { auth?: boolean }): Promise<any> {
  const key = orKey();
  if (opts?.auth && !key) throw new Error('OpenRouter API key not configured');
  const res = await fetch(`${BASE}${pathWithQuery}`, {
    headers: {
      Accept: 'application/json',
      ...(opts?.auth && key ? { Authorization: `Bearer ${key}` } : {}),
    },
  });
  if (!res.ok) {
    let detail = '';
    try { const j = await res.json(); detail = j?.error?.message ?? JSON.stringify(j).slice(0, 200); }
    catch { detail = String(res.statusText); }
    const err: any = new Error(`OpenRouter HTTP ${res.status}: ${detail}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

export interface OrKeyInfo {
  label: string | null;
  unlimited: boolean;
  usage: number | null;           // USD reported for this key (actual spend through key)
  limit: number | null;           // hard credit limit on the key ($, provider-imposed)
  isFreeTier: boolean;
  rateLimitRequestsPerMinute: number | null;
}

export async function getKeyInfo(): Promise<OrKeyInfo> {
  const j = await orFetch('/api/v1/key', { auth: true });
  const k = j?.data ?? {};
  return {
    label: k.label ?? null,
    unlimited: !!k.unlimited,
    usage: typeof k.usage === 'number' ? k.usage : null,
    limit: typeof k.limit === 'number' ? k.limit : null,
    isFreeTier: !!k.is_free_tier,
    rateLimitRequestsPerMinute: k.rate_limits?.requests_per_minute ?? null,
  };
}

export interface OrCredits {
  totalUsage: number | null;     // lifetime $ used
  totalCredits: number | null;   // lifetime $ purchased
  remaining: number | null;      // computed = credits - usage
  note: string;
}

export async function getCredits(): Promise<OrCredits> {
  const j = await orFetch('/api/v1/credits', { auth: true });
  const d = j?.data ?? {};
  const usage = typeof d.total_usage === 'number' ? d.total_usage : null;
  const credits = typeof d.total_credits === 'number' ? d.total_credits : null;
  return {
    totalUsage: usage,
    totalCredits: credits,
    remaining: usage != null && credits != null ? credits - usage : null,
    note: 'Purchased credits minus lifetime usage. This is a balance, not a billed cost.',
  };
}

/** Pull activity log and store request-level rows + daily aggregates. */
export async function syncOpenRouterActivity(limitPerDay = 50): Promise<{ logs: number; warnings: string[] }> {
  const warnings: string[] = [];
  const db = getDb();
  let logs = 0;
  try {
    const j = await orFetch('/api/v1/activity', { auth: true });
    const items: any[] = j?.data ?? [];
    const now = new Date().toISOString();
    const ins = db.prepare(`
      INSERT INTO request_logs (provider,request_id,timestamp,model,upstream_provider,input_tokens,output_tokens,
        total_tokens,native_currency,native_amount,cost_usd,latency_ms,status,origin,stream,error_message,synced_at)
      VALUES ('openrouter',@request_id,@timestamp,@model,@upstream,@input,@output,@total,@cur,@amt,@cost,NULL,@status,@origin,@stream,NULL,@synced)
      ON CONFLICT(provider,request_id) DO UPDATE SET
        timestamp=excluded.timestamp, model=excluded.model, upstream_provider=excluded.upstream_provider,
        input_tokens=excluded.input_tokens, output_tokens=excluded.output_tokens, total_tokens=excluded.total_tokens,
        native_currency=excluded.native_currency, native_amount=excluded.native_amount, cost_usd=excluded.cost_usd,
        origin=excluded.origin, stream=excluded.stream, synced_at=excluded.synced`);
    for (const it of items.slice(0, limitPerDay * 400)) {
      const ts = it.timestamp ? `${String(it.timestamp).slice(0, 10)}T00:00:00Z` : now;
      ins.run({
        request_id: String(it.generation_id ?? it.id ?? ''),
        timestamp: ts,
        model: it.model_id ?? it.app_name ?? 'unknown',
        upstream: null, // activity feed does not expose routed provider per row
        input: it.tokens_prompt ?? null,
        output: it.tokens_completion ?? null,
        total: (it.tokens_prompt ?? 0) + (it.tokens_completion ?? 0) || null,
        cur: it.native_currency ?? null,
        amt: it.native_amount ?? null,
        cost: typeof it.usage === 'number' ? it.usage : null, // USD cost reported by OpenRouter
        status: 'success',
        origin: it.origin ?? null,
        stream: it.is_stream ? 1 : 0,
        synced: now,
      });
      logs++;
    }
  } catch (e: any) {
    warnings.push(`activity: ${e.message}`);
  }
  return { logs, warnings };
}

/**
 * Build daily/model aggregates FROM stored activity rows (source of truth for
 * OpenRouter token+cost aggregation). Cost here is provider-reported actual
 * spend (usage field in USD) — labeled provider_reported, never estimated.
 */
export function rollupActivityToDaily(): number {
  const db = getDb();
  const rows = db.prepare(`
    SELECT substr(timestamp,1,10) AS date, model,
           COUNT(*) AS requests,
           SUM(COALESCE(input_tokens,0)) AS inp,
           SUM(COALESCE(output_tokens,0)) AS outp,
           SUM(COALESCE(cost_usd,0)) AS cost,
           MAX(cost_usd IS NULL) AS any_null_cost
    FROM request_logs WHERE provider='openrouter'
    GROUP BY date, model`).all() as any[];
  const norm: NormalizedUsage[] = rows.map((r) => ({
    provider: 'openrouter', date: r.date, model: r.model,
    requests: r.requests, success_requests: r.requests, failed_requests: 0,
    input_tokens: r.inp ?? 0, output_tokens: r.outp ?? 0,
    reasoning_tokens: 0, cached_input_tokens: 0, audio_input_tokens: 0, audio_output_tokens: 0,
    image_count: 0, second_count: 0,
    cost_usd: r.any_null_cost && !r.cost ? null : r.cost,
    estimated_cost_usd: null,
    cost_source: 'provider_reported',
    source_id: `activity-rollup:${r.date}:${r.model}`,
  }));
  return upsertUsage(norm);
}

/** Cache public model pricing (per-token USD) for the cost calculator. */
export async function refreshModelPrices(): Promise<number> {
  const j = await orFetch('/api/v1/models'); // public, no auth
  const db = getDb();
  const now = new Date().toISOString();
  const stmt = db.prepare(`
    INSERT INTO model_prices (provider,model_id,name,context_length,input_per_musd,output_per_musd,pricing_source,currency,raw_json,fetched_at)
    VALUES ('openrouter',@id,@name,@ctx,@inp,@out,'per-token','USD',@raw,@fetched)
    ON CONFLICT(provider,model_id) DO UPDATE SET name=excluded.name, context_length=excluded.context_length,
      input_per_musd=excluded.input_per_musd, output_per_musd=excluded.output_per_musd, raw_json=excluded.raw_json, fetched_at=excluded.fetched_at`);
  let n = 0;
  const tx = db.transaction(() => {
    for (const m of j?.data ?? []) {
      const p = m.pricing ?? {};
      const toMusd = (v: any) => (v == null || isNaN(Number(v)) ? null : Number(v) * 1_000_000);
      stmt.run({
        id: m.id, name: m.name ?? m.id, ctx: m.context_length ?? null,
        inp: toMusd(p.prompt), out: toMusd(p.completion),
        raw: JSON.stringify({ price_promise: m.price_promise ?? null, per_request_urls: m.per_request_urls ?? null }),
        fetched: now,
      });
      n++;
    }
  });
  tx();
  return n;
}

export async function testOpenRouterKey(keyPlain: string): Promise<{ ok: boolean; message: string }> {
  try {
    const res = await fetch(`${BASE}/api/v1/key`, { headers: { Authorization: `Bearer ${keyPlain}` } });
    if (!res.ok) return { ok: false, message: `HTTP ${res.status}: ${(await res.text()).slice(0, 160)}` };
    const j = await res.json();
    const label = j?.data?.label ?? '(unnamed key)';
    return { ok: true, message: `Connected. Key label: "${label}". Usage/Credits/Activity endpoints available.` };
  } catch (e: any) {
    return { ok: false, message: e.message ?? 'Connection failed' };
  }
}
