'use strict';

const S = {
  rows: [], cfg: null, filename: '', idx: 0, filter: 'all', search: '', timers: {}, mode: 'review', reviewView: null,
  lnt: {}, lntInflight: {}, historyAll: false,   // LNT caller lookups, by row id
  mcl: {}, mclTerm: {}, mclInfo: {},              // MCL search results by term, search term by row id, row info by MCL value
  db: null, dbMatch: {}, hp: {}, matchTimer: null,
  autoQ: {}, autoBusy: {}, phonesOpen: {},                         // publish-on-approve: waiting (undo window) and in flight, by row id // Databricks status, MCL/denied checks by name, honeypot by number
};
const EDIT_FIELDS = ['partyName', 'name_variations', 'industry', 'partyTypes', 'notes'];
const STATUS_LABEL = { pending: 'Pending', approved: 'Approved', denied: 'Denied', flagged: 'Flagged' };

const $ = (sel, root = document) => root.querySelector(sel);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ------------------------------------------------------------------ helpers

async function api(path, opts = {}) {
  const res = await fetch(path, opts);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || res.statusText);
  return body;
}

function toast(msg, kind = 'info') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = msg;
  $('#toasts').append(el);
  setTimeout(() => el.remove(), kind === 'error' ? 6000 : 3200);
}

// A toast with a button (e.g. Undo) that stays up for `ms`.
function toastAction(msg, label, fn, ms) {
  const el = document.createElement('div');
  el.className = 'toast action';
  el.innerHTML = `<span></span><button></button><i class="toast-timer" style="animation-duration:${ms}ms"></i>`;
  el.firstChild.textContent = msg;
  const btn = el.querySelector('button');
  btn.textContent = label;
  btn.addEventListener('click', e => { e.stopPropagation(); fn(); el.remove(); });
  $('#toasts').append(el);
  setTimeout(() => el.remove(), ms);
}

const digits = s => String(s || '').replace(/\D/g, '').slice(-10);
const fmtPhone = s => {
  const d = digits(s);
  return d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : String(s || '');
};
const telUrl = s => `tel:+1${digits(s)}`;

// Every spelling of a name: itself and its "and" <-> "&" swaps, each as written, lowercase and
// UPPERCASE (the name itself left out). Same rule as the queue query.
function nameVariants(name) {
  name = collapse(name);
  if (!name) return [];
  const word = name === name.toUpperCase() && name !== name.toLowerCase() ? 'AND' : 'and';
  const bases = [name];
  if (/\band\b/i.test(name)) bases.push(name.replace(/\band\b/gi, '&'));
  if (name.includes('&')) {
    bases.push(collapse(name.replace(/\s*&\s*/g, ` ${word} `)));
    bases.push(name.split('&').join(word));
  }
  const out = [];
  for (const b of bases) for (const v of [b, b.toLowerCase(), b.toUpperCase()]) if (v !== name && !out.includes(v)) out.push(v);
  return out;
}
const sameList = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const sameSet = (a, b) => sameList([...a].sort(), [...b].sort());
const collapse = s => String(s).replace(/\s{2,}/g, ' ').trim();

function fieldChanged(row, k) {
  if (k === 'partyTypes') return !sameSet(row.current[k], row.original[k]);
  if (k === 'name_variations') return !sameList(row.current[k], row.original[k]);
  return row.current[k] !== row.original[k];
}
const isChanged = row => EDIT_FIELDS.some(k => fieldChanged(row, k));
const cur = () => S.rows[S.idx];
const isDone = r => !!(r.published || r.released || r.ticketed || (r.ticket?.closed && !r.published));
// a ticket row you've opened in review, while it's someone else's turn: look, add notes, but don't change it
const ticketLocked = r => !!(r?.ticket && r.ticket.status === 'open' && r.ticket.turn && S.me && r.ticket.turn !== S.me);
const readOnly = r => isDone(r) || ticketLocked(r);

async function copyText(text, label) {
  try {
    await navigator.clipboard.writeText(text);
    if (label) toast(label);
  } catch {
    toast('Clipboard blocked by the browser', 'error');
  }
}

// ------------------------------------------------------------------ LNT bridge
// The userscript (static/lnt-bridge.user.js) does the actual request with your LNT login,
// because the browser won't let this page read lnt.fosrv.com directly.

const BRIDGE_VERSION = '1.2';
const bridge = { seq: 0, pending: {}, announced: false, version: '' };
const bridgeReady = () => bridge.announced || !!document.documentElement.dataset.mclvBridge;
const bridgeVersion = () => bridge.version || document.documentElement.dataset.mclvBridge || '';
const bridgeOutdated = () => bridgeReady() && bridgeVersion() !== BRIDGE_VERSION;

// Matched by origin + type only: Tampermonkey's sandbox means e.source isn't reliably `window`.
window.addEventListener('message', e => {
  if (e.origin !== location.origin || !e.data || typeof e.data !== 'object') return;
  if (e.data.type === 'mclv:bridge-ready') {
    const first = !bridge.announced;
    bridge.announced = true;
    bridge.version = e.data.version || bridge.version || '1.0';
    if (first && cur() && $('#lnt-panel')) { loadLnt(cur()); loadMcl(cur()); }
    return;
  }
  if (e.data?.type !== 'mclv:result') return;
  const p = bridge.pending[e.data.id];
  if (!p) return;
  delete bridge.pending[e.data.id];
  e.data.error ? p.reject(new Error(e.data.error)) : p.resolve(e.data);
});

function bridgeFetch(url) {
  return new Promise((resolve, reject) => {
    const id = ++bridge.seq;
    bridge.pending[id] = { resolve, reject };
    window.postMessage({ type: 'mclv:fetch', id, url }, location.origin);
    setTimeout(() => {
      if (bridge.pending[id]) {
        delete bridge.pending[id];
        reject(new Error(bridgeOutdated()
          ? 'The bridge is out of date and didn\'t answer. Update it, then reload.'
          : 'The bridge didn\'t answer. Check Tampermonkey shows it enabled on this page, then reload.'));
      }
    }, 12000);
  });
}

const lntBase = () => (S.cfg.lnt_base || '').replace(/\/$/, '');
const lntUrl = path => new URL(path, `${lntBase()}/`).href;
const lntCallerUrl = row =>
  lntUrl(`/caller/?action=search&search=${encodeURIComponent(row.original.partyName || row.current.partyName)}`);
const lntVerifyUrl = num => lntUrl(`/verification/?action=search&search=${encodeURIComponent(num)}`);

const noneToEmpty = v => (!v || v.trim() === 'None') ? '' : v.trim();
const siteUrl = w => !w ? '' : (/^https?:\/\//i.test(w) ? w : `https://${w}`);
const tdText = el => (el?.textContent || '').replace(/\s+/g, ' ').trim();
const normName = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const isLoginPage = (doc, finalUrl) => /\/login/.test(finalUrl || '') || !!doc.querySelector('input[type="password"]');

function siteHost(w) {
  try { return new URL(siteUrl(w)).hostname.replace(/^www\./, ''); } catch { return ''; }
}
function isAggregator(w) {
  const host = siteHost(w);
  return !!host && (S.cfg.aggregator_domains || []).some(d => host === d || host.endsWith(`.${d}`));
}
function industryName(id) {
  if (id === null || id === undefined || id === '') return '';
  const hit = Object.entries(S.cfg.industry_ids || {}).find(([, v]) => String(v) === String(id));
  return hit ? hit[0] : `Industry #${id}`;
}

// ---- page parsers (DOMParser only reads the HTML; nothing on the page runs)

function parseCaller(html, finalUrl) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  if (isLoginPage(doc, finalUrl)) return { state: 'login' };
  const form = doc.querySelector('#callerForm');
  if (!form) return { state: 'notfound' };

  const val = sel => form.querySelector(sel)?.getAttribute('value') ?? '';
  const selected = name => {
    const o = form.querySelector(`select[name="${name}"] option[selected]`);
    return o ? { value: o.getAttribute('value'), label: o.textContent.trim() } : null;
  };
  const texts = [...form.querySelectorAll('p')].map(tdText);
  const phones = [...form.querySelectorAll('#callerPhoneNumbersCard li')].map(li => ({
    number: li.querySelector('a[href^="tel:"]')?.textContent.trim() || '',
    purpose: (tdText(li).match(/-\s*([^()]+?)\s*\(/) || [])[1] || '',
  }));

  return {
    state: 'ok',
    name: doc.querySelector('h1.header-display')?.textContent.trim() || '',
    website: noneToEmpty(val('#caller-website')),
    address: noneToEmpty(val('#caller-address')),
    email: noneToEmpty(val('#caller-email')),
    purpose: selected('caller_purpose'),
    industry: selected('caller_industry_type'),
    inMcl: form.querySelector('.fa-check') ? true : (form.querySelector('.fa-times') ? false : null),
    created: (texts.find(t => t.startsWith('Created:')) || '').replace('Created:', '').trim(),
    phones,
  };
}

function parseVerification(html, finalUrl) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  if (isLoginPage(doc, finalUrl)) return { state: 'login' };
  const source = tdText(doc.querySelector('h1.header-display strong'));
  const history = [...doc.querySelectorAll('#verificationHistoryTable tbody tr')].map(tr => {
    const td = tr.children;
    const link = td[1]?.querySelector('a[href*="/caller/"]');
    return {
      caller: tdText(link || td[1]),
      callerHref: link?.getAttribute('href') || '',
      purpose: tdText(td[2]),
      industry: tdText(td[3]),
      connection: tdText(td[4]),
      status: tdText(td[5]),
      notes: tdText(td[8]),
      createdBy: tdText(td[9]),
      createdAt: tdText(td[10]),
    };
  }).filter(h => h.createdAt || h.caller);
  history.sort((a, b) => b.createdAt.localeCompare(a.createdAt)); // newest first
  return { state: 'ok', source, history };
}

// Prefer the history entry whose caller matches the row's name; otherwise the newest one with a caller.
function chooseCaller(history, row) {
  const linked = history.filter(h => h.callerHref);
  const want = normName(row.original.partyName);
  return linked.find(h => normName(h.caller) === want) || linked[0] || null;
}

async function fetchCaller(url) {
  const r = await bridgeFetch(url);
  if (r.status >= 400) return { state: 'error', error: `LNT answered HTTP ${r.status}` };
  return parseCaller(r.text, r.finalUrl || url);
}

