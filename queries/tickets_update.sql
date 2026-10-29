-- Change a ticket, only if nobody else changed it first (version check).
-- Parameters: status, turn, resolution, resolved_by, set resolved_at now (boolean), row JSON (null = keep), id, expected version.
update {tickets_table}
set status = ?, turn = ?, resolution = ?, resolved_by = ?,
    resolved_at = case when ? then current_timestamp() else resolved_at end,
    row_json = coalesce(?, row_json),
    version = version + 1, updated_by = current_user(), updated_at = current_timestamp()
where ticket_id = ? and version = ?
