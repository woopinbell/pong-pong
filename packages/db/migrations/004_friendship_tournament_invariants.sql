delete from friendships
where requester_id = addressee_id;

update friendships as friendship
set
  status = 'accepted',
  updated_at = greatest(friendship.updated_at, reverse_friendship.updated_at)
from friendships as reverse_friendship
where friendship.requester_id = reverse_friendship.addressee_id
  and friendship.addressee_id = reverse_friendship.requester_id
  and friendship.id <> reverse_friendship.id
  and friendship.status = 'pending';

with ranked_friendships as (
  select
    id,
    row_number() over (
      partition by least(requester_id, addressee_id), greatest(requester_id, addressee_id)
      order by case when status = 'accepted' then 0 else 1 end, created_at asc, id asc
    ) as position
  from friendships
)
delete from friendships
where id in (
  select id
  from ranked_friendships
  where position > 1
);

alter table friendships
  drop constraint if exists friendships_requester_id_addressee_id_key;

alter table friendships
  add constraint friendships_distinct_users_check
  check (requester_id <> addressee_id);

create unique index friendships_canonical_pair_unique
  on friendships (
    least(requester_id, addressee_id),
    greatest(requester_id, addressee_id)
  );
