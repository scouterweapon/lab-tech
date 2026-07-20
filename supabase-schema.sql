-- Lab Tech shared cloud schema. Run this once in the Supabase SQL Editor
-- (Dashboard -> SQL Editor -> New query -> paste this whole file -> Run).

create table if not exists bets (
  id text primary key,
  placed_at timestamptz not null default now(),
  result text not null default 'pending' check (result in ('pending','win','loss')),
  settled_at timestamptz,
  sport text,
  match text not null,
  market text not null,
  selection text,
  book text,
  odds numeric not null,
  stake numeric not null,
  type text not null default 'single' check (type in ('single','multi','prop')),
  legs jsonb,
  notes text,
  decision text check (decision in ('taking','leaving')),
  decided_at timestamptz,
  auto boolean not null default false
);

create table if not exists app_state (
  id boolean primary key default true check (id),
  starting_bankroll numeric not null default 1000,
  settings jsonb not null default '{}'::jsonb
);
insert into app_state (id) values (true) on conflict do nothing;

alter table bets enable row level security;
alter table app_state enable row level security;

drop policy if exists "public read bets" on bets;
drop policy if exists "public write bets" on bets;
drop policy if exists "public update bets" on bets;
drop policy if exists "public delete bets" on bets;
create policy "public read bets" on bets for select using (true);
create policy "public write bets" on bets for insert with check (true);
create policy "public update bets" on bets for update using (true);
create policy "public delete bets" on bets for delete using (true);

drop policy if exists "public read app_state" on app_state;
drop policy if exists "public update app_state" on app_state;
create policy "public read app_state" on app_state for select using (true);
create policy "public update app_state" on app_state for update using (true);

alter publication supabase_realtime add table bets;
alter publication supabase_realtime add table app_state;

-- RLS policies only apply once the base role has table privileges at all —
-- Supabase doesn't grant these automatically for tables made via SQL editor.
grant usage on schema public to anon, authenticated;
grant select, insert, update, delete on public.bets to anon, authenticated;
grant select, update on public.app_state to anon, authenticated;
