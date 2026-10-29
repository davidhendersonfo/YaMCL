-- New-to-MCL queue: business names from the last 60 days that aren't in the MCL and weren't denied.
-- Same logic as the My-New-To-Mcl notebook, with fixes to the generated name variations:
--   * Each "and" <-> "&" swap is also added in lowercase and UPPERCASE, like the name itself.
--   * The notebook's regexp_replace(partyName, 'and', '&') also replaced "and" INSIDE words
--     ("Highland Ford" -> "Highl& Ford"). This only swaps the whole word "and" (any case).
--   * Its '&' -> ' and ' swap doubled the spaces around a spaced ampersand
--     ("Rahe & Associates" -> "Rahe  and  Associates"). This normalises the spacing,
--     and array_distinct drops the repeat when both swaps give the same result.
-- Table names, the claim expiry, the look-back days and the limit are filled in by the app.
-- The start screen's filters add fixed snippets of SQL with parameters for the values you typed
-- (your text is never pasted into the SQL itself).
select phoneNumbers, createdBys, partyName,
  -- every spelling (the name, its "and" <-> "&" swaps), each as written, lowercase and UPPERCASE
  array_join(filter(array_distinct(flatten(transform(
    array_compact(array(
      partyName,
      case when partyName rlike '(?i)\\band\\b' then regexp_replace(partyName, '(?i)\\band\\b', '&') end,
      case when partyName like '%&%' then trim(regexp_replace(partyName, '\\s*&\\s*',
        case when partyName = upper(partyName) then ' AND ' else ' and ' end)) end,
      case when partyName like '%&%' then replace(partyName, '&',
        case when partyName = upper(partyName) then 'AND' else 'and' end) end
    )),
    v -> array(v, lower(v), upper(v))
  ))), x -> x != partyName), '|') as name_variations,
  array_max(industrys) as industry,
  case
    when array_max(industrys) in ('Agriculture','Legal','Manufacturing','Trade Contractors') then array('OB','CS','DC','SR')
    when array_max(industrys) in ('Automotive','Business Services','Delivery/Shipping','Personal Services','Transportation') then array('CS','EN','OB')
    when array_max(industrys) in ('Education','Health Care','Veterinary Services') then array('DC','EN')
    when array_max(industrys) in ('Government','Public Service','Technology') then array('EN','OB')
    when array_max(industrys) in ('Hospitality/Entertainment') then array('CS','OB','TM')
    when array_max(industrys) in ('Association/Organization','Association/Organizations') then array('OB','TM','SR','PO')
    when array_max(industrys) in ('Insurance','Real Estate') then array('CS','OB','TM')
    when array_max(industrys) in ('Non-Profit','Religious') then array('NP')
    when array_max(industrys) in ('Other Business') then array('CS','EN','OB','PO','SR','TM')
    when array_max(industrys) in ('Prison') then array('PR')
    when array_max(industrys) in ('Restaurant/Food Services','Retail') then array('CS','OB')
    when array_max(industrys) in ('Telecommunications') then array('CS','OB','SR')
    when array_max(industrys) in ('Utilities','Financial') then array('CS','DC','OB','TM')
    else array('???') end as partytypes,
  Notes,
  size(industrys) as entries,
  last_seen
from (
  select collect_set(a.phoneNumber) as phoneNumbers,
    a.partyName, collect_list(a.industryName) as industrys, collect_set(a.createdby) as createdBys, collect_list(a.notes) as Notes,
    max(a.createdtime) as last_seen
  from analysts.research_metrics.v_pnvl_history a
  left anti join {mcl_table} b
    on trim(a.partyname) = trim(b.partyname) or array_contains(b.name_variations, a.partyname)
  left anti join {denied_table} c
    on trim(a.partyname) = trim(c.partyname) or array_contains(c.name_variations, a.partyname)
  left anti join {claims_table} k  -- names someone is already working (claims expire after a while idle)
    on trim(a.partyname) = trim(k.partyname) and k.status = 'active'
       and k.last_activity > current_timestamp() - interval {claim_hours} hours
  left anti join {tickets_table} h  -- names the team is working out on an open ticket
    on trim(a.partyname) = trim(h.partyname) and h.status = 'open'
  where date(createdtime) >= current_date() - interval {days} days
    and createdtime not between '2026-01-09 19:00' and '2026-01-10 03:10'
    and lower(createdBy) not in ('ctauto','fenway','athena','numeracle','cking','cwood','hpautoprocess')
    and a.partyname != 'Scammer'
    {name_filter}
  group by a.partyName
  {having}
)
{industry_filter}
{order_by}
limit {limit}
