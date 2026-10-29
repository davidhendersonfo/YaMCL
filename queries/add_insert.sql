-- Add a new MCL entry by hand (the "Add to MCL" tab). Inserts nothing if the name is already an
-- entry or a variation by the time this runs, so two quick clicks can't create duplicates.
-- Parameters: party name, industry name, industry id, party types (JSON array),
-- name variations (JSON array), then the party name twice more for the duplicate check.
insert into {mcl_table} (partyname, industry_name, industryId, partytypes, name_variations, insertDate, modifyDate)
select ?, ?, ?, from_json(?, 'array<string>'), from_json(?, 'array<string>'), current_date(), null
where not exists (
  select 1 from {mcl_table} t
  where lower(trim(t.partyname)) = lower(trim(?)) or array_contains(t.name_variations, ?)
)
