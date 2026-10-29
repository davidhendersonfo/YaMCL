-- Start a handoff. Parameters: id, party name, assignee, row JSON, thread JSON.
insert into {handoffs_table} (handoff_id, partyname, from_user, assignee, status, created_at, updated_at, row_json, thread_json)
values (?, ?, current_user(), ?, 'open', current_timestamp(), current_timestamp(), ?, ?)
