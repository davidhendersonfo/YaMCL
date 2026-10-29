// Tickets: the shared board. Each ticket is one caller the team is working out together: a conversation,
// a log of every change, and whose turn it is. Rows are researched and edited in the review screen
// ("Open in review"); posting from there shares the edits. Publishing the row resolves the ticket.
// Uses helpers from app.js ($, esc, dbFetch, toast, toastAction, dbOn, S, load, go, flushSaves, ...).
(function () {
'use strict';

const TK = { items: [], counts: {}, filter: null, q: '', sel: null, detail: {}, loaded: false, error: '',
  yourTurnIds: null, drafts: {} };
const FILTERS = [['turn', 'Your turn'], ['updated', 'Updated'], ['open', 'All open'], ['resolved', 'Resolved']];
const RES_LABEL = { added: '✓ Added', merged: '✓ Merged', denied: '✓ Denied', 'up to date': '✓ Up to date',
  released: 'Back in the pool', closed: 'Closed' };

const when = iso => {
  if (!iso) return '';
  const t = new Date(iso);
  const mins = Math.round((Date.now() - t) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  if (mins < 24 * 60) return `${Math.round(mins / 60)}h ago`;
  return t.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
};
const stamp = iso => String(iso || '').replace('T', ' ').slice(0, 16);

// ------------------------------------------------------------------ loading

async function refreshTickets(quiet = true) {
  if (!dbOn() || !S.db?.connected) { $('#tk-count').hidden = true; return; }
  try {
    const r = await dbFetch(`/api/tickets${TK.q ? `?q=${encodeURIComponent(TK.q)}` : ''}`);
    S.me = r.me;
    TK.items = r.items;
    TK.counts = r.counts;
    TK.error = '';
    TK.loaded = true;
    notifyNew(r.items);
  } catch (e) {
    TK.error = e.message;
    if (!quiet) toast(e.message, 'error');
  }
  renderBadge();
  if (S.mode === 'tickets') renderBoard();
}

// A toast when something lands on your plate while you're elsewhere
function notifyNew(items) {
  const mine = new Set(items.filter(i => i.your_turn).map(i => i.id));
  if (TK.yourTurnIds) {
    const fresh = items.filter(i => i.your_turn && !TK.yourTurnIds.has(i.id) && i.last && i.last.by !== meName());
    if (fresh.length === 1) {
      const i = fresh[0];
      toastAction(`${i.last.by} passed you “${i.partyname}”`, 'Open', () => openTicket(i.id), 10000);
    } else if (fresh.length > 1) {
      toastAction(`${fresh.length} tickets are your turn`, 'Open', () => { TK.filter = 'turn'; setMode('tickets'); }, 10000);
    }
  }
  TK.yourTurnIds = mine;
}

const meName = () => (S.cfg?.team || []).find(p => p.email === S.me)?.name || String(S.me || '').split('@')[0];

function renderBadge() {
  const el = $('#tk-count');
  const c = TK.counts || {};
  const n = (c.your_turn || 0) + (c.updated || 0);
  el.hidden = !n;
  el.textContent = n;
  el.className = `tab-count ${c.your_turn ? 'hot' : ''}`;
  el.title = [c.your_turn ? `${c.your_turn} your turn` : '', c.updated ? `${c.updated} updated since you looked` : ''].filter(Boolean).join(', ');
}

async function loadDetail(id, rerender = true) {
  try {
    const d = await dbFetch(`/api/tickets/${encodeURIComponent(id)}`);
    TK.detail[id] = d;
    S.me = d.me;
    const item = TK.items.find(i => i.id === id);
    if (item) Object.assign(item, { unread: false });
    TK.counts.updated = TK.items.filter(i => i.unread && !i.your_turn).length;
    syncWorkingCopy(d);
    renderBadge();
  } catch (e) {
    TK.detail[id] = { error: e.message };
  }
  if (rerender) rerenderWhereShown(id);
}

// keep the review queue's copy of the row in step (the server already updated its saved state)
function syncWorkingCopy(d) {
  const wc = d.working_copy;
  if (!wc) return;
  const row = S.rows[wc.row_id];
  if (!row || row.ticket?.id !== d.id) return;
  const before = JSON.stringify([row.current, row.ticket?.closed, row.ticket?.turn, row.ticket?.stale]);
  row.ticket = wc.ticket;
  row.current = wc.current;
  const after = JSON.stringify([row.current, row.ticket?.closed, row.ticket?.turn, row.ticket?.stale]);
  if (after !== before && cur() === row && S.mode === 'review') { renderEntity(); renderQueue(); }
}

function applyRows(rows) {
  if (!rows) return;
  for (const r of rows) if (S.rows[r.id]) Object.assign(S.rows[r.id], r);
}

function rerenderWhereShown(id) {
  if (S.mode === 'tickets' && TK.sel === id) renderMain();
  const row = cur();
  if (S.mode === 'review' && row?.ticket?.id === id) fillBanner(row);
}

// ------------------------------------------------------------------ board

function showTickets() {
  if (!TK.filter) TK.filter = (TK.counts.your_turn ? 'turn' : 'open');
  renderBoard();
  refreshTickets();
}

function inView(i) {
  switch (TK.filter) {
    case 'turn': return i.your_turn;
    case 'updated': return i.unread;
    case 'resolved': return i.status !== 'open';
    default: return i.status === 'open';
  }
}

function renderBoard() {
  const c = TK.counts || {};
  const n = { turn: c.your_turn || 0, updated: TK.items.filter(i => i.unread).length, open: c.open || 0,
    resolved: TK.items.filter(i => i.status !== 'open').length };
  $('#tk-filters').innerHTML = FILTERS.map(([k, label]) =>
    `<button class="chip-filter ${TK.filter === k ? 'on' : ''}" data-tk-filter="${k}">${label} <b>${n[k]}</b></button>`).join('');
  const items = TK.items.filter(inView);
  $('#tk-list').innerHTML = TK.error ? `<li class="empty">${esc(TK.error)}</li>`
    : !TK.loaded ? '<li class="empty">Loading tickets…</li>'
    : items.length ? items.map(itemHTML).join('')
    : `<li class="empty">${{ turn: 'Nothing is waiting on you.', updated: 'Nothing new since you last looked.',
        open: 'No open tickets. Flag a row (F) to start one.', resolved: 'No resolved tickets in the last 60 days. Search to find older ones.' }[TK.filter]}</li>`;
  if (!TK.sel || !TK.items.some(i => i.id === TK.sel)) TK.sel = items[0]?.id || null;
  renderMain();
}

function itemHTML(i) {
  const tag = i.status !== 'open' ? `<span class="tk-tag done">${esc(RES_LABEL[i.resolution] || 'Resolved')}</span>`
    : i.your_turn ? '<span class="tk-tag mine">Your turn</span>'
    : `<span class="tk-tag">${esc(i.turn_name || '—')}</span>`;
  const last = i.last ? `${esc(i.last.by)}: ${esc(i.last.text || '')}` : '';
  return `<li class="tk-item ${TK.sel === i.id ? 'active' : ''} ${i.unread ? 'unread' : ''}" data-tk-open="${esc(i.id)}">
    <span class="dot ${i.status !== 'open' ? '' : i.your_turn ? 'mine' : 'theirs'} tk-dot"></span>
    <span class="q-name">${esc(i.proposed?.partyName || i.partyname)}</span>${tag}
    <span class="tk-last">${last}</span>
    <span class="tk-when">${esc(when(i.last?.at || i.updated_at))}${i.count > 1 ? ` · ${i.count}` : ''}</span></li>`;
}

function renderMain() {
  const el = $('#tk-main');
  if (!TK.sel) {
    el.innerHTML = `<div class="tk-empty"><h2>🎫 Tickets</h2>
      <p class="muted">When you flag a row (or press H), it becomes a ticket here: a conversation the whole team can see,
      a log of every change, and whose turn it is. Publishing the row closes it.</p></div>`;
    return;
  }
  const d = TK.detail[TK.sel];
  if (!d) { el.innerHTML = '<p class="muted">Loading…</p>'; loadDetail(TK.sel); return; }
  if (d.error) { el.innerHTML = `<div class="check error">${esc(d.error)}</div>`; return; }
  el.innerHTML = detailHTML(d);
  restoreDraft(el, d.id);
}

function turnChip(d) {
  if (d.status !== 'open') return `<span class="tk-turn done">${esc(RES_LABEL[d.resolution] || 'Resolved')}${d.resolved_by ? ` by ${esc(d.resolved_by)}` : ''}</span>`;
  return d.your_turn ? '<span class="tk-turn mine">Your turn</span>' : `<span class="tk-turn">${esc(d.turn_name)}'s turn</span>`;
}

function proposedHTML(d) {
  const o = d.row?.original || {};
  const c = d.row?.current || {};
  const line = (label, now, was) => {
    const changed = JSON.stringify(now) !== JSON.stringify(was);
    const show = v => Array.isArray(v) ? (v.length ? v.map(esc).join(', ') : '<span class="muted">none</span>') : (v ? esc(v) : '<span class="muted">blank</span>');
    return `<dt>${label}</dt><dd>${show(now)}${changed && was !== undefined ? ` <span class="tk-was">was ${show(was)}</span>` : ''}</dd>`;
  };
  return `<dl class="tk-dl">
    ${line('Name', c.partyName, o.partyName)}
    ${line('Industry', c.industry, o.industry)}
    ${line('Party types', c.partyTypes || [], o.partyTypes)}
    ${line('Variations', c.name_variations || [], o.name_variations)}
    ${c.notes ? line('Notes', c.notes, o.notes) : ''}
  </dl>`;
}

function detailHTML(d) {
  const phones = (d.phones || []).slice(0, 6);
  const opened = d.events?.[0];
  const actions = d.status === 'open' ? `
      <button class="btn primary" data-tk="work" data-tk-id="${esc(d.id)}">Open in review</button>
      ${d.your_turn ? '' : `<button class="btn" data-tk="take" data-tk-id="${esc(d.id)}">Take the turn</button>`}
      <span class="spacer"></span>
      <button class="btn ghost" data-tk="release" data-tk-id="${esc(d.id)}" title="Close the ticket and put the name back in the queue for anyone">Send back to the pool</button>
      <button class="btn ghost" data-tk="close" data-tk-id="${esc(d.id)}" title="Close the ticket without publishing anything">Close, nothing to do</button>`
    : ['released', 'closed'].includes(d.resolution) ? `<button class="btn" data-tk="reopen" data-tk-id="${esc(d.id)}">Reopen</button>` : '';
  return `<div class="tk-detail">
    <div class="entity-head">
      <div>
        <div class="eyebrow">Ticket · opened by ${esc(d.created_by)} ${opened ? esc(when(opened.at)) : ''} · with ${esc(d.participants.join(', '))}</div>
        <h1>${esc(d.row?.current?.partyName || d.partyname)}</h1>
        <div class="phones">${phones.map(p => `<span class="phone-wrap"><a class="phone" href="${telUrl(p)}">${esc(fmtPhone(p))}</a></span>`).join('')}
          ${(d.phones || []).length > 6 ? `<span class="muted small">+${d.phones.length - 6} more</span>` : ''}</div>
      </div>
      ${turnChip(d)}
    </div>
    <div class="tk-actions">${actions}</div>
    ${proposedHTML(d)}
    <h4 class="tk-h">Conversation</h4>
    ${threadHTML(d)}
    ${d.status === 'open' ? composerHTML(d) : ''}
  </div>`;
}

// ------------------------------------------------------------------ thread + composer (board and review)

function threadHTML(d, limit = 0) {
  let evs = d.events || [];
  const hidden = limit && evs.length > limit ? evs.length - limit : 0;
  if (hidden) evs = evs.slice(-limit);
  const since = d.unread_since || '';
  let marked = false;
  const items = evs.map(e => {
    let mark = '';
    if (!marked && since && e.id > since && e.by !== S.me) { marked = true; mark = '<li class="tk-new"><span>New since you last looked</span></li>'; }
    if (e.kind === 'edit' || e.kind === 'turn') {
      return `${mark}<li class="tk-sys">${e.kind === 'turn' ? '↪' : '✎'} <b>${esc(e.name)}</b> ${esc(e.text)} <span class="muted">${esc(when(e.at))}</span></li>`;
    }
    const label = { opened: 'opened the ticket', decision: '', resolved: '', reopened: '' }[e.kind];
    const to = e.data?.to && e.kind !== 'turn' ? (S.cfg?.team || []).find(p => p.email === e.data.to)?.name || String(e.data.to).split('@')[0] : '';
    return `${mark}<li class="tk-msg ${e.kind} ${e.by === S.me ? 'me' : ''}">
      <div class="tk-msg-head"><b>${esc(e.name)}</b> ${label ? `<span class="muted">${label}</span>` : ''}
        ${to ? `<span class="muted">→ ${esc(to)}'s turn</span>` : ''}
        <span class="muted small" title="${esc(stamp(e.at))}">${esc(when(e.at))}</span></div>
      <div class="tk-msg-text">${e.kind === 'decision' || e.kind === 'resolved' ? '● ' : ''}${esc(e.text)}</div></li>`;
  }).join('');
  return `<ul class="tk-thread">${hidden ? `<li class="tk-sys"><button class="link-btn" data-tk="all" data-tk-id="${esc(d.id)}">Show ${hidden} earlier</button></li>` : ''}${items}</ul>`;
}

function people(d) {
  const map = new Map();
  for (const p of S.cfg?.team || []) if (p.email) map.set(p.email, p.name || p.email.split('@')[0]);
  for (const e of d.events || []) if (e.by && !map.has(e.by)) map.set(e.by, e.name);
  return map;
}

function defaultPass(d) {
  // passing it on: back to whoever spoke to me last, else my usual person, else the first teammate
  const lastOther = [...(d.events || [])].reverse().find(e => e.by && e.by !== S.me)?.by;
  const others = [...people(d).keys()].filter(e => e !== S.me);
  return lastOther || (others.includes(S.cfg?.handoff_default) ? S.cfg.handoff_default : others[0] || '');
}

function composerHTML(d, where = 'board') {
  const ppl = people(d);
  const keepLabel = d.your_turn ? 'Keep it my turn' : `Keep it ${d.turn_name}'s turn`;
  const pick = d.your_turn ? defaultPass(d) : '';
  const opts = [`<option value="">${esc(keepLabel)}</option>`];
  for (const [email, name] of ppl) {
    if (email === d.turn) continue;
    opts.push(`<option value="${esc(email)}" ${email === pick ? 'selected' : ''}>${email === S.me ? 'Take the turn myself' : `Pass the turn to ${esc(name)}`}</option>`);
  }
  const wc = d.working_copy;
  const editNote = where === 'review' && wc
    ? (wc.ticket?.stale || !d.your_turn ? '' : 'Your edits on this screen are shared when you post.')
    : (wc ? 'You have it open in review; edits made there are shared when you post.' : '');
  return `<div class="tk-compose" data-tk-id="${esc(d.id)}">
    <textarea class="tk-text" rows="3" placeholder="${d.your_turn ? 'Your answer or question…' : 'Add a note (it stays their turn unless you change it below)…'}"></textarea>
    <div class="tk-compose-foot">
      <select class="tk-pass">${opts.join('')}</select>
      <span class="muted small">${esc(editNote)}</span>
      <span class="spacer"></span>
      <button class="btn primary" data-tk="post" data-tk-id="${esc(d.id)}">Post <kbd>Ctrl</kbd>+<kbd>Enter</kbd></button>
    </div></div>`;
}

function saveDraft(root) {
  const id = root?.dataset.tkId;
  if (id) TK.drafts[id] = { text: root.querySelector('.tk-text').value, pass: root.querySelector('.tk-pass').value };
}

function restoreDraft(el, id) {
  const root = el.querySelector(`.tk-compose[data-tk-id="${CSS.escape(id)}"]`);
  const dr = TK.drafts[id];
  if (!root || !dr) return;
  root.querySelector('.tk-text').value = dr.text;
  if ([...root.querySelector('.tk-pass').options].some(o => o.value === dr.pass)) root.querySelector('.tk-pass').value = dr.pass;
}

// ------------------------------------------------------------------ actions

async function post(id, root, extra = {}) {
  const text = root ? root.querySelector('.tk-text').value.trim() : '';
  const pass_to = root ? root.querySelector('.tk-pass').value : '';
  if (!text && !pass_to && !extra.decision) { root?.querySelector('.tk-text').focus(); return; }
  const btn = root?.querySelector('[data-tk="post"]');
  if (btn) btn.disabled = true;
  try {
    await flushSaves();
    const r = await dbFetch(`/api/tickets/${encodeURIComponent(id)}/post`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, pass_to, ...extra }),
    });
    delete TK.drafts[id];
    TK.detail[id] = r.ticket;
    applyRows(r.rows);
    if (!extra.decision) {
      const to = r.ticket.turn_name;
      toast(pass_to && pass_to !== S.me ? `Posted. ${to}'s turn now.` : 'Posted', 'ok');
    }
    afterChange(id);
  } catch (e) {
    toast(e.message, 'error');
    await loadDetail(id);  // shows the latest (and a stale working copy, if that's what happened)
    if (S.mode === 'review' && cur()?.ticket?.id === id) { await reloadState(); }
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function reloadState() {
  try {
    const st = await api('/api/state');
    applyRows(st.rows);
    renderEntity();
  } catch { /* keep what's on screen */ }
}

function afterChange(id) {
  if (S.mode === 'review') {
    const row = cur();
    if (row?.ticket?.id === id) renderEntity();
    renderQueue();
  }
  if (S.mode === 'tickets') renderMain();
  refreshTickets();
}

async function simple(id, path, body, msg) {
  try {
    const r = await dbFetch(`/api/tickets/${encodeURIComponent(id)}/${path}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}),
    });
    if (r.ticket) TK.detail[id] = r.ticket;
    applyRows(r.rows);
    if (msg) toast(msg, 'ok');
    afterChange(id);
  } catch (e) {
    toast(e.message, 'error');
  }
}

async function work(id, discard = false) {
  try {
    await flushSaves();
    const st = await dbFetch(`/api/tickets/${encodeURIComponent(id)}/work`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ discard }),
    });
    Object.assign(S, { lnt: S.lnt || {}, lntInflight: S.lntInflight || {} });
    if (S.mode !== 'review') setMode('review');
    load(st);
    go(st.row_id);
  } catch (e) {
    toast(e.message, 'error');
  }
}

function openTicket(id) {
  TK.sel = id;
  const item = TK.items.find(i => i.id === id);
  if (item && !inView(item)) TK.filter = item.status === 'open' ? 'open' : 'resolved';
  if (S.mode !== 'tickets') setMode('tickets'); else renderBoard();
  loadDetail(id);
}

// Approve / deny on a ticket row is recorded on the ticket (and the turn stays with you until you publish)
async function ticketDecision(row, status) {
  if (!row?.ticket || !['approved', 'denied'].includes(status)) return;
  const d = TK.detail[row.ticket.id];
  await post(row.ticket.id, null, { decision: status });
  if (d) loadDetail(row.ticket.id, false);
}

// ------------------------------------------------------------------ the ticket banner in the review screen

function bannerHTML(row) {
  const tk = row.ticket;
  const mine = !tk.turn || tk.turn === S.me;
  return `<div class="tk-banner ${mine ? 'mine' : ''}" id="tk-banner" data-tk-id="${esc(tk.id)}">
    <div class="tk-banner-head">
      <span>🎫 <b>Ticket</b> · ${mine ? '<b>your turn</b>' : `<b>${esc(tk.turn_name || '')}</b>'s turn. Add a note, or take the turn to change things.`}</span>
      <span class="spacer"></span>
      ${mine ? '' : `<button class="btn" data-tk="take" data-tk-id="${esc(tk.id)}">Take the turn</button>`}
      <button class="btn ghost" data-tk="board" data-tk-id="${esc(tk.id)}">Open on the board</button>
    </div>
    ${tk.stale ? `<div class="check warn">Someone changed this ticket since you opened it, and you've edited it here too, so your edits can't be shared.
      <button class="link-btn" data-tk="discard" data-tk-id="${esc(tk.id)}">Load their version</button> (drops your edits), or post just a note.</div>` : ''}
    <div class="tk-banner-body"><p class="muted small">Loading the conversation…</p></div>
  </div>`;
}

function fillBanner(row) {
  const box = $('#tk-banner');
  if (!box || box.dataset.tkId !== row.ticket.id) return;
  const d = TK.detail[row.ticket.id];
  const body = box.querySelector('.tk-banner-body');
  if (!d) return;
  if (d.error) { body.innerHTML = `<div class="check error">${esc(d.error)}</div>`; return; }
  const keep = box.querySelector('.tk-compose');
  if (keep) saveDraft(keep);
  body.innerHTML = threadHTML(d, 6) + (d.status === 'open' ? composerHTML(d, 'review') : '');
  restoreDraft(body, d.id);
}

function loadTicketForRow(row) {
  if (!row?.ticket) return;
  if (TK.detail[row.ticket.id]) fillBanner(row);
  loadDetail(row.ticket.id);
}

function focusComposer() {
  const t = document.querySelector('#tk-banner .tk-text, #tk-main .tk-text');
  if (t) t.focus();
}

// ------------------------------------------------------------------ events

document.addEventListener('click', e => {
  const t = e.target.closest('[data-tk], [data-tk-open], [data-tk-filter]');
  if (!t) return;
  e.stopPropagation();
  if (t.dataset.tkFilter) { TK.filter = t.dataset.tkFilter; TK.sel = null; return renderBoard(); }
  if (t.dataset.tkOpen) {
    saveDraft($('#tk-main .tk-compose'));
    TK.sel = t.dataset.tkOpen;
    renderBoard();
    return loadDetail(TK.sel);
  }
  const id = t.dataset.tkId;
  switch (t.dataset.tk) {
    case 'post': return post(id, t.closest('.tk-compose'));
    case 'work': return work(id);
    case 'discard': return work(id, true);
    case 'take': return simple(id, 'take', {}, 'Your turn now');
    case 'board': return openTicket(id);
    case 'all': {
      const d = TK.detail[id];
      const list = t.closest('.tk-thread');
      if (d && list) list.outerHTML = threadHTML(d);
      return;
    }
    case 'release': case 'close': {
      if (t.dataset.armed !== '1') {
        t.dataset.armed = '1';
        const was = t.textContent;
        t.textContent = t.dataset.tk === 'release' ? 'Click again: back to the pool' : 'Click again to close';
        t.classList.add('danger-btn');
        setTimeout(() => { t.dataset.armed = ''; t.textContent = was; t.classList.remove('danger-btn'); }, 3500);
        return;
      }
      const text = $('#tk-main .tk-text')?.value.trim() || '';
      return simple(id, 'resolve', { resolution: t.dataset.tk === 'release' ? 'released' : 'closed', text },
        t.dataset.tk === 'release' ? 'Back in the pool for anyone to pick up' : 'Ticket closed');
    }
    case 'reopen': return simple(id, 'reopen', {}, 'Reopened. Your turn.');
  }
}, true);

document.addEventListener('keydown', e => {
  const root = e.target.closest?.('.tk-compose');
  if (!root) return;
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); e.stopPropagation(); post(root.dataset.tkId, root); }
}, true);

document.addEventListener('input', e => {
  const root = e.target.closest?.('.tk-compose');
  if (root) saveDraft(root);
});

let searchTimer;
$('#tk-search').addEventListener('input', e => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => { TK.q = e.target.value.trim(); TK.sel = null; refreshTickets(false); }, 300);
});

setInterval(() => refreshTickets(), 60 * 1000);

window.refreshTickets = refreshTickets;
window.refreshInbox = refreshTickets;  // older name used by app.js
window.showTickets = showTickets;
window.openTicket = openTicket;
window.ticketBannerHTML = bannerHTML;
window.loadTicketForRow = loadTicketForRow;
window.ticketDecision = ticketDecision;
window.focusTicketComposer = focusComposer;
})();
