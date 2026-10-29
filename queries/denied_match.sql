-- Was this name denied before? Same rule the queue query uses to filter denials out.
-- Parameters: the party name, twice.
select partyname
from {denied_table}
where lower(trim(partyname)) = lower(trim(?))
   or array_contains(name_variations, ?)
limit 5
