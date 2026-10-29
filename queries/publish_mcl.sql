-- Publish approved rows to the MCL in ONE statement, so it all lands or none of it does.
-- Behaves like the batch notebook (cells 5-10):
--   * new name      -> insert with insertDate = today, modifyDate = null
--   * existing name -> merge its name variations (plus the new name if it differs), take the new
--                      industry, KEEP the existing party types, set modifyDate = today
-- `target` is the existing MCL partyname the preview matched (null = insert), so this does exactly
-- what the preview showed. Parameter: JSON array of rows.
merge into {mcl_table} t
using (
  select r.target, r.partyname, r.industry_name, m.industry_id as industryId, r.partytypes, r.name_variations
  from (select inline(from_json(?,
          'array<struct<target:string,partyname:string,industry_name:string,partytypes:array<string>,name_variations:array<string>>>'))) r
  join {mapping_table} m on m.industry_name = r.industry_name
) s
on t.partyname = s.target
when matched then update set
  t.industry_name = s.industry_name,
  t.industryId = s.industryId,
  t.name_variations = case
    when s.partyname != t.partyname then array_union(array_union(t.name_variations, s.name_variations), array(s.partyname))
    else array_union(t.name_variations, s.name_variations) end,
  t.modifyDate = current_date()
when not matched then insert (partyname, industry_name, industryId, partytypes, name_variations, insertDate, modifyDate)
  values (s.partyname, s.industry_name, s.industryId, s.partytypes, s.name_variations, current_date(), null)
