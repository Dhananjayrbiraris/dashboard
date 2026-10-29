import { useEffect, useState } from 'react';
import { getSettings, putSettings, setCredential, testCredential, toggleDemo, runSync } from '../api';
import { useApi, Card, ErrorBox, Skeleton } from '../ui';

function KeyManager({ provider, label }: { provider: 'openai' | 'openrouter'; label: string }) {
  const [key, setKey] = useState('');
  const [result, setResult] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const settings = useApi(() => getSettings(), []);
  const isSet = settings.data?.[`${provider}.key_set`] === 'true';

  async function act(fn: () => Promise<any>, done: (r: any) => string) {
    setBusy(true); setResult(null);
    try { setResult(done(await fn())); settings.reload(); }
    catch (e: any) { setResult(`✗ ${e.message}`); }
    finally { setBusy(false); setKey(''); }
  }

  return (
    <div className="rounded-lg border border-slate-200 p-3 dark:border-slate-800">
      <div className="flex items-center justify-between">
        <h4 className="text-sm font-semibold">{label}</h4>
        <span className={`badge ${isSet ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/50 dark:text-emerald-300' : 'bg-slate-200 text-slate-500'}`}>{isSet ? 'connected' : 'not connected'}</span>
      </div>
      <p className="mt-1 text-[11px] text-slate-400">
        Stored encrypted (AES-256-GCM) on the server only. The browser never receives the key — only a masked hint. Rotating = paste new key & save; disconnecting removes it immediately.
        Use a least-privilege key where possible (OpenAI usage/costs endpoints require an admin-level key).
      </p>
      <div className="mt-2 flex flex-wrap gap-2">
        <input className="input w-72 mono" type="password" autoComplete="off" placeholder={isSet ? 'Paste new key to rotate…' : 'sk-… / sk-or-v1-…'} value={key} onChange={(e) => setKey(e.target.value)} />
        <button className="btn-primary" disabled={busy || !key} onClick={() => act(() => setCredential(provider, 'set', key), () => '✓ Key saved (encrypted). Run Sync to verify live access.')}>Save / Rotate</button>
        <button className="btn" disabled={busy} onClick={() => act(() => testCredential(provider, key || undefined), (r) => `${r.ok ? '✓' : '✗'} ${r.message}`)}>Test connection</button>
        {isSet && <button className="btn text-red-600" disabled={busy} onClick={() => act(() => setCredential(provider, 'delete'), () => '✓ Key removed from server.')}>Disconnect</button>}
      </div>
      {result && <div className="mt-2 whitespace-pre-wrap rounded bg-slate-50 p-2 text-xs dark:bg-slate-800">{result}</div>}
    </div>
  );
}

