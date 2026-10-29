-- Who is working which New-to-MCL names, so two people never get the same ones.
-- One row per claim; a name can have many rows over time (only one 'active' at a time).
create table if not exists {claims_table} (
  partyname string,
  phone_numbers array<string>,
  claimed_by string,
  claimed_at timestamp,
  last_activity timestamp,
  status string,      -- active | done | released
  batch_id string
) comment 'YaMCL queue claims'
