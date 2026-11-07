create extension if not exists pgcrypto;
create table hosts(
  id uuid primary key default gen_random_uuid(), slug text unique not null,
  name text not null, email text unique not null, tz text not null default 'UTC', password_hash text, daily_cap int check (daily_cap > 0));
create table event_types(
  id uuid primary key default gen_random_uuid(),
  host_id uuid not null references hosts on delete cascade,
  slug text not null, name text not null,
  duration_min int not null check (duration_min between 15 and 120),
  capacity int not null default 1 check (capacity >= 1),
  buffer_before_min int not null default 0 check (buffer_before_min between 0 and 30),
  buffer_after_min  int not null default 0 check (buffer_after_min  between 0 and 30),
  min_notice_min int not null default 240, horizon_days int not null default 30,
  unique(host_id, slug));
create table availability_rules(   -- weekly windows in HOST local time; many per day allowed
  id uuid primary key default gen_random_uuid(),
  host_id uuid not null references hosts on delete cascade,
  weekday int not null check (weekday between 1 and 7),      -- ISO: 1=Mon
  start_time time not null, end_time time not null, check (end_time > start_time));
create table date_overrides(       -- is_off = day off; otherwise custom hours on that date
  id uuid primary key default gen_random_uuid(),
  host_id uuid not null references hosts on delete cascade,
  on_date date not null, is_off boolean not null default false,
  start_time time, end_time time);
create table bookings(
  id uuid primary key default gen_random_uuid(),
  event_type_id uuid not null references event_types,
  host_id uuid not null references hosts,
  start_at timestamptz not null, end_at timestamptz not null,
  blocked_start timestamptz not null, blocked_end timestamptz not null,  -- slot +/- buffers
  status text not null check (status in ('held','confirmed','cancelled','expired')),
  hold_expires_at timestamptz,
  guest_name text, guest_email text, manage_token text unique, cancel_reason text,
  idempotency_key text unique,
  created_at timestamptz not null default now());
create index on bookings(host_id, blocked_start, blocked_end);
create table notifications(        -- sink: confirmed / rescheduled / cancelled events
  id bigserial primary key, booking_id uuid references bookings,
  kind text not null, payload jsonb not null, created_at timestamptz default now(), delivered_at timestamptz);
