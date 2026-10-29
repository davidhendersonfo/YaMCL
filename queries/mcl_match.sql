-- Is this name already in the MCL? Same rule the batch notebook uses to decide insert vs update.
-- Parameters: the party name, twice.
select partyname, industry_name, partytypes, name_variations, insertDate, modifyDate
from {mcl_table}
where lower(trim(partyname)) = lower(trim(?))
   or array_contains(name_variations, ?)
limit 5
