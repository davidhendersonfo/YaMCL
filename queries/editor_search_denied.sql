-- MCL editor: search the denied list. Parameters: %text% (name), %text% (variations).
select partyname, industry, partytypes, name_variations
from {denied_table}
where partyname ilike ? or exists(name_variations, x -> x ilike ?)
order by partyname
limit 25
