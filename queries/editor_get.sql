-- MCL editor: one entry by its exact party name. Parameter: the party name.
select partyname, industry_name, industryId, partytypes, name_variations, insertDate, modifyDate
from {mcl_table}
where partyname = ?
