// Publish window: preview (dry run) → test on a copy of the MCL → publish.
// Uses helpers from app.js ($, esc, api, toast, dbFetch, S, go, renderAll ...), which loads first.
(function () {
'use strict';

const P = { plan: null, result: null, busy: '', armed: false, armTimer: null, open: { problem: true } };

const ACTION = {
  problem: { title: 'Problems (left out)', hint: 'Fix these and preview again, or leave them for later.' },
  insert: { title: 'New MCL entries', hint: '' },
  merge: { title: 'Updates to existing MCL entries', hint: 'Like the batch notebook: variations are merged, the industry is updated, party types are kept.' },
  deny: { title: 'Added to the denied list', hint: 'They stop showing up in the New-to-MCL queue.' },
  skip: { title: 'Nothing to do', hint: '' },
};

function pendingCount() {
  return S.rows.filter(r => !r.published && (r.status === 'approved' || r.status === 'denied')).length;
}

// called by app.js whenever counts change
function updatePublishButton() {
  const btn = $('#btn-publish');
  if (!btn) return;
  const n = pendingCount();
  btn.hidden = !dbOn() || (n === 0 && S.cfg?.publish?.auto && S.cfg?.publish?.dry_run === false);
  btn.textContent = `Publish to MCL (${n})`;
  btn.disabled = n === 0;
  btn.title = n ? 'Preview, test and publish approved and denied rows' : 'Approve or deny rows first';
  // with Databricks on, publishing is the main action and the CSV export steps back
  $('#exp-approved').classList.toggle('primary', !dbOn());
}

async function openPublish() {
  $('#publish').hidden = false;
  P.result = null;
  await preview();
}

function closePublish() {
  if (P.busy) return;
  $('#publish').hidden = true;
  disarm();
}

async function preview(note) {
  P.busy = 'Checking every row against the MCL…';
  P.plan = null;
  render();
  try {
    await flushSaves();
    P.plan = await dbFetch('/api/publish/preview', { method: 'POST' });
  } catch (e) {
    P.error = e.message;
  }
  P.busy = '';
  render(note);
}

async function runTest() {
  if (!P.plan) return;
  P.busy = 'Copying the MCL and running the publish against the copy…';
  P.result = null;
  render();
  try {
    P.result = await dbFetch('/api/publish/test', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ plan_id: P.plan.plan_id }),
    });
  } catch (e) {
    P.busy = '';
    if (/changed since the preview/.test(e.message)) return preview('Something changed since the preview, so it was refreshed. Check it and test again.');
    P.result = { mode: 'test', errors: [e.message], warnings: [], verify: [] };
  }
  P.busy = '';
  render();
}

function disarm() {
  P.armed = false;
  clearTimeout(P.armTimer);
}

async function runPublish() {
  if (!P.plan) return;
  if (!P.armed) { // two clicks: this writes to the live MCL
    P.armed = true;
    P.armTimer = setTimeout(() => { P.armed = false; render(); }, 5000);
    return render();
  }
  disarm();
  P.busy = 'Publishing to the MCL…';
  P.result = null;
  render();
  try {
    const res = await dbFetch('/api/publish/run', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ plan_id: P.plan.plan_id }),
    });
    if (res.state_rows) {
      Object.assign(S, { dbMatch: {}, mcl: {}, mclTerm: {} }); // MCL lookups from before the publish are stale
      for (const r of res.state_rows) if (S.rows[r.id]) S.rows[r.id].published = r.published || null;
      renderAll();
    }
    P.busy = '';
    const lastResult = res;
    await preview();
    P.result = lastResult;
    render();
    toast(res.errors.length ? 'Publish finished with errors' : 'Published to the MCL', res.errors.length ? 'error' : 'ok');
  } catch (e) {
    P.busy = '';
    if (/changed since the preview/.test(e.message)) return preview('Something changed since the preview, so it was refreshed. Check it before publishing.');
    P.result = { mode: 'publish', errors: [e.message], warnings: [], verify: [] };
    render();
  }
}

// ------------------------------------------------------------------ rendering

