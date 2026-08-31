# Manāra

Civic platform for Lebanon: certified municipal requests are matched to expert
organisations and funded by sponsors, with pledges held in escrow and released
only after independent verification.

**Read `PROJECT_NOTES.md` before touching anything.** It covers the file layout,
the 13 views, the data structures, the naming conventions, the load-order
hazard, and how deployment is wired. Don't rediscover that from the code.

## Hard constraints

- One self-contained `index.html` (~1.8MB), no build step, no bundler, no
  framework, no npm dependencies. This is deliberate — don't split it into
  modules or add tooling unless asked.
- External code is CDN `<script>` tags only: Leaflet, D3, topojson, Motion.
- Motion is optional by design. If its CDN fails, every animation falls back to
  a hand-built CSS path. Maintain both branches when touching animation.

## The one bug that keeps biting

The main application script is a **classic `<script>`, not a module**, so it all
shares one scope and one uncaught error kills everything after it. The init
sequence at the bottom runs at parse time: a render function called there that
reads a `const` declared further down throws `Cannot access X before
initialization` and takes the whole site down. It has happened twice.

**Declare data `const`s above the init sequence.** Always.

## Before you commit

`.githooks/pre-commit` runs `scripts/check-html.mjs` automatically: CSS brace
balance, `node --check` per inline script, and a sandboxed dry run that catches
the load-order bug above. After a fresh clone, re-arm it:

```bash
git config core.hooksPath .githooks
```

## Deploying

A push to `main` deploys automatically, live in about 15–20 seconds. **Never
deploy by drag-and-drop onto the Netlify UI** — that is what left the repo three
days behind production before.

## Working style

- One distinct change per commit, so any single one can be reverted alone.
  Give the user the SHA.
- English is the source language. The user edits English only; Arabic and French
  are topped up afterwards with `node scripts/i18n-report.mjs`.
