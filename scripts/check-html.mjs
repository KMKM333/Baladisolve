#!/usr/bin/env node
// Lightweight pre-commit guard for the single-file Manāra site.
//
// There is no build step here on purpose, so nothing else would ever catch a
// syntax error or a load-order bug before it reached production. This does
// three cheap checks and nothing more:
//
//   1. CSS  — brace balance inside every <style> block.
//   2. JS   — `node --check` on every inline <script> (module or classic).
//   3. JS   — executes each classic inline <script> in a sandbox with stubbed
//             browser globals, to catch load-order bugs that parse fine.
//
// (3) exists because of a real incident: a function called a `const` that had
// not been initialised yet at call time. It parsed cleanly, threw at runtime,
// and halted every script after it — taking the whole site down.
//
// Set SKIP_HTML_CHECK=1 to bypass.

import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';

const file = process.argv[2] ?? 'index.html';
// The hook checks staged content from a temp file; CHECK_LABEL keeps messages readable.
const label = process.env.CHECK_LABEL || file;
const src = readFileSync(file, 'utf8');

let failures = 0;
let warnings = 0;
const fail = (m) => { console.error(`  \x1b[31m✗\x1b[0m ${m}`); failures++; };
const warn = (m) => { console.error(`  \x1b[33m!\x1b[0m ${m}`); warnings++; };
const pass = (m) => console.error(`  \x1b[32m✓\x1b[0m ${m}`);

// Line number of a character offset, 1-based.
const lineAt = (offset) => src.slice(0, offset).split('\n').length;

// ---------------------------------------------------------------- 1. CSS ---
console.error('\nCSS');
{
  const re = /<style\b[^>]*>([\s\S]*?)<\/style>/gi;
  let m, n = 0;
  while ((m = re.exec(src))) {
    n++;
    const startLine = lineAt(m.index);
    // Strip comments and strings so braces inside them do not skew the count.
    const css = m[1]
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/"(?:[^"\\]|\\.)*"/g, '""')
      .replace(/'(?:[^'\\]|\\.)*'/g, "''");
    const open = (css.match(/\{/g) || []).length;
    const close = (css.match(/\}/g) || []).length;
    if (open !== close) {
      fail(`<style> at line ${startLine}: unbalanced braces — ${open} "{" vs ${close} "}" (${open > close ? 'missing' : 'extra'} ${Math.abs(open - close)} closing)`);
    } else {
      pass(`<style> at line ${startLine}: ${open} rule blocks balanced`);
    }
  }
  if (n === 0) warn('no <style> blocks found — is this the right file?');
}

// Collect inline scripts once, reused by checks 2 and 3.
const scripts = [];
{
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(src))) {
    const attrs = m[1];
    if (/\bsrc\s*=/i.test(attrs)) continue;           // external, nothing to check
    const type = (attrs.match(/\btype\s*=\s*["']?([^"'\s>]+)/i) || [])[1] || '';
    if (type && !/^(module|text\/javascript|application\/javascript)$/i.test(type)) continue; // JSON-LD etc.
    const body = m[2];
    if (!body.trim()) continue;
    scripts.push({
      body,
      isModule: /^module$/i.test(type),
      startLine: lineAt(m.index + m[0].indexOf('>') + 1),
    });
  }
}

// ------------------------------------------------------- 2. JS syntax ------
console.error('\nJS syntax');
for (const s of scripts) {
  const lbl = `${s.isModule ? 'module' : 'classic'} <script> at line ${s.startLine}`;
  const tmp = join(tmpdir(), `manara-check-${process.pid}-${s.startLine}.${s.isModule ? 'mjs' : 'cjs'}`);
  // Pad so reported line numbers line up with the HTML file.
  writeFileSync(tmp, '\n'.repeat(s.startLine - 1) + s.body);
  try {
    execFileSync(process.execPath, ['--check', tmp], { stdio: 'pipe' });
    pass(`${lbl}: parses`);
  } catch (e) {
    const out = (e.stderr?.toString() || e.message)
      .split('\n').filter((l) => !l.includes('manara-check-') || l.includes(':')).slice(0, 6).join('\n      ');
    fail(`${lbl}: syntax error\n      ${out.replaceAll(tmp, label)}`);
  } finally {
    try { unlinkSync(tmp); } catch {}
  }
}

// ------------------------------------------------- 3. JS load-order --------
// Executes classic scripts against permissive stubs. Any identifier the code
// touches resolves to a callable, chainable stub, so DOM/Leaflet/D3 calls all
// succeed harmlessly. What a stub cannot fake is a lexical binding used before
// its declaration is initialised — that still throws, which is the point.
console.error('\nJS load order (sandboxed dry run)');
{
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

  for (const s of scripts) {
    if (s.isModule) continue; // top-level await / dynamic import — not sandboxable cheaply
    const lbl = `classic <script> at line ${s.startLine}`;
    const sandbox = new Proxy(Object.create(null), {
      has: () => true,
      get: (t, prop) => {
        if (prop in t) return t[prop];
        if (prop === Symbol.unscopables) return undefined;
        if (typeof globalThis[prop] !== 'undefined' &&
            ['Math','JSON','Date','Object','Array','String','Number','Boolean','RegExp','Error','TypeError',
             'ReferenceError','SyntaxError','Promise','Map','Set','WeakMap','WeakSet','Symbol','Intl',
             'parseInt','parseFloat','isNaN','isFinite','encodeURIComponent','decodeURIComponent',
             'URL','URLSearchParams','TextEncoder','TextDecoder','structuredClone'].includes(prop)) {
          return globalThis[prop];
        }
        return makeStub();
      },
      set: (t, prop, v) => { t[prop] = v; return true; },
    });
    const ctx = vm.createContext(sandbox);
    try {
      new vm.Script('\n'.repeat(s.startLine - 1) + s.body, { filename: label })
        .runInContext(ctx, { timeout: 8000 });
      pass(`${lbl}: runs without throwing`);
    } catch (e) {
      const first = (e.stack || '').split('\n').slice(0, 3).join('\n      ');
      // A ReferenceError here is the bug class this check exists for.
      if (e instanceof ReferenceError || /before initialization|is not defined/.test(e.message || '')) {
        fail(`${lbl}: ${e.message}\n      ${first}\n      \x1b[2mThis is the load-order class of bug that takes the live site down.\x1b[0m`);
      } else if (/Script execution timed out/.test(e.message || '')) {
        warn(`${lbl}: timed out in the sandbox (likely a loop waiting on a stubbed value) — not blocking`);
      } else {
        warn(`${lbl}: threw ${e.name}: ${e.message} — probably a sandbox limitation, not blocking\n      ${first}`);
      }
    }
  }
}

// ------------------------------------------------------------- summary -----
console.error('');
if (failures) {
  console.error(`\x1b[31m${failures} check(s) failed\x1b[0m${warnings ? `, ${warnings} warning(s)` : ''}. Commit aborted.`);
  console.error('Bypass with:  SKIP_HTML_CHECK=1 git commit ...\n');
  process.exit(1);
}
console.error(`\x1b[32mAll checks passed\x1b[0m${warnings ? ` (${warnings} warning(s))` : ''}.\n`);
