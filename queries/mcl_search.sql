-- "Similar in MCL": names or variations containing the search text, closest matches first.
-- Parameters: %text% (name), %text% (variations), text (exact), text% (starts with).
select partyname, industry_name, partytypes, name_variations
from {mcl_table}
where partyname ilike ? or exists(name_variations, x -> x ilike ?)
order by
  case when lower(partyname) = lower(?) then 0
       when partyname ilike ? then 1
       else 2 end,
  partyname
limit 25
