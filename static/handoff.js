// "Make it a ticket": flagging a row (F) or Ticket… (H) moves it out of your queue onto the shared Tickets
// board, with a note and the turn handed to a teammate. The board itself is tickets.js.
// Uses helpers from app.js ($, esc, api, toast, dbFetch, dbOn, S, ...), which loads first.
(function () {
'use strict';

const H = { row: null, flag: false, lastTo: '' };
try { H.lastTo = localStorage.getItem('mclv.lastHandoffTo') || ''; } catch { /* storage blocked */ }

// Flagging offers to make a ticket right away. Esc / "Just flag it" keeps it as a plain flag.
function offerOnFlag(row) {
  if (!dbOn() || S.cfg?.handoff_on_flag === false || row.ticket || isDone(row)) return;
  openHandoff(row, true);
}

async function openHandoff(row, flag = false) {
  if (row.ticket) return window.focusTicketComposer?.();
  H.row = row;
  H.flag = flag;
  $('#ho-title').textContent = flag ? `Flagged “${row.current.partyName}”. Make it a ticket?` : `Make “${row.current.partyName}” a ticket`;
  $('#ho-sub').textContent = flag ? 'Ctrl+Enter makes the ticket; Esc keeps it as a plain flag in your queue. The note is optional.' : '';
  $('[data-ho="cancel"]').textContent = flag ? 'Just flag it' : 'Cancel';
  $('[data-ho="send"]').textContent = 'Make ticket';
  $('#ho-note').placeholder = flag ? 'Optional: what should they look at?' : 'What do you need? e.g. not sure if this is Health Care or Personal Services';
  $('#ho-note').value = '';
  const usual = S.cfg?.handoff_default || H.lastTo;
  const team = (S.cfg?.team || []).filter(p => p.email && p.email !== S.me);
  const opts = list => list.map(p => `<option value="${esc(p.email)}" ${p.email === usual ? 'selected' : ''}>${esc(p.name || p.email)}</option>`).join('');
  $('#ho-to').innerHTML = opts(team);
  $('#handoff').hidden = false;
  $('#ho-note').focus();
  try {  // anyone else who has used the app, after the team
    const r = await api('/api/handoff/people');
    S.me = r.me || S.me;
    const known = new Set(team.map(p => p.email));
    const extra = r.people.filter(p => !known.has(p) && p !== S.me).map(p => ({ email: p, name: r.names?.[p] || p }));
    const keep = $('#ho-to').value;
    $('#ho-to').innerHTML = opts(team.filter(p => p.email !== S.me)) + (extra.length ? `<optgroup label="Others">${opts(extra)}</optgroup>` : '');
    if (keep) $('#ho-to').value = keep;
  } catch { /* the team list is enough */ }
}

function closeHandoff() {
  $('#handoff').hidden = true;
  H.row = null;
}

async function send() {
  const row = H.row;
  const to = $('#ho-to').value;
  const note = $('#ho-note').value.trim();
  if (!to) return toast('Add teammates in Settings → Team first.', 'error');
  if (!note && !H.flag) return $('#ho-note').focus();
  const btn = $('[data-ho="send"]');
  btn.disabled = true;
  try {
    await flushSaves();
    const r = await dbFetch('/api/tickets', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ row_id: row.id, to, note, flag: H.flag }),
    });
    Object.assign(row, { ticketed: r.row.ticketed, status: r.row.status });
    H.lastTo = to;
    try { localStorage.setItem('mclv.lastHandoffTo', to); } catch { /* fine */ }
    closeHandoff();
    toastAction(`“${row.current.partyName}” is a ticket now. ${r.row.ticketed.to}'s turn.`, 'Open', () => window.openTicket?.(r.ticket_id), 8000);
    if (cur() === row || !H.flag) {  // flagging already moved on to the next row
      const next = S.rows.find(x => x.status === 'pending' && !isDone(x));
      if (next) go(next.id); else renderAll();
    } else {
      renderQueue();
    }
    renderFilters();
    renderProgress();
    window.refreshTickets?.();
  } catch (e) {
    toast(e.message, 'error');
  } finally {
    btn.disabled = false;
  }
}

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

window.openHandoff = openHandoff;
window.offerOnFlag = offerOnFlag;
window.closeHandoff = closeHandoff;
})();
