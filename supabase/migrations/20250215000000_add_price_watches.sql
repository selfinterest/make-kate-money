create table if not exists price_watches (
  id bigserial primary key,
  post_id text not null references reddit_posts(post_id) on delete cascade,
  ticker text not null,
  quality_score int not null,
  entry_price numeric not null,
  entry_price_ts timestamptz not null,
  emailed_at timestamptz not null,
  monitor_start_at timestamptz not null,
  monitor_close_at timestamptz not null,
  next_check_at timestamptz,
  last_price numeric,
  last_price_ts timestamptz,
  status text not null default 'pending' check (status in ('pending', 'triggered', 'expired')),
  stop_reason text,
  triggered_at timestamptz,
  triggered_price numeric,
  triggered_move_pct numeric,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists idx_price_watches_post_ticker on price_watches(post_id, ticker);
create index if not exists idx_price_watches_status_next on price_watches(status, next_check_at);
create index if not exists idx_price_watches_next_check on price_watches(next_check_at);

alter table price_watches disable row level security;
