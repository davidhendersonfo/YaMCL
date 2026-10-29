// MCL editor: search the MCL or the denied list, change an entry, preview the diff, save with a
// reason; delete or un-deny; see an entry's history and load an earlier version.
// Uses helpers from app.js ($, esc, api, toast, dbFetch, dbOn, S, collapse ...), which loads first.
(function () {
'use strict';

const E = {
  table: 'mcl', q: '', results: [], resultsState: '', searchTimer: null,
  entry: null, fp: null, dups: 0, history: [], histErr: null,
  form: null, reason: '', preview: null, previewOf: '', busy: '', msg: null,
  deleteOpen: false, confirm: '', undenyArmed: false,
};

const dryRun = () => S.cfg?.publish?.dry_run !== false;
const formKey = () => JSON.stringify(E.form);
const industryNames = () => [...new Set([...Object.keys(S.cfg.industry_ids || {}), ...Object.keys(S.cfg.industries || {})])].sort();

// ------------------------------------------------------------------ mode switching

// Three modes share the page: the review queue, the MCL editor and Add to MCL.
const MODE_VIEWS = { editor: '#editor-view', add: '#add-view', stats: '#stats-view' };
const MODE_TITLES = { editor: 'MCL editor', add: 'Add to MCL', stats: 'Stats' };

function setMode(mode) {
  S.mode = mode;
  document.querySelectorAll('#mode-tabs button').forEach(b => b.classList.toggle('on', b.dataset.mode === mode));
  for (const [m, sel] of Object.entries(MODE_VIEWS)) $(sel).hidden = m !== mode;
  if (MODE_VIEWS[mode]) {
    for (const id of ['#upload-view', '#work-view', '#top-actions', '#progress-wrap']) $(id).hidden = true;
    $('#filename').textContent = `· ${MODE_TITLES[mode]}`;
    if (mode === 'editor') {
      document.title = E.entry ? `MCL editor | ${E.entry.partyname}` : 'MCL editor';
      renderMain();
      if (!E.entry) $('#ed-search').focus();
    } else {
      document.title = MODE_TITLES[mode];
      if (mode === 'add') window.renderAdd?.();
      if (mode === 'stats') window.loadStats?.();
    }
  } else {
    const v = S.reviewView || { view: S.rows.length ? 'work' : 'upload' };
    v.view === 'work' ? showWork() : showUpload(!!v.cancellable);
  }
}

async function openEditor(name, table = 'mcl') {
  if (!dbOn()) return toast('Connect Databricks to use the MCL editor', 'error');
  setTable(table);
  E.q = name;
  $('#ed-search').value = name;
  setMode('editor');
  search();
  await loadEntry(name);
}

function setTable(table) {
  E.table = table;
  document.querySelectorAll('#ed-seg button').forEach(b => b.classList.toggle('on', b.dataset.eTable === table));
  $('#ed-search').placeholder = table === 'denied' ? 'Search the denied list…' : 'Search names and variations…';
}

// ------------------------------------------------------------------ search

async function search() {
  const q = collapse($('#ed-search').value);
  E.q = q;
  if (q.length < 3) { E.results = []; E.resultsState = q ? 'short' : ''; return renderResults(); }
  E.resultsState = 'loading';
  renderResults();
  try {
    const r = await dbFetch(`/api/editor/search?table=${E.table}&q=${encodeURIComponent(q)}`);
    if (E.q !== q) return; // a newer search is on its way
    E.results = r.items;
    E.resultsState = 'ok';
  } catch (e) {
    E.resultsState = e.message;
  }
  renderResults();
}

function renderResults() {
  const el = $('#ed-results');
  if (E.resultsState === 'loading') { el.innerHTML = '<li class="empty">Searching…</li>'; return; }
  if (E.resultsState === 'short') { el.innerHTML = '<li class="empty">Type at least 3 letters.</li>'; return; }
  if (E.resultsState && E.resultsState !== 'ok') { el.innerHTML = `<li class="empty">${esc(E.resultsState)}</li>`; return; }
  if (!E.results.length) {
    el.innerHTML = E.q ? '<li class="empty">No matches.</li>' : `<li class="empty">Search ${E.table === 'denied' ? 'the denied list' : 'the MCL'} by name or variation.</li>`;
    return;
  }
  el.innerHTML = E.results.map(it => `<li data-e-open="${esc(it.partyname)}" class="${E.entry?.partyname === it.partyname ? 'active' : ''}">
    <span class="dot ${E.table === 'denied' ? 'denied' : 'approved'}"></span>
    <span class="q-name">${esc(it.partyname)}</span><span></span>
    <span class="q-phone">${esc(it.industry || '')} · ${esc((it.partytypes || []).join(','))}</span></li>`).join('');
}

// ------------------------------------------------------------------ one entry

async function loadEntry(name) {
  E.busy = 'Loading…';
  E.msg = null;
  renderMain();
  try {
    const r = await dbFetch(`/api/editor/entry?table=${E.table}&name=${encodeURIComponent(name)}`);
    Object.assign(E, { entry: r.entry, fp: r.fingerprint, dups: r.duplicates, history: r.history, histErr: r.history_error });
    resetForm();
    document.title = `MCL editor | ${r.entry.partyname}`;
  } catch (e) {
    E.entry = null;
    E.msg = { kind: 'error', text: e.message };
  }
  E.busy = '';
  renderMain();
  renderResults();
}

function resetForm() {
  const en = E.entry;
  E.form = { partyname: en.partyname, industry: en.industry, partytypes: [...en.partytypes], name_variations: [...en.name_variations] };
  E.preview = null;
  E.previewOf = '';
  E.deleteOpen = false;
  E.confirm = '';
  E.undenyArmed = false;
}

// the old name's forms are kept automatically when renaming (same rule as the review queue)
function lockedForms() {
  const old = E.entry?.partyname;
  if (!old || collapse(E.form.partyname) === old) return [];
  return [...new Set([old, old.toLowerCase(), old.toUpperCase()])];
}

function diffLines(before, after) {
  const out = [];
  if (!before && after) return ['Created'];
  if (before && !after) return ['Deleted'];
  if (before.partyname !== after.partyname) out.push(`Name: ${before.partyname} → ${after.partyname}`);
  if ((before.industry || '') !== (after.industry || '')) out.push(`Industry: ${before.industry || '(none)'} → ${after.industry}`);
  const bp = (before.partytypes || []).join(','), ap = (after.partytypes || []).join(',');
  if (bp !== ap) out.push(`Party types: ${bp || '(none)'} → ${ap || '(none)'}`);
  const bv = before.name_variations || [], av = after.name_variations || [];
  const add = av.filter(v => !bv.includes(v)), rm = bv.filter(v => !av.includes(v));
  if (add.length) out.push(`+ ${add.join(' | ')}`);
  if (rm.length) out.push(`− ${rm.join(' | ')}`);
  return out;
}

function historyHTML() {
  if (E.histErr) return `<div class="check warn">Couldn't load the history: ${esc(E.histErr)}</div>`;
  if (!E.history.length) return '<p class="muted small">No changes logged yet. Changes made through this app (publishing and editing) show up here.</p>';
  return `<ul class="ed-history">${E.history.map((h, i) => {
    const canLoad = E.table === 'mcl' && h.before && h.action !== 'deny' && h.action !== 'undeny';
    return `<li>
      <div><b>${esc(h.action)}</b> <span class="muted small">${esc(h.at)} · ${esc(h.by)}</span>
        ${canLoad ? `<button class="link-btn" data-e-load="${i}" title="Fill the form with the entry as it was before this change">Load the version before this</button>` : ''}</div>
      ${h.reason ? `<div class="small">${esc(h.reason)}</div>` : ''}
      <div class="muted small mono">${diffLines(h.before, h.after).map(esc).join('<br>')}</div></li>`;
  }).join('')}</ul>`;
}

function renderMain() {
  const el = $('#ed-main');
  if (!el || S.mode !== 'editor') return;
  const scroll = el.scrollTop;
  const msg = E.msg ? `<div class="check ${E.msg.kind}">${esc(E.msg.text)}</div>` : '';
  if (E.busy && !E.entry) { el.innerHTML = `<p class="muted">${esc(E.busy)}</p>`; return; }
  if (!E.entry) {
    el.innerHTML = `${msg}<div class="ed-empty">
      <h2>MCL editor</h2>
      <p class="muted">Search the MCL or the denied list on the left. Fix an entry, handle an audit challenge, rename, delete,
      or take a name off the denied list. Every change shows a before/after preview first and is logged with your reason.</p></div>`;
    return;
  }
  const en = E.entry;
  const dry = dryRun();
  const banner = dry ? `<div class="pub-mode">Dry run mode is on: you can preview changes but not save them.
    Turn it off in <button class="link-btn" data-e-act="settings">Settings → Publishing</button>.</div>` : '';

  if (E.table === 'denied') {
    el.innerHTML = `${banner}${msg}
      <div class="eyebrow">Denied list</div><h1>${esc(en.partyname)}</h1>
      <dl class="ed-dl"><dt>Industry</dt><dd>${esc(en.industry || '(none)')}</dd>
        <dt>Party types</dt><dd class="mono">${esc(en.partytypes.join(',') || '(none)')}</dd>
        <dt>Variations</dt><dd>${esc(en.name_variations.join(' | ') || '(none)')}</dd></dl>
      <div class="field"><label for="ed-reason">Reason</label>
        <input id="ed-reason" value="${esc(E.reason)}" placeholder="Why it should come off the denied list" autocomplete="off"></div>
      <div class="ed-actions">
        <button class="btn ${E.undenyArmed ? 'danger-btn' : ''}" data-e-act="undeny" ${dry || collapse(E.reason).length < 3 ? 'disabled' : ''}>
          ${E.undenyArmed ? 'Click again to remove it from the denied list' : 'Remove from the denied list'}</button>
        <span class="muted small">It can then come back through the New-to-MCL queue.</span>
      </div>
      <h3 class="ed-h">History</h3>${historyHTML()}`;
    el.scrollTop = scroll;
    return;
  }

  const f = E.form;
  const locked = lockedForms();
  const have = new Set(f.name_variations);
  const chips = [
    ...f.name_variations.map((v, i) => ({ v, i, lock: locked.includes(v) })),
    ...locked.filter(v => !have.has(v) && v !== collapse(f.partyname)).map(v => ({ v, i: null, lock: true })),
  ];
  const codes = [...new Set([...Object.keys(S.cfg.partytypes || {}), ...f.partytypes])];
  const filterable = S.cfg.filterable || [];
  const p = E.preview;
  const previewFresh = p && E.previewOf === formKey();
  const canSave = previewFresh && !p.problems.length && collapse(E.reason).length >= 3 && !dry && !E.busy;
  const nameOk = E.confirm === en.partyname;

  el.innerHTML = `${banner}${msg}
    <div class="eyebrow">MCL entry · added ${esc(en.insertDate || '?')}${en.modifyDate ? ` · last changed ${esc(en.modifyDate)}` : ''}</div>
    <h1>${esc(en.partyname)}</h1>
    ${E.dups > 1 ? `<div class="check error">There are ${E.dups} MCL entries named exactly “${esc(en.partyname)}”. Delete the duplicate before editing.</div>` : ''}
    <div class="ed-form">
      <div class="field"><label for="ed-name">Party name</label>
        <input id="ed-name" data-e-field="partyname" value="${esc(f.partyname)}" autocomplete="off" spellcheck="false"></div>
      <div class="field"><label>Name variations</label>
        <div class="vars">${chips.length ? chips.map(c => `<span class="var ${c.lock ? 'locked' : ''}"
            ${c.lock ? 'title="The old name. Kept so it still links to this entry."' : ''}>
            ${c.lock ? '<span class="lock">🔒</span>' : ''}<span class="var-text">${esc(c.v)}</span>
            ${c.lock || c.i === null ? '' : `<button data-e-rmvar="${c.i}" title="Remove">×</button>`}</span>`).join('')
          : '<span class="muted small">None</span>'}</div>
        <input id="ed-var-add" placeholder="Add a variation (pipe-separated lists work too) and press Enter" autocomplete="off" spellcheck="false">
        ${locked.length ? '<div class="muted small">🔒 Renaming keeps the old name as a variation.</div>' : ''}</div>
      <div class="field"><label for="ed-industry">Industry</label>
        <input id="ed-industry" data-e-field="industry" list="ed-industry-list" value="${esc(f.industry)}" autocomplete="off">
        <datalist id="ed-industry-list">${industryNames().map(i => `<option value="${esc(i)}">`).join('')}</datalist></div>
      <div class="field"><label>Party types</label>
        <div class="pts">${codes.map(c => `<button class="pt ${f.partytypes.includes(c) ? 'on' : ''} ${filterable.includes(c) ? 'risky' : ''}"
          data-e-pt="${esc(c)}" title="${esc(S.cfg.partytypes?.[c] || c)}"><b>${esc(c)}</b>${S.cfg.partytypes?.[c] ? `<span>${esc(S.cfg.partytypes[c])}</span>` : ''}</button>`).join('')}</div></div>
      <div class="field"><label for="ed-reason">Reason for the change</label>
        <input id="ed-reason" value="${esc(E.reason)}" placeholder="e.g. audit challenge, ticket 123" autocomplete="off"></div>
    </div>
    <div class="ed-actions">
      <button class="btn" data-e-act="preview" ${E.busy ? 'disabled' : ''}>Preview changes</button>
      <button class="btn primary" data-e-act="save" ${canSave ? '' : 'disabled'}
        title="${dry ? 'Dry run mode is on' : !previewFresh ? 'Preview first' : collapse(E.reason).length < 3 ? 'Add a reason' : ''}">Save to the MCL</button>
      <button class="btn ghost" data-e-act="reset" ${formKey() === JSON.stringify({ partyname: en.partyname, industry: en.industry, partytypes: en.partytypes, name_variations: en.name_variations }) ? 'disabled' : ''}>Undo my edits</button>
      ${E.busy ? `<span class="muted small">${esc(E.busy)}</span>` : ''}
    </div>
    ${p ? `<div class="ed-preview ${previewFresh ? '' : 'stale'}">
      <b>${previewFresh ? 'Preview' : 'Preview (out of date: you changed something since, preview again)'}</b>
      ${p.problems.map(x => `<div class="check error">${esc(x)}</div>`).join('')}
      ${p.changes.map(x => `<div class="pub-change">${esc(x)}</div>`).join('')}</div>` : ''}
    <h3 class="ed-h">History</h3>${historyHTML()}
    <details class="ed-danger" ${E.deleteOpen ? 'open' : ''}><summary data-e-act="toggle-delete">Delete this entry…</summary>
      <p class="small">Deleting removes “${esc(en.partyname)}” from the MCL entirely. It's logged with its full contents, so it can be recreated.
        Type the exact name to confirm${collapse(E.reason).length < 3 ? ', and add a reason above' : ''}.</p>
      <div class="set-add"><input id="ed-confirm" value="${esc(E.confirm)}" placeholder="${esc(en.partyname)}" autocomplete="off" spellcheck="false">
        <button class="btn danger-btn" data-e-act="delete" ${nameOk && collapse(E.reason).length >= 3 && !dry ? '' : 'disabled'}>Delete</button></div>
    </details>`;
  el.scrollTop = scroll;
}

// small updates that mustn't steal focus from a text box
function refreshActions() {
  const danger = $('.ed-danger');
  if (danger) E.deleteOpen = danger.open; // keep "Delete…" as the person left it
  const keep = document.activeElement;
  const id = keep?.id, pos = keep?.selectionStart;
  renderMain();
  if (id && $(`#${id}`)) {
    const f = $(`#${id}`);
    f.focus();
    if (pos != null && f.setSelectionRange) f.setSelectionRange(pos, pos);
  }
}

// ------------------------------------------------------------------ actions

async function preview() {
  E.busy = 'Checking…';
  renderMain();
  const of = formKey();
  try {
    E.preview = await dbFetch('/api/editor/preview', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: E.entry.partyname, after: E.form }),
    });
    E.previewOf = of;
    if (E.preview.fingerprint !== E.fp) E.msg = { kind: 'warn', text: 'Someone changed this entry since you opened it. Reload it before saving.' };
  } catch (e) {
    E.msg = { kind: 'error', text: e.message };
  }
  E.busy = '';
  renderMain();
}