function resultHTML(res) {
  if (!res) return '';
  const test = res.mode === 'test';
  const m = res.mcl || {}, d = res.denied || {};
  const parts = [];
  if (res.mcl) parts.push(`${m.num_inserted_rows ?? 0} inserted, ${m.num_updated_rows ?? 0} updated`);
  if (res.denied) parts.push(`${d.num_inserted_rows ?? d.num_affected_rows ?? 0} added to the denied list`);
  const ok = !res.errors.length && !res.verify.length;
  const head = test
    ? (ok ? 'Test passed on a copy of the MCL.' : 'The test found problems.')
    : (ok ? 'Published to the MCL.' : 'Publishing finished with problems.');
  return `<div class="pub-result ${ok ? 'ok' : 'bad'}">
    <b>${head}</b> ${esc(parts.join(' · '))}${ok ? '. Read back and matched the preview.' : ''}
    ${test && res.sandbox ? `<div class="muted small">Ran against <span class="mono">${esc(res.sandbox.mcl)}</span> and
      <span class="mono">${esc(res.sandbox.denied)}</span>. The real tables weren't touched.</div>` : ''}
    ${[...res.errors, ...res.verify].map(x => `<div class="check error">${esc(x)}</div>`).join('')}
    ${res.warnings.map(x => `<div class="check warn">${esc(x)}</div>`).join('')}
  </div>`;
}

function itemHTML(it) {
  const lines = [
    ...it.problems.map(x => `<div class="check error">${esc(x)}</div>`),
    ...it.changes.map(x => `<div class="pub-change">${esc(x)}</div>`),
    ...it.info.map(x => `<div class="muted small">${esc(x)}</div>`),
  ];
  let what = '';
  if (it.action === 'insert') what = `${esc(it.after.industry)} · <span class="mono">${esc(it.after.partytypes.join(','))}</span>
    <div class="muted small">${esc(it.after.name_variations.join(' | '))}</div>`;
  if (it.action === 'merge') what = `into <b>${esc(it.target)}</b>`;
  return `<li>
    <div class="pub-item-head"><button class="link-btn" data-pub-row="${it.row_id}" title="Go to row ${it.row_id + 1}">${esc(it.name)}</button>
      <span class="muted small">row ${it.row_id + 1}</span> ${what}</div>
    ${lines.join('')}</li>`;
}

function render(note) {
  const body = $('#pub-body');
  const plan = P.plan;
  const dry = plan ? plan.dry_run : true;
  const writes = plan ? plan.counts.insert + plan.counts.merge + plan.counts.deny : 0;

  let html = '';
  if (P.busy) html = `<p class="pub-busy">${esc(P.busy)}</p>`;
  else if (!plan) html = `<div class="check error">${esc(P.error || 'Couldn\'t build the preview.')}</div>`;
  else {
    const c = plan.counts;
    html += dry ? `<div class="pub-mode">Dry run mode is on. You can preview and test, but nothing is written to the real MCL.
      Turn it off in <button class="link-btn" data-pub="settings">Settings → Publishing</button> when you're ready.</div>` : '';
    html += note ? `<div class="check warn">${esc(note)}</div>` : '';
    html += resultHTML(P.result);
    html += `<div class="pub-summary">
      <span><b>${c.insert}</b> new</span><span><b>${c.merge}</b> updates</span><span><b>${c.deny}</b> to denied list</span>
      <span class="muted"><b>${c.skip}</b> nothing to do</span>${c.problem ? `<span class="bad"><b>${c.problem}</b> with problems</span>` : ''}</div>`;
    if (!plan.items.length) html += '<p class="muted">No approved or denied rows waiting to publish.</p>';
    for (const action of ['problem', 'insert', 'merge', 'deny', 'skip']) {
      const items = plan.items.filter(it => it.action === action);
      if (!items.length) continue;
      // problems always start open; other groups only when they're short
      const open = P.open[action] ?? (action === 'problem' || (action !== 'skip' && items.length <= 5));
      html += `<details class="pub-group ${action}" data-group="${action}" ${open ? 'open' : ''}>
        <summary><b>${ACTION[action].title}</b> <span class="muted">(${items.length})</span>
          ${ACTION[action].hint ? `<span class="muted small"> · ${esc(ACTION[action].hint)}</span>` : ''}</summary>
        <ul class="pub-list">${items.map(itemHTML).join('')}</ul></details>`;
    }
  }
  body.innerHTML = html;

  const busy = !!P.busy;
  $('[data-pub="preview"]').disabled = busy;
  $('[data-pub="test"]').disabled = busy || !writes;
  const run = $('[data-pub="run"]');
  run.disabled = busy || !writes || dry;
  run.classList.toggle('armed', P.armed);
  run.textContent = P.armed ? `Click again to publish ${writes} to the live MCL` : `Publish ${writes} change${writes === 1 ? '' : 's'}`;
  run.title = dry ? 'Dry run mode is on (Settings → Publishing)' : '';
  $('#pub-msg').textContent = busy ? '' : (plan && writes ? (dry ? 'Dry run mode: publishing is locked.' : '') : '');
}

// ------------------------------------------------------------------ events

$('#btn-publish').addEventListener('click', openPublish);

$('#publish').addEventListener('click', e => {
  e.stopPropagation();
  if (e.target.id === 'publish') return closePublish();
  const t = e.target.closest('button, summary');
  if (!t) return;
  if (t.tagName === 'SUMMARY') {
    const g = t.parentElement;
    setTimeout(() => { P.open[g.dataset.group] = g.open; });
    return;
  }
  const a = t.dataset.pub;
  if (a === 'close') return closePublish();
  if (a === 'preview') { P.result = null; return preview(); }
  if (a === 'test') return runTest();
  if (a === 'run') return runPublish();
  if (a === 'settings') { closePublish(); return openSettings('publishing'); }
  if (t.dataset.pubRow !== undefined) { closePublish(); return go(Number(t.dataset.pubRow)); }
});

window.openPublish = openPublish;
window.closePublish = closePublish;
window.updatePublishButton = updatePublishButton;
})();
