alter table matches add column if not exists result_key text;

update matches
set result_key = 'legacy:' || id::text
where result_key is null;

alter table matches alter column result_key set not null;

alter table matches
  add constraint matches_result_key_unique unique (result_key);

create table if not exists rating_history (
  id uuid primary key default gen_random_uuid(),
  match_id uuid not null references matches(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  rating_before integer not null,
  rating_after integer not null,
  delta integer not null,
  created_at timestamptz not null default now(),
  unique (match_id, user_id)
);

create index if not exists rating_history_user_created_idx
  on rating_history (user_id, created_at desc);
