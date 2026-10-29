-- MCL editor: an entry's change history from the change log, including changes made under an
-- earlier name. Parameters: the party name, twice.
select logged_at, changed_by, action, target_table, partyname, before_json, after_json, reason
from {log_table}
where partyname = ? or get_json_object(before_json, '$.partyname') = ?
order by logged_at desc
limit 50
