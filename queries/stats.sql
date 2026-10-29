-- Stats tab: changes per person and kind, since the start of the chosen period.
-- Days are counted in the local time zone (Settings → raw JSON "timezone"), not UTC.
-- Parameters: the time zone, twice.
select split(changed_by, '@')[0] as user, action, count(*) as n
from {log_table}
where to_date(from_utc_timestamp(logged_at, ?)) >= {since}
group by split(changed_by, '@')[0], action
