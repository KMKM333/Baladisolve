-- Manāra — database schema, step 1 of the infrastructure plan.
-- Derived from the data shapes in index.html, so the site can read from here
-- with the same field names it already uses. Run in the Supabase SQL editor.
-- Stage transitions (who may move a request forward, and what must exist
-- first) come in step 2 as functions; here they are only a fixed list.

create extension if not exists pgcrypto;

-- Accounts. Residents need none; the four roles do.
create table if not exists profiles (
  id            uuid primary key references auth.users(id) on delete cascade,
  role          text not null check (role in ('government','experts','sponsors','verifiers')),
  subtype       text,                       -- ministry / districts / municipality / an expert field / a sponsor kind / v-district …
  org_name      text,
  governorates  text[] default '{}',
  fields        text[] default '{}',
  verified_at   timestamptz,                -- identity checked, login handed over
  created_at    timestamptz not null default now()
);

-- The six stages, in order. Fixed on Baladi Map sits outside the ledger.
create table if not exists stages (
  key   text primary key,
  ord   int  not null,
  label text not null
);
insert into stages (key, ord, label) values
  ('reported',1,'Reported'),('certified',2,'Certified'),('signed_off',3,'Signed off & bids'),
  ('funding',4,'Funding'),('in_progress',5,'In progress'),('complete',6,'Complete'),
  ('fixed_on_baladi',0,'Fixed on Baladi Map')
on conflict (key) do nothing;

create table if not exists municipalities (
  name  text primary key,
  gov   text not null,
  lat   double precision,
  lng   double precision
);