// Number first: verification history -> its caller link. Falls back to a name search.
async function fetchLntInfo(row) {
  const num = digits(row.original.phoneNumbers[0]);
  let history = [], source = '';
  if (num) {
    const r = await bridgeFetch(lntVerifyUrl(num));
    if (r.status >= 400) return { state: 'error', error: `LNT answered HTTP ${r.status}` };
    const ver = parseVerification(r.text, r.finalUrl);
    if (ver.state === 'login') return ver;
    history = ver.history;
    source = ver.source;
  }
  const pick = chooseCaller(history, row);
  const callerUrl = pick ? lntUrl(pick.callerHref) : lntCallerUrl(row);
  const caller = await fetchCaller(callerUrl);
  if (caller.state === 'login') return caller;
  return { state: 'ok', via: pick ? 'number' : 'name', callerUrl, caller, history, source };
}

function loadLnt(row, force = false) {
  if (!row) return;
  if (!bridgeReady()) return renderLnt(row, { state: 'nobridge' });
  if (!force && S.lnt[row.id]) return renderLnt(row, S.lnt[row.id]);
  renderLnt(row, { state: 'loading' });
  if (S.lntInflight[row.id]) return;

  S.lntInflight[row.id] = fetchLntInfo(row)
    .catch(e => ({ state: 'error', error: e.message }))
    .then(info => {
      delete S.lntInflight[row.id];
      if (info.state === 'ok') S.lnt[row.id] = info; // don't cache errors or login prompts
      renderLnt(row, info);
      return info;
    });
}

// Clicking another caller in the history loads that caller instead.
async function loadOtherCaller(row, href) {
  const info = S.lnt[row.id];
  if (!info) return;
  info.callerUrl = lntUrl(href);
  info.via = 'picked';
  info.caller = { state: 'loading' };
  renderLnt(row, info);
  info.caller = await fetchCaller(info.callerUrl).catch(e => ({ state: 'error', error: e.message }));
  renderLnt(row, info);
}

// Quietly load the next row too, so its website is ready when you get there.
function prefetchNext(row) {
  if (S.cfg.prefetch_next === false) return;
  const next = S.rows[row.id + 1];
  if (next && bridgeReady() && !S.lnt[next.id] && !S.lntInflight[next.id]) loadLnt(next);
}

// ---- LNT panel rendering

function callerHTML(row, info) {
  const c = info.caller;
  if (c.state === 'loading') return '<p class="muted small">Loading caller…</p>';
  if (c.state === 'error') return `<div class="check error">${esc(c.error)}</div>`;
  if (c.state === 'notfound') return '<div class="check info">Couldn\'t open a single caller page for that name. Use the links below.</div>';

  const ourPhone = digits(row.original.phoneNumbers[0]);
  const phoneMatch = c.phones.some(p => digits(p.number) === ourPhone);
  const nameMatch = normName(c.name) === normName(row.current.partyName);
  const otherInd = c.industry && c.industry.label !== row.current.industry;
  const rows = [
    ['Website', c.website
      ? `<a href="${esc(siteUrl(c.website))}" target="_blank" rel="noopener" class="site">${esc(siteHost(c.website) || c.website)}</a>`
        + (isAggregator(c.website) ? '<div class="check warn">This is a listing site, not the business\'s own site. Look for the real one.</div>' : '')
      : '<span class="muted">None on file</span>'],
    c.address && ['Address', esc(c.address)],
    c.email && ['Email', esc(c.email)],
    ['Purpose', c.purpose ? esc(c.purpose.label) : '<span class="muted">Not set</span>'],
    ['Industry', c.industry
      ? esc(c.industry.label) + (otherInd ? ` <button class="link-btn" data-use-industry="${esc(c.industry.label)}">Use this</button>` : '')
      : '<span class="muted">Not set</span>'],
    ['In MCL', c.inMcl === null ? '?' : (c.inMcl ? '<span class="yes">Yes</span>' : '<span class="no">No</span>')],
    c.created && ['Created', esc(c.created)],
  ].filter(Boolean);

  return `
    <div class="lnt-name">${esc(c.name)}</div>
    ${nameMatch ? '' : '<div class="check info">The LNT caller name differs from the party name.</div>'}
    <div class="check ${phoneMatch ? 'ok' : 'warn'}">${phoneMatch
      ? 'This number is on the caller.'
      : 'This number is not listed on this caller.'}</div>
    <dl>${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>
    ${c.phones.length > 1 ? `<div class="lnt-phones">${c.phones.map(p =>
      `<div class="${digits(p.number) === ourPhone ? 'me' : ''}"><span>${esc(fmtPhone(p.number))}</span> ${esc(p.purpose)}</div>`).join('')}</div>` : ''}`;
}

function historyHTML(info) {
  if (!info.history.length) return '';
  const items = S.historyAll ? info.history : info.history.slice(0, 4);
  return `<div class="lnt-sec">
    <div class="lnt-sub">Verification history <span class="muted">(${info.history.length})</span></div>
    <ul class="hist">${items.map(h => {
      const isCur = h.callerHref && lntUrl(h.callerHref) === info.callerUrl;
      const who = h.callerHref
        ? `<button class="link-btn" data-load-caller="${esc(h.callerHref)}">${esc(h.caller)}</button>`
        : `<span class="muted">${esc(h.caller || 'N/A')}</span>`;
      const meta = [h.purpose, h.industry, h.connection, h.createdBy].filter(x => x && !/^\(NA\)/.test(x)).join(' · ');
      return `<li class="${isCur ? 'cur' : ''}">
        <div><span class="muted mono">${esc(h.createdAt.slice(0, 10))}</span> ${who}</div>
        <div class="muted small">${esc(meta)}${h.notes ? ` · <i>${esc(h.notes)}</i>` : ''}</div></li>`;
    }).join('')}</ul>
    ${info.history.length > 4 ? `<button class="link-btn" data-act="history-all">${S.historyAll ? 'Show fewer' : `Show all ${info.history.length}`}</button>` : ''}
  </div>`;
}

function renderLnt(row, info) {
  const panel = $('#lnt-panel');
  if (!panel || cur() !== row) return;
  const update = bridgeOutdated()
    ? `<div class="check warn">Bridge update available (you have v${esc(bridgeVersion())}, this needs v${BRIDGE_VERSION}).
        <a href="/static/lnt-bridge.user.js">Update bridge</a>, then reload.</div>` : '';
  const head = (extra = '') => `<div class="lnt-head"><h3>LNT caller</h3>${extra}</div>${update}`;
  const refreshBtn = '<button class="link-btn" data-act="lnt-refresh">Refresh</button>';
  const num = digits(row.original.phoneNumbers[0]);
  const links = `<p class="small">${info.callerUrl ? `<a class="link-btn" href="${esc(info.callerUrl)}" target="_blank" rel="noopener">Open caller</a> · ` : ''}
    <a class="link-btn" href="${esc(lntVerifyUrl(num))}" target="_blank" rel="noopener">Open verification</a></p>`;

  if (info.state === 'nobridge') {
    panel.innerHTML = head() + `<p class="muted small">Install the LNT bridge userscript to load caller info, including the website, here automatically.</p>
      <a class="btn" href="/static/lnt-bridge.user.js">Install bridge (Tampermonkey)</a>
      <p class="muted small">Then reload this page.</p>`;
    return;
  }
  if (info.state === 'loading') { panel.innerHTML = head() + '<p class="muted small">Loading from the LNT…</p>'; return; }
  if (info.state === 'login') {
    panel.innerHTML = head(refreshBtn) + `<div class="check warn">You're logged out of the LNT. <a href="${esc(lntBase())}/login" target="_blank" rel="noopener">Log in</a>, then Refresh.</div>`;
    return;
  }
  if (info.state === 'error') { panel.innerHTML = head(refreshBtn) + `<div class="check error">${esc(info.error)}</div>` + links; return; }

  const via = {
    number: '<div class="muted small">Found through this number\'s verification history.</div>',
    name: '<div class="check info">No caller in this number\'s history, so this is a name search.</div>',
    picked: '<div class="muted small">Picked from the history.</div>',
  }[info.via];
  panel.innerHTML = head(refreshBtn) + via + callerHTML(row, info) + historyHTML(info)
    + (info.source ? `<div class="muted small">Queue source: ${esc(info.source)}</div>` : '') + links;
}

// ------------------------------------------------------------------ similar names in the MCL
// Uses the same JSON endpoints the LNT's own caller dropdown uses.

const defaultMclTerm = row => collapse(row.original.partyName || row.current.partyName);
const mclKey = term => term.toLowerCase();

async function loadMcl(row, term) {
  if (!row) return;
  if (dbOn()) return loadMclDb(row, term);
  if (!bridgeReady()) return renderMcl(row, { state: 'nobridge' });
  term = collapse(term ?? (S.mclTerm[row.id] || defaultMclTerm(row)));
  S.mclTerm[row.id] = term;
  if (term.length < 3) return renderMcl(row, { state: 'short', term });
  const key = mclKey(term);
  if (S.mcl[key]) return renderMcl(row, S.mcl[key]);

  renderMcl(row, { state: 'loading', term });
  let res;
  try {
    const r = await bridgeFetch(lntUrl(`/api/get_mcl_results/?term=${encodeURIComponent(term)}`));
    let data = null;
    try { data = JSON.parse(r.text); } catch { /* not JSON */ }
    if (r.status === 404) res = { state: 'ok', term, items: [] };
    else if (r.status >= 400) res = { state: 'error', term, error: `LNT answered HTTP ${r.status}` };
    else if (data === null && /\/login/.test(r.finalUrl || '')) res = { state: 'login', term };
    else if (!Array.isArray(data)) res = { state: 'error', term, error: 'Unexpected answer from the MCL search.' };
    else {
      res = {
        state: 'ok', term,
        items: data.map(d => (typeof d === 'object' && d
          ? { value: String(d.value ?? d.id ?? d.label ?? ''), label: String(d.label ?? d.text ?? d.value ?? '') }
          : { value: String(d), label: String(d) })).filter(d => d.label),
      };
    }
  } catch (e) {
    res = { state: 'error', term, error: e.message };
  }
  if (res.state === 'ok') S.mcl[key] = res;
  if (S.mclTerm[row.id] === term) renderMcl(row, res);
}

function rerenderMcl(row) {
  const t = S.mclTerm[row.id];
  const res = t && S.mcl[mclKey(t)];
  if (res) renderMcl(row, res);
}

