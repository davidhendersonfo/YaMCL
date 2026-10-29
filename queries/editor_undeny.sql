-- MCL editor: take a name off the denied list so it can come back through the New-to-MCL queue.
-- Parameter: its exact party name.
delete from {denied_table} where partyname = ?
