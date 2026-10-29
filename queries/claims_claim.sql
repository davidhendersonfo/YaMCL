-- Claim names for one queue load. Only inserts names nobody holds an active, unexpired claim on,
-- so if two people load at the same moment each name goes to exactly one of them (Delta rejects one
-- of two simultaneous MERGEs and the app retries it against the updated table).
-- Parameters: JSON array of {partyname, phone_numbers}, then the batch id.
merge into {claims_table} k
using (select inline(from_json(?, 'array<struct<partyname:string,phone_numbers:array<string>>>'))) s
on trim(k.partyname) = trim(s.partyname)
   and k.status = 'active'
   and k.last_activity > current_timestamp() - interval {claim_hours} hours
when not matched then insert (partyname, phone_numbers, claimed_by, claimed_at, last_activity, status, batch_id)
  values (s.partyname, s.phone_numbers, current_user(), current_timestamp(), current_timestamp(), 'active', ?)
