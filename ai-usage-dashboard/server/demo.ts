// Demo mode: generates SYNTHETIC data clearly labeled cost_source='demo'.
// Only active when explicitly enabled; the UI always shows a "DEMO DATA" badge.
// Real sync never overwrites demo rows (different source_id namespace) and
// disabling demo mode deletes all demo rows to avoid mixing them with real data.
import { getDb } from './db.js';
import type { NormalizedUsage } from './openai.js';
import { upsertUsage } from './openai.js';

function mulberry32(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const OPENAI_MODELS = [
  { id: 'gpt-4o', inP: 2.5, outP: 10 },
  { id: 'gpt-4o-mini', inP: 0.075, outP: 0.3 },
  { id: 'gpt-4.1', inP: 2.0, outP: 8.0 },
  { id: 'o3-mini', inP: 1.1, outP: 4.4 },
  { id: 'text-embedding-3-small', inP: 0.02, outP: 0 },
];
const OR_MODELS = [
  { id: 'anthropic/claude-sonnet-4.5', inP: 3.0, outP: 15 },
  { id: 'openai/gpt-5-mini', inP: 0.25, outP: 2.0 },
  { id: 'google/gemini-2.5-flash', inP: 0.3, outP: 2.5 },
  { id: 'deepseek/deepseek-chat-v3', inP: 0.25, outP: 1.0 },
  { id: 'meta-llama/llama-3.3-70b-instruct', inP: 0.18, outP: 0.74 },
];

export function generateDemoData(days = 90): number {
  const db = getDb();
  const rand = mulberry32(42); // deterministic — repeatable regeneration
  const rows: NormalizedUsage[] = [];
  const today = new Date().toISOString().slice(0, 10);
  for (let i = days - 1; i >= 0; i--) {
    const date = new Date(Date.parse(today + 'T00:00:00Z') - i * 86400000).toISOString().slice(0, 10);
    const weekday = new Date(date + 'T00:00:00Z').getUTCDay();
    const scale = (weekday === 0 || weekday === 6 ? 0.4 : 1) * (0.7 + rand() * 0.6) * (1 + (days - i) / days * 0.5);
    for (const [provider, models] of [['openai', OPENAI_MODELS], ['openrouter', OR_MODELS]] as const) {
      for (const m of models) {
        if (rand() < 0.15) continue; // some days skip some models
        const requests = Math.round((5 + rand() * 120) * scale);
        const avgIn = Math.round(400 + rand() * 2600);
        const avgOut = Math.round(150 + rand() * 900);
        const input_tokens = requests * avgIn;
        const output_tokens = provider.includes('embeddings') ? 0 : requests * avgOut;
        const cost_usd = (input_tokens * m.inP + output_tokens * m.outP) / 1e6;
        rows.push({
          provider, date, model: m.id,
          requests, success_requests: Math.max(requests - Math.round(rand() * 3), 0), failed_requests: Math.round(rand() * 3),
          input_tokens, output_tokens, reasoning_tokens: 0, cached_input_tokens: Math.round(input_tokens * rand() * 0.2),
          audio_input_tokens: 0, audio_output_tokens: 0, image_count: 0, second_count: 0,
          cost_usd: Number(cost_usd.toFixed(6)), estimated_cost_usd: null, cost_source: 'demo',
          source_id: `demo:${date}:${m.id}`,
        });
      }
    }
  }
  const n = upsertUsage(rows);

  // A few synthetic request-log rows so the logs page is demonstrable.
  const now = new Date().toISOString();
  const ins = db.prepare(`INSERT OR IGNORE INTO request_logs
    (provider,request_id,timestamp,model,upstream_provider,input_tokens,output_tokens,total_tokens,native_currency,native_amount,cost_usd,latency_ms,status,origin,stream,error_message,synced_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const allModels = [...OPENAI_MODELS.map((m) => ['openai', m]), ...OR_MODELS.map((m) => ['openrouter', m])] as any[];
  for (let i = 0; i < 120; i++) {
    const [prov, m] = allModels[Math.floor(rand() * allModels.length)];
    const ts = new Date(Date.now() - Math.floor(rand() * 7 * 86400000)).toISOString();
    const inp = Math.round(300 + rand() * 3000);
    const outp = Math.round(100 + rand() * 1200);
    const ok = rand() > 0.08;
    ins.run(prov, `demo-gen-${i}-${Math.floor(rand() * 1e9)}`, ts, m.id,
      prov === 'openrouter' ? ['DeepInfra', 'Together', 'Fireworks', 'OpenAI'][Math.floor(rand() * 4)] : null,
      ok ? inp : null, ok ? outp : null, ok ? inp + outp : null,
      prov === 'openrouter' ? 'USD' : null, null,
      ok ? Number(((inp * m.inP + outp * m.outP) / 1e6).toFixed(8)) : null,
      ok ? Math.round(200 + rand() * 4000) : null,
      ok ? 'success' : 'error', 'https://example-app.dev', rand() > 0.5 ? 1 : 0,
      ok ? null : 'Upstream provider returned 429 Too Many Requests', now);
  }
  return n;
}

export function clearDemoData(): void {
  const db = getDb();
  db.prepare(`DELETE FROM usage_daily WHERE cost_source='demo'`).run();
  db.prepare(`DELETE FROM request_logs WHERE request_id LIKE 'demo-gen-%'`).run();
}

export function demoEnabled(): boolean {
  return getDb().prepare(`SELECT 1 AS x FROM usage_daily WHERE cost_source='demo' LIMIT 1`).get() != null;
}
