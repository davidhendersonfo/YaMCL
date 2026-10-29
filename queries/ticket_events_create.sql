-- One row per thing that happened on a ticket: opened, note, edit, turn, decision, resolved, reopened.
create table if not exists {ticket_events_table} (
  ticket_id string,
  event_id string,      -- sortable within a ticket
  at timestamp,
  by_user string,
  kind string,
  text string,
  data_json string
) comment 'YaMCL ticket conversations and changes'
