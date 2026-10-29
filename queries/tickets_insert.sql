-- Open a ticket. Parameters: id, party name, phone numbers (JSON array), created by, turn, row JSON.
insert into {tickets_table} (ticket_id, partyname, phone_numbers, created_by, created_at, status, turn,
  resolution, resolved_by, resolved_at, updated_by, updated_at, version, row_json)
values (?, ?, from_json(?, 'array<string>'), ?, current_timestamp(), 'open', ?,
  null, null, null, current_user(), current_timestamp(), 1, ?)
