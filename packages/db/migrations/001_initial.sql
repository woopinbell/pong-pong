create extension if not exists pgcrypto;

create table if not exists users (
  id uuid primary key default gen_random_uuid(),
  email text unique,
  handle text not null unique,
  display_name text not null,
  avatar_key text not null default 'blue',
  role text not null default 'user',
  status text not null default 'active',
  rating integer not null default 1200,
  wins integer not null default 0,
  losses integer not null default 0,
  created_at timestamptz not null default now(),
  banned_at timestamptz
);

create table if not exists sessions (
  token text primary key,
  user_id uuid not null references users(id) on delete cascade,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create table if not exists friendships (
  id uuid primary key default gen_random_uuid(),
  requester_id uuid not null references users(id) on delete cascade,
  addressee_id uuid not null references users(id) on delete cascade,
  status text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (requester_id, addressee_id)
);

create table if not exists matches (
  id uuid primary key default gen_random_uuid(),
  mode text not null,
  winner_id uuid references users(id),
  loser_id uuid references users(id),
  score_left integer not null,
  score_right integer not null,
  rating_delta integer not null default 16,
  started_at timestamptz not null default now(),
  ended_at timestamptz not null default now()
);

create table if not exists chat_messages (
  id uuid primary key default gen_random_uuid(),
  scope text not null,
  room_id text,
  sender_id uuid not null references users(id) on delete cascade,
  body text not null,
  created_at timestamptz not null default now()
);

create table if not exists tournaments (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  status text not null default 'open',
  created_by uuid not null references users(id),
  winner_id uuid references users(id),
  capacity integer not null default 4,
  created_at timestamptz not null default now()
);

create table if not exists tournament_entries (
  id uuid primary key default gen_random_uuid(),
  tournament_id uuid not null references tournaments(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  seed integer not null,
  created_at timestamptz not null default now(),
  unique (tournament_id, user_id)
);

create table if not exists tournament_matches (
  id uuid primary key default gen_random_uuid(),
  tournament_id uuid not null references tournaments(id) on delete cascade,
  round text not null,
  slot integer not null,
  status text not null default 'ready',
  left_user_id uuid references users(id),
  right_user_id uuid references users(id),
  winner_id uuid references users(id),
  room_id text,
  match_id uuid references matches(id),
  score_left integer,
  score_right integer,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tournament_id, round, slot)
);

create table if not exists admin_actions (
  id uuid primary key default gen_random_uuid(),
  actor_id uuid references users(id),
  target_user_id uuid references users(id),
  action text not null,
  reason text not null,
  created_at timestamptz not null default now()
);

create index if not exists matches_ended_at_idx on matches (ended_at desc);
create index if not exists chat_messages_scope_idx on chat_messages (scope, created_at desc);
create index if not exists tournament_matches_tournament_idx on tournament_matches (tournament_id, round, slot);
