update chat_messages
set room_id = null
where scope = 'lobby' and room_id is not null;

delete from chat_messages
where scope not in ('lobby', 'match')
   or (
     scope = 'match'
     and (
       room_id is null
       or room_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     )
   );

alter table chat_messages
  drop constraint if exists chat_messages_scope_room_check;

alter table chat_messages
  add constraint chat_messages_scope_room_check
  check (
    (scope = 'lobby' and room_id is null)
    or (
      scope = 'match'
      and room_id is not null
      and room_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    )
  );
