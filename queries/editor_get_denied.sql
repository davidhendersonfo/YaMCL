-- MCL editor: one denied-list entry by its exact party name. Parameter: the party name.
select partyname, industry, partytypes, name_variations
from {denied_table}
where partyname = ?
