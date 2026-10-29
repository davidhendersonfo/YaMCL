# 🍠 YaMCL

Yet another MCL (tool), a sibling of YaLnT. Say it "yam-cull" (or yam-sicle, nobody's checking).
A local web app for working through the New-to-MCL queue one caller at a time.

## Run it

```bash
cd YaMCL
python -m venv .venv
.venv\Scripts\activate          # Windows  (macOS/Linux: source .venv/bin/activate)
pip install -r requirements.txt
python app.py
```

Open http://127.0.0.1:5050. It runs on port 5050 so it doesn't clash with YALnT on 5555
(set `PORT=xxxx` to change it).

## Keeping everyone up to date (git)

The app lives in a private git repo. David pushes new versions, and everyone else's **StartServer.bat** pulls
them on every start (`git pull --ff-only`), reinstalling packages only when `requirements.txt` changed.
So updating is just restarting the app. Settings → Team shows which version and commit you're running.

What's shared and what isn't:

| In the repo (shared) | Never pushed (`.gitignore`) |
|---|---|
| The app, `queries/`, `config.json` (industries, party types, tables, team list…) | `.local/` (your Databricks sign-in token) |
| `Setup.bat`, `StartServer.bat`, `START HERE.txt`, `VERSION` | `config.local.json` (your personal settings) |
| | `data/` (your queue, edits and publish log), `.venv/` |

**Personal settings** (tagged *just you* in Settings) are saved to `config.local.json`: dry run, auto-publish
and its undo window, whose turn your new tickets start as, offering a ticket when you flag, looking further back and how far,
background preloading, the token file, and whether you maintain the shared settings.

**Shared settings** are read-only in Settings unless you tick **I maintain the shared settings** (Settings → Team).
That stops anyone accidentally editing `config.json`, which would block their next update. When the maintainer
saves a shared change, it's written to `config.json`; commit and push it to share it.

### First-time repo setup (David, once)

1. Unzip the new version over your current folder as usual (`.venv`, `.local` and `data` are kept). The first
   start moves your personal settings into `config.local.json`. If you'd changed shared settings in the app since
   the last zip, keep a copy of your old `config.json` first and copy those bits back in afterwards.
2. Create an empty private repo (no README) in the company GitHub or Azure DevOps, and give Michael read access.
3. In the folder:
   ```bash
   git init -b main
   git add -A
   git status          # check: no .local/, .venv/, data/ or config.local.json in the list
   git commit -m "YaMCL 2026.10.29"
   git remote add origin <the repo's URL>
   git push -u origin main
   ```
4. In the app: Settings → Team → tick **I maintain the shared settings**.

### Pushing an update

Change the files (or unzip a new version over the folder), bump `VERSION` if you like, then
`git add -A && git commit -m "what changed" && git push`. Everyone gets it on their next start.

### Michael's install (once)

1. Install **Git for Windows** (ask IT if it's blocked). It comes with Git Credential Manager, so he signs in to
   GitHub/Azure DevOps once in the browser and pulls just work after that.
2. Clone the repo, e.g. in a Command Prompt: `git clone <the repo's URL> "%USERPROFILE%\Documents\YaMCL"`
   (or use GitHub Desktop's Clone).
3. Optional: copy the `.local` folder from his old install into the new folder to keep his Databricks sign-in.
4. Double-click **Setup.bat** once, then **StartServer.bat** as usual.
5. Settings → Team → **Give new tickets' turn to**: David.

If an update ever says "your local changes would be overwritten", an app file was edited on that computer.
`git status` shows which; `git checkout -- <file>` puts it back (or `git stash` to keep a copy), then restart.

## Databricks

The app connects to Databricks the same way the YALnT server does: `databricks-sql-connector`
with your own OAuth login through the SQL warehouse in `config.json` → `databricks`. The first query
opens a Databricks sign-in page in your browser; the token is then cached in `.local/databricks_oauth.json`
(plain text, so keep `.local/` out of git and shared drives; `.gitignore` already excludes it).
Set `databricks.token_file` to share YALnT's token file instead of signing in separately.

With it connected:

- **Load the queue from Databricks** on the start screen runs the New-to-MCL query directly. No Excel needed.
  Open **Filters** to narrow the pull: industries, name contains, entered by (LNT usernames), how many days
  back, a minimum number of times the name was entered, and the order (most seen first puts the names that
  matter most at the top). **Count matches** shows how many unclaimed names fit before you load anything.
  Your filters are remembered in this browser; each row shows how often and how recently it was entered.
- **Looking further back.** If your filters don't fill the number you asked for within the look-back
  (say Health Care has only 6 unclaimed names in the last 60 days and you asked for 120), the app widens
  the window in steps (90, 120, 180, 270 days, 1 year, …) just far enough to fill the request, up to the
  cap in **Settings → Connections → Loading the queue** (365 days by default; the history goes back to
  September 2015). Names from before your look-back get an **older** tag in the queue and above the name,
  and a message says how far back it went. **Count matches** also shows the counts at each wider window.
  Turn it off in the same place to keep loads strictly inside your look-back. Wider windows mean a bigger
  scan of `v_pnvl_history`, so loads that reach back years take longer.
- Each party name is checked against the MCL and the denied list, and re-checked when you rename it:
  "Already in the MCL as …" (approving would update that entry) or "Denied before".
- **Similar in MCL** searches the MCL table and shows each entry's industry and purposes, with "Use these".
- **Honeypot transcripts** for the number appear in the side panel.

The pill in the top bar shows the connection. Click it to connect. Next to it, the **mode badge** shows how
Publish works right now: **Dry run** (nothing reaches the real MCL), **Batch publish** (approve and deny,
then press Publish) or **Auto-publish** (each approve or deny publishes after the undo window). Click it to
change the mode.

**Check my access** (Settings → Connections) tries a one-row read of every table the app uses and shows
Databricks' own message for any that fail. Databricks reports a missing permission as "table not found",
so a "not found" on a table you know exists means a missing USE CATALOG, USE SCHEMA or SELECT grant. The first query of the day can take a
minute while the warehouse starts. Only the Publish window writes to Databricks (see below).

The SQL lives in `queries/*.sql`, so it's easy to read and tweak. `new_to_mcl.sql` is the notebook's
query with one fix to the generated variations (explained at the top of the file).

## Publishing to the MCL

**Publish to MCL** (top bar, when Databricks is connected) replaces the batch-upload notebook:

1. **Preview** (opens automatically): every approved and denied row that isn't published yet, grouped as
   new MCL entries, updates to existing entries (with exactly what changes), additions to the denied list,
   nothing to do, and problems. Rows with problems are left out: not allowed by the MCL checks,
   an industry missing from the mapping table, a name matching more than one MCL entry, or two rows that
   would merge into the same entry.
2. **Test on a copy of the MCL**: shallow-clones the MCL and denied tables into your schema
   (`analysts.rhenderson.mcl_verifier_sandbox_*`), runs the exact publish SQL against the clones, reads the
   results back and checks them against the preview. The real tables aren't touched.
3. **Publish** (two clicks): refuses if anything changed since the preview, writes the MCL in one atomic
   MERGE, then the denied list, reads everything back to verify, and logs it. Published rows are locked
   in the queue (✓ MCL).

Updates follow the batch notebook: name variations are merged (plus the new name if it differs), the
industry is updated, the existing party types are kept, and modifyDate is set. The SQL is in
`queries/publish_mcl.sql` and `queries/publish_denied.sql`.

**Dry run mode is on by default** (Settings → Publishing). While it's on you can preview and test but not publish.

Every real change is logged to `analysts.rhenderson.mcl_change_log` (who, when, before, after, phone numbers,
notes); the table is created on the first publish. Tests and publishes are also logged locally in
`data/publish_log.jsonl`, which you can view, download or clear in Settings → Publishing.

### Publish when you approve (Settings → Publishing)

With **Publish when I approve or deny** on (and dry run off), every Approve or Deny shows an Undo toast for
10 seconds (adjustable), then publishes that one row in the background. The queue shows *queued*,
*publishing…* and then moves the row to the **Done** tab. A row that fails the checks (unmapped industry,
disallowed party type, etc.) is never written: it bounces back to **Flagged** with the reason on it.
The Publish window stays available for testing on a copy and for anything left over.

## Sharing the queue (claims)

Loading the queue from Databricks claims those names in `analysts.rhenderson.mcl_queue_claims`, so whoever
loads next gets different ones, even if you both click at the same moment (if someone beats you to some names,
the app tops your queue up from what's still free). The top bar shows what others are working
("mmiwamura is working 34"), and the name check warns if you rename something to a name someone else holds.

- Publishing or denying a row marks its claim done.
- **Release** (bottom bar) gives a name back to the pool, e.g. one you want a second opinion on.
- Loading a new queue (or a file) gives back your unfinished names from the previous one.
- While the app is open your claims stay alive; once closed, they expire after 24 idle hours (Settings → Publishing).

### Setting Michael up

1. He installs the app from the repo (see "Michael's install" above) and signs in to Databricks with his own login.
   He gets the same `config.json` table settings automatically.
2. The shared tables are created the first time they're used: load a queue once (claims and ticket tables)
   and publish once (change log). Then grant him access. In a Databricks SQL editor, with his Databricks login in the backticks:

```sql
GRANT USE SCHEMA, CREATE TABLE ON SCHEMA analysts.rhenderson TO `his.login@company.com`;  -- CREATE TABLE is for his test copies
GRANT SELECT, MODIFY ON TABLE analysts.rhenderson.mcl_queue_claims TO `his.login@company.com`;
GRANT SELECT, MODIFY ON TABLE analysts.rhenderson.mcl_change_log TO `his.login@company.com`;
GRANT SELECT, MODIFY ON TABLE analysts.rhenderson.mcl_tickets TO `his.login@company.com`;
GRANT SELECT, MODIFY ON TABLE analysts.rhenderson.mcl_ticket_events TO `his.login@company.com`;
```

He also needs what the batch notebook already needed: write access to the MCL and denied tables, and read
access to `v_pnvl_history` and the industry mapping. Test copies are per person
(`..._sandbox_mcl_rhenderson`, `..._sandbox_mcl_mmiwamura`), so you can both test at once.

### Tickets (working a caller out together)

A caller you're unsure about becomes a **ticket**: its own conversation on a shared **Tickets** board that everyone
on the Team list (Settings → Team) can see, with a log of every change and **whose turn** it is.

- **Making one:** flag a row (`F`) and the "Make it a ticket" box opens (turn this off in Settings → Team), or press
  **Ticket…** / `H`. Pick whose turn it is (your usual person is filled in) and add a note. The row leaves your
  queue (it's under Done with a 🎫 tag), and nobody else can pull that name into a queue while the ticket is open.
- **The board** (Tickets tab): *Your turn*, *Updated* (someone posted on a ticket you've been part of since you last
  looked), *All open* and *Resolved* (the last 60 days; search finds older ones). The tab shows a count, and a
  message pops up when a ticket lands on your plate. It checks every minute.
- **Talking:** post from the board or from the review screen. Each post can pass the turn (back to whoever spoke to
  you last, by default), take it yourself, or leave it where it is ("just a note").
- **Working it:** **Open in review** puts the row in your review screen with the conversation on top, so you have the
  LNT info, honeypot and MCL search. Edit as usual; your changes are logged on the ticket ("Michael changed party
  types: CS, EN, OB → CS, OB") when you post. Only whoever has the turn can change the row; anyone can add notes,
  and **Take the turn** is one click. If someone changes the ticket while you're editing your copy, posting your
  edits is refused and you're offered their version, so nobody silently overwrites anyone.
- **Finishing:** approve or deny it in review (that's noted on the ticket and the turn stays with you), then publish
  as usual: publishing resolves the ticket ("Added to the MCL"). Or, from the board, **Send back to the pool**
  (anyone can pick the name up in a queue load) or **Close, nothing to do**. Those two can be reopened.
- **History:** resolved tickets keep their whole conversation, so "how did we classify that, and why?" is a search away.

Tickets live in `analysts.rhenderson.mcl_tickets` and `mcl_ticket_events` (one row per note, edit or turn change, so
two people posting at once never collide). Both are created automatically. Open handoffs from the old "Ask someone"
become tickets on first use, conversations included.

## MCL editor

The **Review queue | MCL editor** switch in the top bar (with Databricks connected) opens the editor:

- Search the **MCL** or the **Denied list** by name or variation. "Open in editor" links also appear on
  "Already in the MCL" warnings and on published rows.
- Change the name, variations, industry or party types (party types *are* editable here, unlike merges).
  Renaming keeps the old name as a locked variation, same as the queue.
- **Preview changes** shows the before/after and anything that would fail; **Save** needs a reason
  (e.g. "audit challenge, ticket 123") and refuses if someone else changed the entry since you opened it.
- **History** lists the entry's logged changes (publishes and edits, including under an earlier name).
  "Load the version before this" fills the form with the old values so you can save them back.
- **Delete** asks you to type the exact name; **Remove from the denied list** takes two clicks.
  Both are logged with the full entry, so they can be undone.

Dry run mode blocks saving in the editor too.

## Add to MCL

The **Add to MCL** tab (top bar) creates a brand-new entry for a caller that never came through the queue,
the in-app version of the manual-insert notebook:

- Type the party name: name variations are generated with the notebook's rules (lower/UPPER, `&` ↔ `and` as
  whole words) as chips you can remove or add to; "Regenerate from the name" starts over.
- Pick the industry: its default party types are filled in until you change them.
- Optional phone numbers and notes are saved in the change log with the new entry.
- The check runs as you type and blocks the add if the name is already an MCL entry or variation, or differs
  from one only in capitalization; if the industry isn't in the mapping table; or if a party type isn't
  allowed. It warns (without blocking) when the name is on the denied list, someone has it in their queue, or
  a variation already points to another entry. You see the exact row before it's written.
- The insert itself skips the row if the name appeared in the meantime, so a double-click can't duplicate it.

Dry run mode blocks adding too.

## Stats

The **Stats** tab counts what each person has done, from the change log: new MCL entries (from the queue or
Add to MCL), merges into existing entries, denials, editor edits, deletes and un-denials, plus a "callers
handled" total. Pick today, this week, this month or all time; a chart shows the last 14 days per person.
Days are counted in local time (`timezone` in config.json, default America/Chicago). Work done before the app's
first publish isn't in the log, so it isn't counted.

If Stats shows an error, it's Databricks' exact message about reading the change log. "Not found" on a
log that exists means that person is missing a grant on it (see Check my access, and the GRANT lines
under "Setting Michael up").

To pull the same numbers in Databricks yourself:

```sql
select split(changed_by, '@')[0] as person, action, count(*) as n
from analysts.rhenderson.mcl_change_log
where to_date(from_utc_timestamp(logged_at, 'America/Chicago')) >= date_trunc('week', from_utc_timestamp(current_timestamp(), 'America/Chicago'))
group by 1, 2 order by 1, 2;
```

## Name variations

Every spelling of a name is added: the name itself and its "and" ↔ "&" swaps (whole word "and", any case), each
as written, in lowercase and in UPPERCASE. "Hemet USD Wellness & Community Outreach Center" gets
`hemet usd wellness & community outreach center`, `HEMET USD WELLNESS & COMMUNITY OUTREACH CENTER`,
`Hemet USD Wellness and Community Outreach Center`, `hemet usd wellness and community outreach center` and
`HEMET USD WELLNESS AND COMMUNITY OUTREACH CENTER`. Rows from Databricks arrive with all of them, "Add current name
variants" adds them, and a row missing any gets a "Missing … spellings" note with an Add button.

## Workflow

1. Load the queue from Databricks, or paste the results into Excel, save as .xlsx (or .csv) and drop it on the page.
   Rows from Databricks start with your Settings defaults for party types, not the query's guesses.
2. For each row: click a number to call it (RingCentral picks up `tel:` links), use the quick links
   (V opens the number's LNT verification history, LNT caller search, Google), fix the fields, then
   **Approve / Flag / Deny**. Finished rows move to the **Done** tab.
3. Progress saves automatically to `data/session.json`, so you can close the tab or restart and
   pick up where you left off.
4. **Export approved CSV** downloads `New-to-MCL.csv`, ready for the Databricks batch upload notebook.
   **More exports** has: all rows except denied (same CSV), denied only (`New-to-MCL-denied.csv`),
   and a review copy (.xlsx) with every original column, a status column and edited cells highlighted.

The upload CSV has exactly the columns the notebook reads, in order:

```
partyname,industry,partytypes,name_variations
Don Rafa,Automotive,"CS,EN,OB",don rafa|DON RAFA|don rafa car rental|DON RAFA CAR RENTAL|Don Rafa Car Rental
```

Party types are a plain comma list with no spaces (the quotes are standard CSV for a cell containing
commas; Spark removes them when it reads the file). Name variations are pipe-separated, because the
notebook splits that column on `|`. The file is UTF-8 without a BOM so the `partyname` header reads cleanly.

The tool also flags the notebook's own checks before you export: party types outside the allowed
list (`upload_allowed_partytypes`, e.g. PN), and party names of 2 characters or fewer.

## LNT caller panel and the website button (needs the bridge)

The browser won't let a page on 127.0.0.1 read lnt.fosrv.com, so a tiny Tampermonkey
userscript does the request using the LNT login you already have in that browser.

1. Install Tampermonkey (Chrome/Edge extension) if you don't have it.
2. With the app running, open http://127.0.0.1:5050/static/lnt-bridge.user.js.
   Tampermonkey shows an install screen; click Install. (Or use the button in the app's panel.)
3. Reload the app. Be logged in to the LNT in the same browser.
4. The first request may show a Tampermonkey prompt to allow lnt.fosrv.com. Choose "Always allow domain".

For each row, the app opens the number's verification page and follows the caller link in its
history. It prefers the entry whose name matches the partyName, otherwise the newest. If the
history has no caller, it falls back to searching callers by name. The panel shows:

- the caller's website, address, purpose, industry, In MCL and created date
- whether the row's number is on that caller, and whether the LNT name matches the party name
- a warning when the website is a listing site (BBB, Facebook, Yelp…, see `aggregator_domains`)
- the verification history; click any caller in it to load that one instead

Press **W** to open the website. The next row is loaded in the background so it's ready when you
get there. Set `"prefetch_next": false` in config.json to turn that off.

**Similar in MCL** searches the MCL the same way the LNT's caller dropdown does. Click a result to
see its industry and purposes, and "Use these" to copy them onto the row. Edit the search box and
press Enter to search for something shorter (e.g. "boys & girls").

The bridge only makes GET requests to lnt.fosrv.com and only runs on the app's page. It never
submits or changes anything in the LNT. If you installed version 1.0, open the install link again
to update it to the latest version (1.2). Older versions silently fail inside Tampermonkey.

## Keyboard shortcuts

Press `?` in the app for the list. The big ones are `A` approve and next, `F` flag, `D` deny,
`J`/`K` next/previous, `T` call, `V` LNT verification history, and `Esc` to leave a text box.
The editor has no single-key shortcuts, so typing there is always safe.

## Settings (the cog, top right)

Changes apply as soon as you press Save (no restart). Personal settings go to `config.local.json`, shared ones to
`config.json` (only when you maintain the shared settings; the previous version is kept as `config.json.bak`).
See "Keeping everyone up to date" above.

- **Industries:** each industry's default party types (offered with one click when a row doesn't match).
  **Compare with the MCL** shows the most common party types each industry actually has in the MCL, with
  "Use" to adopt them. **Sync industry list from Databricks** pulls the official list from the industry
  mapping table and flags any of yours that aren't on it.
- **Party types:** codes, labels, which are Call Guard blockable (warned) and which the upload allows (others are errors).
- **Checks & export:** export file name, variation separator, listing sites.
- **Connections:** LNT address, background preloading, Databricks workspace, warehouse, token file and table names.
- **Team:** the team list (names and Databricks logins: who you can give a ticket's turn to), whose turn new tickets
  start as, the ticket and claims tables, and the "I maintain the shared settings" switch. Also shows your version.
- **Raw JSON:** everything (shared and personal together), for anything else.
- **Shortcuts:** the keyboard list (also opened with `?`).