async function loadMclInfo(row, value) {
  if (S.mclInfo[value]?.state === 'ok') { delete S.mclInfo[value]; return rerenderMcl(row); } // click again to collapse
  S.mclInfo[value] = { state: 'loading' };
  rerenderMcl(row);
  try {
    const r = await bridgeFetch(lntUrl(`/api/get_mcl_row_info/?term=${encodeURIComponent(value)}`));
    if (r.status >= 400) throw new Error(`LNT answered HTTP ${r.status}`);
    let d;
    try { d = JSON.parse(r.text); } catch { throw new Error('Unexpected answer from the LNT.'); }
    S.mclInfo[value] = {
      state: 'ok',
      industry: industryName(d.industry_id),
      flags: (d.mcl_call_purposes || []).map(p => p.flag).filter(Boolean),
    };
  } catch (e) {
    S.mclInfo[value] = { state: 'error', error: e.message };
  }
  if (cur() === row) rerenderMcl(row);
}

function applyMclInfo(value) {
  const info = S.mclInfo[value];
  if (!info || info.state !== 'ok') return;
  if (info.industry && !info.industry.startsWith('Industry #')) setField('industry', info.industry);
  if (info.flags.length) setField('partyTypes', [...info.flags]);
  toast('Copied that MCL entry\'s industry and party types');
}

function mclInfoHTML(value) {
  const i = S.mclInfo[value];
  if (!i) return '';
  if (i.state === 'loading') return '<div class="muted small">Loading…</div>';
  if (i.state === 'error') return `<div class="check error">${esc(i.error)}</div>`;
  return `<div class="small">${esc(i.industry || 'No industry')} · <span class="mono">${esc(i.flags.join(', ') || 'no purposes')}</span>
    <button class="link-btn" data-mcl-apply="${esc(value)}">Use these</button></div>`;
}

function renderMcl(row, res) {
  const panel = $('#mcl-panel');
  if (!panel || cur() !== row) return;
  panel.hidden = res.state === 'nobridge';
  if (panel.hidden) return;

  const typing = document.activeElement?.id === 'mcl-term';
  const term = res.term ?? S.mclTerm[row.id] ?? '';
  let body;
  if (res.state === 'loading') body = '<p class="muted small">Searching the MCL…</p>';
  else if (res.state === 'short') body = '<p class="muted small">Type at least 3 letters.</p>';
  else if (res.state === 'login') body = '<div class="check warn">You\'re logged out of the LNT.</div>';
  else if (res.state === 'error') body = `<div class="check error">${esc(res.error)}</div>`;
  else if (!res.items.length) body = '<p class="muted small">No MCL names match. Try fewer words.</p>';
  else {
    const shown = res.items.slice(0, 15);
    const fromDb = shown.every(it => S.mclInfo[it.value]?.db); // Databricks results already include the details
    body = `<ul class="mcl-list">${shown.map(it => `<li>
        ${fromDb ? `<span class="mcl-name">${esc(it.label)}</span>`
          : `<button class="link-btn" data-mcl-value="${esc(it.value)}">${esc(it.label)}</button>`}
        ${mclInfoHTML(it.value)}</li>`).join('')}</ul>
      ${res.items.length > shown.length ? `<p class="muted small">Showing 15 of ${res.items.length}.</p>` : ''}
      ${fromDb ? '' : '<p class="muted small">Click a name to see how it\'s classified.</p>'}`;
  }
  panel.innerHTML = `<div class="lnt-head"><h3>Similar in MCL</h3></div>
    <input id="mcl-term" class="mcl-term" value="${esc(term)}" placeholder="Search the MCL…" autocomplete="off" spellcheck="false">
    ${body}`;
  if (typing) { const f = $('#mcl-term'); f.focus(); f.setSelectionRange(f.value.length, f.value.length); }
}

// ------------------------------------------------------------------ Databricks (read-only)
// The Flask server holds the Databricks connection (same OAuth as YALnT); the page just asks it.

const dbOn = () => !!(S.db?.installed && S.db?.configured);
let dbInflight = 0;
let dbSlowTimer = null;

async function refreshDbStatus() {
  try { S.db = await api('/api/db/status'); } catch { S.db = null; }
  renderDbPill();
}

// Which publishing mode you're in, always visible in the top bar.
function renderModeBadge() {
  const b = $('#mode-badge');
  if (!b) return;
  const pub = S.cfg?.publish || {};
  if (!dbOn() || !S.cfg) { b.hidden = true; return; }
  b.hidden = false;
  if (pub.dry_run !== false) {
    b.className = 'mode-badge dry';
    b.textContent = 'Dry run';
    b.title = 'Dry run: Publish can preview and test on a copy, but nothing reaches the real MCL. Click to change.';
  } else if (pub.auto) {
    b.className = 'mode-badge auto';
    b.textContent = `Auto-publish · ${pub.auto_delay_seconds ?? 10}s undo`;
    b.title = 'Each Approve or Deny publishes to the real MCL after the undo window. Click to change.';
  } else {
    b.className = 'mode-badge batch';
    b.textContent = 'Batch publish';
    b.title = 'Approve and Deny just mark rows. Nothing reaches the MCL until you press Publish. Click to change.';
  }
}

function renderDbPill() {
  renderModeBadge();
  const pill = $('#db-pill');
  $('#db-load').hidden = !dbOn();
  $('#mode-tabs').hidden = !dbOn();
  if (window.updatePublishButton) updatePublishButton();
  if (!S.db?.configured) { pill.hidden = true; return; }
  pill.hidden = false;
  pill.disabled = false;
  if (!S.db.installed) {
    pill.className = 'db-pill bad';
    pill.textContent = 'Databricks connector not installed';
    pill.title = 'Run: pip install -r requirements.txt, then restart the app';
  } else if (S.db.busy) {
    pill.className = 'db-pill busy';
    pill.textContent = S.db.busy;
    pill.disabled = true;
  } else if (S.db.connected) {
    pill.className = 'db-pill ok';
    pill.textContent = 'Databricks connected';
    pill.title = 'Databricks connected: signed in. Lookups run through your SQL warehouse.';
  } else {
    pill.className = `db-pill ${S.db.last_error ? 'bad' : ''}`;
    pill.textContent = 'Connect Databricks';
    pill.title = S.db.last_error ? `Last error: ${S.db.last_error}` : 'Opens the Databricks sign-in page if you aren\'t signed in yet';
  }
}

// Wraps api() so a slow first call shows "waking up" instead of looking frozen.
async function dbFetch(path, opts) {
  dbInflight++;
  if (!dbSlowTimer) {
    dbSlowTimer = setTimeout(() => {
      if (dbInflight && S.db) {
        S.db.busy = S.db.connected ? 'Databricks is working…' : 'Signing in / waking Databricks…';
        renderDbPill();
      }
    }, 2500);
  }
  try {
    const r = await api(path, opts);
    const wasConnected = S.db?.connected;
    if (S.db) { S.db.connected = true; S.db.last_error = null; }
    if (!wasConnected) refreshOthers();
    return r;
  } catch (e) {
    if (S.db && /^Databricks/.test(e.message)) { S.db.connected = false; S.db.last_error = e.message; }
    throw e;
  } finally {
    dbInflight--;
    if (!dbInflight) {
      clearTimeout(dbSlowTimer);
      dbSlowTimer = null;
      if (S.db) S.db.busy = null;
    }
    renderDbPill();
  }
}

async function connectDb() {
  try {
    await dbFetch('/api/db/connect', { method: 'POST' });
    toast('Connected to Databricks', 'ok');
    refreshOthers();
    if (cur() && $('#lnt-panel')) { checkNameInDb(cur()); loadHoneypot(cur()); loadMcl(cur()); }
  } catch (e) {
    toast(e.message, 'error');
  }
}

// ---- queue filters (start screen). Remembered in this browser between visits.

const QF_DEFAULT = { industries: [], name: '', created_by: '', days: 60, min_seen: 1, order: 'any' };
const QF_KEY = 'mclv.queueFilters';
let qf = { ...QF_DEFAULT };
try { qf = { ...QF_DEFAULT, ...JSON.parse(localStorage.getItem(QF_KEY) || '{}') }; } catch { /* storage blocked: defaults */ }

function saveQf() {
  try { localStorage.setItem(QF_KEY, JSON.stringify(qf)); } catch { /* storage blocked: fine */ }
}

function qfSummary() {
  const bits = [];
  if (qf.industries.length) bits.push(qf.industries.length <= 3 ? qf.industries.join(', ') : `${qf.industries.length} industries`);
  if (qf.name) bits.push(`name has “${qf.name}”`);
  if (qf.created_by) bits.push(`by ${qf.created_by}`);
  if (Number(qf.days) !== 60) bits.push(`last ${qf.days} days`);
  if (Number(qf.min_seen) > 1) bits.push(`seen ${qf.min_seen}+ times`);
  if (qf.order !== 'any') bits.push($('#qf-order').selectedOptions[0]?.textContent.toLowerCase());
  return bits.length ? bits.join(' · ') : 'none: everything unclaimed from the last 60 days';
}

function renderQf() {
  if (!S.cfg) return;
  const names = [...new Set([...Object.keys(S.cfg.industry_ids || {}), ...Object.keys(S.cfg.industries || {})])].sort();
  $('#qf-industries').innerHTML = names.map(n =>
    `<button type="button" class="code ind ${qf.industries.includes(n) ? 'on' : ''}" data-qf-ind="${esc(n)}">${esc(n)}</button>`).join('');
  $('#qf-name').value = qf.name;
  $('#qf-by').value = qf.created_by;
  $('#qf-days').value = qf.days;
  $('#qf-seen').value = qf.min_seen;
  $('#qf-order').value = qf.order;
  $('#qf-summary').textContent = qfSummary();
  const active = JSON.stringify(qf) !== JSON.stringify(QF_DEFAULT);
  $('#qf').classList.toggle('active', active);
  if (active && !$('#qf').dataset.touched) $('#qf').open = true; // show remembered filters so they're not a surprise
}

function readQf() {
  qf = {
    ...qf,
    name: $('#qf-name').value.trim(),
    created_by: $('#qf-by').value.trim(),
    days: $('#qf-days').value === '' ? 60 : Number($('#qf-days').value),   // 0 or 400 goes through so the server can say why
    min_seen: $('#qf-seen').value === '' ? 1 : Number($('#qf-seen').value),
    order: $('#qf-order').value,
  };
  saveQf();
  $('#qf-count').textContent = '';
  $('#qf-summary').textContent = qfSummary();
  $('#qf').classList.toggle('active', JSON.stringify(qf) !== JSON.stringify(QF_DEFAULT));
}

