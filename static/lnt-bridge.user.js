// ==UserScript==
// @name         MCL Verifier - LNT bridge
// @namespace    mcl-verifier
// @version      1.2
// @description  Lets the local MCL Verifier read LNT caller pages using your existing LNT login.
// @match        http://127.0.0.1:5050/*
// @match        http://localhost:5050/*
// @grant        GM_xmlhttpRequest
// @connect      lnt.fosrv.com
// @run-at       document-start
// ==/UserScript==

(function () {
    'use strict';

    const VERSION = '1.2';
    // Only GET requests to the LNT are ever made. Nothing is written back.
    const ALLOWED = /^https:\/\/lnt\.fosrv\.com\//;
    const TIMEOUT_MS = 10000;

    // Tampermonkey runs this in a sandbox where `window` is a wrapper, not the page's window,
    // so messages are matched by origin and type rather than by e.source.
    function post(data) {
        window.postMessage(data, location.origin);
    }

    function announce() {
        if (document.documentElement) document.documentElement.dataset.mclvBridge = VERSION;
        post({ type: 'mclv:bridge-ready', version: VERSION });
    }

    window.addEventListener('message', (e) => {
        if (e.origin !== location.origin) return;
        const msg = e.data;
        if (!msg || typeof msg !== 'object') return;

        if (msg.type === 'mclv:ping') { announce(); return; }
        if (msg.type !== 'mclv:fetch') return;

        const reply = (data) => post({ type: 'mclv:result', id: msg.id, ...data });
        if (typeof msg.url !== 'string' || !ALLOWED.test(msg.url)) {
            reply({ error: 'URL not allowed' });
            return;
        }

        try {
            GM_xmlhttpRequest({
                method: 'GET',
                url: msg.url,
                timeout: TIMEOUT_MS,
                // The LNT's own pages call /api/ with jQuery, which sends this header.
                headers: /\/api\//.test(msg.url) ? { 'X-Requested-With': 'XMLHttpRequest', 'Accept': 'application/json' } : {},
                onload: (r) => reply({ status: r.status, finalUrl: r.finalUrl, text: r.responseText }),
                onerror: (r) => reply({ error: `couldn't reach the LNT${r && r.error ? ` (${r.error})` : ''}` }),
                ontimeout: () => reply({ error: 'the LNT took too long to answer' }),
            });
        } catch (err) {
            reply({ error: `bridge error: ${err.message}` });
        }
    });

    announce();
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', announce);
    console.log(`[MCL Verifier bridge] v${VERSION} loaded`);
})();
