#!/usr/bin/env node
// Copies the Baladi Map reports held in index.html into the Supabase `requests`
// table, after scripts/import-baladi.mjs has refreshed the file. The file stays
// the site's fallback and the single place reports are imported; the database
// follows it.
//
//   node scripts/sync-to-supabase.mjs             write (needs SUPABASE_SECRET_KEY)
//   node scripts/sync-to-supabase.mjs --dry-run   read-only plan, uses the public key
//   node scripts/sync-to-supabase.mjs --prune     also remove untouched reports that
//                                                 have left Baladi's feed
//
// Rules:
//  - Only rows with source = 'baladi' are ever touched.
//  - A report still untouched on Manāra (proposed or fixed, not certified) mirrors
//    the file completely.
//  - Once a report has moved on Manāra (certified, funding, in progress, complete)
//    the database owns its state. The sync then refreshes only what Baladi owns:
//    title, text, photo, confirmations, urgency, position.
//  - Without the secret key the script does nothing and exits 0, so the daily
//    workflow keeps working before the secret is added.
import { readSiteData, readSiteConfig, requestRow, eventRows } from './lib/read-site-data.mjs';

const DRY = process.argv.includes('--dry-run');
const PRUNE = process.argv.includes('--prune');
const { url, publishableKey } = readSiteConfig();
const secret = process.env.SUPABASE_SECRET_KEY || '';

if (!url) { console.log('Database sync skipped: no Supabase URL in index.html.'); process.exit(0); }
if (!secret && !DRY) { console.log('Database sync skipped: SUPABASE_SECRET_KEY is not set.'); process.exit(0); }
if (secret && /^sb_publishable_/.test(secret)) { console.error('SUPABASE_SECRET_KEY holds a publishable key; it must be the secret key.'); process.exit(1); }
const key = secret || publishableKey;

async function api(method, path, body, prefer) {
  const res = await fetch(`${url}/rest/v1/${path}`, {
    method,
    headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', ...(prefer ? { Prefer: prefer } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path.split('?')[0]} -> ${res.status} ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}
async function getAll(path) {                       // PostgREST pages at 1000 rows
  const out = [];
  for (let from = 0; ; from += 1000) {
    const page = await api('GET', `${path}${path.includes('?') ? '&' : '?'}limit=1000&offset=${from}`);
    out.push(...page);
    if (page.length < 1000) return out;
  }
}
const stable = (v) => JSON.stringify(v, (k, x) => (x && typeof x === 'object' && !Array.isArray(x))
  ? Object.fromEntries(Object.keys(x).sort().map((kk) => [kk, x[kk]])) : x);
const chunk = (a, n) => a.length ? [a.slice(0, n), ...chunk(a.slice(n), n)] : [];

// What Manāra owns once a report has moved past "reported".
const DB_OWNED = ['status', 'cert_status', 'certifying_body', 'goal', 'raised', 'size', 'partner', 'org', 'corridor',
  'expert_partner', 'timeline_start', 'timeline_target', 'schedule', 'schedule_label'];
const untouched = (r) => (r.status === 'proposed' || r.status === 'fixed') && r.cert_status === 'pending';

const { PROJECTS } = readSiteData();
const fileRows = new Map(PROJECTS.filter((p) => p.source === 'baladi').map((p) => [p.id, { row: requestRow(p), events: eventRows(p) }]));
const dbRows = new Map((await getAll('requests?source=eq.baladi&select=*')).map((r) => [Number(r.id), r]));

const inserts = [], updates = [], replaceEvents = [];
let moved = 0;
for (const [id, f] of fileRows) {
  const d = dbRows.get(id);
  if (!d) { inserts.push(f.row); replaceEvents.push(id); continue; }
  const want = { ...f.row };
  if (!untouched(d)) { moved++; for (const c of DB_OWNED) want[c] = d[c]; }
  const changed = Object.keys(want).filter((c) => stable(want[c]) !== stable(d[c] ?? null) && !(want[c] == null && d[c] == null));
  if (changed.length) updates.push({ row: want, changed });
  if (untouched(d)) replaceEvents.push(id);           // compared below, replaced only if different
}
const left = [...dbRows.values()].filter((d) => !fileRows.has(Number(d.id)));
const prunable = left.filter(untouched);

// Custody trail: only for untouched reports, and only where it differs.
const evIds = replaceEvents.filter((id) => dbRows.has(id));
const dbEvents = new Map();
for (const ids of chunk(evIds, 150)) {
  for (const e of await getAll(`stage_events?request_id=in.(${ids.join(',')})&select=request_id,title,shown_date,meta,ref,state,ord&order=request_id,ord`)) {
    const k = Number(e.request_id); if (!dbEvents.has(k)) dbEvents.set(k, []);
    const { request_id, ...rest } = e; dbEvents.get(k).push(rest);
  }
}
const eventsToWrite = replaceEvents.filter((id) => {
  const want = fileRows.get(id).events.map(({ request_id, ...rest }) => rest);
  return stable(want) !== stable(dbEvents.get(id) || []);
});

console.log(`Database sync${DRY ? ' (dry run, nothing written)' : ''}`);
console.log(`  Baladi reports in the file      ${fileRows.size}`);
console.log(`  Baladi reports in the database  ${dbRows.size}`);
console.log(`  to add                          ${inserts.length}`);
console.log(`  to update                       ${updates.length}`);
console.log(`  custody trails to refresh       ${eventsToWrite.length}`);
console.log(`  moved on Manāra (state kept)    ${moved}`);
console.log(`  left Baladi's feed              ${left.length}  (${prunable.length} untouched${PRUNE ? ', will be removed' : ', kept; run with --prune to remove'})`);
for (const u of updates.slice(0, 5)) console.log(`    ~ ${u.row.id} ${String(u.row.title).slice(0, 40)}: ${u.changed.join(', ')}`);
for (const d of left.slice(0, 12)) console.log(`    - ${d.id} ${String(d.title).slice(0, 50)}${untouched(d) ? '' : '  [moved on Manāra, never removed]'}`);
if (DRY) process.exit(0);

const rows = [...inserts, ...updates.map((u) => u.row)].map((r) => ({ ...r, updated_at: new Date().toISOString() }));
for (const part of chunk(rows, 200)) await api('POST', 'requests?on_conflict=id', part, 'resolution=merge-duplicates,return=minimal');
for (const ids of chunk(eventsToWrite, 150)) {
  await api('DELETE', `stage_events?request_id=in.(${ids.join(',')})`, undefined, 'return=minimal');
  await api('POST', 'stage_events', ids.flatMap((id) => fileRows.get(id).events), 'return=minimal');
}
if (PRUNE && prunable.length) {
  for (const ids of chunk(prunable.map((d) => d.id), 150)) await api('DELETE', `requests?id=in.(${ids.join(',')})&source=eq.baladi&cert_status=eq.pending`, undefined, 'return=minimal');
}
console.log('  written.');
