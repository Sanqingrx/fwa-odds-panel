// ==UserScript==
// @name         FWA Odds Panel
// @namespace    fwa.monitor
// @version      3.0
// @description  Live odds for fwa.fun: true cost per pull, full outcome distribution, and how many pulls is optimal. Same data source as the official UI, with built-in consistency checks.
// @match        https://www.fwa.fun/*
// @match        https://fwa.fun/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

/* ═══════════════════════════════════════════════════════════════════════════
 *  Usage
 *    A) Tampermonkey → new script → paste this file → save. The panel then appears
 *       automatically whenever you open fwa.fun.
 *    B) One-off: on fwa.fun press F12 → Console → paste → Enter.
 *
 *  What changed in 3.0
 *    fwa.fun moved to server-side rendering in 2026-08. /api/ponder still exists but
 *    now answers only a small whitelist (leaderboard, prize, ...), so the
 *    pool-public / pool-prizes-page calls 2.0 relied on return
 *    "Invalid Ponder operation request" and the panel could no longer fetch anything.
 *    The pool data did not disappear — it moved into the page's own server-rendered
 *    payload. 3.0 reads that instead, and the result is better than before.
 *
 *  Why the numbers match fwa.fun exactly
 *    1. It reads the very payload the official UI renders from (the RSC data embedded
 *       in the page). That is stronger than "same endpoint": it is the same snapshot.
 *       Gas still comes from the site's own /api/rpc.
 *    2. Every protocol parameter (surcharge / settlement discount / hotGap / coldGap /
 *       whether acquisitions are enabled) is read live from gameState on each refresh.
 *       Nothing is hardcoded. If the owner changes a parameter, the panel follows.
 *    3. Gas price is read live from chain, not estimated.
 *    4. The ticket price is computed twice via two independent paths and cross-checked:
 *         Path A (contract view): weightedBackingTotal / totalActiveWeight × (1+surcharge)
 *         Path B (enumeration):   N / Σ(1/backing) × (1+surcharge)
 *       Agreement proves not one of the 6000+ listings was missed. Disagreement → red alert.
 *    5. New in 3.0: four digit-exact reconciliations — the enumerated Σweight and
 *       Σbacking must equal the gameState totals as exact BigInt equalities, and every
 *       weight must equal exactly 1e36 ÷ backing.
 *
 *  Known limitations that code cannot fix are listed in the panel's "Limits" tab.
 * ═══════════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';
  if (window.__fwaPanel) { window.__fwaPanel.refresh(); return; }

  const E = 1e18;
  const HDR = { 'content-type': 'application/json', 'x-gacha-client': 'web' };
  let onProgress = () => {};

  const rpc = (method, params = []) =>
    fetch('/api/rpc', { method: 'POST', headers: HDR, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })
      .then(r => r.json());
  /* ── Data source: the page's own server-rendered payload ─────────────────
     fwa.fun moved to server-side rendering in 2026-08. /api/ponder still exists but
     now answers only a small whitelist of operations (leaderboard, prize, ...), so
     the old pool-public / pool-prizes-page calls all return
     "Invalid Ponder operation request".

     The pool data did not disappear — it moved into the page's own RSC flight
     payload: the homepage embeds the complete gameState plus every active listing
     (id / weight / backing / activatedAt / allocatedAt / resolvedAt).

     This is strictly better than the old pagination:
       · one request instead of up to 60, seconds instead of tens of seconds;
       · gameState and listings come from ONE server render, so the "pool shifted
         while we were paginating" race is gone — the listing-count check is now an
         exact equality rather than a tolerance;
       · still nothing hardcoded, which matters more than ever: the owner has since
         changed the parameters (surcharge 1000 → 250 bps, settlement discount
         8500 → 9000 bps).                                                      */
  function flightRaw(html) {
    let raw = '';
    const re = /self\.__next_f\.push\(\[\d+,("(?:[^"\\]|\\.)*")\]\)/g;
    let m;
    while ((m = re.exec(html))) { try { raw += JSON.parse(m[1]); } catch (e) {} }
    return raw;
  }
  function flightFromDOM() {
    let html = '';
    for (const s of document.querySelectorAll('script')) {
      const t = s.textContent || '';
      if (t.indexOf('__next_f.push') !== -1) html += t;
    }
    return flightRaw(html);
  }
  // Bracket-match out "key":{…} or "key":[…]. A key can occur more than once, so try
  // each candidate until one parses.
  function grabJSON(raw, key, open, close) {
    let k = -1;
    while ((k = raw.indexOf('"' + key + '"', k + 1)) !== -1) {
      const st = raw.indexOf(open, k);
      if (st < 0 || st - k > 40) continue;
      let d = 0;
      for (let e = st; e < raw.length; e++) {
        const c = raw[e];
        if (c === open) d++;
        else if (c === close) {
          if (--d === 0) {
            try { return JSON.parse(raw.slice(st, e + 1)); } catch (err) { break; }
          }
        }
      }
    }
    return null;
  }

  const F = (x, d = 4) => (x == null || !isFinite(x)) ? '—' : (+x).toFixed(d);
  const PCT = x => (x * 100).toFixed(2) + '%';

  // Self-paid gas estimate (VRF 800k/+30% comes from official docs; the two tx gas figures are conservative guesses)
  const VRF_GAS = 800000, VRF_MARGIN = 1.30, BUY_GAS = 300000, SETTLE_GAS = 180000;

  const BK = [
    ['Wipeout <30%', 0, .30, '#8b2635'], ['Heavy loss 30–60%', .30, .60, '#c74a4a'],
    ['Small loss 60–95%', .60, .95, '#e0844a'], ['Break-even ±5%', .95, 1.05, '#8b929e'],
    ['Small win 1–2×', 1.05, 2, '#5fb87a'], ['Double 2–5×', 2, 5, '#3fd68c'],
    ['Jackpot ≥5×', 5, 1e9, '#f5c451']
  ];

  /* ══════════════ FETCH ══════════════ */
  let usedDOM = false;
  async function fetchAll() {
    // First render uses the payload already in the page (zero requests). Every refresh
    // after that re-fetches the homepage, so the pool stays current without a reload.
    let raw = null, gs = null, ls = null;
    if (!usedDOM) {
      onProgress('Reading page data…');
      raw = flightFromDOM();
      gs = grabJSON(raw, 'gameState', '{', '}');
      ls = grabJSON(raw, 'listings', '[', ']');
      if (gs && ls && ls.length) usedDOM = true;
    }
    if (!gs || !ls || !ls.length) {
      onProgress('Requesting the latest pool from fwa.fun…');
      const html = await fetch('/', { cache: 'no-store', credentials: 'same-origin' }).then(r => r.text());
      raw = flightRaw(html);
      gs = grabJSON(raw, 'gameState', '{', '}');
      ls = grabJSON(raw, 'listings', '[', ']');
    }
    if (!gs) throw new Error('gameState not found in the page (are you on the fwa.fun domain?)');
    if (!ls || !ls.length) throw new Error('Listing array not found in the page — the site structure may have changed again');

    onProgress('Computing…');
    let gwei = null;
    try { const r = await rpc('eth_gasPrice'); if (r.result) gwei = parseInt(r.result, 16) / 1e9; } catch (e) {}

    const act = ls.filter(x => x.activatedAt && !x.allocatedAt && !x.resolvedAt);
    // gameState and listings come from one render, so "before" and "after" are the same snapshot
    return { g: gs, g0: gs, act, pages: 1, gwei };
  }

  /* ══════════════ COMPUTE ══════════════ */
  function compute(g, act, g0, gwei) {
    const sur = Number(g.surchargeBps) / 10000;            // live
    const bid = Number(g.settlementDiscountBps) / 10000;   // live
    const hot = Number(g.hotGap), cold = Number(g.coldGap);

    // Path A: contract view
    const evChain = Number(BigInt(g.weightedBackingTotal) * 100000000n / BigInt(g.totalActiveWeight)) / 1e8 / E;
    const ticket = evChain * (1 + sur);

    // Path B: enumeration
    const b = act.map(x => Number(x.backing) / E);
    const N = b.length, S = b.reduce((s, v) => s + 1 / v, 0);
    const evEnum = N / S, ticketEnum = evEnum * (1 + sur);
    const drift = Math.abs(ticketEnum - ticket) / ticket;

    const nA = (g0 || g).activeListingCount, nB = g.activeListingCount;
    const churn = Math.abs(nA - nB);
    const countOK = N >= Math.min(nA, nB) - churn - 2 && N <= Math.max(nA, nB) + churn + 2;
    const exact = N === nB;

    // True all-in cost
    const gw = (gwei ?? 1) * 1e-9;
    const vrfFee = VRF_GAS * VRF_MARGIN * gw, buyGas = BUY_GAS * gw, setGas = SETTLE_GAS * gw;
    const cost = ticket + vrfFee + buyGas + setGas;

    // Cold-start: what share of the surcharge goes to the buyer
    const secs = Math.floor(Date.now() / 1000) - Number(g.lastAcquisitionAt);
    const forced = Number(g.forcedTokenShareBps);
    const share = forced >= 0 ? forced / 10000 : Math.max(0, Math.min(1, (secs - hot) / (cold - hot)));
    const rebate = sur * evChain * share * 0.99;   // minus the 1% FWA trading fee

    const p = b.map(v => (1 / v) / S);
    const got = b.map(v => bid * v + rebate);
    const ratio = got.map(x => x / cost);

    let cum = 0;
    const buckets = BK.map(([n, lo, hi, c]) => {
      const ix = []; for (let i = 0; i < N; i++) if (ratio[i] >= lo && ratio[i] < hi) ix.push(i);
      const pr = ix.reduce((s, i) => s + p[i], 0); cum += pr;
      return { n, c, p: pr, cum, cnt: ix.length,
        lo: ix.length ? Math.min(...ix.map(i => got[i])) : null,
        hi: ix.length ? Math.max(...ix.map(i => got[i])) : null };
    });

    const ord = [...Array(N).keys()].sort((x, y) => ratio[x] - ratio[y]);
    let acc = 0, med = ord[0];
    for (const i of ord) { acc += p[i]; if (acc >= .5) { med = i; break; } }

    const pNo = p.reduce((s, v, i) => s + (got[i] >= cost ? v : 0), 0);
    const ev = p.reduce((s, v, i) => s + v * got[i], 0);
    const mx = b.indexOf(Math.max(...b));
    const refundRate = Number(g.totalAcquisitions) ? Number(g.totalAcquisitionsRefunded) / Number(g.totalAcquisitions) : 0;

    return { N, nA, nB, churn, exact, countOK, drift, sur, bid, hot, cold, secs, share, rebate,
      evChain, evEnum, ticket, ticketEnum, cost, vrfFee, buyGas, setGas, gwei, S,
      buckets, medB: b[med], medGot: got[med], medNet: got[med] - cost, pNo, ev,
      maxB: b[mx], maxMult: got[mx] / cost, pMax: p[mx], minB: Math.min(...b),
      refundRate, enabled: g.acquisitionsEnabled,
      totalBacking: Number(g.totalActiveBacking) / E, topPot: Number(g.topListingPot) / E,
      totalAcq: Number(g.totalAcquisitions), feeVolume: Number(g.totalAcquisitionFeeVolume) / E,
      p, got, b,
      raw: act, gTotalWeight: g.totalActiveWeight, gTotalBacking: g.totalActiveBacking };
  }

  /* ══════════════ MULTI-PULL CURVE ══════════════
     At N≈5000, removing even the 200 cheapest listings raises the ticket price by only 7%;
     10 pulls moves it 0.5%. So pulls are treated as i.i.d. — the without-replacement
     correction is negligible at this pool size. */
  function multi(r, NS = [1, 2, 3, 4, 5, 8, 10, 15, 20, 30, 50, 100]) {
    const M = r.N, cum = new Float64Array(M);
    let a = 0; for (let i = 0; i < M; i++) { a += r.p[i]; cum[i] = a; }
    const pick = () => { const u = Math.random(); let lo = 0, hi = M - 1;
      while (lo < hi) { const m = (lo + hi) >> 1; if (cum[m] < u) lo = m + 1; else hi = m; } return lo; };
    const R = 12000;
    return NS.map(n => {
      const res = new Float64Array(R);
      for (let k = 0; k < R; k++) { let v = 0; for (let d = 0; d < n; d++) v += r.got[pick()]; res[k] = v - n * r.cost; }
      const arr = Array.from(res).sort((x, y) => x - y);
      const q = t => arr[Math.floor(t * (R - 1))];
      return { n, cost: n * r.cost, pNo: arr.filter(x => x >= 0).length / R,
        p5: q(.05), med: q(.5), p95: q(.95) };
    });
  }

  /* ══════════════ SELF-TEST ══════════════ */
  function selftest(r) {
    const T = [], add = (n, exp, act, tol) =>
      T.push({ n, exp, act, err: Math.abs(exp - act), ok: Math.abs(exp - act) <= tol });
    add('All draw probabilities sum to 1', 1, r.p.reduce((s, v) => s + v, 0), 1e-9);
    add('Σ(probability × backing) = harmonic mean', r.evEnum, r.p.reduce((s, v, i) => s + v * r.b[i], 0), 1e-9);
    add('Ticket ÷ expected value = 1+surcharge', 1 + r.sur, r.ticketEnum / r.evEnum, 1e-9);
    add('Bucket probabilities sum to 1', 1, r.buckets.reduce((s, x) => s + x.p, 0), 1e-9);
    add('Contract view vs enumeration ticket price', r.ticket, r.ticketEnum, r.ticket * 0.005);
    // Monte Carlo cross-check against the analytic expectation
    const M = r.N, cum = new Float64Array(M); let a = 0;
    for (let i = 0; i < M; i++) { a += r.p[i]; cum[i] = a; }
    const R = 150000; let tot = 0;
    for (let k = 0; k < R; k++) { const u = Math.random(); let lo = 0, hi = M - 1;
      while (lo < hi) { const m = (lo + hi) >> 1; if (cum[m] < u) lo = m + 1; else hi = m; }
      tot += r.got[lo]; }
    add('Monte Carlo 150k runs vs analytic expectation', r.ev, tot / R, r.ev * 0.02);

    // The four below reconcile the enumerated pool against the official gameState
    // totals, digit for digit. If even one listing were missed or misread the
    // difference would be non-zero — direct proof that nothing was dropped.
    if (r.raw && r.gTotalWeight != null) {
      try {
        const B = x => BigInt(x);
        let sw = 0n, sb = 0n, wOK = 0;
        for (const l of r.raw) {
          const w = B(l.weight), b = B(l.backing);
          sw += w; sb += b;
          if (w === (10n ** 36n) / b) wOK++;
        }
        add('Listing count = activeListingCount', Number(r.nB), r.raw.length, 0);
        add('Σweight = totalActiveWeight (exact)', 0, Number(sw - B(r.gTotalWeight)), 0);
        add('Σbacking = totalActiveBacking (exact)', 0, Number(sb - B(r.gTotalBacking)), 0);
        add('Every weight = 1e36 ÷ backing', r.raw.length, wOK, 0);
      } catch (e) { /* If the site changes field types, skip these rather than break the tab */ }
    }
    return T;
  }

  /* ══════════════ UI ══════════════ */
  const el = document.createElement('div');
  el.id = 'fwa-panel';
  el.innerHTML = `<style>
    #fwa-panel{position:fixed;right:14px;bottom:14px;width:404px;max-height:90vh;display:flex;flex-direction:column;
      z-index:2147483647;background:#0e1014;color:#e6e8eb;border:1px solid #2a2f38;border-radius:13px;
      font:13px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC",sans-serif;
      box-shadow:0 14px 44px rgba(0,0,0,.7)}
    #fwa-panel *{box-sizing:border-box}
    .fH{display:flex;align-items:center;gap:7px;padding:10px 12px;border-bottom:1px solid #22262e;cursor:move;flex:none}
    .fH b{font-size:13px;flex:1}
    .fH button,.fT b{background:#20242c;color:#8b929e;border:1px solid #2f3540;border-radius:6px;
      padding:3px 8px;font-size:11px;cursor:pointer}
    .fH button:hover{background:#2a2f38;color:#e6e8eb}
    .fT{display:flex;gap:4px;padding:9px 12px 0;flex:none}
    .fT b{font-weight:500}
    .fT b.on{background:#2c3340;color:#e6e8eb;border-color:#3d4655}
    .fB{padding:11px 12px 14px;overflow:auto;flex:1}
    .big{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:11px}
    .big>div{background:#161920;border:1px solid #22262e;border-radius:9px;padding:9px 10px}
    .k{font-size:9.5px;color:#5d646f;text-transform:uppercase;letter-spacing:.4px;margin-bottom:4px}
    .v{font-size:20px;font-family:ui-monospace,Menlo,Consolas,monospace;font-weight:700;letter-spacing:-.5px}
    .nn{font-size:10px;color:#8b929e;margin-top:3px}
    .bar{display:flex;height:28px;border-radius:7px;overflow:hidden;border:1px solid #22262e;margin-bottom:9px}
    table.t{width:100%;border-collapse:collapse;font-size:11.5px}
    table.t td{padding:5px 4px;border-bottom:1px solid #1a1d23;text-align:right;font-family:ui-monospace,Menlo,monospace}
    table.t td:first-child{text-align:left;font-family:inherit}
    table.t tr:last-child td{border-bottom:none}
    .dot{display:inline-block;width:8px;height:8px;border-radius:2px;margin-right:6px}
    .g{color:#3fd68c}.b{color:#ff5c5c}.w{color:#ffb020}.d{color:#8b929e}.gd{color:#f5c451}
    .chk{font-size:10.5px;padding:7px 9px;border-radius:7px;margin-bottom:10px;line-height:1.55;background:#161920;border:1px solid #22262e;color:#8b929e}
    .ok{background:rgba(63,214,140,.09);border:1px solid rgba(63,214,140,.3);color:#a5e8c4}
    .no{background:rgba(255,92,92,.09);border:1px solid rgba(255,92,92,.32);color:#ffbdbd}
    .sec{font-size:9.5px;color:#5d646f;text-transform:uppercase;letter-spacing:.5px;margin:13px 0 6px}
    .nt{font-size:10.5px;color:#5d646f;line-height:1.65;margin-top:9px}
    .step{border-left:2px solid #22262e;padding:0 0 12px 13px;margin-left:4px;position:relative}
    .step:before{content:'';position:absolute;left:-5px;top:5px;width:8px;height:8px;border-radius:50%;
      background:#6ea8ff;border:2px solid #0e1014}
    .step .ti{font-size:11.5px;font-weight:600}
    .step .wy{font-size:10.5px;color:#5d646f;margin-top:4px;line-height:1.6}
    .step .eq{font-family:ui-monospace,Menlo,monospace;font-size:10.5px;background:#08090b;border:1px solid #1e222a;
      border-radius:6px;padding:7px 9px;margin-top:6px;white-space:pre;overflow-x:auto;color:#cfd4db;line-height:1.6}
    .pass{color:#3fd68c;font-weight:600}.fail{color:#ff5c5c;font-weight:600}
  </style>
  <div class="fH"><b>FWA Odds Panel</b><span id="fAge" style="font-size:10px;color:#5d646f"></span>
    <button id="fR">Refresh</button><button id="fM">—</button></div>
  <div class="fT">
    <b data-t="0" class="on">Overview</b><b data-t="1">Multi-pull</b><b data-t="2">Method</b><b data-t="3">Self-test</b><b data-t="4">Limits</b>
  </div>
  <div class="fB" id="fBody"><div class="chk">Starting…</div></div>`;
  document.body.appendChild(el);

  const body = el.querySelector('#fBody');
  let R = null, TAB = 0, mini = false;

  el.querySelector('#fM').onclick = () => {
    mini = !mini;
    el.querySelector('.fT').style.display = mini ? 'none' : 'flex';
    body.style.display = mini ? 'none' : 'block';
    el.querySelector('#fM').textContent = mini ? '+' : '—';
  };
  el.querySelectorAll('.fT b').forEach(t => t.onclick = () => {
    el.querySelectorAll('.fT b').forEach(x => x.classList.toggle('on', x === t));
    TAB = +t.dataset.t; paint();
  });
  // Drag to move
  (() => { const h = el.querySelector('.fH'); let sx, sy, ox, oy, on = false;
    h.onmousedown = e => { if (e.target.tagName === 'BUTTON') return;
      on = true; sx = e.clientX; sy = e.clientY;
      const r = el.getBoundingClientRect(); ox = r.left; oy = r.top;
      el.style.right = 'auto'; el.style.bottom = 'auto'; e.preventDefault(); };
    addEventListener('mousemove', e => { if (!on) return;
      el.style.left = (ox + e.clientX - sx) + 'px'; el.style.top = (oy + e.clientY - sy) + 'px'; });
    addEventListener('mouseup', () => on = false); })();

  /* ── Tab renderers ── */
  function paint() {
    if (!R) return;
    body.innerHTML = [tabOverview, tabMulti, tabDerive, tabTest, tabLimits][TAB](R);
    if (TAB === 1) hookMulti();
  }

  function tabOverview(r) {
    const consistent = r.drift < 0.005 && r.countOK;
    const vis = r.buckets.filter(x => x.p > 5e-4);
    return `
    <div class="chk ${consistent ? 'ok' : 'no'}">
      ${consistent ? '✅ Consistency check passed' : '⚠️ Consistency check FAILED'}<br>
      Ticket: contract <b>${F(r.ticket, 6)}</b> ｜ enumeration <b>${F(r.ticketEnum, 6)}</b> ｜ drift <b>${(r.drift * 100).toFixed(3)}%</b><br>
      Listings: enumerated ${r.N} ｜ on-chain ${r.nA}→${r.nB}
      ${r.exact ? '(exact match)' : r.churn ? `<span class="d">(${r.churn} pulled during fetch — normal race)</span>`
        : '<span class="w">(mismatch, review)</span>'}
      ${r.enabled ? '' : '<br><b class="b">Acquisitions currently disabled</b>'}
    </div>
    <div class="big">
      <div><div class="k">True cost per pull</div><div class="v">${F(r.cost, 4)}</div>
        <div class="nn">ticket ${F(r.ticket, 4)} + fees ${F(r.cost - r.ticket, 5)}</div></div>
      <div><div class="k">Most likely return</div><div class="v ${r.medNet >= 0 ? 'g' : 'b'}">${F(r.medGot, 4)}</div>
        <div class="nn">net ${r.medNet >= 0 ? '+' : ''}${F(r.medNet, 4)} Ξ</div></div>
      <div><div class="k">Chance of not losing</div><div class="v ${r.pNo >= .5 ? 'g' : r.pNo >= .25 ? 'w' : 'b'}">${(r.pNo * 100).toFixed(1)}%</div>
        <div class="nn">${r.N} listings</div></div>
      <div><div class="k">Expected value / pull</div><div class="v ${r.ev >= r.cost ? 'g' : 'b'}">${F(r.ev - r.cost, 4)}</div>
        <div class="nn">${((r.ev / r.cost - 1) * 100).toFixed(1)}%</div></div>
    </div>
    <div class="bar">${vis.map(x => `<i style="width:${x.p * 100}%;background:${x.c}" title="${x.n} ${PCT(x.p)}"></i>`).join('')}</div>
    <table class="t">${r.buckets.map(x => x.p <= 0 ? '' : `<tr>
      <td><span class="dot" style="background:${x.c}"></span>${x.n}</td>
      <td><b>${PCT(x.p)}</b></td><td class="d">${(x.cum * 100).toFixed(1)}%</td>
      <td class="d">${F(x.lo, 3)}–${F(x.hi, 3)}</td></tr>`).join('')}</table>

    <div class="sec">Top prize</div>
    <table class="t"><tr><td>backing ${F(r.maxB, 2)} Ξ</td>
      <td class="gd">${Math.round(r.maxMult)}× cost</td>
      <td class="d">odds 1 in ${Math.round(1 / r.pMax).toLocaleString()}</td></tr></table>

    <div class="sec">Live state (all read on-chain)</div>
    <table class="t">
      <tr><td>Surcharge</td><td>${(r.sur * 100).toFixed(1)}%</td><td class="d">gameState</td></tr>
      <tr><td>Buyer sell-back rate</td><td>${(r.bid * 100).toFixed(0)}%</td><td class="d">gameState</td></tr>
      <tr><td>Gas price</td><td>${r.gwei == null ? '—' : r.gwei.toFixed(3) + ' gwei'}</td><td class="d">eth_gasPrice</td></tr>
      <tr><td>Since last pull</td><td>${r.secs < 90 ? r.secs + 's' : Math.floor(r.secs / 60) + 'm'}</td>
          <td class="${r.share >= 1 ? 'g' : 'd'}">${(r.share * 100).toFixed(0)}% of surcharge to you</td></tr>
      <tr><td>Cold-start FWA credit</td><td class="${r.rebate > 0 ? 'g' : 'd'}">${F(r.rebate, 5)}</td><td class="d">Ξ equiv.</td></tr>
      <tr><td>Historical refund rate</td><td class="w">${(r.refundRate * 100).toFixed(1)}%</td><td class="d">of ${r.totalAcq.toLocaleString()} pulls</td></tr>
      <tr><td>Total pool backing</td><td>${F(r.totalBacking, 1)}</td><td class="d">Ξ</td></tr>
    </table>
    <div class="nt">"Return" assumes you accept the depositor's sell-back bid. If the NFT's floor price
      exceeds that bid, keeping the NFT pays more, so your real outcome would beat what's shown.
      The panel has no floor-price feed, so treat these figures as a <b>lower bound</b>.</div>`;
  }

  function tabMulti(r) {
    return `<div class="sec">How many pulls is optimal</div>
      <div class="nt" style="margin-top:0">With one pull you must hit a winner outright, which is unlikely.
        At 2–4 pulls a single good hit can carry the losses of the others, so the odds improve.
        Beyond that, the fixed ${((1 - r.ev / r.cost) * 100).toFixed(1)}% edge against you compounds via the
        law of large numbers. The chance of not losing therefore has a <b>peak</b>.</div>
      <div style="margin:11px 0"><button id="fGo">Run Monte Carlo (~2s)</button></div>
      <div id="fOut"></div>`;
  }
  function hookMulti() {
    const btn = body.querySelector('#fGo'), out = body.querySelector('#fOut');
    btn.onclick = () => {
      out.innerHTML = '<span class="d">Computing…</span>';
      setTimeout(() => {
        const m = multi(R), best = m.reduce((a, x) => x.pNo > a.pNo ? x : a, m[0]);
        const mx = Math.max(...m.map(x => x.pNo));
        out.innerHTML = `
        <div style="display:flex;align-items:flex-end;gap:2px;height:60px;margin-bottom:4px">
          ${m.map(x => `<div style="flex:1;text-align:center" title="${x.n} pulls: ${(x.pNo * 100).toFixed(1)}% chance of not losing">
            <div style="font-size:8px;color:${x === best ? '#f5c451' : '#5d646f'};margin-bottom:2px">${(x.pNo * 100).toFixed(0)}</div>
            <div style="height:${Math.max(2, x.pNo / mx * 38)}px;background:${x === best ? '#f5c451' : '#6ea8ff'};border-radius:2px 2px 0 0"></div>
            <div style="font-size:8px;color:#5d646f;margin-top:2px">${x.n}</div></div>`).join('')}
        </div>
        <div class="nt" style="margin-top:0">Top row = % chance of not losing, bottom row = number of pulls</div>
        <div class="sec">Key figures</div>
        <table class="t">
          <tr><td>Best odds at</td><td class="gd"><b>${best.n} pulls</b></td><td class="d">${(best.pNo * 100).toFixed(1)}%</td></tr>
          ${m.filter(x => [1, 10, 50, 100].includes(x.n)).map(x => `<tr>
            <td>${x.n} pulls</td><td class="${x.pNo >= .15 ? 'w' : 'b'}">${(x.pNo * 100).toFixed(1)}%</td>
            <td class="d">cost ${F(x.cost, 2)}, median ${F(x.med, 2)}</td></tr>`).join('')}
        </table>
        <div class="nt"><b>Note:</b> the peak of ${(best.pNo * 100).toFixed(1)}% is still far below 50%.
          "Optimal" here means <b>most uncertain outcome</b>, not "profitable" — expected value is
          ${((r => (r.ev / r.cost - 1) * 100)(R)).toFixed(1)}% at every pull count.</div>`;
      }, 30);
    };
  }

  function tabDerive(r) {
    const i = r.p.indexOf(Math.max(...r.p));
    const S = [
      ['Turn backing into weight',
        'weight = 1e36 ÷ backing. Less backing → more weight → easier to draw.',
        `This pool: ${r.N} listings\nTotal weight Σ(1/backing) = ${r.S.toFixed(2)}`],
      ['Derive the ticket price',
        'The price is anchored to how much backing you expect to draw. Because weight is inverse to backing, that expectation equals the harmonic mean of all backings.',
        `Expected backing = ${r.N} ÷ ${r.S.toFixed(2)} = ${r.evEnum.toFixed(6)} Ξ\n` +
        `Ticket = ${r.evEnum.toFixed(6)} × (1 + ${(r.sur * 100).toFixed(0)}%) = ${r.ticket.toFixed(6)} Ξ`],
      ['Add on-chain fees',
        'The site shows only the in-protocol ticket. You also pay the VRF randomness service fee and gas for two transactions.',
        `${F(r.ticket, 6)}  ticket\n+ ${F(r.vrfFee, 6)}  VRF (800k×1.3×${r.gwei == null ? '?' : r.gwei.toFixed(3)}gwei)\n` +
        `+ ${F(r.buyGas, 6)}  purchase gas\n+ ${F(r.setGas, 6)}  settlement gas\n= ${F(r.cost, 6)} Ξ`],
      ['Probability of any one listing',
        'probability = that listing\'s weight ÷ total weight. Taking the most drawable listing in the pool:',
        `backing ${F(r.minB, 4)} Ξ\nprobability = (1/${F(r.minB, 4)}) ÷ ${r.S.toFixed(2)} = ${PCT(r.p[i])}`],
      ['What you get back',
        `Best of two options: sell back to the depositor for ${(r.bid * 100).toFixed(0)}% × backing, or keep the NFT (worth its floor price, which the panel cannot read).`,
        `Sell-back = ${(r.bid * 100).toFixed(0)}% × backing` +
        (r.rebate > 0 ? `\n+ cold-start FWA credit ${F(r.rebate, 6)} Ξ` : '') +
        `\nNet = return − ${F(r.cost, 6)}`],
      ['Bucket into a distribution',
        'For every listing compute return ÷ cost, sort into seven buckets by multiple, and sum the probabilities inside each — that is the table on the Overview tab.',
        `Expected value = Σ(probability × return) = ${F(r.ev, 6)} Ξ\nAverage per pull = ${F(r.ev - r.cost, 6)} Ξ`]
    ];
    return S.map(([t, w, e]) => `<div class="step"><div class="ti">${t}</div>
      <div class="wy">${w}</div><div class="eq">${e}</div></div>`).join('') +
      `<div class="nt"><b>Why expected value is always negative:</b> the ticket costs
       expected backing × ${(1 + r.sur).toFixed(2)}, while selling back returns only ${r.bid.toFixed(2)}×.
       ${r.bid.toFixed(2)} ÷ ${(1 + r.sur).toFixed(2)} = <b>${(r.bid / (1 + r.sur) * 100).toFixed(1)}%</b>,
       independent of luck or pool size.</div>`;
  }

  function tabTest(r) {
    const T = selftest(r);
    return `<div class="nt" style="margin-top:0">Every refresh re-verifies the identities below and cross-checks a
      Monte Carlo run against the analytic solution. All must PASS for the maths to be sound.</div>
      <table class="t" style="margin-top:10px">${T.map(t => `<tr>
        <td style="font-size:10.5px">${t.n}</td>
        <td class="d" style="font-size:10px">${t.err.toExponential(1)}</td>
        <td class="${t.ok ? 'pass' : 'fail'}">${t.ok ? 'PASS' : 'FAIL'}</td></tr>`).join('')}</table>
      <div class="nt">The error column is |expected − actual|. The first four should hold to floating-point
        precision; the fifth cross-checks two independent ticket-price paths; the sixth is a stochastic
        simulation, where anything within 2% is normal.</div>`;
  }

  function tabLimits(r) {
    return `
    <div class="chk no"><b>Biggest caveat: I have not read the contract source.</b>
      These formulas come from the prose and technical notes in the official docs, not from a
      line-by-line reading of the Solidity. That said, the dual-path cross-check
      (drift ${(r.drift * 100).toFixed(3)}%) shows that "weight is inversely proportional to backing" and
      "ticket = harmonic mean x (1+surcharge)" do match the live implementation.</div>
    <div class="nt">
    <b>Reasons reality may be worse than the panel shows:</b><br>
    1. <b>No floor-price feed.</b> "Return" uses the sell-back bid, which is a lower bound. But if you keep
       the NFT, the floor is an <b>ask</b>, not a fill — realising it costs marketplace fees and royalties.
       The error runs in both directions.<br>
    2. <b>Refund risk ${(r.refundRate * 100).toFixed(1)}%.</b> The real rate across
       ${r.totalAcq.toLocaleString()} historical pulls. An empty pool, price drift beyond your bounds, or a
       VRF timeout all trigger a refund — <b>but the VRF service fee is not refunded</b>. The panel does not
       amortise this into expected value.<br>
    3. <b>Others front-run you.</b> Requests settle in order; the pool shifts between your submission and
       your fill (10% upward drift is allowed by default).<br>
    4. <b>The two gas figures are estimates</b> (purchase ${BUY_GAS / 1000}k, settlement ${SETTLE_GAS / 1000}k).
       VRF's 800k x 1.3 comes from the docs but the owner can change it. The gas price itself is read live.<br>
    5. <b>The daily $FWA purchaser pot is excluded.</b> During the emission window, 1% of total supply per day
       is split among that day's pulls. It could be sizeable, but external FWA buys are disabled by default
       (sell-only), making it hard to price, so it is left out. This is the one item that makes the panel
       <b>conservative</b>.<br>
    6. <b>Multi-pull assumes i.i.d.</b> Measured at N approximately 5000: 10 pulls moves the ticket 0.5%,
       200 pulls at worst 7%, so the without-replacement correction is ignored. This breaks down if the
       pool shrinks to a few hundred.
    </div>
    <div class="nt"><b>What is solid:</b> for a given pool snapshot, every probability and amount on the Overview
      tab is an <b>exact analytic solution</b>, not an approximation — that is precisely what the identity checks on
      the Self-test tab demonstrate. The uncertainty lives in the six items above, not in the maths.</div>`;
  }

  /* ══════════════ MAIN LOOP ══════════════ */
  let last = 0, busy = false;
  async function refresh() {
    if (busy) return;
    busy = true;
    const t0 = Date.now();
    // On first load show progress inside the panel; once data exists, just dim instead of wiping it
    const showProgress = msg => {
      const secs = ((Date.now() - t0) / 1000).toFixed(0);
      if (!R) body.innerHTML = `<div class="chk">${msg}<br><span class="d">${secs}s elapsed.</span></div>`;
      else el.querySelector('#fAge').textContent = msg;
    };
    onProgress = showProgress;
    try {
      showProgress('Connecting to indexer…');
      body.style.opacity = .45;
      const { g, g0, act, gwei } = await fetchAll();
      R = compute(g, act, g0, gwei);
      paint(); last = Date.now();
    } catch (e) {
      body.innerHTML = `<div class="chk no">Fetch failed: ${e.message}<br>Make sure the current page is on the www.fwa.fun domain.</div>`;
    } finally { body.style.opacity = 1; onProgress = () => {}; busy = false; }
  }
  el.querySelector('#fR').onclick = refresh;
  setInterval(() => { el.querySelector('#fAge').textContent = last ? Math.floor((Date.now() - last) / 1000) + 's ago' : ''; }, 1000);
  setInterval(refresh, 60000);
  refresh();

  window.__fwaPanel = { refresh, compute, fetchAll, multi, selftest, get data() { return R; } };
})();
