// Handoffs: "Ask someone" sends a row (with your edits and a note) to a teammate; their "For you"
// list picks it up; they finish it or send it back with a reply.
// Uses helpers from app.js ($, esc, api, toast, dbFetch, dbOn, S, load, go, renderAll ...), which loads first.
(function () {
'use strict';

const H = { row: null, people: [], inbox: [], lastTo: '', flag: false };
try { H.lastTo = localStorage.getItem('mclv.lastHandoffTo') || ''; } catch { /* storage blocked */ }

// ------------------------------------------------------------------ send

// Flagging (F) offers to pass the row on right away. Esc / "Just flag it" keeps it as a plain flag.
function offerOnFlag(row) {
  if (!dbOn() || S.cfg?.handoff_on_flag === false || row.handoff || isDone(row)) return;
  openHandoff(row, true);
}

async function openHandoff(row, flag = false) {
  H.row = row;
  H.flag = flag;
  const back = !!row.handoff;
  const sender = row.handoff ? (row.handoff.thread || []).filter(m => m.email).slice(-1)[0] : null;
  $('#ho-title').textContent = flag ? `Flagged “${row.current.partyName}”. Pass it to someone?`
    : back ? `Reply about “${row.current.partyName}”` : `Ask someone about “${row.current.partyName}”`;
  $('#ho-sub').textContent = flag ? 'Press Ctrl+Enter to send, or Esc to just keep it flagged. The note is optional.'
    : back ? 'Sends it back with your reply (or to someone else if you change who it goes to).' : '';
  $('[data-ho="cancel"]').textContent = flag ? 'Just flag it' : 'Cancel';
  $('[data-ho="send"]').textContent = flag ? 'Pass it on' : 'Send';
  $('#ho-note').placeholder = flag ? 'Optional: what should they look at?' : 'What do you need? e.g. not sure if this is Health Care or Personal Services';
  // your default person (Settings → Team) wins; otherwise whoever you last sent one to
  const usual = S.cfg?.handoff_default || H.lastTo;
  $('#ho-to').value = back ? (sender?.email || '') : usual;
  $('#ho-note').value = '';
  $('#handoff').hidden = false;
  (back || usual ? $('#ho-note') : $('#ho-to')).focus();
  try {
    const r = await api('/api/handoff/people');
    H.people = r.people;
    $('#ho-people').innerHTML = H.people.map(p => `<option value="${esc(p)}">${esc(r.names?.[p] || '')}</option>`).join('');
    if (!$('#ho-to').value && H.people.length === 1) { $('#ho-to').value = H.people[0]; $('#ho-note').focus(); }
  } catch { /* the list is only a convenience */ }
}

function closeHandoff() {
  $('#handoff').hidden = true;
  H.row = null;
}

async function send() {
  const row = H.row;
  const to = $('#ho-to').value.trim().toLowerCase();
  const note = $('#ho-note').value.trim();
  if (!to) return $('#ho-to').focus();
  if (!note && !H.flag) return $('#ho-note').focus();
  const btn = $('[data-ho="send"]');
  btn.disabled = true;
  try {
    await flushSaves();
    const r = await dbFetch('/api/handoff/send', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ row_id: row.id, to, note, flag: H.flag }),
    });
    Object.assign(row, { handed_off: r.row.handed_off, status: r.row.status });
    if (!row.handoff) {
      H.lastTo = to;
      try { localStorage.setItem('mclv.lastHandoffTo', to); } catch { /* fine */ }
    }
    closeHandoff();
    toast(`Sent “${row.current.partyName}” to ${r.row.handed_off.to}`, 'ok');
    if (cur() === row || !H.flag) {  // flagging already moved on to the next row
      const next = S.rows.find(x => x.status === 'pending' && !isDone(x));
      if (next) go(next.id); else renderAll();
    } else {
      renderQueue();
    }
    renderFilters();
    renderProgress();
  } catch (e) {
    toast(e.message, 'error');
  } finally {
    btn.disabled = false;
  }
}

// ------------------------------------------------------------------ inbox ("For you")

async function refreshInbox() {
  const box = $('#inbox');
  if (!dbOn() || !S.db?.connected) { box.hidden = true; return; }
  try {
    H.inbox = (await api('/api/handoff/inbox')).items;
  } catch {
    return;
  }
  // a row already open in my queue isn't "new"
  const inQueue = new Set(S.rows.filter(r => r.handoff && !isDone(r)).map(r => r.handoff.id));
  const waiting = H.inbox.filter(i => !inQueue.has(i.id));
  box.hidden = !waiting.length;
  $('#inbox-btn').textContent = `📨 ${waiting.length} for you`;
  $('#inbox-list').innerHTML = waiting.map(i => `<a href="#" data-ho-open="${esc(i.id)}">
      <b>${esc(i.partyname)}</b>
      <span class="muted small">from ${esc(i.last_by || i.from)} · ${esc(i.updated)}</span>
      <span class="small">“${esc(i.last_text || '')}”</span></a>`).join('');
}

async function take(id) {
  $('#inbox-list').hidden = true;
  try {
    const st = await dbFetch('/api/handoff/take', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }),
    });
    if (S.mode !== 'review') setMode('review');
    load(st);
    go(st.row_id);
    toast('Added to your queue with their notes', 'ok');
  } catch (e) {
    toast(e.message, 'error');
  }
  refreshInbox();
}

// ------------------------------------------------------------------ events

$('#handoff').addEventListener('click', e => {
  e.stopPropagation();
  if (e.target.id === 'handoff') return closeHandoff();
  const a = e.target.closest('[data-ho]')?.dataset.ho;
  if (a === 'cancel') return closeHandoff();
  if (a === 'send') return send();
});
$('#handoff').addEventListener('keydown', e => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); send(); }
});

$('#inbox-btn').addEventListener('click', e => {
  e.stopPropagation();
  $('#inbox-list').hidden = !$('#inbox-list').hidden;
});
$('#inbox-list').addEventListener('click', e => {
  e.preventDefault();
  e.stopPropagation();
  const a = e.target.closest('[data-ho-open]');
  if (a) take(a.dataset.hoOpen);
});
document.addEventListener('click', e => {
  if (!e.target.closest('#inbox')) $('#inbox-list').hidden = true;
});

setInterval(refreshInbox, 2 * 60 * 1000);

window.openHandoff = openHandoff;
window.offerOnFlag = offerOnFlag;
window.closeHandoff = closeHandoff;
window.refreshInbox = refreshInbox;
})();