async function countQf() {
  readQf();
  $('#qf-count').textContent = 'Counting…';
  try {
    const r = await dbFetch('/api/db/queue/count', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ filters: qf }),
    });
    let txt = `${r.n.toLocaleString()} unclaimed name${r.n === 1 ? '' : 's'} match in the last ${r.days} days`;
    const wider = (r.buckets || []).filter(b => b.days > r.days && b.n > r.n);
    if (wider.length) {
      // what you'd get if the app has to reach further back to fill your request
      const want = Math.max(1, Math.min(Number($('#db-limit').value) || 1023, 5000));
      txt += ` · going back further: ${wider.map(b => `${lookbackLabel(b.days)} ${b.n.toLocaleString()}`).join(', ')}`;
      if (r.n < want) {
        const hit = wider.find(b => b.n >= want);
        txt += hit ? `. Loading ${want} would reach back ${lookbackLabel(hit.days)}.` : `. Loading ${want} would reach back as far as Settings allows.`;
      }
    }
    $('#qf-count').textContent = txt;
  } catch (e) {
    $('#qf-count').textContent = e.message;
  }
}

async function loadDbQueue() {
  readQf();
  const limit = Math.max(1, Math.min(Number($('#db-limit').value) || 1023, 5000));
  const btn = $('#btn-db-queue');
  btn.disabled = true;
  $('#db-load-status').textContent = 'Running the New-to-MCL query… The first run can take a minute while Databricks wakes up, and may open a sign-in page.';
  try {
    const st = await dbFetch('/api/db/queue', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ limit, filters: qf }),
    });
    Object.assign(S, { lnt: {}, lntInflight: {}, mcl: {}, mclTerm: {}, mclInfo: {}, dbMatch: {}, hp: {} });
    $('#db-load-status').textContent = '';
    load(st);
    const lost = st.claims?.lost || 0;
    const lb = st.lookback || {};
    let msg = `Loaded and claimed ${st.rows.length} names${lost ? ` (${lost} went to someone who loaded at the same moment)` : ''}`;
    if (lb.used > lb.requested) {
      msg = `Only ${lb.within_requested} matched in the last ${lb.requested} days, so I looked back ${lookbackLabel(lb.used)} and loaded ${st.rows.length}. `
        + `The ${st.rows.length - lb.within_requested} older ones are tagged “older”.`;
    }
    toast(msg, 'ok');
    refreshOthers();
  } catch (e) {
    $('#db-load-status').textContent = e.message;
  } finally {
    btn.disabled = false;
  }
}

function lookbackLabel(days) {
  if (days < 365 || days % 365) return `${days} days`;
  return days === 365 ? '1 year' : `${days / 365} years`;
}

// ---- claims: who is working what

async function releaseRow(row) {
  try {
    const r = await dbFetch('/api/claims/release', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ row_ids: [row.id] }),
    });
    for (const x of r.rows) if (S.rows[x.id]) S.rows[x.id].released = x.released || null;
    toast(`Released “${row.current.partyName}” for someone else to pick up`, 'ok');
    const next = S.rows.find(x => x.status === 'pending' && !isDone(x));
    if (next) go(next.id); else renderAll();
    renderFilters(); renderProgress();
  } catch (e) {
    toast(e.message, 'error');
  }
}

async function refreshOthers() {
  window.refreshInbox?.();
  const el = $('#others');
  if (!dbOn() || !S.db?.connected) { el.hidden = true; return; }
  try {
    const r = await api('/api/claims/others');
    el.hidden = !r.others.length;
    el.textContent = '👥 ' + r.others.map(o => `${o.user} ${o.n}`).join(' · ');
    el.title = r.others.map(o => `${o.user} is working ${o.n} names`).join('\n') + '\nThey won\'t show up in your queue.';
  } catch {
    el.hidden = true;
  }
}

setInterval(() => { if (S.claimBatch && S.db?.connected) api('/api/claims/heartbeat', { method: 'POST' }).catch(() => {}); }, 10 * 60 * 1000);
setInterval(refreshOthers, 3 * 60 * 1000);

// ---- is the (current) name already in the MCL, or denied before?

const matchKey = n => collapse(n).toLowerCase();

function checkNameInDb(row) {
  if (!dbOn() || !row) return;
  const name = collapse(row.current.partyName);
  if (name.length < 3) return;
  const key = matchKey(name);
  if (S.dbMatch[key]) return;
  S.dbMatch[key] = { state: 'loading' };
  dbFetch(`/api/db/mcl/match?name=${encodeURIComponent(name)}`)
    .then(r => { S.dbMatch[key] = { state: 'ok', mcl: r.mcl, denied: r.denied, claimed_by: r.claimed_by }; })
    .catch(e => {
      S.dbMatch[key] = { state: 'error', error: e.message };
      setTimeout(() => { if (S.dbMatch[key]?.state === 'error') delete S.dbMatch[key]; }, 30000); // allow a retry later
    })
    .finally(() => { if (cur() && matchKey(cur().current.partyName) === key) refresh(); });
}

function dbNameChecks(name, add) {
  if (!dbOn() || collapse(name).length < 3) return;
  const m = S.dbMatch[matchKey(name)];
  if (!m || m.state === 'loading') { add('info', 'partyName', 'Checking the MCL…'); return; }
  if (m.state === 'error') { add('info', 'partyName', `Couldn't check the MCL. ${m.error}`); return; }
  const hit = m.mcl[0];
  if (hit) {
    add('warn', 'partyName', `Already in the MCL as “${hit.partyname}” (${hit.industry || 'no industry'} · ${hit.partytypes.join(', ') || 'no purposes'}). `
      + 'Adding it would update that entry, not create a new one.', () => openEditor(hit.partyname), 'Open in editor');
  }
  if (m.denied.length) add('warn', 'partyName', `This name was denied before (as “${m.denied[0]}”).`);
  if (m.claimed_by) add('warn', 'partyName', `${m.claimed_by} is working this name right now.`);
  if (!hit && !m.denied.length && !m.claimed_by) add('ok', 'partyName', 'Not in the MCL or the denied list yet.');
}

// ---- "Similar in MCL" straight from the MCL table (shows each entry's industry and purposes)

async function loadMclDb(row, term) {
  term = collapse(term ?? (S.mclTerm[row.id] || defaultMclTerm(row)));
  S.mclTerm[row.id] = term;
  if (term.length < 3) return renderMcl(row, { state: 'short', term });
  const key = mclKey(term);
  if (S.mcl[key]) return renderMcl(row, S.mcl[key]);

  renderMcl(row, { state: 'loading', term });
  let res;
  try {
    const r = await dbFetch(`/api/db/mcl/search?q=${encodeURIComponent(term)}`);
    for (const it of r.items) {
      S.mclInfo[it.partyname] = { state: 'ok', industry: it.industry, flags: it.partytypes, db: true };
    }
    res = { state: 'ok', term, items: r.items.map(it => ({ value: it.partyname, label: it.partyname })) };
    S.mcl[key] = res;
  } catch (e) {
    res = { state: 'error', term, error: e.message };
  }
  if (S.mclTerm[row.id] === term) renderMcl(row, res);
}

// ---- honeypot transcripts

function loadHoneypot(row, force = false) {
  const panel = $('#hp-panel');
  if (!panel || !row) return;
  panel.hidden = !dbOn();
  if (!dbOn()) return;
  const num = digits(row.original.phoneNumbers[0]);
  if (num.length !== 10) return renderHp(row, { state: 'ok', matches: [] });
  if (!force && S.hp[num]) return renderHp(row, S.hp[num]);
  renderHp(row, { state: 'loading' });
  dbFetch(`/api/db/honeypot/${num}`)
    .then(r => ({ state: 'ok', matches: r.matches }))
    .catch(e => ({ state: 'error', error: e.message }))
    .then(res => {
      if (res.state === 'ok') S.hp[num] = res;
      renderHp(row, res);
    });
}

function renderHp(row, res) {
  const panel = $('#hp-panel');
  if (!panel || cur() !== row) return;
  let body;
  if (res.state === 'loading') body = '<p class="muted small">Loading transcripts…</p>';
  else if (res.state === 'error') body = `<div class="check error">${esc(res.error)}</div>`;
  else if (!res.matches.length) body = '<p class="muted small">No honeypot transcripts mention this number.</p>';
  else {
    body = `<ul class="hp-list">${res.matches.map(m => `<li class="hp-item">
        <div class="muted small">${esc(m.callTimestamp || m.date || '')}${m.aNumber ? ` · call from ${esc(fmtPhone(m.aNumber))}` : ''}</div>
        <div class="hp-text">${esc(m.transcript)}</div>
        <button class="link-btn" data-hp-expand>Show more</button></li>`).join('')}</ul>`;
  }
  panel.innerHTML = `<div class="lnt-head"><h3>Honeypot transcripts</h3><button class="link-btn" data-act="hp-refresh">Refresh</button></div>${body}`;
  // only offer "Show more" where the text is actually cut off
  panel.querySelectorAll('.hp-item').forEach(li => {
    const t = $('.hp-text', li);
    if (t.scrollHeight <= t.clientHeight + 2) $('[data-hp-expand]', li).remove();
  });
}

// ------------------------------------------------------------------ validation

