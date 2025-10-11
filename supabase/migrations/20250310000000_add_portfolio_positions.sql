create extension if not exists pgcrypto;

create table if not exists portfolio_positions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  ticker text not null,
  shares numeric not null check (shares >= 0),
  watch boolean not null default false,
  last_price numeric,
  last_price_ts timestamptz,
  last_price_source text,
  alert_threshold_pct numeric not null default 0.05,
  last_alert_at timestamptz,
  last_alert_price numeric,
  last_alert_move_pct numeric,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, ticker)
);

create index if not exists idx_portfolio_positions_user on portfolio_positions(user_id);
create index if not exists idx_portfolio_positions_watch on portfolio_positions(watch);

create or replace function public.apply_portfolio_position_defaults()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  requester_role text := coalesce((auth.jwt() ->> 'role'), '');
begin
  new.ticker := upper(new.ticker);
  new.updated_at := now();

  if requester_role is distinct from 'service_role' then
    if tg_op = 'INSERT' then
      new.user_id := coalesce(auth.uid(), new.user_id);
      new.last_price := null;
      new.last_price_ts := null;
      new.last_price_source := null;
      new.last_alert_at := null;
      new.last_alert_price := null;
      new.last_alert_move_pct := null;
    elsif tg_op = 'UPDATE' then
      new.user_id := old.user_id;
      new.last_price := old.last_price;
      new.last_price_ts := old.last_price_ts;
      new.last_price_source := old.last_price_source;
      new.last_alert_at := old.last_alert_at;
      new.last_alert_price := old.last_alert_price;
      new.last_alert_move_pct := old.last_alert_move_pct;
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists trg_portfolio_positions_defaults on portfolio_positions;

create trigger trg_portfolio_positions_defaults
before insert or update on portfolio_positions
for each row
when (new.ticker is not null)
execute function public.apply_portfolio_position_defaults();

alter table portfolio_positions enable row level security;

create policy "Users can view own positions"
  on portfolio_positions
  for select
  using (auth.uid() = user_id);

create policy "Users can insert own positions"
  on portfolio_positions
  for insert
  with check (auth.uid() = coalesce(user_id, auth.uid()));

create policy "Users can update own positions"
  on portfolio_positions
  for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "Users can delete own positions"
  on portfolio_positions
  for delete
  using (auth.uid() = user_id);
