-- For the settings window: the official industry list the batch notebook joins against.
select industry_name, industry_id
from {mapping_table}
order by industry_name
