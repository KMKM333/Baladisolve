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
(`.githooks/pre-commit`, wired with `core.hooksPath`). It does four things:

1. Brace balance in every `<style>` block.
2. `node --check` on every inline `<script>` (module and classic handled correctly).
3. **Load-order dry run** — executes each classic script in a `node:vm` sandbox
   where every browser/library global resolves to a permissive chainable stub.
   DOM and Leaflet/D3 calls succeed harmlessly, but a lexical binding used
   before initialisation still throws, which is precisely the bug class above.
4. **HTML nesting** — every element closes, and in the right order. Script and
   style bodies are blanked first (JS template strings are full of angle
   brackets that aren't markup), and elements whose end tag is optional in HTML
   close implicitly rather than being reported. This exists because checks 1–3
   all pass on markup that is missing a `</div>`, and moving a block of HTML by
   hand — which happens often in a single-file site — is exactly where that
   lands. Calibrated against all 118 historical builds: zero false positives.

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

## Baladi Map import

The projects with `source:'baladi'` (ids 1001+) are real citizen reports from
Baladi Map, the demand-side partner. They are not hand-written; they are
generated into the block between the two `BALADI IMPORT` markers inside
`PROJECTS` by `scripts/import-baladi.mjs`. **Edit the script, not the block** —
the block is overwritten on every run.

```bash
node scripts/import-baladi.mjs --limit 200 --pages 15   # everything Baladi serves
```

How it works, and the rules it enforces:

- **Dev-time only, output committed.** The script reads two public pages —
  `/en/issues?page=N` (text, photos, dates, governorate) and `/en/map`
  (coordinates) — joins them on id, and writes the block. The live site never
  calls baladimap.com: no CORS, no key, nothing scraping a partner in production.
- **Ids are pinned.** `scripts/baladi-ids.json` maps each Baladi report id to
  its Manāra number for good. Re-running reuses the number; new reports take the
  next free one; numbers are never handed back. A link someone has already been
  given can never start opening a different report.
- **Selection is additive.** Everything imported before is imported again; only
  spare slots are filled from the ranking (photo first, spread across
  categories, most-confirmed first). A smaller `--limit` stops adding, never
  removes.
- **Nothing about the funding side is invented.** Reports come in as
  `proposed`, with `goal:null`, `raised:0`, no partner, no certifying body, no
  verifier. Title, description, severity and confirmation count are the
  reporter's own. Photos are hotlinked from Baladi's public storage, resized via
  its render endpoint (`photoAt()`), and credited. **Generated illustrations are
  never produced for a Baladi report** — `projectImage()` returns before the
  prompt lookup for anything with `source:'baladi'`.
- **It refuses to write bad data.** Zero reports or zero coordinates parsed
  throws (a redesign still returns 200). A sharp drop against what is already
  committed throws too; `--force` overrides when the drop is real.

Where the site's analysis does not apply to a citizen report, it says so rather
than pretending: no verifier is named on an uncertified request (assignment is at
certification, and the verifier signs the request off before it can open for
pledges), reporting communities are excluded from both
leaderboards, `size` is null until something is costed, and the 19 reports
filed without a pin carry a note on their page and do not appear on the live
map. The import prints these flags on every run.

`.github/workflows/sync-baladi.yml` re-runs the import daily at 05:00 UTC and
commits if anything moved; that push is what deploys. It runs
`check-html.mjs` itself, because the pre-commit hook is local git config and
does not exist in CI. Dates are formatted in `Asia/Beirut`, not the runner's
zone — the first automated run committed a one-day date flip and nothing else.

## Verification model (September 2026)

The pipeline a request follows, and where each piece lives in `index.html`:

1. **Reported** — a Baladi import or a municipal filing (`status:'proposed'`).
2. **Certified, verifier assigned** — `verifierFor(p)` picks from `VERIFIERS`
   by the five independence tests, at certification, not at escrow.
3. **Signed off** — the verifier confirms milestones, evidence and a cost
   bracket. `priceCardHTML(p)` shows the bracket, bids and the published
   breakdown; both verifier fees are fixed lines so they cannot grow with
   the project. Demo figures derive from `goal`; a citizen report has none
   and the card says so.
4. **Second-line review** — `VERIFIERS_L2` (pseudonymous, appointed from the
   register) via `verifierL2For(p)`. `signoffRows(p)` synthesises the two
   sign-off rows at the top of every funded request's custody trail so the
   trail can never name a different verifier from the card.
5. **Bids open** — attributes decide who may bid, price decides who wins.
6. **Escrow, milestones, releases** — unchanged. A change to cost or timeline
   is a `Variance approved` ledger row, approved by both verifiers, paid
   from contingency (Halba, id 10, carries the example).

The Trust page's "who checks the verifier" section treats Option C as built
(the second line) and Option B (re-checking releases) as the remaining gap.
The register has a second table, `#vrTableL2`, with agreement rates.

Project pages carry two chats: public (`p.comments`) and stakeholder
(`p.stakeholderChat`, seeded from `STAKEHOLDER_CHAT` for ids 10, 13, 14).
Verifiers are in the stakeholder chat on purpose. The affected-residents
group is seeded from Baladi confirmations rather than a new identity check.

Attribute frameworks in `GROUP_META` carry six conduct metrics marked
`isNew` (two per role; the municipality pair carry `scope`). Recusal Rate
for verifiers was considered and deliberately dropped.

## Deployment

**A push to `main` deploys automatically.** That is the whole workflow — do not
deploy by drag-and-drop again, it silently desyncs the repo from production.

`netlify.toml` sets `publish = "."` with an empty build command, and marks
`index.html` `must-revalidate` so a stale cache cannot survive a deploy.

### How the link is actually wired

Continuous deployment was originally never configured at all: the site's
`build_settings` were empty, which is why every deploy up to 2026-08-31 was a
manual upload. It is now connected using Netlify's **deploy-key** method rather
than the Netlify GitHub App, so `installation_id` is `null` and there is no
OAuth grant involved. Two pieces make it work:

1. A read-only **deploy key** on the GitHub repo (`Netlify — manara-civic-network`),
   paired to the Netlify site via `deploy_key_id`, which is how Netlify clones.
2. A **webhook** on the repo pointing at `https://api.netlify.com/hooks/github`
   (events: `push`, `pull_request`, `delete`), which is what tells Netlify a
   push happened.

If auto-deploy ever stops, check those two first — a deleted webhook is the
most likely cause, and it is silent. You can tell a git-triggered deploy from a
manual upload at a glance: manual ones have no commit ref.

```bash
netlify api listSiteDeploys --data '{"site_id":"dba26b85-05c1-4f75-b5dd-75cafe230cfa"}'
gh api repos/KMKM333/Baladisolve/hooks
```

### Manual deploy (fallback)

The CLI is installed and authenticated, and this directory is linked to the
site, so a manual deploy still works if you ever need to bypass git:

```bash
netlify deploy --prod
```

### After a fresh clone

Two pieces of local state are not carried by the repo:

```bash
git config core.hooksPath .githooks   # re-arm the pre-commit check
netlify link --id dba26b85-05c1-4f75-b5dd-75cafe230cfa
```
