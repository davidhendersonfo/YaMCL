-- Append events. Parameter: JSON array of {ticket_id, event_id, at (null = now), by_user, kind, text, data_json}.
insert into {ticket_events_table} (ticket_id, event_id, at, by_user, kind, text, data_json)
select ticket_id, event_id, coalesce(to_timestamp(at), current_timestamp()), by_user, kind, text, data_json
from (select inline(from_json(?,
  'array<struct<ticket_id:string,event_id:string,at:string,by_user:string,kind:string,text:string,data_json:string>>')))
