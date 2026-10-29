-- MCL editor: save one entry (like the update notebook, but every field is set explicitly).
-- Parameters: new party name, industry name, industry id, party types (JSON array),
-- name variations (JSON array), then the party name being edited.
update {mcl_table}
set partyname = ?,
    industry_name = ?,
    industryId = ?,
    partytypes = from_json(?, 'array<string>'),
    name_variations = from_json(?, 'array<string>'),
    modifyDate = current_date()
where partyname = ?