function validate(row) {
  const c = row.current, cfg = S.cfg, out = [];
  const add = (level, field, msg, fix, fixLabel = 'Fix') => out.push({ level, field, msg, fix, fixLabel });

  // party name
  const name = c.partyName;
  if (!name.trim()) add('error', 'partyName', 'Party name is empty.');
  else if (collapse(name).length <= 2) add('error', 'partyName', 'Names of 2 characters or fewer fail the MCL upload checks.');
  if (name.trim()) {
    if (name !== name.trim()) add('warn', 'partyName', 'Leading or trailing spaces in the name.', () => setField('partyName', name.trim()));
    if (/\s{2,}/.test(name.trim())) add('warn', 'partyName', 'Double spaces in the name.', () => setField('partyName', collapse(name)));
    if (/[A-Z]{3,}/.test(name) && name === name.toUpperCase()) add('info', 'partyName', 'Name is ALL CAPS. Check the official capitalization (website copyright line).');
    if (/[a-z]/.test(name) && name === name.toLowerCase()) add('info', 'partyName', 'Name is all lowercase. Check the official capitalization.');
  }
  dbNameChecks(name, add);

  // name variations
  const vars = c.name_variations;
  const clean = collapse(name);
  if (clean) {
    const missing = nameVariants(clean).filter(v => !vars.includes(v));
    if (missing.length) add('warn', 'name_variations', `Missing ${missing.length > 2 ? `${missing.length} spellings: ` : ''}${missing.map(m => `“${m}”`).join(missing.length > 2 ? ', ' : ' and ')}.`,
      () => setField('name_variations', [...missing, ...vars]), 'Add');
  }
  if (!vars.length) add('error', 'name_variations', 'No name variations.');
  if (new Set(vars).size !== vars.length) add('warn', 'name_variations', 'Duplicate variations.',
    () => setField('name_variations', [...new Set(vars)]), 'Remove dupes');
  const spaced = vars.filter(v => /\s{2,}/.test(v) || v !== v.trim());
  if (spaced.length) {
    const clean = new Set(vars.filter(v => !spaced.includes(v)));
    const dupes = spaced.filter(v => clean.has(collapse(v)));
    const plural = spaced.length > 1;
    let msg = `${spaced.length} variation${plural ? 's have' : ' has'} extra spaces.`;
    if (dupes.length === spaced.length) msg += ` A clean copy already exists, so Fix removes the spaced one${plural ? 's' : ''}.`;
    else if (dupes.length) msg += ` ${dupes.length} already ha${dupes.length > 1 ? 've' : 's'} a clean copy and will be removed; the rest get cleaned.`;
    add('warn', 'name_variations', msg, () => setField('name_variations', [...new Set(vars.map(collapse))]));
  }

  // industry
  const lntInds = Object.keys(cfg.industry_ids || {});
  const inds = [...new Set([...lntInds, ...Object.keys(cfg.industries || {})])];
  const ind = c.industry;
  if (!ind.trim()) add('error', 'industry', 'Industry is empty.');
  else if (!inds.includes(ind)) {
    const match = inds.find(i => i.toLowerCase() === ind.trim().toLowerCase());
    if (match) add('warn', 'industry', `Capitalization should be “${match}”.`, () => setField('industry', match));
    else add('warn', 'industry', 'Not a known industry type. Double-check the spelling.');
  } else if (lntInds.length && !lntInds.includes(ind)) {
    add('warn', 'industry', `“${ind}” isn't one of the LNT's industry types.`);
  }

  // party types
  const pts = c.partyTypes;
  if (!pts.length) add('error', 'partyTypes', 'No party types selected.');
  const allowed = cfg.upload_allowed_partytypes;
  const blocked = allowed ? pts.filter(p => !allowed.includes(p)) : [];
  if (blocked.length) add('error', 'partyTypes', `${blocked.join(', ')} ${blocked.length > 1 ? 'aren\'t' : 'isn\'t'} allowed by the MCL upload checks and will fail the batch upload.`,
    () => setField('partyTypes', pts.filter(p => !blocked.includes(p))), 'Remove');
  const unknown = pts.filter(p => !(p in (cfg.partytypes || {})) && !blocked.includes(p));
  if (unknown.length) add('info', 'partyTypes', `Unrecognized code${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')}.`);
  const filt = pts.filter(p => (cfg.filterable || []).includes(p));
  if (filt.length) add('warn', 'partyTypes', `${filt.join(', ')} ${filt.length > 1 ? 'are' : 'is'} blockable by Call Guard. Make sure it really fits.`);
  const def = cfg.industries?.[ind]?.default_partytypes;
  if (def && def.length && !sameSet(def, pts)) add('info', 'partyTypes', `${ind} usually gets ${def.join(', ')}.`,
    () => setField('partyTypes', [...def]), 'Apply');

  return out;
}

// ------------------------------------------------------------------ boot

async function init() {
  window.postMessage({ type: 'mclv:ping' }, location.origin); // asks an installed bridge to announce its version
  try {
    await refreshDbStatus();
    const st = await api('/api/state');
    load(st);
  } catch (e) {
    toast(`Couldn't reach the server: ${e.message}`, 'error');
  }
}

function load(st) {
  S.cfg = st.config;
  renderModeBadge();
  S.claimBatch = st.claim_batch || null;
  S.rows = st.rows || [];
  S.filename = st.filename || '';
  if (!S.rows.length) return showUpload(false);
  const firstPending = S.rows.findIndex(r => r.status === 'pending');
  S.idx = firstPending >= 0 ? firstPending : 0;
  showWork();
}

function showUpload(cancellable) {
  S.reviewView = { view: 'upload', cancellable };
  if (S.mode === 'editor') return;
  renderQf();
  document.title = 'YaMCL';
  $('#upload-view').hidden = false;
  $('#work-view').hidden = true;
  $('#top-actions').hidden = true;
  $('#progress-wrap').hidden = true;
  $('#upload-warning').hidden = !cancellable;
  $('#btn-cancel-upload').hidden = !cancellable;
  $('#filename').textContent = '';
}

function showWork() {
  S.reviewView = { view: 'work' };
  if (S.mode === 'editor') return;
  $('#upload-view').hidden = true;
  $('#work-view').hidden = false;
  $('#top-actions').hidden = false;
  $('#progress-wrap').hidden = false;
  $('#filename').textContent = S.filename ? `· ${S.filename}` : '';
  renderAll();
}

async function uploadFile(file) {
  if (!file) return;
  const fd = new FormData();
  fd.append('file', file);
  try {
    const st = await api('/api/upload', { method: 'POST', body: fd });
    load(st);
    toast(`Loaded ${st.rows.length} rows`);
  } catch (e) {
    toast(e.message, 'error');
  }
}

// ------------------------------------------------------------------ rendering

function renderAll() {
  renderProgress();
  renderFilters();
  renderQueue();
  renderEntity();
}

// Counts for the filter chips. Published rows only count under Done.
function counts() {
  const c = { all: 0, pending: 0, approved: 0, flagged: 0, denied: 0, edited: 0, done: 0 };
  for (const r of S.rows) {
    if (isDone(r)) { c.done++; continue; }
    c.all++;
    c[r.status]++;
    if (isChanged(r)) c.edited++;
  }
  return c;
}

// Counts over every row, published or not (progress bar and exports).
function totals() {
  const t = { all: S.rows.length, pending: 0, approved: 0, flagged: 0, denied: 0 };
  for (const r of S.rows) t[r.status]++;
  return t;
}

function renderProgress() {
  const c = totals();
  const done = c.all - c.pending;
  $('#progress-bar').style.width = `${c.all ? (done / c.all) * 100 : 0}%`;
  $('#progress-text').textContent = `${done} / ${c.all} reviewed`;

  // export labels show what each file will contain
  const allCount = c.all - c.denied;
  $('#exp-approved').textContent = `Export approved CSV (${c.approved})`;
  $('#exp-approved').dataset.count = c.approved;
  $('#exp-approved-menu').dataset.count = c.approved;
  $('#exp-approved-note').textContent = `${c.approved} rows, as a New-to-MCL CSV`;
  // with Databricks connected, publishing is the main action and CSV exports live in one menu
  $('#exp-approved').hidden = dbOn();
  $('#exp-approved-menu').hidden = !dbOn();
  $('#export-summary').textContent = dbOn() ? 'Export ▾' : 'More exports ▾';
  $('#exp-all').dataset.count = allCount;
  $('#exp-denied').dataset.count = c.denied;
  const unsure = [c.pending && `${c.pending} pending`, c.flagged && `${c.flagged} flagged`].filter(Boolean);
  $('#exp-all-note').textContent = `${allCount} rows${unsure.length ? `, including ${unsure.join(' and ')}` : ''}`;
  if (window.updatePublishButton) updatePublishButton();
}

// Wait for any typing that hasn't been saved yet, so the export has the latest edits.
async function flushSaves() {
  const ids = Object.keys(S.timers);
  await Promise.all(ids.map(id => {
    clearTimeout(S.timers[id]);
    return saveRow(S.rows[Number(id)]);
  }));
}

function renderFilters() {
  const c = counts();
  const keys = ['all', 'pending', 'approved', 'flagged', 'denied', 'edited', 'done'];
  $('#filters').innerHTML = keys.map(k =>
    `<button class="chip-filter ${S.filter === k ? 'on' : ''}" data-filter="${k}">${k[0].toUpperCase() + k.slice(1)} <b>${c[k]}</b></button>`
  ).join('');
}

function inFilter(r) {
  if (S.filter === 'done') { if (!isDone(r)) return false; }
  else if (isDone(r)) return false;
  else if (S.filter === 'edited' ? !isChanged(r) : (S.filter !== 'all' && r.status !== S.filter)) return false;
  if (!S.search) return true;
  const q = S.search.toLowerCase();
  return r.current.partyName.toLowerCase().includes(q)
    || r.original.partyName.toLowerCase().includes(q)
    || r.original.phoneNumbers.some(p => digits(p).includes(q.replace(/\D/g, '') || '\u0000'));
}

function queueItemHTML(r) {
  return `<span class="dot ${r.status}"></span>
    <span class="q-name">${esc(r.current.partyName || '(no name)')}${r.original.older
      ? ` <span class="q-old" title="Last entered ${esc(r.original.last_seen)}, before your look-back window. Loaded to fill your request.">older</span>` : ''}</span>
    ${S.autoBusy[r.id] ? '<span class="q-wait">publishing…</span>'
      : S.autoQ[r.id] ? '<span class="q-wait" title="Waiting out the undo window">queued</span>'
      : r.publish_error ? '<span class="q-err" title="Couldn\'t publish">!</span>'
      : r.ticketed ? `<span class="q-rel" title="A ticket now: ${esc(r.ticketed.to)}'s turn when it was made">🎫 ${esc(r.ticketed.to)}</span>`
      : r.ticket && !r.published && !r.released ? (ticketLocked(r) ? `<span class="q-rel" title="Ticket: ${esc(r.ticket.turn_name)}'s turn">🎫 ${esc(r.ticket.turn_name)}</span>`
        : '<span class="q-ho" title="Ticket: your turn">🎫 your turn</span>')
      : r.released ? '<span class="q-rel" title="Released for someone else">released</span>'
      : r.published ? '<span class="q-pub" title="Published to Databricks">✓ MCL</span>'
      : (isChanged(r) ? '<span class="q-edit" title="Edited">✎</span>' : '')}
    <span class="q-phone">${esc(fmtPhone(r.original.phoneNumbers[0]))}</span>`;
}

