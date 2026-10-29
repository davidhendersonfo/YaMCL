-- Stats tab: new MCL entries, merges and denials per person per day for the last 14 days.
-- Parameters: the time zone, three times.
select to_date(from_utc_timestamp(logged_at, ?)) as day, split(changed_by, '@')[0] as user, count(*) as n
from {log_table}
where action in ('insert', 'merge', 'deny')
  and to_date(from_utc_timestamp(logged_at, ?)) >= date_sub(to_date(from_utc_timestamp(current_timestamp(), ?)), 13)
group by to_date(from_utc_timestamp(logged_at, ?)), split(changed_by, '@')[0]
