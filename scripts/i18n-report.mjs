#!/usr/bin/env node
// Lists every translatable string that is missing an Arabic or French translation.
//
// English is the source of truth and lives in the markup. Translations are keyed
// by the English string itself, so editing an English string silently drops it
// back to English rather than showing a stale translation. This script is how you
// see that happen: run it after editing English copy.
//
//   node scripts/i18n-report.mjs
//
// Exits 0 always — it reports, it does not gate commits.

import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const file = process.argv[2] ?? 'index.html';
const src = readFileSync(file, 'utf8');

// Every element the page marks as translatable.
// The browser compares against textContent, which is entity-decoded, so decode
// here too — otherwise "Trust &amp; Values" reads as missing when it is fine.
const decode = (t) => t
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'").replace(/&nbsp;/g, ' ');
const marked = [...src.matchAll(/<[a-z0-9]+\b[^>]*\bdata-i18n\b[^>]*>([\s\S]*?)<\/[a-z0-9]+>/gi)]
  .map(m => decode(m[1].replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim())
  .filter(Boolean);
const strings = [...new Set(marked)];

// Pull the live I18N object out of the page rather than re-parsing it by hand.
const scripts = [...src.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)]
  .filter(m => !/\bsrc\s*=/i.test(m[1]) && !/type\s*=\s*["']?module/i.test(m[1]));
const body = scripts.map(m => m[2]).join('\n');

const stub = (d = 0) => d > 10 ? undefined : new Proxy(function () {}, {
  get(t, p) {
    if (p === Symbol.iterator) return function* () {};
    if (p === Symbol.toPrimitive) return () => 0;
    if (p === 'then') return undefined;
    if (['forEach', 'map', 'filter'].includes(p)) return () => stub(d + 1);
    return stub(d + 1);
  },
  set: () => true, has: () => true, apply: () => stub(d + 1), construct: () => stub(d + 1),
  ownKeys: () => [], getPrototypeOf: () => Object.prototype,
  getOwnPropertyDescriptor: () => ({ configurable: true, enumerable: true, value: undefined }),
});
const seed = Object.create(null);
const PASS = 'Math JSON Date Object Array String Number Boolean RegExp Error Promise Map Set Symbol parseInt parseFloat isNaN decodeURIComponent encodeURIComponent'.split(' ');
const ctx = vm.createContext(new Proxy(seed, {
  has: () => true,
  get: (t, p) => p in t ? t[p] : (PASS.includes(p) ? globalThis[p] : stub()),
  set: (t, p, v) => { t[p] = v; return true; },
}));
try { new vm.Script(body).runInContext(ctx, { timeout: 15000 }); }
catch (e) { console.error('Could not evaluate the page script:', e.message); process.exit(0); }

const I18N = vm.runInContext('typeof I18N !== "undefined" ? I18N : null', ctx);
if (!I18N) { console.error('No I18N object found in', file); process.exit(0); }

const langs = Object.keys(I18N);
console.log(`\n${strings.length} translatable string(s) marked in ${file}\n`);

let totalMissing = 0;
for (const lang of langs) {
  const dict = I18N[lang] || {};
  const missing = strings.filter(str => !dict[str]);
  const done = strings.length - missing.length;
  const pct = strings.length ? Math.round((done / strings.length) * 100) : 100;
  console.log(`${lang.toUpperCase()}  ${done}/${strings.length} (${pct}%)`);
  for (const m of missing) {
    console.log(`   missing: ${JSON.stringify(m.length > 90 ? m.slice(0, 87) + '…' : m)}`);
  }
  // A translation whose English key no longer exists is dead weight.
  const stale = Object.keys(dict).filter(k => !strings.includes(k));
  for (const k of stale) {
    console.log(`   stale (no longer in the page): ${JSON.stringify(k.length > 70 ? k.slice(0, 67) + '…' : k)}`);
  }
  totalMissing += missing.length;
  console.log('');
}
console.log(totalMissing === 0
  ? 'Every marked string is translated.\n'
  : `${totalMissing} translation(s) to fill in.\n`);
