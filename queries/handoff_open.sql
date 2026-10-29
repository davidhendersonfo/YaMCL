-- Open handoffs from the old "Ask someone" (moved over to tickets once). No parameters.
select handoff_id, partyname, from_user, assignee, status, created_at, updated_at, row_json, thread_json
from {handoffs_table}
where status = 'open'