export function SettingsPage() {
  const s = useApi(() => getSettings(), []);
  const [form, setForm] = useState<Record<string, string>>({});
  const [saved, setSaved] = useState<string | null>(null);
  const [demoBusy, setDemoBusy] = useState(false);
  useEffect(() => { if (s.data) setForm(s.data as Record<string, string>); }, [s.data]);

  async function save(patch: Record<string, string>) {
    setSaved(null);
    try { await putSettings(patch); setForm((f) => ({ ...f, ...patch })); setSaved('Saved.'); }
    catch (e: any) { setSaved(`Failed: ${e.message}`); }
  }

  if (s.loading) return <Skeleton h={400} />;
  if (s.error) return <ErrorBox message={s.error} onRetry={s.reload} />;

  return (
    <div className="space-y-4">
      <Card title="Provider credentials">
        <div className="space-y-3">
          <KeyManager provider="openai" label="OpenAI" />
          <KeyManager provider="openrouter" label="OpenRouter" />
          <details className="text-xs text-slate-500"><summary className="cursor-pointer">Environment-variable alternative</summary>
            <p className="mono mt-1">OPENAI_API_KEY, OPENROUTER_API_KEY, MASTER_KEY (encrypts stored keys), ADMIN_USERNAME/ADMIN_PASSWORD (first-run bootstrap), SYNC_INTERVAL_MINUTES, ALERT_WEBHOOK_URL, AUTH_DISABLED=1 (dev only).</p></details>
        </div>
      </Card>

      <Card title="Sync & refresh">
        <div className="grid gap-3 md:grid-cols-2">
          <div><label className="label">Automatic sync interval (minutes, min 5)</label>
            <input type="number" min={5} className="input w-32 tabular-nums" defaultValue={form['sync.interval_minutes'] ?? '60'}
              onBlur={(e) => save({ 'sync.interval_minutes': e.target.value })} /></div>
          <div><label className="label">OpenAI backfill days for first sync</label>
            <input type="number" min={1} max={365} className="input w-32 tabular-nums" defaultValue={form['openai.backfill_days'] ?? '90'}
              onBlur={(e) => save({ 'openai.backfill_days': e.target.value })} /></div>
          <div><label className="label">OpenAI project id (optional — leave blank for all)</label>
            <input className="input w-64 mono" defaultValue={form['openai.project_id'] ?? ''} placeholder="proj_…" onBlur={(e) => save({ 'openai.project_id': e.target.value })} /></div>
          <div><label className="label">OpenAI business account id (if org uses one)</label>
            <input className="input w-64 mono" defaultValue={form['openai.biz_member'] ?? ''} onBlur={(e) => save({ 'openai.biz_member': e.target.value })} /></div>
        </div>
        {saved && <div className="mt-2 text-xs text-emerald-600">{saved}</div>}
      </Card>

      <Card title="Display, budgets & notifications">
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          <div><label className="label">Currency</label>
            <select className="input" defaultValue={form.currency ?? 'USD'} onBlur={(e) => save({ currency: e.target.value })}>
              <option>USD</option><option>EUR</option><option>GBP</option></select>
            <p className="mt-1 text-[11px] text-slate-400">All provider figures are USD-native; display conversion not applied yet.</p></div>
          <div><label className="label">Timezone (display)</label>
            <input className="input w-48" defaultValue={form.timezone ?? 'UTC'} onBlur={(e) => save({ timezone: e.target.value })} />
            <p className="mt-1 text-[11px] text-slate-400">Storage & daily buckets are always UTC (matches provider APIs).</p></div>
          <div><label className="label">Data retention (days, 0 = keep all)</label>
            <input type="number" min={0} className="input w-32 tabular-nums" defaultValue={form['retention.days'] ?? '0'} onBlur={(e) => save({ 'retention.days': e.target.value })} /></div>
          <div><label className="label">Alert email (informational)</label>
            <input className="input w-56" defaultValue={form['alerts.email'] ?? ''} placeholder="you@example.com" onBlur={(e) => save({ 'alerts.email': e.target.value })} />
            <p className="mt-1 text-[11px] text-slate-400">SMTP delivery not implemented in this build — configure a webhook below for real notifications.</p></div>
          <div><label className="label">Alert webhook URL (POST JSON on 90/100% budget, spikes, sync errors, low credits)</label>
            <input className="input w-full mono" defaultValue={form['alerts.webhook_url'] ?? ''} placeholder="https://hooks.example.com/…" onBlur={(e) => save({ 'alerts.webhook_url': e.target.value })} /></div>
        </div>
        <p className="mt-2 text-[11px] text-slate-400">Monthly/provider budgets are managed on the Budgets & Alerts page. Export data via Providers → CSV links or <a className="underline" href="/api/export/usage.csv">usage CSV export</a>.</p>
      </Card>

      <Card title="Demo mode">
        <p className="text-xs text-slate-500 dark:text-slate-400">
          Generates 90 days of clearly-labeled synthetic usage so you can evaluate the UI before connecting providers. Demo rows are tagged <b>cost_source=demo</b>,
          excluded when you disable demo mode, and never mixed with real synced data.
        </p>
        <div className="mt-2 flex gap-2">
          <button className="btn" disabled={demoBusy} onClick={async () => { setDemoBusy(true); await toggleDemo(true); location.reload(); }}>Enable demo data</button>
          <button className="btn" disabled={demoBusy} onClick={async () => { setDemoBusy(true); await toggleDemo(false); location.reload(); }}>Remove demo data</button>
          <button className="btn" disabled={demoBusy} onClick={async () => { setDemoBusy(true); try { await runSync(); } catch {} setDemoBusy(false); alert('Sync triggered — see Providers page for results.'); }}>Trigger full sync now</button>
        </div>
      </Card>
    </div>
  );
}
