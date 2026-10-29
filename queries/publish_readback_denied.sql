-- After a publish (or test): read the denied entries back to verify them. Parameter: JSON array of names.
select partyname, industry, partytypes, name_variations
from {denied_table}
where partyname in (select explode(from_json(?, 'array<string>')))
