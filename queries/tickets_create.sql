-- Tickets: rows the team works out together. `turn` is whose move it is; the conversation and every
-- change live in the events table (append-only, so two people writing at once never collide).
create table if not exists {tickets_table} (
  ticket_id string,
  partyname string,
  phone_numbers array<string>,
  created_by string,
  created_at timestamp,
  status string,        -- open | resolved
  turn string,          -- email of whoever acts next (null once resolved)
  resolution string,    -- added | merged | denied | up to date | released | closed
  resolved_by string,
  resolved_at timestamp,
  updated_by string,
  updated_at timestamp,
  version int,          -- bumped on every change, so edits made from an out-of-date copy are caught
  row_json string       -- the row as currently proposed: {"original": ..., "current": ...}
) comment 'YaMCL tickets'
