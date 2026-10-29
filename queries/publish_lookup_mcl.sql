-- Publish preview: every MCL entry each name would match. Same rule the batch notebook uses
-- (case-insensitive name match, or the name is already one of an entry's variations).
-- Parameter: JSON array of party names.
select s.name as lookup_name, t.partyname, t.industry_name, t.industryId, t.partytypes, t.name_variations,
       t.insertDate, t.modifyDate
from (select explode(from_json(?, 'array<string>')) as name) s
join {mcl_table} t
  on lower(trim(t.partyname)) = lower(trim(s.name)) or array_contains(t.name_variations, s.name)