create table if not exists requests (
  id              bigint primary key,           -- keeps the site's ids and every published link
  title           text not null,
  type            text not null,
  gov             text not null,
  locality        text,
  size            text,                          -- small / medium / large, null until costed
  goal            numeric,                       -- null until a bracket and a winning bid exist
  raised          numeric not null default 0,
  status          text not null check (status in ('proposed','funding','progress','complete','fixed')),
  urgency         text,
  partner         text,
  org             text,
  corridor        text,
  certifying_body text,
  cert_status     text not null default 'pending' check (cert_status in ('pending','certified')),
  source          text check (source in ('baladi') or source is null),
  source_id       text,                          -- Baladi Map uuid
  source_url      text,
  lat             double precision,
  lng             double precision,
  photo           text,
  description     text,
  timeline_start  text,
  timeline_target text,
  schedule        text,
  schedule_label  text,
  origin_ref      text,                          -- BM-XXXXXXXX
  confirmed       int not null default 0,        -- residents who confirmed on Baladi Map
  beneficiaries   int,
  metrics         jsonb not null default '[]',
  expert_partner  jsonb,                         -- {name, field}
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index if not exists requests_status_idx on requests(status);
create index if not exists requests_gov_idx on requests(gov);
create unique index if not exists requests_source_idx on requests(source, source_id) where source is not null;

-- The custody trail: every event on a request, in order. What the site draws
-- as the ledger. Actor is null for events synced from Baladi Map.
create table if not exists stage_events (
  id          bigserial primary key,
  request_id  bigint not null references requests(id) on delete cascade,
  title       text not null,
  shown_date  text,                              -- as displayed ("9 Aug", "22 Jun 2026")
  meta        text,
  ref         text,
  state       text not null check (state in ('pending','submitted','verified','rejected','remediation','escalated','disputed')),
  actor       uuid references profiles(id),
  at          timestamptz not null default now(),
  ord         int not null default 0
);
create index if not exists stage_events_request_idx on stage_events(request_id, ord);

-- First-line verifiers and their public record.
create table if not exists verifiers (
  id              text primary key,
  kind            text not null,                  -- v-district / v-oea / v-envofficer / v-auditor / v-inspector
  name            text not null,
  org             text not null,
  fields          text[] not null default '{}',
  licence         text not null,
  licence_expiry  date not null,
  govs            text[] not null default '{}',
  locality        text,
  verified        int not null default 0,
  rejected        int not null default 0,
  overturned      int not null default 0,
  median_days     int,
  profile_id      uuid references profiles(id)
);

-- Second line: pseudonymous, appointed from the register.
create table if not exists verifiers_l2 (
  id              text primary key,
  pseudonym       text not null unique,
  appointed       text,
  licence_expiry  date,
  reviewed        int not null default 0,
  confirmed       int not null default 0,
  sent_back       int not null default 0,
  median_days     int,
  profile_id      uuid references profiles(id)   -- never exposed through a policy
);

create table if not exists assignments (
  request_id  bigint primary key references requests(id) on delete cascade,
  verifier_id text references verifiers(id),
  l2_id       text references verifiers_l2(id),
  assigned_at timestamptz not null default now()
);

-- Bids inside the bracket. Bidder is revealed only once chosen (see the view).
create table if not exists bids (
  id            bigserial primary key,
  request_id    bigint not null references requests(id) on delete cascade,
  bidder        uuid references profiles(id),
  bidder_name   text,
  amount        numeric not null,
  quality       numeric,                          -- attribute score /5
  price_score   numeric,                          -- cheapest = 5, others in proportion
  total         numeric,                          -- (quality + price_score) / 2
  chosen        boolean not null default false,
  reason        text,                             -- required when the chosen bid is not the top-ranked
  created_at    timestamptz not null default now()
);

create table if not exists pledges (
  id            bigserial primary key,
  request_id    bigint not null references requests(id) on delete cascade,
  sponsor       uuid references profiles(id),
  sponsor_name  text,
  anonymous     boolean not null default false,
  kind          text,                             -- Organisation / Individual / Municipality / Anonymous
  amount        numeric not null,
  shown_date    text,
  pledged_at    timestamptz not null default now(),
  captured_at   timestamptz,
  refunded_at   timestamptz
);

create table if not exists milestones (
  id            bigserial primary key,
  request_id    bigint not null references requests(id) on delete cascade,
  ord           int not null,
  title         text not null,
  amount        numeric,
  state         text not null default 'pending' check (state in ('pending','submitted','verified','rejected','remediation','escalated','disputed')),
  submitted_at  timestamptz,
  decided_at    timestamptz,
  decided_by    text references verifiers(id),
  note          text
);

create table if not exists evidence (
  id            bigserial primary key,
  milestone_id  bigint not null references milestones(id) on delete cascade,
  kind          text,                             -- photo / receipt / report / log / test …
  url           text,
  note          text,
  added_by      uuid references profiles(id),
  added_at      timestamptz not null default now()
);

-- A change to a published cost or timeline, approved by both lines.
create table if not exists variances (
  id            bigserial primary key,
  request_id    bigint not null references requests(id) on delete cascade,
  milestone_id  bigint references milestones(id),
  pct           numeric,
  reason        text,
  approved_l1   text references verifiers(id),
  approved_l2   text references verifiers_l2(id),
  approved_at   timestamptz not null default now()
);

-- Two chats per request. Verifiers sit in the stakeholder one on purpose.
create table if not exists messages (
  id            bigserial primary key,
  request_id    bigint not null references requests(id) on delete cascade,
  channel       text not null check (channel in ('public','stake')),
  author        uuid references profiles(id),
  author_name   text,
  role          text,
  body          text not null,
  shown_date    text,
  created_at    timestamptz not null default now()
);
create index if not exists messages_request_idx on messages(request_id, channel, created_at);

-- The affected group: confirmed on Baladi Map, or pressed "I've been affected too".
create table if not exists affected (
  request_id  bigint not null references requests(id) on delete cascade,
  member      uuid not null references auth.users(id) on delete cascade,
  joined_at   timestamptz not null default now(),
  primary key (request_id, member)
);

-- Public views hide what the model says must stay hidden.
create or replace view bids_public as
  select id, request_id, amount, quality, price_score, total, chosen, reason, created_at,
         case when chosen then bidder_name else null end as bidder_name
  from bids;

create or replace view pledges_public as
  select id, request_id, amount, kind, shown_date, pledged_at, captured_at, refunded_at, anonymous,
         case when anonymous then 'Anonymous' else sponsor_name end as sponsor_name
  from pledges;

create or replace view verifiers_l2_public as
  select id, pseudonym, appointed, licence_expiry, reviewed, confirmed, sent_back, median_days
  from verifiers_l2;
