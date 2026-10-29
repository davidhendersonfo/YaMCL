// Add to MCL: create a brand-new MCL entry by hand, for callers that never came through the queue.
// Same rules as the manual-insert notebook: the name can't already be an entry or a variation, and
// name variations are generated automatically (case versions and & <-> "and"), editable as chips.
// Uses helpers from app.js ($, esc, toast, dbFetch, dbOn, S, collapse ...), which loads first.
(function () {
'use strict';

const blank = () => ({ partyname: '', industry: '', partytypes: [], name_variations: [] });
const A = {
  form: blank(), autoVars: true, typesTouched: false, phones: '', reason: '',
  check: null, checkOf: '', checking: false, checkTimer: null, busy: '', msg: null, added: null,
};
const dryRun = () => S.cfg?.publish?.dry_run !== false;
const formKey = () => JSON.stringify([A.form, A.phones]);

// The manual-insert notebook's variation rules, unchanged.
function genVariations(name) {
  name = collapse(name);
  if (!name) return [];
  const out = new Set();
  const isUpper = name === name.toUpperCase();
  const isLower = name === name.toLowerCase();
  const cases = v => {
    if (isUpper) out.add(v.toLowerCase());
    else if (isLower) out.add(v.toUpperCase());
    else { out.add(v.toLowerCase()); out.add(v.toUpperCase()); }
  };
  cases(name);
  if (name.includes('&')) {
    const andVersion = name.split('&').join('and');
    out.add(andVersion);
    cases(andVersion);
  }
  if (/\band\b/i.test(name)) {
    const ampVersion = name.replace(/\band\b/gi, '&');
    if (ampVersion !== name) { out.add(ampVersion); cases(ampVersion); }
  }
  out.delete(name);
  return [...out].sort();
}

function industryNames() {
  return [...new Set([...Object.keys(S.cfg.industry_ids || {}), ...Object.keys(S.cfg.industries || {})])].sort();
}

// ------------------------------------------------------------------ rendering

function renderAdd() {
  const el = $('#add-view');
  if (!el || S.mode !== 'add') return;
  const f = A.form;
  const dry = dryRun();
  const c = A.check;
  const fresh = c && A.checkOf === formKey();
  const canAdd = fresh && !c.problems.length && !dry && !A.busy;
  const codes = [...new Set([...Object.keys(S.cfg.partytypes || {}), ...f.partytypes])];
  const filterable = S.cfg.filterable || [];

  if (A.added) {
    el.innerHTML = `<div class="add-card">
      <div class="pub-result ok"><b>Added “${esc(A.added.partyname)}” to the MCL.</b>
        ${esc(A.added.industry)} · <span class="mono">${esc(A.added.partytypes.join(','))}</span>
        <div class="muted small">${esc(A.added.name_variations.join(' | '))}</div></div>
      ${(A.msg?.warnings || []).map(w => `<div class="check warn">${esc(w)}</div>`).join('')}
      <div class="ed-actions">
        <button class="btn primary" data-a-act="another">Add another</button>
        <button class="btn" data-a-act="open">Open it in the MCL editor</button>
      </div></div>`;
    return;
  }

  const row = fresh && !c.problems.length ? c.after : null;
  el.innerHTML = `<div class="add-card">
    <h1>Add a new MCL entry</h1>
    <p class="muted">For callers that never came through the New-to-MCL queue. The same checks as the manual-insert
      notebook run before anything is written, and the addition is logged.</p>
    ${dry ? `<div class="pub-mode">Dry run mode is on: you can check an entry but not add it.
      Turn it off in <button class="link-btn" data-a-act="settings">Settings → Publishing</button>.</div>` : ''}
    ${A.msg?.error ? `<div class="check error">${esc(A.msg.error)}</div>` : ''}
    <div class="ed-form">
      <div class="field"><label for="add-name">Party name</label>
        <input id="add-name" data-a-field="partyname" value="${esc(f.partyname)}" placeholder="Exactly as the business writes it" autocomplete="off" spellcheck="false"></div>
      <div class="field"><label for="add-industry">Industry</label>
        <input id="add-industry" data-a-field="industry" list="add-industry-list" value="${esc(f.industry)}" autocomplete="off">
        <datalist id="add-industry-list">${industryNames().map(i => `<option value="${esc(i)}">`).join('')}</datalist></div>
      <div class="field"><label>Party types ${A.typesTouched ? '' : '<span class="muted small">(the industry\'s defaults until you change them)</span>'}</label>
        <div class="pts">${codes.map(code => `<button class="pt ${f.partytypes.includes(code) ? 'on' : ''} ${filterable.includes(code) ? 'risky' : ''}"
          data-a-pt="${esc(code)}" title="${esc(S.cfg.partytypes?.[code] || code)}"><b>${esc(code)}</b>${S.cfg.partytypes?.[code] ? `<span>${esc(S.cfg.partytypes[code])}</span>` : ''}</button>`).join('')}</div></div>
      <div class="field"><label>Name variations
        <span class="muted small">${A.autoVars ? 'generated from the name' : 'edited by hand'}</span>
        ${A.autoVars ? '' : '<button class="link-btn" data-a-act="regen">Regenerate from the name</button>'}</label>
        <div class="vars">${f.name_variations.length ? f.name_variations.map((v, i) => `<span class="var"><span class="var-text">${esc(v)}</span>
          <button data-a-rmvar="${i}" title="Remove">×</button></span>`).join('') : '<span class="muted small">None yet</span>'}</div>
        <input id="add-var" placeholder="Add a variation (pipe-separated lists work too) and press Enter" autocomplete="off" spellcheck="false"></div>
      <div class="field"><label for="add-phones">Phone numbers <span class="muted small">(optional, saved in the change log)</span></label>
        <input id="add-phones" value="${esc(A.phones)}" placeholder="e.g. 5099405838, 5099676737" autocomplete="off"></div>
      <div class="field"><label for="add-reason">Notes <span class="muted small">(optional, saved in the change log)</span></label>
        <input id="add-reason" value="${esc(A.reason)}" placeholder="e.g. found on honeypot, verified by greeting" autocomplete="off"></div>
    </div>
    ${c ? `<div class="ed-preview ${fresh ? '' : 'stale'}">
      <b>${A.checking ? 'Checking…' : fresh ? (c.problems.length ? 'Can\'t add this yet' : 'Ready to add') : 'Out of date: checking again…'}</b>
      ${c.problems.map(x => `<div class="check error">${esc(x)}</div>`).join('')}
      ${c.warnings.map(x => `<div class="check warn">${esc(x)}</div>`).join('')}
      ${row ? `<table class="add-row"><tr><th>partyname</th><th>industry_name</th><th>industryId</th><th>partytypes</th><th>name_variations</th><th>insertDate</th></tr>
        <tr><td>${esc(row.partyname)}</td><td>${esc(row.industry)}</td><td>${esc(row.industryId)}</td>
        <td class="mono">${esc(JSON.stringify(row.partytypes))}</td><td class="mono">${esc(JSON.stringify(row.name_variations))}</td><td>today</td></tr></table>` : ''}
    </div>` : ''}
    <div class="ed-actions">
      <button class="btn primary" data-a-act="add" ${canAdd ? '' : 'disabled'}
        title="${dry ? 'Dry run mode is on' : !fresh ? 'Waiting for the check' : ''}">Add to the MCL</button>
      <button class="btn ghost" data-a-act="clear">Clear</button>
      ${A.busy ? `<span class="muted small">${esc(A.busy)}</span>` : ''}
    </div></div>`;
}

function refreshKeepingFocus() {
  const el = document.activeElement;
  const id = el?.id, pos = el?.selectionStart;
  renderAdd();
  if (id && $(`#${id}`)) {
    const f = $(`#${id}`);
    f.focus();
    if (pos != null && f.setSelectionRange) f.setSelectionRange(pos, pos);
  }
}

// ------------------------------------------------------------------ checking & adding

// Checks run by themselves shortly after you stop typing, so "already in the MCL" shows up early.
function scheduleCheck() {
  clearTimeout(A.checkTimer);
  if (collapse(A.form.partyname).length < 3 || !A.form.industry) return;
  A.checkTimer = setTimeout(runCheck, 600);
}

async function runCheck() {
  const of = formKey();
  A.checking = true;
  refreshKeepingFocus();
  try {
    const r = await dbFetch('/api/add/preview', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ entry: A.form, phones: A.phones }),
    });
    if (of !== formKey()) return; // something changed while checking; a newer check is coming
    A.check = r;
    A.checkOf = of;
  } catch (e) {
    A.msg = { error: e.message };
  } finally {
    A.checking = false;
    refreshKeepingFocus();
  }
}

