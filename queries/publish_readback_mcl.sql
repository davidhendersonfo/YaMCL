-- After a publish (or test): read the affected MCL entries back to verify them.
-- Parameter: JSON array of party names.
select partyname, industry_name, industryId, partytypes, name_variations, insertDate, modifyDate
from {mcl_table}
where partyname in (select explode(from_json(?, 'array<string>')))