function renderQueue() {
  const list = $('#queue-list');
  const items = S.rows.filter(inFilter);
  list.innerHTML = items.length
    ? items.map(r => `<li data-id="${r.id}" class="${r.id === S.idx ? 'active' : ''}">${queueItemHTML(r)}</li>`).join('')
    : '<li class="empty">Nothing matches.</li>';
  const active = $('li.active', list);
  if (active) active.scrollIntoView({ block: 'nearest' });
}

function refreshQueueItem(row) {
  const li = $(`#queue-list li[data-id="${row.id}"]`);
  if (li) li.innerHTML = queueItemHTML(row);
}

// Long number lists fold to one line, with a toggle (some callers have hundreds of numbers).
function fitPhones(row) {
  const box = $('#phones'), more = $('#phones-more');
  if (!box || !more) return;
  const open = !!S.phonesOpen[row.id];
  box.classList.remove('open');
  const overflowing = box.scrollHeight > box.clientHeight + 2;
  box.classList.toggle('open', open);
  more.hidden = !overflowing;
  if (overflowing) {
    const n = row.original.phoneNumbers.length;
    more.firstElementChild.textContent = open ? 'Show fewer' : `Show all ${n} numbers`;
  }
}

function publishedBanner(row) {
  if (row.ticketed) {
    return `<div class="published-banner released">🎫 This is a ticket now (${esc(String(row.ticketed.at || '').replace('T', ' ').slice(0, 16))},
      ${esc(row.ticketed.to)}'s turn): “${esc(row.ticketed.note)}”.
      <button class="link-btn" data-tk="board" data-tk-id="${esc(row.ticketed.id)}">Open the ticket</button></div>`;
  }
  if (row.ticket?.closed && !row.published) {
    const what = { added: 'added to the MCL', merged: 'merged into an MCL entry', denied: 'added to the denied list',
      'up to date': 'already up to date', released: 'sent back to the pool', closed: 'closed without changes' }[row.ticket.closed] || 'resolved';
    return `<div class="published-banner released">🎫 This ticket was ${what}${row.ticket.resolved_by ? ` by ${esc(row.ticket.resolved_by)}` : ''}, so there's nothing left to do here.
      <button class="link-btn" data-tk="board" data-tk-id="${esc(row.ticket.id)}">Open the ticket</button></div>`;
  }
  const ticket = row.ticket && !row.published && !row.released && window.ticketBannerHTML ? window.ticketBannerHTML(row) : '';
  return ticket + publishedBannerInner(row);
}

function publishedBannerInner(row) {
  if (row.publish_error && !row.published) {
    return `<div class="published-banner error">${esc(row.publish_error)} Fix it and approve again.</div>`;
  }
  if (row.released) {
    return `<div class="published-banner released">Released to the pool · ${esc(String(row.released.at || '').replace('T', ' ').slice(0, 16))}.
      Anyone can pick it up in their next queue load.</div>`;
  }
  const p = row.published;
  if (!p) return '';
  const when = String(p.at || '').replace('T', ' ').slice(0, 16);
  const what = {
    insert: `Added to the MCL as a new entry`,
    merge: `Merged into the existing MCL entry “${esc(p.target)}”`,
    deny: 'Added to the denied list',
    skip: p.kind === 'denied' ? 'Already on the denied list' : `Already up to date in the MCL (“${esc(p.target)}”)`,
  }[p.action] || 'Published';
  const target = p.kind === 'denied' ? null : (p.target || row.current.partyName);
  return `<div class="published-banner">✓ ${what} · ${esc(when)}. This row is locked; later fixes go through the MCL editor.
    ${target && dbOn() ? `<button class="link-btn" data-open-editor="${esc(target)}">Open in MCL editor</button>` : ''}</div>`;
}

function renderEntity() {
  const row = cur();
  const el = $('#entity');
  if (!row) { el.innerHTML = ''; return; }
  const o = row.original;
  const phones = o.phoneNumbers.length ? o.phoneNumbers : [''];

  el.innerHTML = `
    <div class="entity-head">
      <div>
        <div class="eyebrow">Row ${row.id + 1} of ${S.rows.length}${o.createdBys.length ? ` · created by ${esc(o.createdBys.join(', '))}` : ''}${
          o.seen ? ` · entered ${o.seen} time${o.seen === 1 ? '' : 's'}` : ''}${o.last_seen ? `, last on ${esc(o.last_seen)}` : ''}${
          o.older ? ' <span class="q-old" title="From before your look-back window: the app reached further back to fill your request">older</span>' : ''}</div>
        <h1 id="title">${esc(row.current.partyName || '(no name)')}</h1>
        <div class="phones ${S.phonesOpen[row.id] ? 'open' : ''}" id="phones">${phones.map(p => digits(p).length === 10 ? `<span class="phone-wrap">
          <a class="phone" href="${telUrl(p)}" title="Call ${esc(fmtPhone(p))}">${esc(fmtPhone(p))}</a><button class="phone-copy"
            data-phone="${esc(digits(p))}" title="Copy number" aria-label="Copy ${esc(fmtPhone(p))}">⧉</button></span>`
          : `<span class="phone bad-phone">${esc(p || 'no number')}</span>`).join('')}</div>
        <div class="phones-more" id="phones-more" hidden>
          <button class="link-btn" data-act="phones-toggle"></button>
          <button class="link-btn" data-act="phones-copy">Copy all ${phones.length} numbers</button>
        </div>
      </div>
      <span class="status-pill ${row.status}" id="status-pill">${STATUS_LABEL[row.status]}</span>
    </div>

    ${publishedBanner(row)}
    <div class="links">
      <button class="btn primary-outline" data-act="site">Open website <kbd>W</kbd></button>
      <button class="btn" data-act="copy">Copy number <kbd>C</kbd></button>
      <button class="btn" data-act="verify">LNT verification <kbd>V</kbd></button>
      <button class="btn" data-act="lnt">LNT caller search <kbd>L</kbd></button>
      <button class="btn" data-act="google">Google name <kbd>G</kbd></button>
      <button class="btn" data-act="gphone">Google number <kbd>P</kbd></button>
    </div>

    <div class="grid">
      <fieldset class="form" ${readOnly(row) ? 'disabled' : ''}>
        <div class="field">
          <label for="f-name">Party name</label>
          <input id="f-name" autocomplete="off" spellcheck="false">
          <div class="diff" id="diff-partyName"></div>
          <div class="field-checks" data-checks="partyName"></div>
        </div>

        <div class="field">
          <label>Name variations <button class="link-btn" id="btn-gen" title="Put lower and UPPER of the current name first, keep the rest (old names stay as aliases)">Add current name variants</button></label>
          <div class="vars" id="f-vars"></div>
          <div class="muted small vars-note" id="vars-note" hidden>🔒 The name changed, so the original name's variations are locked in. Anyone entering the old name will still link to this caller.</div>
          <input id="f-var-add" placeholder="Add a variation (paste pipe-separated lists too) and press Enter" autocomplete="off" spellcheck="false">
          <div class="diff" id="diff-name_variations"></div>
          <div class="field-checks" data-checks="name_variations"></div>
        </div>

        <div class="field">
          <label for="f-industry">Industry</label>
          <input id="f-industry" list="industry-list" autocomplete="off">
          <datalist id="industry-list">${[...new Set([...Object.keys(S.cfg.industry_ids || {}), ...Object.keys(S.cfg.industries || {})])].sort()
            .map(i => `<option value="${esc(i)}">`).join('')}</datalist>
          <div class="diff" id="diff-industry"></div>
          <div class="field-checks" data-checks="industry"></div>
        </div>

        <div class="field">
          <label>Party types</label>
          <div class="pts" id="f-pts"></div>
          <div class="diff" id="diff-partyTypes"></div>
          <div class="field-checks" data-checks="partyTypes"></div>
        </div>

        <div class="field">
          <label for="f-notes">Notes</label>
          <textarea id="f-notes" rows="3" placeholder="Anything worth remembering about this one…"></textarea>
          <div class="diff" id="diff-notes"></div>
        </div>
      </fieldset>
      <aside class="side">
        <div class="lnt" id="lnt-panel"></div>
        <div class="lnt" id="hp-panel" hidden></div>
        <div class="lnt" id="mcl-panel" hidden></div>
      </aside>
    </div>

    <footer class="actionbar">
      <button class="btn ghost" data-act="prev">← Prev <kbd>K</kbd></button>
      <div class="spacer"></div>
      ${S.claimBatch && !isDone(row) && !row.ticket ? '<button class="btn ghost" data-act="release" title="Give this name back so someone else can work it">Release</button>' : ''}
      ${dbOn() && !isDone(row) && !row.ticket ? '<button class="btn ghost" data-act="handoff" title="Make this row a ticket on the shared board, with a note">Ticket… <kbd>H</kbd></button>' : ''}
      ${row.ticket && !isDone(row) ? '<button class="btn ghost" data-act="handoff" title="Write on the ticket">Reply <kbd>H</kbd></button>' : ''}
      <button class="btn flag" data-act="flagged" ${readOnly(row) || row.ticket ? 'disabled' : ''}>Flag <kbd>F</kbd></button>
      <button class="btn deny" data-act="denied" ${readOnly(row) ? 'disabled' : ''}>Deny <kbd>D</kbd></button>
      <button class="btn primary" data-act="approved" ${readOnly(row) ? 'disabled' : ''}>Approve <kbd>A</kbd></button>
      <div class="spacer"></div>
      <button class="btn ghost" data-act="next">Next → <kbd>J</kbd></button>
    </footer>`;

  $('#f-name').value = row.current.partyName;
  $('#f-industry').value = row.current.industry;
  $('#f-notes').value = row.current.notes;
  renderVars();
  renderPts();
  refresh();
  fitPhones(row);
  loadLnt(row);
  loadMcl(row);
  checkNameInDb(row);
  loadHoneypot(row);
  if (row.ticket && !isDone(row)) window.loadTicketForRow?.(row);
  const inflight = S.lntInflight[row.id];
  if (inflight) inflight.then(() => prefetchNext(row)); else prefetchNext(row);
}

