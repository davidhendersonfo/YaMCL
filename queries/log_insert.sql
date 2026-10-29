-- One log row per change. changed_by is whoever is signed in to Databricks. Parameter: JSON array of entries.
insert into {log_table}
select current_timestamp(), r.run_id, current_user(), r.action, r.target_table, r.partyname,
       r.phone_numbers, r.before_json, r.after_json, r.reason
from (select inline(from_json(?,
        'array<struct<run_id:string,action:string,target_table:string,partyname:string,phone_numbers:array<string>,before_json:string,after_json:string,reason:string>>'))) r
