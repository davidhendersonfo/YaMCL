-- Rows one person hands to another ("Ask someone" on a flagged row). `assignee` is whoever needs to
-- act next; the note thread and the row as it was handed over travel with it.
create table if not exists {handoffs_table} (
  handoff_id string,
  partyname string,
  from_user string,
  assignee string,
  status string,       -- open | done
  created_at timestamp,
  updated_at timestamp,
  row_json string,
  thread_json string
) comment 'YaMCL handoffs between reviewers'
