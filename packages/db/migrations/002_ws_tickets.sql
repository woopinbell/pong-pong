create table ws_tickets (
  ticket_hash text primary key check (ticket_hash ~ '^[a-f0-9]{64}$'),
  user_id uuid not null references users(id) on delete cascade,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create index ws_tickets_expires_at_idx on ws_tickets (expires_at);
