-- Publish preview: which denied names are already on the denied list (same rule as the queue query).
-- Parameter: JSON array of party names.
select s.name as lookup_name, t.partyname
from (select explode(from_json(?, 'array<string>')) as name) s
join {denied_table} t
  on lower(trim(t.partyname)) = lower(trim(s.name)) or array_contains(t.name_variations, s.name)
