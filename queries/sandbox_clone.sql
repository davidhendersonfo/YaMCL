-- Test publish: a shallow clone shares the original's data files (instant, no storage cost), and
-- writes to it never touch the original.
create or replace table {sandbox_table} shallow clone {source_table}
