create schema if not exists dex;

create table if not exists dex.owner_favorite_entities (
  id bigint generated always as identity primary key,
  entity_key text not null unique,
  entity_name text not null,
  created_at timestamptz not null default now()
);
