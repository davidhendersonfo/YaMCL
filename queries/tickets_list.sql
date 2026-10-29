-- The board: every open ticket, plus resolved ones from the last {resolved_days} days or matching the search.
-- Parameters: search pattern (empty string = no search), the same pattern again.
select ticket_id, partyname, phone_numbers, created_by, created_at, status, turn, resolution, resolved_by,
  resolved_at, updated_by, updated_at, version, row_json
from {tickets_table}
where status = 'open'
   or updated_at > current_timestamp() - interval {resolved_days} days
   or (? != '' and lower(partyname) like ?)
order by updated_at desc
limit 1000
