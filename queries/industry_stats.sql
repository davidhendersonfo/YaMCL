-- For the settings window: how many MCL entries use each party-type set, per industry.
select industry_name, array_join(array_sort(partytypes), ',') as pts, count(*) as n
from {mcl_table}
where industry_name is not null
group by industry_name, array_join(array_sort(partytypes), ',')