async function addIt() {
  A.busy = 'Adding…';
  renderAdd();
  try {
    const r = await dbFetch('/api/add/save', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ entry: A.form, phones: A.phones, reason: A.reason }),
    });
    A.added = r.entry;
    A.msg = { warnings: [...(r.warnings || []), ...(r.verify || [])] };
    Object.assign(S, { dbMatch: {}, mcl: {}, mclTerm: {} }); // MCL lookups in the review queue are stale now
    toast(`Added “${r.entry.partyname}” to the MCL`, 'ok');
  } catch (e) {
    A.msg = { error: e.message };
  }
  A.busy = '';
  renderAdd();
}

function reset() {
  Object.assign(A, { form: blank(), autoVars: true, typesTouched: false, phones: '', reason: '',
                     check: null, checkOf: '', msg: null, added: null });
  renderAdd();
  $('#add-name')?.focus();
}

function changed() {
  A.msg = null;
  scheduleCheck();
}

// ------------------------------------------------------------------ events

const view = $('#add-view');

view.addEventListener('click', e => {
  e.stopPropagation();
  const t = e.target.closest('button');
  if (!t) return;
  if (t.dataset.aPt) {
    const set = new Set(A.form.partytypes);
    set.has(t.dataset.aPt) ? set.delete(t.dataset.aPt) : set.add(t.dataset.aPt);
    const order = Object.keys(S.cfg.partytypes || {});
    A.form.partytypes = [...set].sort((a, b) => (order.indexOf(a) + 1 || 99) - (order.indexOf(b) + 1 || 99));
    A.typesTouched = true;
    changed();
    return renderAdd();
  }
  if (t.dataset.aRmvar !== undefined) {
    A.form.name_variations.splice(Number(t.dataset.aRmvar), 1);
    A.autoVars = false;
    changed();
    return renderAdd();
  }
  switch (t.dataset.aAct) {
    case 'add': return addIt();
    case 'clear': case 'another': return reset();
    case 'open': return openEditor(A.added.partyname);
    case 'settings': return openSettings('publishing');
    case 'regen':
      A.autoVars = true;
      A.form.name_variations = genVariations(A.form.partyname);
      changed();
      return renderAdd();
  }
});

view.addEventListener('input', e => {
  e.stopPropagation();
  const t = e.target;
  if (t.dataset.aField === 'partyname') {
    A.form.partyname = t.value;
    if (A.autoVars) A.form.name_variations = genVariations(t.value);
  } else if (t.dataset.aField === 'industry') {
    A.form.industry = t.value;
    const defaults = S.cfg.industries?.[collapse(t.value)]?.default_partytypes;
    if (!A.typesTouched && defaults) A.form.partytypes = [...defaults];
  } else if (t.id === 'add-phones') {
    A.phones = t.value;
  } else if (t.id === 'add-reason') {
    A.reason = t.value;
    return; // notes don't affect the check
  } else {
    return;
  }
  changed();
  refreshKeepingFocus();
});

view.addEventListener('keydown', e => {
  if (e.key === 'Enter' && e.target.id === 'add-var') {
    e.preventDefault();
    for (const v of e.target.value.split('|').map(x => x.trim()).filter(Boolean)) {
      if (!A.form.name_variations.includes(v)) A.form.name_variations.push(v);
    }
    A.autoVars = false;
    changed();
    renderAdd();
    $('#add-var').focus();
  }
});

window.renderAdd = renderAdd;
})();
