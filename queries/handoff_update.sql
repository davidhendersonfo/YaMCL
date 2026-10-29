-- Reply / send back / finish. Parameters: assignee, status, row JSON, thread JSON, id.
update {handoffs_table}
set assignee = ?, status = ?, row_json = ?, thread_json = ?, updated_at = current_timestamp()
where handoff_id = ?
