-- Events for some tickets, oldest first. Parameter: JSON array of ticket ids.
select ticket_id, event_id, at, by_user, kind, text, data_json
from {ticket_events_table}
where ticket_id in (select explode(from_json(?, 'array<string>')))
order by ticket_id, at, event_id
