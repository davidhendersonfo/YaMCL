-- How many names everyone else is working right now.
select claimed_by, count(*) as n
from {claims_table}
where status = 'active' and claimed_by != current_user()
  and last_activity > current_timestamp() - interval {claim_hours} hours
group by claimed_by
