// OpenAI integration — uses official endpoints only:
//  * GET /v1/organization/usage/completions        (tokens, requests by model/day)
//  * GET /v1/organization/costs                  (actual billed costs by day)
//  * GET /v1/organization/projects               (project-level breakdown)
//  * GET /v1/models                              (catalog)
// NOTE: These require an ADMIN-LEVEL or organization-scoped API key for a
// personal (user-owned) key. Errors are surfaced verbatim (sanitized) so the
// user knows exactly which permission is missing. We never invent numbers.
import { getDb, settingGet } from './db.js';
import { decrypt } from './crypto.js';

const BASE = 'https://api.openai.com';

export function openaiApiKey(dataDir: string): { key: string | null; source: 'settings' | 'env' | null } {
  const enc = settingGet('openai.api_key_enc');
  if (enc) return { key: decrypt(enc, dataDir), source: 'settings' };
  if (process.env.OPENAI_API_KEY) return { key: process.env.OPENAI_API_KEY, source: 'env' };
  return { key: null, source: null };
}

async function fetchJson(pathWithQuery: string, key: string, init?: RequestInit): Promise<any> {
  const res = await fetch(`${BASE}${pathWithQuery}`, {
    ...init,
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  });
  if (!res.ok) {
    let detail = '';
    try {
      const j = await res.json();
      detail = j?.error?.message ?? JSON.stringify(j).slice(0, 200);
    } catch { detail = await res.text().then((t) => t.slice(0, 200)).catch(() => ''); }
    const err: any = new Error(`OpenAI HTTP ${res.status}: ${detail}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

export interface NormalizedUsage {
  provider: 'openai' | 'openrouter';
  date: string;
  model: string;
  requests: number;
  success_requests: number;
  failed_requests: number;
  input_tokens: number;
  output_tokens: number;
  reasoning_tokens: number;
  cached_input_tokens: number;
  audio_input_tokens: number;
  audio_output_tokens: number;
  image_count: number;
  second_count: number;
  cost_usd: number | null;
  estimated_cost_usd: number | null;
  cost_source: 'provider_reported' | 'estimated' | 'demo';
  source_id: string; // dedupe key
}

/** Upsert normalized rows; UNIQUE(provider,date,model,source_id) prevents duplicates on re-sync. */
export function upsertUsage(rows: NormalizedUsage[]): number {
  const db = getDb();
  const now = new Date().toISOString();
  const stmt = db.prepare(`
    INSERT INTO usage_daily (provider,date,model,requests,success_requests,failed_requests,
      input_tokens,output_tokens,reasoning_tokens,cached_input_tokens,audio_input_tokens,audio_output_tokens,
      image_count,second_count,cost_usd,estimated_cost_usd,cost_source,source_id,synced_at)
    VALUES (@provider,@date,@model,@requests,@success_requests,@failed_requests,
      @input_tokens,@output_tokens,@reasoning_tokens,@cached_input_tokens,@audio_input_tokens,@audio_output_tokens,
      @image_count,@second_count,@cost_usd,@estimated_cost_usd,@cost_source,@source_id,@synced_at)
    ON CONFLICT(provider,date,model,source_id) DO UPDATE SET
      requests=excluded.requests, success_requests=excluded.success_requests, failed_requests=excluded.failed_requests,
      input_tokens=excluded.input_tokens, output_tokens=excluded.output_tokens,
      reasoning_tokens=excluded.reasoning_tokens, cached_input_tokens=excluded.cached_input_tokens,
      audio_input_tokens=excluded.audio_input_tokens, audio_output_tokens=excluded.audio_output_tokens,
      image_count=excluded.image_count, second_count=excluded.second_count,
      cost_usd=excluded.cost_usd, estimated_cost_usd=excluded.estimated_cost_usd,
      cost_source=excluded.cost_source, synced_at=excluded.synced_at`);
  let n = 0;
  const tx = db.transaction((rs: NormalizedUsage[]) => {
    for (const r of rs) {
      stmt.run({ ...r, synced_at: now });
      n++;
    }
  });
  tx(rows);
  return n;
}

function blank(p: 'openai', date: string, model: string, source_id: string): NormalizedUsage {
  return {
    provider: p, date, model, requests: 0, success_requests: 0, failed_requests: 0,
    input_tokens: 0, output_tokens: 0, reasoning_tokens: 0, cached_input_tokens: 0,
    audio_input_tokens: 0, audio_output_tokens: 0, image_count: 0, second_count: 0,
    cost_usd: null, estimated_cost_usd: null, cost_source: 'provider_reported', source_id,
  };
}

/**
 * Sync OpenAI usage + costs for [start,end] (UTC dates).
 * Usage API buckets by UTC day ('date_trunc':'day'). Costs come from the
 * separate /organization/costs endpoint and are MERGED into the same rows
 * (never double-counted: one row per provider/date/model/source).
 */
export async function syncOpenAI(start: string, end: string, projectId?: string | null): Promise<{ rows: number; warnings: string[] }> {
  const { key } = openaiApiKey(process.env.DATA_DIR ?? 'data');
  if (!key) throw new Error('OpenAI API key not configured');
  const warnings: string[] = [];
  const byKey = new Map<string, NormalizedUsage>();

  const projQ = projectId && projectId !== 'all' ? `&project_ids=${encodeURIComponent(projectId)}` : '';
  const biz = settingGet('openai.biz_member') || process.env.OPENAI_BIZ_MEMBER || '';
  const bizQ = biz ? `&business_account=${encodeURIComponent(biz)}` : '';

  // ---- completions usage (tokens/requests by model per day) ----
  for (const endpoint of ['completions', 'chatgpt']) {
    try {
      const url = `/v1/organization/usage/${endpoint}?start_date=${start}&end_date=${end}&bucket_width=1d&group_by[]=model${projQ}${bizQ}`;
      let cursor: string | undefined;
      do {
        const j = await fetchJson(url + (cursor ? `&after=${encodeURIComponent(cursor)}` : ''), key);
        for (const b of j?.data ?? []) {
          const date = String(b.start_time ?? '').slice(0, 10);
          if (!date) continue;
          const models: string[] = b.grouping?.model ?? ['unknown'];
          (b.results ?? []).forEach((r: any, i: number) => {
            const model = models[i] ?? 'unknown';
            const sid = `usage:${endpoint}:${date}:${model}:${projectId ?? 'all'}`;
            const row = byKey.get(sid) ?? blank('openai', date, model, sid);
            row.requests += r.n_requests ?? 0;
            row.success_requests += r.n_success ?? 0;
            row.failed_requests += (r.n_requests ?? 0) - (r.n_success ?? 0);
            row.input_tokens += r.total_tokens?.input ?? 0;
            row.output_tokens += r.total_tokens?.output ?? 0;
            row.reasoning_tokens += r.total_tokens?.output_tokens_details?.reasoning_tokens ?? 0;
            row.cached_input_tokens += r.total_tokens?.input_tokens_details?.cached_tokens ?? 0;
            row.audio_input_tokens += r.total_tokens?.input_tokens_details?.audio_tokens ?? 0;
            row.audio_output_tokens += r.total_tokens?.output_tokens_details?.audio_tokens ?? 0;
            byKey.set(sid, row);
          });
        };
        cursor = j?.has_more && j?.next_page ? j.next_page : undefined;
      } while (cursor);
    } catch (e: any) {
      warnings.push(`usage/${endpoint}: ${e.message}`);
    }
  }

  // ---- embeddings & images usage ----
  for (const [endpoint, field] of [['embeddings', 'input_tokens'], ['images', 'n_images']] as const) {
    try {
      const url = `/v1/organization/usage/${endpoint}?start_date=${start}&end_date=${end}&bucket_width=1d&group_by[]=model${projQ}${bizQ}`;
      const j = await fetchJson(url, key);
      for (const b of j?.data ?? []) {
        const date = String(b.start_time ?? '').slice(0, 10);
        if (!date) continue;
        const models: string[] = b.grouping?.model ?? ['unknown'];
        (b.results ?? []).forEach((r: any, i: number) => {
          const model = models[i] ?? 'unknown';
          const sid = `usage:${endpoint}:${date}:${model}:${projectId ?? 'all'}`;
          const row = byKey.get(sid) ?? blank('openai', date, model, sid);
          row.requests += r.n_requests ?? 0;
          row.success_requests += r.n_success ?? 0;
          if (field === 'input_tokens') row.input_tokens += r[field] ?? 0;
          else row.image_count += r[field] ?? 0;
          byKey.set(sid, row);
        });
      }
    } catch (e: any) {
      warnings.push(`usage/${endpoint}: ${e.message}`);
    }
  }

  // ---- actual billed costs (authoritative $ figures) ----
  try {
    let after: string | undefined;
    do {
      const j = await fetchJson(`/v1/organization/costs?start_date=${start}&end_date=${end}&group_by[]=day&group_by[]=model&limit=100${after ? `&after=${after}` : ''}${bizQ}`, key);
      for (const line of j?.data ?? []) {
        const date = new Date((line.timestamp ?? 0) * 1000).toISOString().slice(0, 10);
        const model = line.grouping?.model ?? 'other';
        const sid = `costs:${date}:${model}:${line.project_name ?? 'default'}`;
        const row = byKey.get(sid) ?? blank('openai', date, model, sid);
        row.cost_usd = (row.cost_usd ?? 0) + (line.cost ?? 0);
        row.cost_source = 'provider_reported';
        byKey.set(sid, row);
      }
      after = j?.has_more && j?.next_page ? j.next_page : undefined;
    } while (after);
  } catch (e: any) {
    warnings.push(`costs: ${e.message}`);
  }

  const rows = [...byKey.values()];
  const n = upsertUsage(rows);
  return { rows: n, warnings };
}

export async function openaiProjects(): Promise<any[]> {
  const { key } = openaiApiKey(process.env.DATA_DIR ?? 'data');
  if (!key) return [];
  try {
    const j = await fetchJson('/v1/organization/projects?limit=50', key);
    return (j?.data ?? []).map((p: any) => ({ id: p.id, name: p.name }));
  } catch {
    return [];
  }
}

/** Connection test used by Settings page. Never returns the key itself. */
export async function testOpenAIKey(keyPlain: string): Promise<{ ok: boolean; message: string; needsAdminHint: boolean }> {
  try {
    await fetchJson('/v1/models?limit=1', keyPlain);
    // Probe usage endpoint to detect non-admin keys early (documented behavior).
    try {
      const today = new Date().toISOString().slice(0, 10);
      await fetchJson(`/v1/organization/usage/completions?start_date=${today}&end_date=${today}&bucket_width=1d`, keyPlain);
      return { ok: true, message: 'Connected. Usage & Costs endpoints reachable.', needsAdminHint: false };
    } catch (e: any) {
      return {
        ok: true,
        message: `Key authenticates, but Usage API probe failed (${e.message}). OpenAI's Usage/Costs endpoints require an admin key or org-scoped access.`,
        needsAdminHint: true,
      };
    }
  } catch (e: any) {
    return { ok: false, message: e.message ?? 'Connection failed', needsAdminHint: false };
  }
}
