-- The names this load actually won. Parameter: the batch id.
select partyname
from {claims_table}
where batch_id = ? and claimed_by = current_user() and status = 'active'
