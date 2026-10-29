// Settings window. Works on a draft; nothing is written until Save. The server splits what you save:
// personal settings go to config.local.json (this computer only), shared ones to config.json (the team's repo).
// Uses helpers from app.js ($, esc, api, toast, dbFetch, dbOn, S, ...), which loads first.

(function () {
'use strict';

const SET = { tab: 'industries', lastTab: 'industries', draft: null, saved: '', stats: null, statsState: '', syncNote: '', jsonError: '',
  meta: { personal: [] } };
const clone = o => JSON.parse(JSON.stringify(o));
const setDirty = () => SET.draft && JSON.stringify(SET.draft) !== SET.saved;

// ------------------------------------------------------------------ open / close / save

async function openSettings(tab) {
  try {
    const cfg = takeMeta(await api('/api/config'));
    SET.draft = clone(cfg);
    SET.saved = JSON.stringify(cfg);
  } catch (e) {
    return toast(`Couldn't load settings: ${e.message}`, 'error');
  }
  const m = SET.meta;
  $('#settings-version').textContent = m.version || m.commit ? `version ${m.version || ''}${m.commit ? ` · ${m.commit}` : ''}` : '';
  SET.jsonError = '';
  SET.syncNote = '';
  $('#settings').hidden = false;
  showTab(tab || SET.lastTab); // the cog reopens the last settings tab; ? jumps to shortcuts
  updateFoot();
}

function closeSettings(force = false) {
  if (!force && setDirty()) {
    updateFoot('You have unsaved changes. Save them, or discard them to close.', 'warn');
    $('#set-foot').classList.remove('nudge');
    void $('#set-foot').offsetWidth; // restart the animation
    $('#set-foot').classList.add('nudge');
    return;
  }
  $('#settings').hidden = true;
}

async function saveSettings() {
  if (SET.jsonError) return updateFoot('Fix the JSON before saving.', 'error');
  const before = JSON.parse(SET.saved || '{}');
  try {
    const cfg = takeMeta(await api('/api/config', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(SET.draft),
    }));
    const sharedChanged = cfg.shared_changed;
    delete cfg.shared_changed;
    SET.draft = clone(cfg);
    SET.saved = JSON.stringify(cfg);
    S.cfg = cfg;
    renderModeBadge();
    if (JSON.stringify(before.databricks) !== JSON.stringify(cfg.databricks)) {
      Object.assign(S, { dbMatch: {}, mcl: {}, mclTerm: {}, mclInfo: {}, hp: {} });
      SET.stats = null;
      await refreshDbStatus();
    }
    if (JSON.stringify(before.lnt_base) !== JSON.stringify(cfg.lnt_base)) Object.assign(S, { lnt: {}, lntInflight: {} });
    if (cur() && !$('#work-view').hidden) { renderEntity(); renderProgress(); }
    renderTab();
    if (sharedChanged) {
      updateFoot('Saved. Shared settings changed: commit and push config.json so the team gets them.', 'ok');
      toast('Saved. Commit and push config.json to share the change.', 'ok');
    } else {
      updateFoot('Saved.', 'ok');
      toast('Settings saved', 'ok');
    }
  } catch (e) {
    updateFoot(e.message, 'error');
  }
}

function updateFoot(msg, kind) {
  const dirty = setDirty();
  $('[data-set="save"]').disabled = !dirty || !!SET.jsonError;
  $('[data-set="discard"]').hidden = !dirty;
  const el = $('#set-msg');
  if (msg !== undefined) {
    el.textContent = msg;
    el.className = `set-msg ${kind || ''}`;
  } else if (!dirty && el.classList.contains('warn')) {
    el.textContent = '';
    el.className = 'set-msg';
  } else if (dirty && !el.textContent) {
    el.textContent = 'Unsaved changes';
    el.className = 'set-msg';
  }
}

function takeMeta(cfg) {
  if (cfg._meta) SET.meta = cfg._meta;
  delete cfg._meta;
  return cfg;
}

// ------------------------------------------------------------------ tabs

function showTab(tab) {
  SET.tab = tab;
  if (tab !== 'shortcuts') SET.lastTab = tab;
  document.querySelectorAll('#set-tabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === tab));
  const isShortcuts = tab === 'shortcuts';
  $('#set-shortcuts').hidden = !isShortcuts;
  $('#set-body').hidden = isShortcuts;
  $('#set-foot').hidden = isShortcuts && !setDirty();
  if (tab === 'publishing') loadLocalLog();
  if (!isShortcuts) renderTab();
}

function renderTab() {
  const body = $('#set-body');
  const scroll = body.scrollTop;
  body.innerHTML = ({
    industries: industriesHTML, partytypes: partyTypesHTML, checks: checksHTML,
    connections: connectionsHTML, publishing: publishingHTML, team: teamHTML, json: jsonHTML,
  }[SET.tab] || (() => ''))();
  markShared(body);
  body.scrollTop = scroll;
}

// Personal settings get a "just you" tag. Shared ones are read-only unless you maintain the shared config,
// because a local change to config.json would clash with the next update.
const ALWAYS_OK_ACTS = ['check-access', 'stats', 'clear-log'];

function markShared(body) {
  const personal = new Set(SET.meta.personal || []);
  const canShare = !!SET.draft.edit_shared;
  let lockedAny = false;
  body.querySelectorAll('[data-s-path]').forEach(el => {
    if (personal.has(el.dataset.sPath)) {
      const holder = el.closest('.set-field, .set-check, .big-toggle');
      const label = holder?.querySelector('.big-toggle b') || holder?.querySelector('label') || holder;
      if (label && !label.querySelector('.you-tag')) label.insertAdjacentHTML('beforeend', ' <span class="you-tag" title="Saved on this computer only (config.local.json)">just you</span>');
    } else if (!canShare) {
      el.disabled = true;
      lockedAny = true;
    }
  });
  if (!canShare && SET.tab !== 'json') {
    body.querySelectorAll('input:not([data-s-path]), textarea:not([data-s-path]), select:not([data-s-path])').forEach(el => { el.disabled = true; lockedAny = true; });
    body.querySelectorAll('[data-s-act]').forEach(b => {
      if (!ALWAYS_OK_ACTS.includes(b.dataset.sAct)) { b.disabled = true; lockedAny = true; }
    });
  }
  if (!canShare && (lockedAny || SET.tab === 'json')) {
    body.insertAdjacentHTML('afterbegin', `<div class="shared-note">
      ${SET.tab === 'json' ? 'You can edit your personal settings here; changes to shared ones won\'t save.'
        : 'Greyed-out settings are shared with the team and come from <span class="mono">config.json</span> in the repo, so updates keep everyone in step.'}
      Settings tagged <span class="you-tag">just you</span> are yours. To change a shared one, ask David,
      or if you maintain the repo, tick “I maintain the shared settings” on the <button class="link-btn" data-tab="team">Team</button> tab.</div>`);
  }
}

const codesList = () => Object.keys(SET.draft.partytypes || {});

// ---- Industries

function industriesHTML() {
  const d = SET.draft;
  const ids = d.industry_ids || {};
  const hasIds = Object.keys(ids).length > 0;
  const names = Object.keys(d.industries || {}).sort((a, b) => a.localeCompare(b));
  const stats = SET.stats;
  const canDb = dbOn();

  const statCell = name => {
    if (!stats) return '';
    const s = stats[name];
    if (!s || !s.top.length) return '<td class="muted small">Not in the MCL</td>';
    const top = s.top[0];
    const pct = Math.round((top.n / s.total) * 100);
    const mine = d.industries[name].default_partytypes;
    const same = [...top.types].sort().join() === [...mine].sort().join();
    const others = s.top.slice(1).map(t => `${t.types.join(',') || '(none)'} ${Math.round((t.n / s.total) * 100)}%`).join(' · ');
    return `<td class="small"><span class="mono">${esc(top.types.join(',') || '(none)')}</span>
      <span class="muted">${pct}% of ${s.total}</span>
      ${same ? '<span class="match">✓ matches</span>'
        : `<button class="link-btn" data-s-act="use-stat" data-s-ind="${esc(name)}">Use</button>`}
      ${others ? `<div class="muted">${esc(others)}</div>` : ''}</td>`;
  };

  const notInList = stats ? Object.keys(stats).filter(n => n && !d.industries[n]) : [];

  return `
    <p class="set-intro">Each industry's default party types. When a row's types don't match its industry, the
      app offers these with one click. Click a code to switch it on or off.</p>
    <div class="set-tools">
      <button class="btn" data-s-act="stats" ${canDb ? '' : 'disabled'}>${SET.statsState === 'loading' ? 'Counting…' : 'Compare with the MCL'}</button>
      <button class="btn" data-s-act="sync" ${canDb ? '' : 'disabled'}>Sync industry list from Databricks</button>
      ${canDb ? '' : '<span class="muted small">Connect Databricks to compare or sync.</span>'}
    </div>
    ${SET.syncNote ? `<div class="check info">${esc(SET.syncNote)}</div>` : ''}
    ${SET.statsState && SET.statsState !== 'loading' && SET.statsState !== 'ok' ? `<div class="check error">${esc(SET.statsState)}</div>` : ''}
    ${notInList.length ? `<div class="check warn">In the MCL but not in your list: ${esc(notInList.join(', '))}.</div>` : ''}
    <table class="set-table">
      <thead><tr><th>Industry</th><th>Default party types</th>${stats ? '<th>Most common in the MCL</th>' : ''}<th></th></tr></thead>
      <tbody>${names.map(name => {
        const on = new Set(d.industries[name].default_partytypes);
        const extra = [...on].filter(c => !codesList().includes(c));
        return `<tr>
          <td><b>${esc(name)}</b>${hasIds && !(name in ids) ? '<div class="muted small">Not an official LNT industry type</div>' : ''}</td>
          <td><div class="code-toggles">${[...codesList(), ...extra].map(c =>
            `<button class="code ${on.has(c) ? 'on' : ''}" data-s-act="toggle-default" data-s-ind="${esc(name)}" data-s-code="${esc(c)}"
              title="${esc(d.partytypes[c] || c)}">${esc(c)}</button>`).join('')}</div></td>
          ${statCell(name)}
          <td><button class="link-btn danger" data-s-act="remove-ind" data-s-ind="${esc(name)}" title="Remove ${esc(name)}">Remove</button></td>
        </tr>`;
      }).join('')}</tbody>
    </table>
    <div class="set-add">
      <input id="s-new-ind" placeholder="New industry name (exactly as the LNT spells it)" autocomplete="off">
      <button class="btn" data-s-act="add-ind">Add industry</button>
    </div>`;
}

// ---- Party types

function partyTypesHTML() {
  const d = SET.draft;
  const filt = new Set(d.filterable || []);
  const allowed = new Set(d.upload_allowed_partytypes || []);
  return `
    <p class="set-intro">The party-type codes shown as toggles on each row.
      <b>Call Guard blockable</b> codes show a warning when selected.
      <b>Allowed in upload</b> mirrors the batch notebook's check: any other code is flagged as an error.</p>
    <table class="set-table">
      <thead><tr><th>Code</th><th>Label</th><th class="c">Call Guard blockable</th><th class="c">Allowed in upload</th><th></th></tr></thead>
      <tbody>${codesList().map(c => `<tr>
        <td class="mono"><b>${esc(c)}</b></td>
        <td><input data-s-label="${esc(c)}" value="${esc(d.partytypes[c])}" autocomplete="off"></td>
        <td class="c"><input type="checkbox" data-s-list="filterable" data-s-code="${esc(c)}" ${filt.has(c) ? 'checked' : ''}></td>
        <td class="c"><input type="checkbox" data-s-list="upload_allowed_partytypes" data-s-code="${esc(c)}" ${allowed.has(c) ? 'checked' : ''}></td>
        <td><button class="link-btn danger" data-s-act="remove-code" data-s-code="${esc(c)}">Remove</button></td>
      </tr>`).join('')}</tbody>
    </table>
    ${[...allowed].filter(c => !d.partytypes[c]).length ? `<p class="muted small">Also allowed in upload but not shown as toggles:
      ${esc([...allowed].filter(c => !d.partytypes[c]).join(', '))}</p>` : ''}
    <div class="set-add">
      <input id="s-new-code" placeholder="Code, e.g. UB" maxlength="4" class="mono" autocomplete="off">
      <input id="s-new-label" placeholder="Label, e.g. Unknown Business" autocomplete="off">
      <button class="btn" data-s-act="add-code">Add party type</button>
    </div>`;
}

// ---- Checks & export

function checksHTML() {
  const d = SET.draft;
  return `
    <div class="set-field">
      <label for="s-csv-name">Export file name</label>
      <input id="s-csv-name" data-s-path="csv_filename" value="${esc(d.csv_filename || '')}">
      <p class="muted small">Used by the CSV exports. "Denied only" adds <span class="mono">-denied</span> to the name.</p>
    </div>
    <div class="set-field">
      <label for="s-sep">Name variation separator</label>
      <input id="s-sep" class="mono short" data-s-path="csv_variation_separator" value="${esc(d.csv_variation_separator || '|')}">
      <p class="muted small">The batch notebook splits name_variations on <span class="mono">|</span>, so leave this alone unless the notebook changes.</p>
    </div>
    <div class="set-field">
      <label for="s-domains">Listing sites (one per line)</label>
      <textarea id="s-domains" rows="8" class="mono" data-s-path="aggregator_domains" data-s-kind="lines">${esc((d.aggregator_domains || []).join('\n'))}</textarea>
      <p class="muted small">A caller website on one of these gets a "listing site, look for the real one" warning.</p>
    </div>`;
}

// ---- Connections

function connectionsHTML() {
  const d = SET.draft;
  const db = d.databricks || {};
  const t = db.tables || {};
  const q = d.queue || {};
  const field = (label, path, value, help = '', cls = '') => `
    <div class="set-field">
      <label>${label}</label>
      <input class="${cls}" data-s-path="${path}" value="${esc(value ?? '')}" spellcheck="false" autocomplete="off">
      ${help ? `<p class="muted small">${help}</p>` : ''}
    </div>`;
  return `
    <h4>LNT</h4>
    ${field('LNT address', 'lnt_base', d.lnt_base, 'If this ever changes, the bridge userscript needs updating too (it only talks to lnt.fosrv.com).')}
    <label class="set-check"><input type="checkbox" data-s-path="prefetch_next" ${d.prefetch_next !== false ? 'checked' : ''}>
      Preload the next row's LNT info in the background</label>
    <h4>Databricks</h4>
    ${field('Workspace hostname', 'databricks.hostname', db.hostname)}
    ${field('SQL warehouse HTTP path', 'databricks.http_path', db.http_path, '', 'mono')}
    ${field('Token file', 'databricks.token_file', db.token_file,
      'Leave blank to use <span class="mono">.local/databricks_oauth.json</span> in this folder, or point at YALnT\'s token file to share one sign-in.', 'mono')}
    <h4>Tables</h4>
    ${field('MCL', 'databricks.tables.mcl', t.mcl, '', 'mono')}
    ${field('Denied names', 'databricks.tables.denied', t.denied, '', 'mono')}
    ${field('Honeypot transcripts', 'databricks.tables.honeypot', t.honeypot, '', 'mono')}
    ${field('Industry mapping', 'databricks.tables.industry_mapping', t.industry_mapping, '', 'mono')}
    <p class="muted small">Changing the hostname, path or token file reconnects (and may ask you to sign in again).</p>
    <h4>Check my access</h4>
    <p class="muted small">Tries a one-row read of every table the app uses (the saved settings, so save first if you changed any)
      and shows Databricks' own message for any that fail.</p>
    <div class="set-tools"><button class="btn" data-s-act="check-access">Check my access</button></div>
    ${accessHTML()}
    <h4>Loading the queue</h4>
    <label class="set-check"><input type="checkbox" data-s-path="queue.extend_lookback" ${q.extend_lookback !== false ? 'checked' : ''}>
      If my filters don't fill the number I ask for, look further back automatically</label>
    <div class="set-field">
      <label>Look back at most (days)</label>
      <input class="short" type="number" min="30" max="4400" data-s-path="queue.max_lookback_days" data-s-kind="int"
        value="${esc(q.max_lookback_days ?? 365)}">
      <p class="muted small">Only reaches as far as it needs to fill your request. Names from before the look-back on the start
        screen get an <span class="q-old">older</span> tag. 365 is a year; the history goes back to September 2015 (about 4,070 days).</p>
    </div>`;
}

function accessHTML() {
  const a = SET.access;
  if (!a) return '';
  if (a.state === 'loading') return '<p class="muted small">Checking each table…</p>';
  if (a.state === 'error') return `<div class="check error">${esc(a.error)}</div>`;
  const bad = a.tables.filter(x => !x.ok);
  return `<p class="small">Signed in to Databricks as <b>${esc(a.user)}</b>.
      ${bad.length ? `<span class="bad">${bad.length} table${bad.length === 1 ? '' : 's'} can't be read.</span>` : 'Every table can be read.'}</p>
    <ul class="access-list">${a.tables.map(x => `<li class="${x.ok ? 'ok' : 'bad'}">
      <span>${x.ok ? '✓' : '✕'}</span> <b>${esc(x.key.replace(/_/g, ' '))}</b> <span class="mono small">${esc(x.table)}</span>
      ${x.ok ? '' : `<div class="muted small">${x.missing
        ? 'Databricks says it doesn\'t exist, which is also what it says when you lack USE CATALOG / USE SCHEMA / SELECT on it. '
          + (/change_log|claims|handoffs/.test(x.key) ? 'If nobody has published or loaded yet it may simply not be created yet. ' : '')
        : ''}${esc(x.error)}</div>`}</li>`).join('')}</ul>`;
}

async function checkAccess() {
  SET.access = { state: 'loading' };
  renderTab();
  try {
    SET.access = { state: 'ok', ...(await dbFetch('/api/db/check')) };
  } catch (e) {
    SET.access = { state: 'error', error: e.message };
  }
  if (SET.tab === 'connections') renderTab();
}

// ---- Team & sharing

function teamHTML() {
  const d = SET.draft;
  const t = (d.databricks || {}).tables || {};
  const team = d.team || [];
  const m = SET.meta;
  return `
    <h4>Team</h4>
    <p class="muted small">The people who share the queue and the Tickets board. They're who you can hand a ticket's turn to.
      Use the email each person signs in to Databricks with.</p>
    <table class="team-table">
      <tr><th>Name</th><th>Databricks login</th><th></th></tr>
      ${team.map((p, i) => `<tr>
        <td><input data-s-team="${i}" data-s-field="name" value="${esc(p.name || '')}" placeholder="Name" autocomplete="off"></td>
        <td><input class="mono" data-s-team="${i}" data-s-field="email" value="${esc(p.email || '')}" placeholder="name@firstorion.com" autocomplete="off" spellcheck="false"></td>
        <td><button class="btn ghost" data-s-act="remove-member" data-s-i="${i}" aria-label="Remove">✕</button></td></tr>`).join('')}
    </table>
    <div class="set-tools"><button class="btn" data-s-act="add-member">+ Add someone</button></div>

    <h4>Tickets</h4>
    <label class="set-check"><input type="checkbox" data-s-path="handoff_on_flag" ${d.handoff_on_flag !== false ? 'checked' : ''}>
      When I flag a row, offer to make it a ticket</label>
    <div class="set-field">
      <label>Give new tickets' turn to</label>
      <select data-s-path="handoff_default">
        <option value="">Whoever I sent one to last</option>
        ${team.filter(p => p.email).map(p => `<option value="${esc(p.email)}" ${d.handoff_default === p.email ? 'selected' : ''}>${esc(p.name || p.email)} (${esc(p.email)})</option>`).join('')}
        ${d.handoff_default && !team.some(p => p.email === d.handoff_default) ? `<option value="${esc(d.handoff_default)}" selected>${esc(d.handoff_default)}</option>` : ''}
      </select>
      <p class="muted small">Filled in when the "Make it a ticket" box opens. You can still change it each time.</p>
    </div>
    <div class="set-field">
      <label>Tickets table</label>
      <input class="mono" data-s-path="databricks.tables.tickets" value="${esc(t.tickets || '')}" spellcheck="false">
    </div>
    <div class="set-field">
      <label>Ticket conversations table</label>
      <input class="mono" data-s-path="databricks.tables.ticket_events" value="${esc(t.ticket_events || '')}" spellcheck="false">
      <p class="muted small">Both are created automatically. Everyone on the team must point at the same tables.</p>
    </div>

    <h4>Claims</h4>
    <div class="set-field">
      <label>Claims table</label>
      <input class="mono" data-s-path="databricks.tables.claims" value="${esc(t.claims || '')}" spellcheck="false">
      <p class="muted small">Names you load are claimed here so nobody else gets them. Everyone sharing the queue must point at the same table.</p>
    </div>
    <div class="set-field">
      <label>Claims expire after (hours without activity)</label>
      <input class="short" type="number" min="1" max="168" data-s-path="claims.expire_hours" data-s-kind="int"
        value="${esc((d.claims || {}).expire_hours ?? 24)}">
      <p class="muted small">While the app is open your claims stay alive. Close it and they go back to the pool after this long.</p>
    </div>

    <h4>Shared and personal settings</h4>
    <p class="muted small">Shared settings (industries, party types, tables, the team list…) live in <span class="mono">config.json</span>,
      which comes with each update from the team repo. Settings tagged <span class="you-tag">just you</span> live in
      <span class="mono">${esc(m.local_file || 'config.local.json')}</span> on this computer and are never pushed.</p>
    <label class="set-check"><input type="checkbox" data-s-path="edit_shared" ${d.edit_shared ? 'checked' : ''}>
      I maintain the shared settings (I commit and push <span class="mono">config.json</span>)</label>
    <p class="muted small">Leave this off unless you push updates. Shared changes saved here only reach the team once
      <span class="mono">config.json</span> is committed and pushed.</p>
    <p class="muted small">This copy: ${m.version ? `version ${esc(m.version)}` : 'no version file'}${m.commit ? `, commit <span class="mono">${esc(m.commit)}</span>` : ''}${m.git ? '' : ' (not a git checkout, so it won\'t update itself)'}.</p>`;
}

// ---- Publishing

function publishingHTML() {
  const d = SET.draft;
  const pub = d.publish || {};
  const t = (d.databricks || {}).tables || {};
  const schema = pub.sandbox_schema || 'analysts.rhenderson';
  const log = SET.log || { state: 'loading' };
  const when = s => String(s || '').replace('T', ' ').slice(0, 16);
  let logHTML;
  if (log.state === 'loading') logHTML = '<p class="muted small">Loading…</p>';
  else if (log.state === 'error') logHTML = `<div class="check error">${esc(log.error)}</div>`;
  else if (!log.runs.length) logHTML = '<p class="muted small">Nothing logged yet.</p>';
  else {
    logHTML = `<ul class="log-list">${log.runs.slice(0, 25).map(r => {
      const c = r.counts || {};
      const bad = (r.errors || []).length + (r.verify || []).length;
      return `<li><span class="log-mode ${esc(r.mode)}">${r.mode === 'publish' ? 'PUBLISHED' : 'TEST'}</span>
        ${esc(when(r.at))} · ${c.insert || 0} new, ${c.merge || 0} updated, ${c.deny || 0} denied
        ${bad ? `<span class="bad"> · ${bad} problem${bad === 1 ? '' : 's'}</span>` : ''}
        <div class="muted small">${esc((r.items || []).filter(i => ['insert', 'merge', 'deny'].includes(i.action))
          .map(i => i.name).slice(0, 8).join(', '))}${(r.items || []).length > 8 ? '…' : ''}</div></li>`;
    }).join('')}</ul>
    ${log.runs.length > 25 ? `<p class="muted small">Showing the latest 25 of ${log.runs.length}. Download for everything.</p>` : ''}`;
  }
  return `
    <label class="big-toggle"><input type="checkbox" data-s-path="publish.dry_run" ${pub.dry_run !== false ? 'checked' : ''}>
      <span><b>Dry run mode</b>
      <span class="muted small">While this is on, the Publish window can preview and test on a copy of the MCL, but
      can't write to the real MCL or denied list. Turn it off once a test run looks right.</span></span></label>
    <label class="big-toggle"><input type="checkbox" data-s-path="publish.auto" ${pub.auto ? 'checked' : ''}>
      <span><b>Publish when I approve or deny</b>
      <span class="muted small">Each Approve or Deny waits out an undo window, then publishes that row in the background.
      Rows that fail the checks bounce back to Flagged with the reason. Only works with dry run mode off.</span></span></label>
    <div class="set-field">
      <label>Undo window (seconds)</label>
      <input class="short" type="number" min="3" max="120" data-s-path="publish.auto_delay_seconds" data-s-kind="int"
        value="${esc(pub.auto_delay_seconds ?? 10)}">
    </div>
    <h4>Testing</h4>
    <div class="set-field">
      <label>Schema for test copies</label>
      <input class="mono" data-s-path="publish.sandbox_schema" value="${esc(schema)}" spellcheck="false">
      <p class="muted small">“Test on a copy” makes <span class="mono">${esc(schema)}.mcl_verifier_sandbox_mcl_&lt;you&gt;</span> and
        <span class="mono">…_sandbox_denied_&lt;you&gt;</span> here (shallow clones, so no extra storage), replacing them each time.</p>
    </div>
    <div class="set-field">
      <label>Databricks change log table</label>
      <input class="mono" data-s-path="databricks.tables.change_log" value="${esc(t.change_log || '')}" spellcheck="false">
      <p class="muted small">One row per real change: who, when, before and after. Created automatically on the first publish.</p>
    </div>
    <h4>Local log</h4>
    <p class="muted small">Every test and publish is also written to <span class="mono">${esc(log.path || 'data/publish_log.jsonl')}</span>
      ${log.size ? `(${(log.size / 1024).toFixed(1)} KB)` : ''}. Clearing it doesn't touch the Databricks change log.</p>
    <div class="set-tools">
      <a class="btn" href="/api/publish/log/download" ${log.runs && log.runs.length ? '' : 'hidden'}>Download</a>
      <button class="btn ${SET.clearArmed ? 'danger-btn' : ''}" data-s-act="clear-log" ${log.runs && log.runs.length ? '' : 'disabled'}>
        ${SET.clearArmed ? 'Click again to clear the local log' : 'Clear local log'}</button>
    </div>
    ${logHTML}`;
}

async function loadLocalLog() {
  try {
    SET.log = { state: 'ok', ...(await api('/api/publish/log')) };
  } catch (e) {
    SET.log = { state: 'error', error: e.message, runs: [] };
  }
  if (SET.tab === 'publishing') renderTab();
}

// ---- Raw JSON

function jsonHTML() {
  return `
    <p class="set-intro">Everything in config.json. Edit directly for anything the other tabs don't cover.
      The previous version is kept as <span class="mono">config.json.bak</span> each time you save.</p>
    <textarea id="s-json" class="json-edit" spellcheck="false">${esc(JSON.stringify(SET.draft, null, 2))}</textarea>
    ${SET.jsonError ? `<div class="check error">${esc(SET.jsonError)}</div>` : ''}`;
}

// ------------------------------------------------------------------ editing

function setPath(obj, path, value) {
  const keys = path.split('.');
  let o = obj;
  for (const k of keys.slice(0, -1)) o = (o[k] = o[k] && typeof o[k] === 'object' ? o[k] : {});
  o[keys[keys.length - 1]] = value;
}

function act(name, el) {
  const d = SET.draft;
  const ind = el.dataset.sInd;
  const code = el.dataset.sCode;
  switch (name) {
    case 'toggle-default': {
      const list = d.industries[ind].default_partytypes;
      const i = list.indexOf(code);
      i >= 0 ? list.splice(i, 1) : list.push(code);
      const order = codesList();
      list.sort((a, b) => (order.indexOf(a) + 1 || 99) - (order.indexOf(b) + 1 || 99));
      break;
    }
    case 'remove-ind': delete d.industries[ind]; break;
    case 'add-ind': {
      const name = collapse($('#s-new-ind').value);
      if (!name) return;
      if (d.industries[name]) return updateFoot(`${name} is already in the list.`, 'warn');
      d.industries[name] = { default_partytypes: [] };
      break;
    }
    case 'use-stat': {
      const top = SET.stats?.[ind]?.top?.[0];
      if (top) d.industries[ind].default_partytypes = [...top.types];
      break;
    }
    case 'remove-code': {
      delete d.partytypes[code];
      for (const v of Object.values(d.industries)) v.default_partytypes = v.default_partytypes.filter(c => c !== code);
      d.filterable = (d.filterable || []).filter(c => c !== code);
      break;
    }
    case 'add-code': {
      const c = $('#s-new-code').value.trim().toUpperCase();
      const label = $('#s-new-label').value.trim();
      if (!/^[A-Z0-9]{1,4}$/.test(c)) return updateFoot('Codes are 1–4 letters or digits.', 'error');
      if (d.partytypes[c] !== undefined) return updateFoot(`${c} is already in the list.`, 'warn');
      d.partytypes[c] = label;
      break;
    }
    case 'stats': return loadStats();
    case 'clear-log': {
      if (!SET.clearArmed) {
        SET.clearArmed = true;
        setTimeout(() => { SET.clearArmed = false; if (SET.tab === 'publishing') renderTab(); }, 4000);
        return renderTab();
      }
      SET.clearArmed = false;
      api('/api/publish/log', { method: 'DELETE' })
        .then(() => { toast('Local log cleared', 'ok'); loadLocalLog(); })
        .catch(e => updateFoot(e.message, 'error'));
      return;
    }
    case 'sync': return syncIndustries();
    case 'check-access': return checkAccess();
    case 'add-member': (d.team = d.team || []).push({ name: '', email: '' }); break;
    case 'remove-member': d.team.splice(Number(el.dataset.sI), 1); break;
  }
  renderTab();
  updateFoot();
}

async function loadStats() {
  SET.statsState = 'loading';
  renderTab();
  try {
    SET.stats = await dbFetch('/api/db/industry-stats');
    SET.statsState = 'ok';
  } catch (e) {
    SET.statsState = e.message;
  }
  if (SET.tab === 'industries') renderTab();
}

async function syncIndustries() {
  try {
    const list = await dbFetch('/api/db/industry-mapping');
    if (!list.length) throw new Error('The industry mapping table came back empty.');
    const d = SET.draft;
    d.industry_ids = Object.fromEntries(list.map(x => [x.name, x.id]));
    const added = list.map(x => x.name).filter(n => !d.industries[n]);
    for (const n of added) d.industries[n] = { default_partytypes: [] };
    const extra = Object.keys(d.industries).filter(n => !(n in d.industry_ids));
    SET.syncNote = `Synced ${list.length} official industry types. `
      + (added.length ? `Added ${added.join(', ')} (no defaults yet). ` : 'Nothing new to add. ')
      + (extra.length ? `Not in the official list: ${extra.join(', ')}. Rows using them get a warning; remove them if they're not needed.` : '');
  } catch (e) {
    SET.syncNote = '';
    return updateFoot(e.message, 'error');
  }
  renderTab();
  updateFoot();
}

// ------------------------------------------------------------------ events
// Settings handles its own clicks and stops them there, so app.js's handlers never see them.

$('#btn-settings').addEventListener('click', () => openSettings());

$('#settings').addEventListener('click', e => {
  e.stopPropagation();
  if (e.target.id === 'settings') return closeSettings(); // clicked the dimmed backdrop
  const t = e.target.closest('button');
  if (!t) return;
  if (t.dataset.tab) return showTab(t.dataset.tab);
  const s = t.dataset.set;
  if (s === 'close') return closeSettings();
  if (s === 'save') return saveSettings();
  if (s === 'discard') {
    SET.draft = JSON.parse(SET.saved);
    SET.jsonError = '';
    updateFoot('');
    return closeSettings(true);
  }
  if (t.dataset.sAct) return act(t.dataset.sAct, t);
});

$('#settings').addEventListener('input', e => {
  e.stopPropagation();
  const t = e.target;
  const d = SET.draft;
  if (t.id === 's-json') {
    try {
      const parsed = JSON.parse(t.value);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('The top level must be { … }.');
      SET.draft = parsed;
      SET.jsonError = '';
    } catch (err) {
      SET.jsonError = `Invalid JSON: ${err.message}`;
    }
    const box = $('#set-body .check.error');
    if (box) box.remove();
    if (SET.jsonError) t.insertAdjacentHTML('afterend', `<div class="check error">${esc(SET.jsonError)}</div>`);
    return updateFoot();
  }
  if (t.dataset.sPath) {
    let v = t.type === 'checkbox' ? t.checked : t.value;
    if (t.dataset.sKind === 'lines') v = v.split(/\s+/).map(x => x.trim()).filter(Boolean);
    if (t.dataset.sKind === 'int') v = Number.parseInt(v, 10);
    setPath(d, t.dataset.sPath, v);
    if (t.dataset.sPath === 'edit_shared') { renderTab(); return updateFoot(); }  // unlock / lock the shared fields now
  } else if (t.dataset.sTeam !== undefined) {
    d.team[Number(t.dataset.sTeam)][t.dataset.sField] = t.dataset.sField === 'email' ? t.value.trim().toLowerCase() : t.value;
  } else if (t.dataset.sLabel) {
    d.partytypes[t.dataset.sLabel] = t.value;
  } else if (t.dataset.sList) {
    const key = t.dataset.sList;
    const set = new Set(d[key] || []);
    t.checked ? set.add(t.dataset.sCode) : set.delete(t.dataset.sCode);
    d[key] = [...set];
  }
  updateFoot();
});

$('#settings').addEventListener('keydown', e => {
  if (e.key === 'Enter' && e.target.id === 's-new-ind') { e.preventDefault(); act('add-ind', e.target); }
  if (e.key === 'Enter' && (e.target.id === 's-new-code' || e.target.id === 's-new-label')) { e.preventDefault(); act('add-code', e.target); }
});

// The only names app.js needs.
window.openSettings = openSettings;
window.closeSettings = closeSettings;
})();
