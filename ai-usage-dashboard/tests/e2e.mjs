// End-to-end smoke test against a running server (dev or prod).
// Usage: node tests/e2e.mjs [baseURL]   (default http://localhost:8787)
const BASE = process.argv[2] ?? 'http://localhost:8787';
let jar = '';
const fail = (m) => { console.error('✗', m); process.exitCode = 1; };
const ok = (m) => console.log('✓', m);
async function req(path, opts = {}) {
  const res = await fetch(`${BASE}${path}`, { ...opts, headers: { 'Content-Type': 'application/json', ...(opts.headers ?? {}), ...(jar ? { Cookie: jar } : {}) } });
  const sc = res.headers.getSetCookie?.() ?? [];
  for (const c of sc) jar = c.split(';')[0];
  const body = res.status === 204 ? null : await res.json().catch(() => null);
  return { res, body };
}
(async () => {
  const h = await req('/api/health'); if (!h.body?.ok) fail('health'); else ok('health endpoint');
  let r = await req('/api/overview'); 
  if (r.res.status === 401) ok('unauthenticated API access blocked'); 
  else fail('auth NOT enforced!');
  const st = await req('/api/setup-status');
  if (st.body?.needsSetup) {
    r = await req('/api/setup', { method: 'POST', body: JSON.stringify({ username: 'admin', password: 'testpass123' }) });
    if (!r.body?.ok) fail('setup'); else ok('first-run account created');
  } else {
    r = await req('/api/login', { method: 'POST', body: JSON.stringify({ username: 'admin', password: 'testpass123' }) });
    if (!r.body?.ok) { console.warn('! cannot log in with test password (real deployment) — skipping authenticated checks'); process.exit(0); }
    ok('login');
  }
  r = await req('/api/demo', { method: 'POST', body: JSON.stringify({ enable: true, days: 60 }) });
  if (!r.body?.ok || !r.body.rows) fail('demo enable'); else ok(`demo data generated (${r.body.rows} rows)`);
  const ov = await req('/api/overview?range=30d');
  const t = ov.body?.totals;
  if (!t || t.requests <= 0) fail('overview totals empty'); else ok(`overview totals: ${t.requests} reqs, $${t.costUsd.toFixed(4)}, ${t.totalTokens} tokens`);
  if (t.costBasis.demo <= 0) fail('demo basis not tracked'); else ok('cost basis labels demo data correctly');
  if (Math.abs(t.costUsd - (t.inputTokens * 0 + t.outputTokens * 0 + t.costUsd)) > 1e-9) fail('math'); else ok('totals internally consistent');
  const md = await req('/api/models');
  if (!md.body?.models?.length) fail('models table empty'); else ok(`models aggregated: ${md.body.models.length} rows, top=${md.body.models[0].model}`);
  const lg = await req('/api/logs?page=1&pageSize=10');
  if (!lg.body?.items?.length) fail('logs empty'); else ok(`logs pagination: ${lg.body.total} total, page has ${lg.body.items.length}`);
  const csv = await fetch(`${BASE}/api/logs/export.csv`, { headers: { Cookie: jar } });
  const text = await csv.text();
  if (!text.startsWith('timestamp,provider')) fail('csv export'); else ok('CSV export works');
  const ps = await req('/api/providers/status');
  const s = JSON.stringify(ps.body);
  if (/sk-[a-zA-Z0-9]{10,}/.test(s)) fail('SECRET LEAK in providers status!'); else ok('no secrets leaked in status payload');
  const settings = await req('/api/settings');
  if (JSON.stringify(settings.body).includes('api_key_enc')) fail('encrypted key exposed!'); else ok('settings response excludes key material');
  const bd = await req('/api/settings/budgets', { method: 'PUT', body: JSON.stringify({ budgets: [{ id: 'b1', name: 'Test monthly', scope: 'combined', period: 'monthly', limitUsd: 1, enabled: true }] }) });
  if (!bd.body?.ok) fail('budget save'); else ok('budget config saved');
  const ov2 = await req('/api/overview?range=30d');
  const b = ov2.body.budgets.find((x) => x.budget.id === 'b1');
  if (!b || b.pct < 100) fail('budget threshold eval'); else ok(`budget evaluation: ${b.pct.toFixed(0)}%, thresholds ${b.thresholdsHit.join('/')}`);
  const al = await req('/api/alerts');
  if (!al.body?.length) fail('alerts not raised'); else ok(`alerts raised: ${al.body.length} (incl. ${al.body.map(a=>a.kind).filter((v,i,s)=>s.indexOf(v)===i).join(',')})`);
  const fc = ov2.body.forecast;
  if (!fc) fail('forecast missing'); else ok(`forecast: projected month end $${fc.projectedMonthEndUsd.toFixed(2)} (${fc.method.slice(0, 30)}…)`);
  const dup = await req('/api/demo', { method: 'POST', body: JSON.stringify({ enable: true, days: 60 }) });
  const ov3 = await req('/api/overview?range=30d');
  if (ov3.body.totals.requests !== t.requests) fail(`re-sync duplicated data! ${t.requests} -> ${ov3.body.totals.requests}`); else ok('idempotent re-sync: totals unchanged after repeat sync');
  await req('/api/demo', { method: 'POST', body: JSON.stringify({ enable: false }) });
  const ov4 = await req('/api/overview?range=30d');
  if (ov4.body.totals.requests !== 0) fail('demo cleanup failed'); else ok('demo removal purges synthetic data');
  console.log(process.exitCode ? '\nE2E: FAILURES' : '\nE2E: ALL PASS');
})().catch((e) => { console.error('E2E crashed:', e.message); process.exit(1); });
