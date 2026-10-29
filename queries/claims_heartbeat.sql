-- Keep your claims alive while the app is open; they expire {claim_hours} hours after this stops.
update {claims_table}
set last_activity = current_timestamp()
where claimed_by = current_user() and status = 'active'
