# Manāra — project notes

Context for anyone (or any Claude session) picking this up cold.

## What this is

A civic platform prototype: a **single self-contained HTML file** (`index.html`,
~1.8 MB, ~4,900 lines) with inline `<style>` and inline `<script>`. No build
step, no bundler, no framework, no npm dependencies.

**The single-file design is deliberate.** Do not split it into modules or add a
build pipeline unless explicitly asked. The only external dependencies are CDN
`<script>` tags: Leaflet 1.9.4, D3 7, topojson-client 3, and Motion 13.

- Live: <https://manara-civic-network.netlify.app>
- Repo: <https://github.com/KMKM333/Baladisolve>
- Netlify site ID: `dba26b85-05c1-4f75-b5dd-75cafe230cfa`

## File layout

| Lines (approx.) | Contents |
|---|---|
| 1–9 | `<head>`, meta, fonts |
| 10–594 | One `<style>` block — ~510 rule blocks, the entire stylesheet |
| 595–1428 | `<body>` markup: nav, then 13 `<section class="page">` blocks |
| 1429–1431 | CDN `<script src>` tags (Leaflet, D3, topojson) |
| 1436–1445 | `<script type="module">` — Motion loader **only** |
| 1447–4919 | `<script>` (classic) — the entire application |

Two things here surprise people:

1. **The main application script is a classic `<script>`, not `type="module"`.**
   Only the tiny Motion CDN loader is a module. So the app runs in global scope
   with no module isolation — which is what makes the load-order hazard below
   possible.
2. **Motion is optional by design.** If the CDN fails, the `catch` in the module
   block leaves `window.Motion` undefined and every animation falls back to a
   hand-built CSS/JS path. Both paths are maintained; check `if(window.Motion)`
   branches when touching animation.

## Pages and navigation

13 views, each a `<section class="page" id="view-…">`:

`view-home`, `view-network`, `view-lead-list`, `view-dashboard`, `view-detail`,
`view-municipalities`, `view-map`, `view-corridors`, `view-scoreboard`,
`view-trust`, `view-join`, `view-workflow-demo`, `view-account-demo`.

`switchView(view)` (line ~2624) is the single entry point. It toggles the
`.active` class, animating via Motion when available and falling back to CSS
classes otherwise.

**There is no router.** No `location.hash`, no `pushState` — the URL never
changes. `/` is the only real URL the site has. That is why `netlify.toml`
deliberately has no SPA catch-all redirect: it would only mask real 404s.

One non-obvious detail, documented in a comment at line ~2646: after the
entrance animation the code clears `next.style.transform`, because *any*
transform on a `.page` — even `translateY(0)` — creates a containing block and
silently breaks `position: sticky` for every descendant.

## Key data structures

All top-level `const`s in the classic script:

- `PROJECTS` (~2414) — the core project records.
- `ALL_LEADS` (~1720) — organisations, grouped as Government / Expert
  organisations / Sponsors (see `LEAD_GROUP_ORDER`, `LEAD_GROUP_CLASS`, `LEAD_GROUP_DOT`).
- `COUNTRY_META` (~3974), `GROUP_META` (~3647), `CATEGORY_META` (~3780) — page copy keyed by id.
- `MUNICIPALITIES` (~1570), `DISTRICTS`, `DISTRICT_GOV`, `DISTRICT_FACTS`, `GOVS`, `CITIES`.
- `EXPERT_FIELDS` (~2861) — the eight technical fields experts are matched on.
- Map lookups: `PROJECT_COORDS`, `EXPERT_COORDS`, `MUNI_COORDS`, `GOV_SHAPES`.
  These are kept **separate from** `PROJECTS`/`ALL_LEADS` on purpose (see the
  comment at line ~1448) so adding coordinates can never corrupt tested data.

## Conventions

- `.wrap` — shared page-width container. Use it for consistent gutters.
- `.light-card` (63 uses) — the default card. `.field-card` (9) for expert
  fields, `.proj-card` for project tiles.
- **`renderX()` pattern** — each page has a dedicated render function
  (`renderHome`, `renderGrid`, `renderLeadList`, `renderScoreboard`,
  `renderMuniDirectory`, …26 in total). They rebuild `innerHTML` from the data
  structures above; they are not incremental.
- Event wiring is done inline next to each feature, not centralised.

## The init sequence — and the load-order hazard

At the bottom of the classic script (~4504–4515) is an unindented init run:

```js
renderGrid(true); renderStats(); renderGovJumpChips(); renderCorridors();
// … a function declaration sits in the middle here …
renderScoreboard(); renderCaseStudies(); renderHome(); renderMuniDirectory();
renderCorridorFeatureGrid(); renderWorkflowDemoCard(); renderLeadList('all');
```

**This is the most dangerous part of the file.** These calls execute at parse
time, in order. Function *declarations* hoist, so interleaving them is safe —
but a `const` or `let` does **not** initialise until its line is reached. A
render function called here that reads a `const` declared further down throws
`ReferenceError: Cannot access 'X' before initialization`, and because this is
one classic script, that uncaught error **halts every remaining line** — killing
the rest of the init and taking the whole site down.

This has actually happened: `COUNTRY_META` was referenced before initialisation
in two historical builds (`_79`, `_81`). It parses cleanly and passes casual
review, which is exactly why the automated check below exists.

**Rule of thumb: declare data `const`s above the init sequence, always.**

## Safety check

`scripts/check-html.mjs` runs automatically via a `pre-commit` hook
(`.githooks/pre-commit`, wired with `core.hooksPath`). It does three things:

1. Brace balance in every `<style>` block.
2. `node --check` on every inline `<script>` (module and classic handled correctly).
3. **Load-order dry run** — executes each classic script in a `node:vm` sandbox
   where every browser/library global resolves to a permissive chainable stub.
   DOM and Leaflet/D3 calls succeed harmlessly, but a lexical binding used
   before initialisation still throws, which is precisely the bug class above.

Validated against real history: of all 123 historical builds, it flags exactly
`_79` and `_81` — the two known-broken ones — and passes the other 121.

Zero dependencies; typical run is a couple of seconds.

```bash
node scripts/check-html.mjs index.html    # run manually
SKIP_HTML_CHECK=1 git commit …            # bypass if ever needed
```

Limits, stated honestly: the sandbox only executes the top-level path. Code
inside event handlers and most callbacks never runs, so it will not catch a
load-order bug that only triggers on user interaction. It catches the
init-time class, which is the one that has actually broken production.

### After a fresh clone

`core.hooksPath` is local config and is **not** cloned. Re-arm it with:

```bash
git config core.hooksPath .githooks
```

## Deployment

`netlify.toml` sets `publish = "."` with an empty build command, and marks
`index.html` `must-revalidate` so a stale cache can never survive a deploy.

History worth knowing: for a long time deploys were manual drag-and-drop onto
the Netlify UI, bypassing git entirely, so the repo drifted ~3 days behind
production. The `Baseline: sync repo with live production file.` commit fixed
that. **Do not deploy by drag-and-drop again** — it silently desyncs the repo.
