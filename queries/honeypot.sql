-- Honeypot callback transcripts that mention this number (same query as the YALnT server).
-- Parameter: the 10-digit number.
select dt, callTimestamp, honeypotId, aNumber, transcript
from {honeypot_table}
where inTextNumber = ?
order by callTimestamp desc
limit 3
