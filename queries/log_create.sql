-- YaMCL change log: one row per MCL or denied-list change (created on the first real publish).
create table if not exists {log_table} (
  logged_at timestamp,
  run_id string,
  changed_by string,
  action string,
  target_table string,
  partyname string,
  phone_numbers array<string>,
  before_json string,
  after_json string,
  reason string
) comment 'Changes made to the MCL by YaMCL'
