-- People who've used the app (for the "Ask someone" list): anyone who has claimed queue names.
select distinct claimed_by as person from {claims_table} where claimed_by != current_user()
