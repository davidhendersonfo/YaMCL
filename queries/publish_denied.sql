-- Add denied names to the denied list so the New-to-MCL queue stops showing them.
-- Skips any already there (same matching rule as the queue query). Parameter: JSON array of rows.
insert into {denied_table} (partyname, industry, partytypes, name_variations)
select r.partyname, r.industry, r.partytypes, r.name_variations
from (select inline(from_json(?,
        'array<struct<partyname:string,industry:string,partytypes:array<string>,name_variations:array<string>>>'))) r
where not exists (
  select 1 from {denied_table} d
  where lower(trim(d.partyname)) = lower(trim(r.partyname)) or array_contains(d.name_variations, r.partyname)
)