// Once the party name changes, the original name and its variations must stay, so anyone who
// enters the old name still gets linked to the renamed caller in the MCL.
function protectedVariations(row) {
  const oldName = collapse(row.original.partyName);
  if (!oldName || collapse(row.current.partyName) === oldName) return [];
  // The exact original (as it was capitalized) comes first, then its lower/UPPER forms and old variations.
  return [...new Set([oldName, oldName.toLowerCase(), oldName.toUpperCase(), ...row.original.name_variations.map(collapse)]
    .filter(Boolean))];
}

// The locked forms aren't written into the list while you type: they're shown (and added at
// export) only while the name differs, so typing your way back to the original leaves nothing behind.
function renderVars() {
  const row = cur();
  const vars = row.current.name_variations;
  const lockedList = protectedVariations(row);
  const locked = new Set(lockedList);
  const have = new Set(vars.map(collapse));
  const items = [
    ...vars.map((v, i) => ({ v, i })),
    ...lockedList.filter(p => !have.has(p)).map(v => ({ v, i: null })), // locked forms not in the list yet
  ];
  $('#f-vars').innerHTML = items.length
    ? items.map(({ v, i }) => {
      const isLocked = locked.has(collapse(v));
      const text = esc(v).replace(/ {2,}/g, m => '<u>' + '·'.repeat(m.length) + '</u>');
      return `<span class="var ${/\s{2,}/.test(v) ? 'bad' : ''} ${isLocked ? 'locked' : ''}"
        ${isLocked ? 'title="Original name. Kept so anyone entering the old name still links to this caller."' : ''}>
        ${isLocked ? '<span class="lock" aria-hidden="true">🔒</span>' : ''}<span class="var-text">${text}</span>
        ${isLocked || i === null ? '' : `<button data-rm="${i}" title="Remove">×</button>`}</span>`;
    }).join('')
    : '<span class="muted small">None yet</span>';
  $('#vars-note').hidden = !locked.size;
}

function renderPts() {
  const row = cur();
  const known = Object.keys(S.cfg.partytypes || {});
  const extras = row.current.partyTypes.filter(p => !known.includes(p));
  const filterable = S.cfg.filterable || [];
  $('#f-pts').innerHTML = [...known, ...extras].map(code => {
    const on = row.current.partyTypes.includes(code);
    const label = S.cfg.partytypes?.[code];
    return `<button class="pt ${on ? 'on' : ''} ${filterable.includes(code) ? 'risky' : ''}" data-pt="${esc(code)}" title="${esc(label || code)}">
      <b>${esc(code)}</b>${label ? `<span>${esc(label)}</span>` : ''}</button>`;
  }).join('') + `<input id="f-pt-add" class="pt-add" placeholder="+ code" maxlength="4">`;
}

function diffHTML(row, k) {
  if (!fieldChanged(row, k)) return '';
  const o = row.original[k];
  const shown = Array.isArray(o) ? (k === 'name_variations' ? o.join(' | ') : o.join(', ')) : o;
  return `Original: <span>${esc(shown) || '<i>empty</i>'}</span> <button class="link-btn" data-revert="${k}">Revert</button>`;
}

// Updates everything that depends on field values without rebuilding the inputs.
function refresh() {
  const row = cur();
  if (!row) return;
  $('#title').textContent = row.current.partyName || '(no name)';
  document.title = `MCL | ${collapse(row.current.partyName) || '(no name)'}`;
  for (const k of EDIT_FIELDS) {
    const d = $(`#diff-${k}`);
    if (d) d.innerHTML = diffHTML(row, k);
  }
  const checks = validate(row);
  S.currentChecks = checks;
  document.querySelectorAll('[data-checks]').forEach(box => {
    const mine = checks.filter(c => c.field === box.dataset.checks);
    box.innerHTML = mine.map(c => {
      const i = checks.indexOf(c);
      return `<div class="check ${c.level}">${esc(c.msg)}${c.fix ? ` <button class="link-btn" data-fix="${i}">${esc(c.fixLabel)}</button>` : ''}</div>`;
    }).join('');
  });
  refreshQueueItem(row);
  renderProgress();
  renderFilters();
}

// ------------------------------------------------------------------ editing & saving

function setField(k, v) {
  const row = cur();
  if (isDone(row)) return toast('This row is finished here, so it can\'t be changed.', 'error');
  row.current[k] = v;
  if (k === 'partyName') {
    $('#f-name').value = v;
    renderVars();
    checkNameInDb(row);
  }
  if (k === 'industry') $('#f-industry').value = v;
  if (k === 'notes') $('#f-notes').value = v;
  if (k === 'name_variations') renderVars();
  if (k === 'partyTypes') renderPts();
  scheduleSave(row);
  refresh();
}

function setSaveState(text) { $('#save-state').textContent = text; }

function scheduleSave(row, immediate = false) {
  clearTimeout(S.timers[row.id]);
  setSaveState('Saving…');
  if (immediate) return saveRow(row);
  S.timers[row.id] = setTimeout(() => saveRow(row), 400);
}

async function saveRow(row) {
  delete S.timers[row.id];
  try {
    await api(`/api/rows/${row.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ current: row.current, status: row.status }),
    });
    setSaveState('Saved');
  } catch (e) {
    setSaveState('Save failed');
    toast(`Save failed: ${e.message}`, 'error');
  }
}

function addVariations(text) {
  const row = cur();
  const incoming = String(text).split('|').map(s => s.trim()).filter(Boolean);
  if (!incoming.length) return;
  const vars = row.current.name_variations;
  setField('name_variations', [...vars, ...incoming.filter(v => !vars.includes(v))]);
}

function addCurrentNameVariants() {
  const row = cur();
  const n = collapse(row.current.partyName);
  if (!n) return toast('Enter a party name first', 'error');
  const front = nameVariants(n);
  setField('name_variations', [...front, ...row.current.name_variations.filter(v => !front.includes(v))]);
}

function togglePt(code) {
  const row = cur();
  const known = Object.keys(S.cfg.partytypes || {});
  const set = new Set(row.current.partyTypes);
  set.has(code) ? set.delete(code) : set.add(code);
  const ordered = [...known.filter(c => set.has(c)), ...[...set].filter(c => !known.includes(c))];
  setField('partyTypes', ordered);
}

// ------------------------------------------------------------------ navigation & status

function go(i) {
  if (i < 0 || i >= S.rows.length) return;
  S.idx = i;
  renderQueue();
  renderEntity();
}

function step(delta) {
  // move within the filtered view when there is one
  const visible = S.rows.filter(inFilter).map(r => r.id);
  const pos = visible.indexOf(S.idx);
  if (pos === -1) return go(S.idx + delta);
  const next = visible[pos + delta];
  if (next !== undefined) go(next);
}

function setStatus(status) {
  const row = cur();
  if (isDone(row)) return toast(row.ticketed ? 'This row is a ticket now: work it on the Tickets board.' : row.released ? 'This row was released, so its status is locked.' : 'This row is already published, so its status is locked.', 'error');
  if (ticketLocked(row)) return toast(`It's ${row.ticket.turn_name}'s turn on this ticket. Take the turn to decide it.`, 'error');
  if (row.ticket && status === 'flagged') return window.focusTicketComposer?.();
  if (S.autoBusy[row.id]) return toast('That row is publishing right now.', 'error');
  const previous = row.status;
  cancelAutoPublish(row);
  row.status = status;
  delete row.publish_error;
  scheduleSave(row, true);
  if ((status === 'approved' || status === 'denied') && autoPublishOn()) queueAutoPublish(row, previous);
  if (status === 'flagged' && previous !== 'flagged') setTimeout(() => window.offerOnFlag?.(row), 0);
  if (row.ticket && status !== previous) window.ticketDecision?.(row, status);
  renderFilters();
  refresh();
  if (status === 'pending') {
    $('#status-pill').className = 'status-pill pending';
    $('#status-pill').textContent = 'Pending';
    return;
  }
  const n = S.rows.length;
  for (let k = 1; k <= n; k++) {
    const r = S.rows[(row.id + k) % n];
    if (r.status === 'pending' && !isDone(r)) return go(r.id);
  }
  renderEntity();
  toast(autoPublishOn() ? 'Every row has been reviewed.' : 'Every row has been reviewed. Time to publish or export!', 'ok');
}

// ------------------------------------------------------------------ publish on approve
// Approve/Deny waits a few seconds (with Undo), then publishes that one row in the background.

const autoPublishOn = () => !!(dbOn() && S.cfg.publish?.auto && S.cfg.publish?.dry_run === false);
const autoDelay = () => Math.max(3, Number(S.cfg.publish?.auto_delay_seconds) || 10) * 1000;

function queueAutoPublish(row, previous) {
  const name = row.current.partyName;
  const verb = row.status === 'denied' ? 'Denying' : 'Publishing';
  const timer = setTimeout(() => runAutoPublish(row), autoDelay());
  S.autoQ[row.id] = { timer, previous };
  toastAction(`${verb} “${name}” in ${Math.round(autoDelay() / 1000)}s`, 'Undo', () => {
    if (!S.autoQ[row.id]) return;
    cancelAutoPublish(row);
    row.status = previous === 'approved' || previous === 'denied' ? 'pending' : previous;
    scheduleSave(row, true);
    go(row.id);
    renderFilters();
    toast(`Undone. “${name}” is back to ${row.status}.`);
  }, autoDelay());
  refreshQueueItem(row);
}

function cancelAutoPublish(row) {
  const q = S.autoQ[row.id];
  if (!q) return;
  clearTimeout(q.timer);
  delete S.autoQ[row.id];
  refreshQueueItem(row);
}

async function runAutoPublish(row) {
  delete S.autoQ[row.id];
  S.autoBusy[row.id] = true;
  refreshQueueItem(row);
  try {
    await flushSaves();
    const r = await dbFetch(`/api/publish/row/${row.id}`, { method: 'POST' });
    Object.assign(row, { status: r.row.status, published: r.row.published || null, publish_error: r.row.publish_error });
    if (r.published) {
      Object.assign(S, { dbMatch: {}, mcl: {}, mclTerm: {} });
      const what = { insert: 'added to the MCL', merge: `merged into “${r.target}”`, deny: 'added to the denied list', skip: 'already up to date' }[r.action];
      toast(`✓ “${row.current.partyName}” ${what || 'published'}`, 'ok');
      for (const w of [...(r.warnings || []), ...(r.verify || [])]) toast(w, 'error');
    } else {
      toast(`“${row.current.partyName}” wasn't published and is now Flagged: ${row.publish_error}`, 'error');
    }
  } catch (e) {
    row.publish_error = `Couldn't publish: ${e.message}`;
    toast(`“${row.current.partyName}”: ${e.message}`, 'error');
  } finally {
    delete S.autoBusy[row.id];
    renderQueue(); // a published row moves from the active list to Done
    renderFilters();
    renderProgress();
    if (cur() === row) renderEntity();
  }
}

