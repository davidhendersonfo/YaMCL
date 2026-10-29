-- Give back every name you still hold (used when you load a new queue).
update {claims_table}
set status = 'released', last_activity = current_timestamp()
where claimed_by = current_user() and status = 'active'
