-- Fallback when a shallow clone isn't possible: a plain copy.
create or replace table {sandbox_table} as select * from {source_table}
