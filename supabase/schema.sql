create schema if not exists dex;

create table if not exists dex.entities (
  id bigint generated always as identity primary key,
  entity_name text not null,
  full_zapper_link text not null unique,
  resolved_label text,
  link_type text not null check (link_type in ('bundle', 'account')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists dex.entity_wallets (
  id bigint generated always as identity primary key,
  entity_id bigint not null references dex.entities(id) on delete cascade,
  wallet_address text not null,
  wallet_index integer not null,
  created_at timestamptz not null default now(),
  unique(entity_id, wallet_address)
);

create table if not exists dex.holding_snapshots (
  id bigint generated always as identity primary key,
  status text not null check (status in ('running', 'success', 'partial', 'failed', 'canceled')),
  zapper_key_label text,
  total_entities integer not null default 0,
  entities_completed integer not null default 0,
  entities_failed integer not null default 0,
  total_rows integer not null default 0,
  error_message text,
  created_at timestamptz not null default now(),
  finished_at timestamptz
);

create table if not exists dex.entity_fetch_runs (
  id bigint generated always as identity primary key,
  snapshot_id bigint not null references dex.holding_snapshots(id) on delete cascade,
  entity_id bigint not null references dex.entities(id) on delete cascade,
  status text not null check (status in ('running', 'success', 'failed', 'canceled')),
  rows_found integer not null default 0,
  total_balance_usd numeric not null default 0,
  error_message text,
  started_at timestamptz not null,
  finished_at timestamptz
);

create table if not exists dex.raw_holdings (
  id bigint generated always as identity primary key,
  snapshot_id bigint not null references dex.holding_snapshots(id) on delete cascade,
  entity_id bigint not null references dex.entities(id) on delete cascade,
  token_key text not null,
  token_symbol text not null,
  token_name text not null,
  token_address text,
  network_name text not null,
  chain_id bigint,
  balance text not null,
  balance_raw text not null,
  balance_usd numeric not null,
  price numeric,
  market_cap numeric,
  liquidity_usd numeric,
  volume_24h numeric,
  txns_24h numeric,
  token_age_hours numeric,
  moni_score numeric,
  moni_level integer,
  moni_level_name text,
  moni_momentum_score_pct numeric,
  moni_momentum_rank integer,
  fetched_at timestamptz not null
);

create table if not exists dex.token_blacklist (
  id bigint generated always as identity primary key,
  token_key text not null unique,
  token_symbol text not null,
  token_name text not null,
  network_name text not null,
  chain_id bigint,
  token_address text,
  reason text,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_entity_wallets_entity on dex.entity_wallets(entity_id, wallet_index);
create index if not exists idx_raw_holdings_snapshot on dex.raw_holdings(snapshot_id, token_key, balance_usd desc);
create index if not exists idx_raw_holdings_token_lookup on dex.raw_holdings(snapshot_id, token_key, entity_id);
create index if not exists idx_snapshot_created on dex.holding_snapshots(created_at desc, id desc);
