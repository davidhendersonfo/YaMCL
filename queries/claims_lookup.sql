-- Does someone else hold this name? Parameter: the party name.
select claimed_by, claimed_at
from {claims_table}
where status = 'active' and claimed_by != current_user()
  and last_activity > current_timestamp() - interval {claim_hours} hours
  and lower(trim(partyname)) = lower(trim(?))
limit 1
