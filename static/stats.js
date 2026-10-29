// Stats: how many callers each person has put into the MCL (and denied, merged, edited),
// read from the change log. Uses helpers from app.js ($, esc, dbFetch, S ...), which loads first.
(function () {
'use strict';

const ST = { period: 'week', data: null, error: null, loading: false };
const PERIODS = { today: 'Today', week: 'This week', month: 'This month', all: 'All time' };
const COLS = [
  ['insert', 'New entries', 'Added to the MCL: from the queue or Add to MCL'],
  ['merge', 'Merged', 'Queue names merged into an existing MCL entry'],
  ['deny', 'Denied', 'Added to the denied list'],
  ['edit', 'Edits', 'Changes made in the MCL editor'],
  ['delete', 'Deletes', 'Entries deleted in the MCL editor'],
  ['undeny', 'Un-denied', 'Names taken off the denied list'],
];

async function loadStats() {
  ST.loading = true;
  render();
  try {
    ST.data = await dbFetch(`/api/stats?period=${ST.period}`);
    ST.error = null;
  } catch (e) {
    ST.error = e.message;
  }
  ST.loading = false;
  render();
}

function dailyHTML(daily, users) {
  if (!daily.length) return '';
  const days = [];
  const today = new Date();
  for (let i = 13; i >= 0; i--) {
    const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() - i);
    days.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`);
  }
  const names = [...new Set([...users.map(u => u.user), ...daily.map(d => d.user)])];
  const get = (day, user) => daily.find(d => d.day === day && d.user === user)?.n || 0;
  const max = Math.max(1, ...daily.map(d => d.n));
  return `<h3 class="ed-h">Last 14 days <span class="muted small">(new entries + merged + denied, per day)</span></h3>
    <table class="stats-days"><thead><tr><th></th>${days.map(d => `<th title="${d}">${d.slice(8)}</th>`).join('')}</tr></thead>
    <tbody>${names.map(u => `<tr><th>${esc(u)}</th>${days.map(d => {
      const n = get(d, u);
      return `<td title="${esc(u)} · ${d}: ${n}"><span class="bar" style="height:${Math.round((n / max) * 34)}px"></span><span class="n">${n || ''}</span></td>`;
    }).join('')}</tr>`).join('')}</tbody></table>`;
}

function render() {
  const el = $('#stats-view');
  if (!el || S.mode !== 'stats') return;
  const d = ST.data;
  let body;
  if (ST.loading && !d) body = '<p class="muted">Counting…</p>';
  else if (ST.error) body = `<div class="check error">${esc(ST.error)}</div>`;
  else if (!d || d.empty || !d.users.length) {
    body = `<p class="muted">Nothing logged ${d && !d.empty ? 'in this period' : 'yet'}. Every publish, Add to MCL entry and editor change
      is counted here, starting from the first one made in this app.</p>`;
  } else {
    const totals = Object.fromEntries(COLS.map(([k]) => [k, d.users.reduce((s, u) => s + (u[k] || 0), 0)]));
    body = `<table class="stats-table"><thead><tr><th>Person</th>${COLS.map(([, label, tip]) => `<th title="${esc(tip)}">${label}</th>`).join('')}
        <th title="New entries + merged + denied">Callers handled</th></tr></thead>
      <tbody>${d.users.map(u => `<tr class="${u.user === d.me ? 'me' : ''}"><th>${esc(u.user)}${u.user === d.me ? ' <span class="muted small">(you)</span>' : ''}</th>
        ${COLS.map(([k]) => `<td>${u[k] || ''}</td>`).join('')}
        <td><b>${(u.insert || 0) + (u.merge || 0) + (u.deny || 0)}</b></td></tr>`).join('')}</tbody>
      ${d.users.length > 1 ? `<tfoot><tr><th>Everyone</th>${COLS.map(([k]) => `<td>${totals[k] || ''}</td>`).join('')}
        <td><b>${totals.insert + totals.merge + totals.deny}</b></td></tr></tfoot>` : ''}</table>
      ${dailyHTML(d.daily, d.users)}
      <p class="muted small">From the change log (${esc(S.cfg?.databricks?.tables?.change_log || '')}), counted in ${esc(d.timezone)} time.
        Work done before the app's first publish (e.g. the old batch notebook) isn't included.</p>`;
  }
  el.innerHTML = `<div class="add-card">
    <div class="stats-head"><h1>Stats</h1>
      <div class="seg stats-seg">${Object.entries(PERIODS).map(([k, label]) =>
        `<button data-st-period="${k}" class="${ST.period === k ? 'on' : ''}">${label}</button>`).join('')}</div>
      <button class="btn ghost" data-st-act="refresh" ${ST.loading ? 'disabled' : ''}>${ST.loading ? 'Refreshing…' : 'Refresh'}</button>
    </div>${body}</div>`;
}

$('#stats-view').addEventListener('click', e => {
  e.stopPropagation();
  const t = e.target.closest('button');
  if (!t) return;
  if (t.dataset.stPeriod) { ST.period = t.dataset.stPeriod; return loadStats(); }
  if (t.dataset.stAct === 'refresh') return loadStats();
});

window.loadStats = loadStats;
})();
