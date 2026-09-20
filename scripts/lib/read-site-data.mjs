// Reads the data built into index.html by running the site's classic script in
// a sandbox, the same trick scripts/check-html.mjs uses, so the arrays come from
// the source of truth rather than being re-typed. Shared by export-seed.mjs and
// sync-to-supabase.mjs.
import fs from 'node:fs';
import vm from 'node:vm';

export function readSiteData() {
  const html = fs.readFileSync(new URL('../../index.html', import.meta.url), 'utf8');
  const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)([^>]*)>([\s\S]*?)<\/script>/g)]
    .filter((m) => !/type\s*=\s*["']module["']/.test(m[1]))
    .map((m) => m[2]);
  const main = scripts.find((b) => /const PROJECTS\s*=/.test(b));
  if (!main) throw new Error('main script not found');

    const makeStub = (depth = 0) => {
      if (depth > 12) return undefined; // guard against unbounded chains
      const target = function () {};
      return new Proxy(target, {
        get(t, prop) {
          if (prop === Symbol.iterator) return function* () {};
          if (prop === Symbol.toPrimitive) return () => 0;
          if (prop === Symbol.asyncIterator) return undefined;
          if (prop === 'then') return undefined;        // never look thenable
          if (prop === 'length') return 0;
          if (prop === 'nodeType') return 1;
          if (prop === Symbol.toStringTag) return 'Stub';
          if (prop === 'constructor') return Object;
          // Array-ish helpers: run the callback once for a little more reach.
          if (['forEach', 'map', 'filter', 'find', 'some', 'every', 'flatMap'].includes(prop)) {
            return (cb) => { if (typeof cb === 'function') cb(makeStub(depth + 1), 0, makeStub(depth + 1)); return makeStub(depth + 1); };
          }
          return makeStub(depth + 1);
        },
        set: () => true,
        has: () => true,                                 // unknown globals resolve
        deleteProperty: () => true,
        apply: () => makeStub(depth + 1),
        construct: () => makeStub(depth + 1),
        getPrototypeOf: () => Object.prototype,
        getOwnPropertyDescriptor: () => ({ configurable: true, enumerable: true, value: undefined }),
        ownKeys: () => [],
      });
    };

  let captured = null;
  const target = Object.create(null);
  target.__EXPORT = (o) => { captured = o; };
  const sandbox = new Proxy(target, {
    has: () => true,
    get: (t, prop) => {
      if (prop in t) return t[prop];
      if (prop === Symbol.unscopables) return undefined;
      if (typeof globalThis[prop] !== 'undefined' &&
          ['Math','JSON','Date','Object','Array','String','Number','Boolean','RegExp','Error','TypeError',
           'ReferenceError','SyntaxError','Promise','Map','Set','WeakMap','WeakSet','Symbol','Intl',
           'parseInt','parseFloat','isNaN','isFinite','encodeURIComponent','decodeURIComponent',
           'URL','URLSearchParams','TextEncoder','TextDecoder','structuredClone'].includes(prop)) return globalThis[prop];
      return makeStub();
    },
    set: (t, prop, v) => { t[prop] = v; return true; },
  });
  const ctx = vm.createContext(sandbox);
  new vm.Script(main + '\n;__EXPORT({PROJECTS, VERIFIERS, VERIFIERS_L2, MUNICIPALITIES, MUNI_COORDS, STAKEHOLDER_CHAT});', { filename: 'index.html' })
    .runInContext(ctx, { timeout: 20000 });
  if (!captured) throw new Error('export hook did not run');
  return captured;
}

// The public Supabase settings the site itself uses (url + publishable key).
export function readSiteConfig() {
  const html = fs.readFileSync(new URL('../../index.html', import.meta.url), 'utf8');
  const m = html.match(/window\.MANARA_SUPABASE = \{ url: '([^']*)', anonKey: '([^']*)' \};/);
  return m ? { url: m[1], publishableKey: m[2] } : { url: '', publishableKey: '' };
}

// One request as a database row. Column mapping matches export-seed.mjs.
export function requestRow(p) {
  const num = (v) => (v == null || v === '' || Number.isNaN(Number(v))) ? null : Number(v);
  return {
    id: p.id, title: p.title, type: p.type, gov: p.gov, locality: p.locality ?? null, size: p.size ?? null,
    goal: num(p.goal), raised: num(p.raised || 0) ?? 0, status: p.status, urgency: p.urgency ?? null,
    partner: p.partner ?? null, org: p.org ?? null, corridor: p.corridor ?? null,
    certifying_body: p.certifyingBody ?? null, cert_status: p.certStatus || 'pending',
    source: p.source || null, source_id: p.sourceId || null, source_url: p.sourceUrl || null,
    lat: num(p.coords && p.coords[0]), lng: num(p.coords && p.coords[1]), photo: p.photo || null,
    description: p.desc ?? null,
    timeline_start: (p.timeline && p.timeline.start) ?? null, timeline_target: (p.timeline && p.timeline.target) ?? null,
    schedule: (p.timeline && p.timeline.schedule) ?? null, schedule_label: (p.timeline && p.timeline.scheduleLabel) ?? null,
    origin_ref: (p.originReport && p.originReport.ref) ?? null, confirmed: num(p.originReport ? p.originReport.confirmed : 0) ?? 0,
    beneficiaries: num(p.beneficiaries), metrics: p.metrics || [], expert_partner: p.expertPartner || null,
  };
}
export function eventRows(p) {
  return (p.ledger || []).map((l, i) => ({
    request_id: p.id, title: l.t, shown_date: l.d ?? null, meta: l.meta ?? null, ref: l.ref ?? null, state: l.state, ord: i,
  }));
}
