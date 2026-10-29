-- One ticket. Parameter: its id.
select ticket_id, partyname, phone_numbers, created_by, created_at, status, turn, resolution, resolved_by,
  resolved_at, updated_by, updated_at, version, row_json
from {tickets_table}
where ticket_id = ?
