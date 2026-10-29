-- Mark some of your claims done (published) or released (given back). Parameters: new status, JSON array of names.
update {claims_table}
set status = ?, last_activity = current_timestamp()
where claimed_by = current_user() and status = 'active'
  and partyname in (select explode(from_json(?, 'array<string>')))
