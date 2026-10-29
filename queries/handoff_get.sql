-- One handoff. Parameter: its id.
select handoff_id, partyname, from_user, assignee, status, created_at, updated_at, row_json, thread_json
from {handoffs_table}
where handoff_id = ?