async function save() {
  E.busy = 'Saving…';
  renderMain();
  try {
    const r = await dbFetch('/api/editor/save', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: E.entry.partyname, after: E.form, reason: E.reason, fingerprint: E.fp }),
    });
    toast(`Saved “${r.entry.partyname}”`, 'ok');
    for (const w of [...(r.verify || []), ...(r.warnings || [])]) toast(w, 'error');
    E.reason = '';
    E.busy = '';
    await loadEntry(r.entry.partyname);
    E.msg = { kind: 'ok', text: `Saved: ${r.changes.join('; ')}` };
    renderMain();
    search();
  } catch (e) {
    E.busy = '';
    E.msg = { kind: 'error', text: e.message };
    renderMain();
  }
}

async function remove(table) {
  E.busy = table === 'denied' ? 'Removing…' : 'Deleting…';
  renderMain();
  try {
    const r = await dbFetch('/api/editor/delete', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ table, key: E.entry.partyname, reason: E.reason, fingerprint: E.fp, confirm: E.confirm }),
    });
    for (const w of r.warnings || []) toast(w, 'error');
    toast(table === 'denied' ? `“${E.entry.partyname}” is off the denied list` : `Deleted “${E.entry.partyname}”`, 'ok');
    E.entry = null;
    E.reason = '';
    E.msg = null;
    document.title = 'MCL editor';
    search();
  } catch (e) {
    E.msg = { kind: 'error', text: e.message };
  }
  E.busy = '';
  renderMain();
}

