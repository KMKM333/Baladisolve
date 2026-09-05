-- Manāra — row-level security, step 1. Reads are public: the ledger is the
-- product. Writes are narrow, and every write that moves a request between
-- stages is deliberately absent here — those come as functions in step 2, so
-- no page can skip a step. Run after schema.sql.

alter table profiles       enable row level security;
alter table stages         enable row level security;
alter table municipalities enable row level security;
alter table requests       enable row level security;
alter table stage_events   enable row level security;
alter table verifiers      enable row level security;
alter table verifiers_l2   enable row level security;
alter table assignments    enable row level security;
alter table bids           enable row level security;
alter table pledges        enable row level security;
alter table milestones     enable row level security;
alter table evidence       enable row level security;
alter table variances      enable row level security;
alter table messages       enable row level security;
alter table affected       enable row level security;

-- Everyone can read the ledger.
create policy "public read" on stages         for select using (true);
create policy "public read" on municipalities for select using (true);
create policy "public read" on requests       for select using (true);
create policy "public read" on stage_events   for select using (true);
create policy "public read" on verifiers      for select using (true);
create policy "public read" on assignments    for select using (true);
create policy "public read" on milestones     for select using (true);
create policy "public read" on evidence       for select using (true);
create policy "public read" on variances      for select using (true);
create policy "public read" on messages       for select using (channel = 'public');

-- Bids and pledges are read through their public views; the tables themselves
-- are visible only to the row's owner. The second line is never selectable
-- directly — only through verifiers_l2_public, which drops profile_id.
create policy "own bids"    on bids    for select using (auth.uid() = bidder);
create policy "own pledges" on pledges for select using (auth.uid() = sponsor);

-- Profiles: you see and edit your own. Role and verified_at are set by staff.
create policy "own profile read"   on profiles for select using (auth.uid() = id);
create policy "own profile update" on profiles for update using (auth.uid() = id)
  with check (auth.uid() = id and role = (select role from profiles p where p.id = auth.uid())
              and verified_at is not distinct from (select verified_at from profiles p where p.id = auth.uid()));

-- The stakeholder chat: everyone on the request — its government lead, the
-- chosen bidder, its sponsors, its verifiers and the affected group.
create or replace function is_stakeholder(req bigint, who uuid) returns boolean
language sql stable as $$
  select exists (select 1 from affected a where a.request_id = req and a.member = who)
      or exists (select 1 from pledges p where p.request_id = req and p.sponsor = who)
      or exists (select 1 from bids b where b.request_id = req and b.bidder = who and b.chosen)
      or exists (select 1 from assignments s join verifiers v on v.id = s.verifier_id
                  where s.request_id = req and v.profile_id = who)
      or exists (select 1 from assignments s join verifiers_l2 l on l.id = s.l2_id
                  where s.request_id = req and l.profile_id = who)
      or exists (select 1 from profiles pr where pr.id = who and pr.role = 'government' and pr.verified_at is not null);
$$;

create policy "stakeholders read stake chat" on messages for select
  using (channel = 'stake' and is_stakeholder(request_id, auth.uid()));
create policy "post to public chat" on messages for insert to authenticated
  with check (channel = 'public' and author = auth.uid());
create policy "post to stake chat" on messages for insert to authenticated
  with check (channel = 'stake' and author = auth.uid() and is_stakeholder(request_id, auth.uid()));

-- Anyone signed in can join the affected group of a request.
create policy "join affected" on affected for insert to authenticated with check (member = auth.uid());
create policy "see own membership" on affected for select using (member = auth.uid());

-- A verified sponsor can pledge; capture and refund are the custodian's, later.
create policy "sponsors pledge" on pledges for insert to authenticated
  with check (sponsor = auth.uid() and exists (select 1 from profiles p where p.id = auth.uid() and p.role = 'sponsors' and p.verified_at is not null));

-- A verified expert can bid, on a request that is open for bids.
create policy "experts bid" on bids for insert to authenticated
  with check (bidder = auth.uid()
              and exists (select 1 from profiles p where p.id = auth.uid() and p.role = 'experts' and p.verified_at is not null)
              and exists (select 1 from requests r where r.id = request_id and r.cert_status = 'certified' and r.status = 'proposed'));

-- Nothing else is writable from a browser. Certifying, signing off, confirming,
-- choosing a bid, releasing a tranche and approving a variance all wait for
-- the step-2 functions, which check the rules and write the stage_events row.