window.addEventListener('beforeunload', e => {
  if (Object.keys(S.autoQ).length || Object.keys(S.autoBusy).length) { e.preventDefault(); e.returnValue = ''; }
});

function phone() { return digits(cur().original.phoneNumbers[0]); }
function openUrl(url) { window.open(url, '_blank', 'noopener'); }

function act(name) {
  const row = cur();
  const base = (S.cfg.lnt_base || '').replace(/\/$/, '');
  const searchName = row.original.partyName || row.current.partyName;
  switch (name) {
    case 'site': {
      const site = S.lnt[row.id]?.caller?.website;
      if (site) return openUrl(siteUrl(site));
      if (S.lntInflight[row.id]) return toast('Still loading from the LNT…');
      if (!bridgeReady()) return toast('Install the LNT bridge to open websites from here', 'error');
      return toast('No website on file in the LNT. Try Google (G)');
    }
    case 'lnt-refresh': return loadLnt(row, true);
    case 'release': return releaseRow(row);
    case 'handoff':
      if (isDone(row)) return toast('This row is finished here.', 'error');
      if (!dbOn()) return toast('Connect Databricks to use tickets', 'error');
      if (row.ticket) return window.focusTicketComposer?.();
      return openHandoff(row);
    case 'phones-toggle':
      S.phonesOpen[row.id] = !S.phonesOpen[row.id];
      return fitPhones(row);
    case 'phones-copy':
      return copyText(row.original.phoneNumbers.map(digits).filter(Boolean).join('\n'),
        `Copied ${row.original.phoneNumbers.length} numbers, one per line`);
    case 'hp-refresh': return loadHoneypot(row, true);
    case 'history-all': S.historyAll = !S.historyAll; return S.lnt[row.id] && renderLnt(row, S.lnt[row.id]);
    case 'copy': return copyText(phone(), `Copied ${fmtPhone(phone())}`);
    case 'verify':
      copyText(phone());
      return openUrl(lntVerifyUrl(phone()));
    case 'call':
      if (phone().length !== 10) return toast('No phone number to call', 'error');
      location.href = telUrl(phone());
      return;
    case 'lnt': return openUrl(`${base}/caller/?action=search&search=${encodeURIComponent(searchName)}`);
    case 'google': return openUrl(`https://www.google.com/search?q=${encodeURIComponent('"' + searchName + '"')}`);
    case 'gphone': return openUrl(`https://www.google.com/search?q=${encodeURIComponent('"' + fmtPhone(phone()) + '"')}`);
    case 'prev': return step(-1);
    case 'next': return step(1);
    case 'approved': case 'denied': case 'flagged': return setStatus(name);
  }
}

// ------------------------------------------------------------------ events

document.addEventListener('click', async e => {
  const menu = $('#export-menu');
  if (menu?.open && !e.target.closest('#export-menu')) menu.open = false;

  const exp = e.target.closest('a.export-link');
  if (exp) {
    e.preventDefault();
    if (exp.dataset.count === '0') return toast('No rows to export for that option yet', 'error');
    if (menu) menu.open = false;
    await flushSaves();
    location.href = exp.href;
    return;
  }

  const t = e.target.closest('button, li[data-id]');
  if (!t) return;
  if (t.matches('li[data-id]')) return go(Number(t.dataset.id));
  if (t.dataset.filter) { S.filter = t.dataset.filter; renderFilters(); renderQueue(); return; }
  if (t.dataset.act) return act(t.dataset.act);
  if (t.dataset.phone !== undefined) return copyText(t.dataset.phone, `Copied ${fmtPhone(t.dataset.phone)}`);
  if (t.dataset.rm !== undefined) {
    const vars = [...cur().current.name_variations];
    vars.splice(Number(t.dataset.rm), 1);
    return setField('name_variations', vars);
  }
  if (t.dataset.pt) return togglePt(t.dataset.pt);
  if (t.dataset.openEditor) return openEditor(t.dataset.openEditor);
  if (t.dataset.useIndustry) return setField('industry', t.dataset.useIndustry);
  if (t.dataset.loadCaller) return loadOtherCaller(cur(), t.dataset.loadCaller);
  if (t.dataset.mclValue !== undefined) {
    if (S.mclInfo[t.dataset.mclValue]?.db) return; // Databricks results already show their details
    return loadMclInfo(cur(), t.dataset.mclValue);
  }
  if (t.dataset.hpExpand !== undefined) {
    const li = t.closest('.hp-item');
    li.classList.toggle('open');
    t.textContent = li.classList.contains('open') ? 'Show less' : 'Show more';
    return;
  }
  if (t.id === 'db-pill') return connectDb();
  if (t.id === 'btn-db-queue') return loadDbQueue();
  if (t.dataset.qfInd) {
    const set = new Set(qf.industries);
    set.has(t.dataset.qfInd) ? set.delete(t.dataset.qfInd) : set.add(t.dataset.qfInd);
    qf.industries = [...set].sort();
    t.classList.toggle('on');
    return readQf();
  }
  if (t.id === 'qf-ind-clear') { qf.industries = []; renderQf(); return readQf(); }
  if (t.id === 'qf-reset') { qf = { ...QF_DEFAULT }; saveQf(); renderQf(); $('#qf-count').textContent = ''; return; }
  if (t.id === 'qf-count-btn') return countQf();
  if (t.dataset.mclApply !== undefined) return applyMclInfo(t.dataset.mclApply);
  if (t.dataset.fix !== undefined) return S.currentChecks?.[Number(t.dataset.fix)]?.fix?.();
  if (t.dataset.revert) {
    const k = t.dataset.revert, o = cur().original[k];
    return setField(k, Array.isArray(o) ? [...o] : o);
  }
  if (t.id === 'btn-gen') return addCurrentNameVariants();
  if (t.id === 'btn-new-file') return showUpload(true);
  if (t.id === 'btn-cancel-upload') return showWork();
});

document.addEventListener('input', e => {
  if (e.target.closest?.('#qf')) return readQf(); // start-screen filters
  const row = cur();
  if (!row) return;
  const map = { 'f-name': 'partyName', 'f-industry': 'industry', 'f-notes': 'notes' };
  const k = map[e.target.id];
  if (k) {
    row.current[k] = e.target.value;
    if (k === 'partyName') {
      renderVars(); // locks appear/disappear as the name moves away from (or back to) the original
      clearTimeout(S.matchTimer);
      S.matchTimer = setTimeout(() => checkNameInDb(row), 600); // re-check the MCL once typing pauses
    }
    scheduleSave(row);
    refresh();
  }
  if (e.target.id === 'queue-search') { S.search = e.target.value.trim(); renderQueue(); }
});

document.addEventListener('keydown', e => {
  if (!$('#publish').hidden) {
    if (e.key === 'Escape') { e.preventDefault(); closePublish(); }
    return;
  }
  if (!$('#settings').hidden) {
    if (e.key === 'Escape') { e.preventDefault(); closeSettings(); }
    return;
  }
  if (!$('#handoff').hidden) {
    if (e.key === 'Escape') { e.preventDefault(); closeHandoff(); }
    return;
  }
  if (S.mode !== 'review') return; // the editor and Add to MCL have no single-key shortcuts
  if (e.target.id === 'mcl-term' && e.key === 'Enter') {
    e.preventDefault();
    loadMcl(cur(), e.target.value);
    return;
  }
  if (e.target.id === 'f-var-add' && e.key === 'Enter') {
    e.preventDefault();
    addVariations(e.target.value);
    e.target.value = '';
    return;
  }
  if (e.target.id === 'f-pt-add' && e.key === 'Enter') {
    e.preventDefault();
    const code = e.target.value.trim().toUpperCase();
    if (code && !cur().current.partyTypes.includes(code)) togglePt(code);
    return;
  }
  if (!S.rows.length || !$('#upload-view').hidden) return;

  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); return setStatus('approved'); }
  const typing = e.target.matches('input, textarea, select');
  if (e.key === 'Escape') {
    if (typing) e.target.blur();
    return;
  }
  if (typing || e.ctrlKey || e.metaKey || e.altKey) return;

  const keys = {
    a: () => setStatus('approved'), d: () => setStatus('denied'), f: () => setStatus('flagged'),
    u: () => setStatus('pending'),
    j: () => step(1), arrowright: () => step(1), k: () => step(-1), arrowleft: () => step(-1),
    w: () => act('site'), r: () => act('lnt-refresh'),
    t: () => act('call'), h: () => act('handoff'),
    c: () => act('copy'), v: () => act('verify'), l: () => act('lnt'), g: () => act('google'), p: () => act('gphone'),
    n: () => { if (isDone(cur())) return; const f = $('#f-name'); f.focus(); f.select(); },
    '?': () => openSettings('shortcuts'),
  };
  const fn = keys[e.key.toLowerCase()];
  if (fn) { e.preventDefault(); fn(); }
});

// file picking + drag and drop
$('#file-input').addEventListener('change', e => { uploadFile(e.target.files[0]); e.target.value = ''; });
const dz = $('#dropzone');
['dragenter', 'dragover'].forEach(ev => dz.addEventListener(ev, e => { e.preventDefault(); dz.classList.add('over'); }));
['dragleave', 'drop'].forEach(ev => dz.addEventListener(ev, e => { e.preventDefault(); dz.classList.remove('over'); }));
dz.addEventListener('drop', e => uploadFile(e.dataTransfer.files[0]));

// flush unsaved edits if the tab closes
window.addEventListener('beforeunload', () => {
  for (const id of Object.keys(S.timers)) {
    clearTimeout(S.timers[id]);
    const row = S.rows[Number(id)];
    fetch(`/api/rows/${row.id}`, {
      method: 'PUT', keepalive: true,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ current: row.current, status: row.status }),
    });
  }
});

init();

$('#qf').addEventListener('toggle', () => { $('#qf').dataset.touched = '1'; });
$('#qf').addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.matches('input')) { e.preventDefault(); countQf(); } });

window.addEventListener('resize', () => { if (cur() && !$('#work-view').hidden) fitPhones(cur()); });

$('#mode-badge').addEventListener('click', () => window.openSettings?.('publishing'));