function addVariations(text) {
  const incoming = String(text).split('|').map(x => x.trim()).filter(Boolean);
  for (const v of incoming) if (!E.form.name_variations.includes(v)) E.form.name_variations.push(v);
}

// ------------------------------------------------------------------ events

$('#mode-tabs').addEventListener('click', e => {
  const b = e.target.closest('button[data-mode]');
  if (!b || b.dataset.mode === S.mode) return;
  if (b.dataset.mode !== 'review' && !dbOn()) return toast(`Connect Databricks to use ${MODE_TITLES[b.dataset.mode]}`, 'error');
  setMode(b.dataset.mode);
});

const view = $('#editor-view');

view.addEventListener('click', e => {
  e.stopPropagation(); // keep the review queue's click handlers out of the editor
  const t = e.target.closest('button, li[data-e-open], summary');
  if (!t) return;
  if (t.dataset.eTable) { if (t.dataset.eTable !== E.table) { setTable(t.dataset.eTable); E.entry = null; renderMain(); search(); } return; }
  if (t.dataset.eOpen !== undefined) return loadEntry(t.dataset.eOpen);
  if (t.dataset.ePt) {
    const set = new Set(E.form.partytypes);
    set.has(t.dataset.ePt) ? set.delete(t.dataset.ePt) : set.add(t.dataset.ePt);
    const order = Object.keys(S.cfg.partytypes || {});
    E.form.partytypes = [...set].sort((a, b) => (order.indexOf(a) + 1 || 99) - (order.indexOf(b) + 1 || 99));
    return renderMain();
  }
  if (t.dataset.eRmvar !== undefined) { E.form.name_variations.splice(Number(t.dataset.eRmvar), 1); return renderMain(); }
  if (t.dataset.eLoad !== undefined) {
    const h = E.history[Number(t.dataset.eLoad)];
    const b = h.before;
    E.form = { partyname: b.partyname, industry: b.industry, partytypes: [...(b.partytypes || [])], name_variations: [...(b.name_variations || [])] };
    E.reason = `Revert to the version before the ${h.action} on ${h.at}`;
    E.preview = null;
    E.msg = { kind: 'info', text: 'Loaded that earlier version into the form. Preview, then save to apply it.' };
    return renderMain();
  }
  switch (t.dataset.eAct) {
    case 'preview': return preview();
    case 'save': return save();
    case 'reset': resetForm(); E.msg = null; return renderMain();
    case 'settings': return openSettings('publishing');
    case 'toggle-delete': return; // the open state is read from the page whenever it redraws
    case 'delete': return remove('mcl');
    case 'undeny':
      if (!E.undenyArmed) {
        E.undenyArmed = true;
        setTimeout(() => { E.undenyArmed = false; renderMain(); }, 4000);
        return renderMain();
      }
      E.undenyArmed = false;
      return remove('denied');
  }
});

view.addEventListener('input', e => {
  e.stopPropagation();
  const t = e.target;
  if (t.id === 'ed-search') {
    clearTimeout(E.searchTimer);
    E.searchTimer = setTimeout(search, 350);
    return;
  }
  if (t.dataset.eField) { E.form[t.dataset.eField] = t.value; return refreshActions(); }
  if (t.id === 'ed-reason') { E.reason = t.value; return refreshActions(); }
  if (t.id === 'ed-confirm') { E.confirm = t.value; return refreshActions(); }
});

view.addEventListener('keydown', e => {
  if (e.key === 'Enter' && e.target.id === 'ed-search') { clearTimeout(E.searchTimer); search(); }
  if (e.key === 'Enter' && e.target.id === 'ed-var-add') {
    e.preventDefault();
    addVariations(e.target.value);
    renderMain();
    $('#ed-var-add').focus();
  }
});

window.openEditor = openEditor;
window.setMode = setMode;
})();
