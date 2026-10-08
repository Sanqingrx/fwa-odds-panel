// ==UserScript==
// @name         FWA V2 Odds Panel
// @namespace    fwa.monitor
// @version      5.0
// @description  Live odds inside fwa.fun V2: true cost per pull, expected return on both settlement routes, seven-tier outcome distribution with chance of not losing, and multi-pull simulation. The full pool is read from the contract and reconciled exactly against its totals.
// @match        https://www.fwa.fun/*
// @match        https://fwa.fun/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==
/* ═══════════════════════════════════════════════════════════════════════════
 *  FWA V2 Odds Panel — v5.0
 *
 *  v5.0 brings back the full outcome distribution. v4.0 dropped it because the
 *  site has no endpoint that enumerates the pool. v5.0 reads the pool straight
 *  from the FWAV2 contract instead:
 *
 *    slotToListing(slot) → listingId      (public mapping, slots start at 1,
 *                                          freed slots are reused, so the range
 *                                          has holes)
 *    listings(id)        → weight, value (backing), status, …
 *
 *  The calls are batched through Multicall3 (aggregate3) and sent via the site's
 *  own /api/rpc proxy, all pinned to ONE block number. Every enumeration has to
 *  pass three exact BigInt checks against the contract's own totals at that same
 *  block before any distribution is drawn:
 *
 *    count(listings)  == activeListingCount
 *    Σ weight         == totalWeight
 *    Σ weight·value   == weightedBackingTotal       (contract: _evOf = w·v)
 *
 *  If any check fails, the distribution tab says so and shows nothing.
 *
 *  Price: the ticket is quoteAcquisitionPrice().total read from the contract —
 *  exactly what acquire() charges (fee + vrfServiceFee). v4.0 added a VRF gas
 *  estimate of 800k×1.3 instead; in V2 the VRF cost is the on-chain vrfServiceFee,
 *  so that estimate was double counting.
 *
 *  Gas (the tx gas you pay yourself) was calibrated on mainnet from recent txs:
 *    acquire(count=1)  mean 610k  (76 txs; median 486k, ~12% exceed 1M because
 *                                  they also process earlier queued requests)
 *    accept ETH bid    ~175k      accept bid as FWA  ~300k
 *
 *  Payout (FWAV2._settleBackingToPurchaser): payout = backing × payoutBps / 10000.
 *  ETH route uses settlementDiscountBps, FWA route tokenSettlementDiscountBps (that
 *  amount of ETH is spent buying FWA for you — swap slippage is not included).
 *
 *  Read-only: no wallet access, no signing, nothing sent anywhere but fwa.fun.
 * ═══════════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';
  if (window.__fwaPanel) { window.__fwaPanel.refresh(); return; }

  const S = {
    title: 'FWA V2 Odds Panel',
    refresh: 'Refresh',
    starting: 'Starting…',
    tabs: ['Overview', 'Tiers', 'Multi-pull', 'Method', 'Self-test', 'Limits'],
    routeEth: 'Take ETH',
    routeFwa: 'Take FWA',
    yes: 'Yes', no: 'No',

    errNoState: 'gameState not found — fwa.fun may have changed its structure. The panel refuses to show numbers that may be wrong.',
    errCall: k => 'Contract call ' + k + ' failed — the contract may have been upgraded.',
    errShort: 'Error',
    cannotShow: 'Cannot display',
    refuse: 'The panel would rather show nothing than show numbers that may be wrong.',

    progState: 'Reading protocol state…',
    progRead: 'Reading listings',
    progScan: (f, n, s) => 'Scanning slots ' + f + '/' + n + ' (up to slot ' + s + ')',
    updated: (t, b, p) => 'Updated ' + t + ' · block ' + b + ' · enumerated in ' + (p.ms / 1000).toFixed(1) + 's' + (p.mode === 'full' ? ' (full)' : ''),

    poolPending: 'Enumerating the full pool from the chain (about 30–40 s the first time, about 10 s after that). Tiers, chance of not losing and multi-pull appear once it finishes.',
    poolFail: k => '<b>The pool enumeration did not reconcile, so no distribution is shown.</b><br>count ' + (k.count ? '✓' : '✗') +
      ' · Σweight ' + (k.sumW ? '✓' : '✗') + ' · Σ(w·b) ' + (k.sumWB ? '✓' : '✗') + '. The next refresh retries automatically.',

    thisPull: 'This pull',
    ticketChain: 'Ticket (contract quote)',
    vrfFee: 'of which VRF service fee',
    gasAcq: 'Purchase gas (est.)',
    expectBack: 'The two settlement routes',
    payoutRate: 'Buyback rate',
    allIn: 'All-in cost Ξ',
    pNoLoss: 'Chance of not losing',
    median: 'Median return Ξ',
    netExp: 'Expected net Ξ',
    rtpNote: 'RTP = buyback rate ÷ (1 + surcharge). Pool size, composition and timing do not change it. "All-in cost" includes the purchase and settlement gas, so the break-even bar sits slightly above the ticket.',
    breakEven: 'Backing needed to break even',
    expBacking: 'Expected backing (harmonic mean)',
    avgBacking: 'Average backing (arithmetic mean)',
    protocol: 'Protocol state',
    active: 'Active listings',
    surcharge: 'Surcharge',
    open: 'Purchases open',
    blackoutNow: 'In pause window',
    staged: 'Staged (queued) listings',
    refundRate: 'Historical refund rate',

    distTitle: 'Which tier this pull lands in',
    tier: ['Wipeout <30%', 'Heavy loss 30–60%', 'Small loss 60–95%', 'Break-even ±5%', 'Small win 1.05–2×', 'Double 2–5×', 'Jackpot ≥5×'],
    colTier: 'Tier', colBack: 'Return Ξ', colCnt: 'Listings', colCum: 'Cum.',
    distNote: a => 'Tiers are set by return ÷ all-in cost (' + a.toFixed(5) + ' Ξ). Probability = total weight of the listings in a tier ÷ total weight, read listing by listing from the chain.',
    whereLand: 'Where the return lands',
    q10: '10% of pulls return less than', q50: 'Half return less than (median)', q90: '90% return less than',
    evBack: 'Expected return',
    bigPrizes: 'Big-prize odds',
    atLeast: m => 'Return ≥ ' + m + '× cost',
    oneIn: s => '≈ 1 in ' + s,
    topPrize: 'Largest listing in pool',
    poolLine: p => 'Full pool: ' + p.N.toLocaleString() + ' listings at block ' + p.block + ', backing ' + p.minB.toFixed(3) + ' – ' + p.maxB.toFixed(2) + ' Ξ. All three exact reconciliation checks passed (see Self-test).',

    multiTitle: 'n pulls in a row (10,000-run Monte Carlo on the real pool)',
    colN: 'Pulls', colCost: 'Cost Ξ', colNoLoss: 'Not losing', colMed: 'Median net Ξ', colRange: '90% range Ξ',
    multiNote: '"Not losing" = total return ≥ total cost. The more you pull, the closer the result gets to the expected value (which is negative), so the chance of not losing falls. Pulling more changes the spread, never the per-pull expectation. Pulls are treated as independent: each removes one listing out of thousands and moves the price by far less than 0.1%.',

    derivTitle: 'Derivation (live on-chain numbers)',
    d1: '① Weight', d2: '② Selection odds', d3: '③ Expected backing', d4: '④ Ticket formula',
    d5: '⑤ Contract quote', d6: '⑥ Buyback', d7: '⑦ RTP (ETH / FWA)',
    enumTitle: 'How the full pool is read',
    enumText: 'The fwa.fun site has no full pool listing (that is why v4.0 dropped the distribution). v5.0 reads the FWAV2 contract directly: ' +
      '<code>slotToListing(slot)</code> gives the listing id in each slot (slots start at 1 and are reused when freed, so the range has holes), ' +
      'and <code>listings(id)</code> gives weight, backing and status. Calls are batched through Multicall3 over the site\'s own /api/rpc, ' +
      'and every read is pinned to <b>one block</b>. Later refreshes only re-read known ids plus new ids (about 10 s); if that fails to reconcile it falls back to a full slot scan.',
    distHow: 'Why the distribution can be trusted',
    distHowText: 'Every enumeration must match the contract\'s own totals <b>exactly</b> at the same block: count = activeListingCount, Σweight = totalWeight, ' +
      'Σ(weight×backing) = weightedBackingTotal (the contract\'s _evOf = w·v). If a single listing were missed or misread, the three could not all hold. ' +
      'If they do not, no distribution is shown.',

    testsTitle: 'Self-test (re-run on every refresh)',
    tFee: 'Ticket formula == contract acquisitionFee',
    tTwoPath: 'Two-path expected backing agree',
    tCfg: 'On-chain params == indexer params',
    cfgLag: 'Indexer lagging; the panel uses on-chain values',
    dev: 'deviation',
    tRtp: k => 'RTP(' + (k === 'eth' ? 'ETH' : 'FWA') + ') == buyback ÷ (1+surcharge)',
    tPool: 'Full-pool enumeration',
    tCount: 'Listings read == activeListingCount',
    tSumW: 'Σweight == totalWeight',
    tSumWB: 'Σ(w·b) == weightedBackingTotal',
    exactBig: 'exact BigInt equality',
    tEach: 'Every weight == 1e36 ÷ backing',
    tSumP: 'Selection odds sum to 1',
    tEnumFee: 'Ticket from enumeration == contract quote',
    tBuckets: k => 'Tier odds sum to 1 (' + (k === 'eth' ? 'ETH' : 'FWA') + ')',
    tEv: k => 'Distribution mean == ticket × RTP (' + (k === 'eth' ? 'ETH' : 'FWA') + ')',
    tSign: k => 'Sign of net matches RTP (' + (k === 'eth' ? 'ETH' : 'FWA') + ')',
    tMc: '150k-run Monte Carlo vs analytic mean',
    testsBad: n => '<b>' + n + ' check(s) failed</b> — the numbers may be unreliable; trust the official UI instead.',
    testsOk: 'All passed. The three exact pool checks mean the distribution uses the complete on-chain pool as it stands right now — not one listing more or less.',

    limitsTitle: 'What this panel cannot tell you',
    limits: c => '<b>1. Keeping the NFT is not modelled.</b> There is no reliable floor price (an ask is not a fill), so tiers use the ETH / FWA buyback only.<br>' +
      '<b>2. The FWA route is valued at the ETH spent.</b> The contract spends the buyback buying FWA from the pool; swap slippage and fees are not deducted, so what you actually receive is usually worth a bit less.<br>' +
      '<b>3. The distribution is the pool at the moment you buy.</b> The contract settles in order after the VRF callback; other pulls, deposits and withdrawals in between change the pool, and staged listings (currently ' + c.staged + ') join before selection. With thousands of listings the effect is small, but not zero.<br>' +
      '<b>4. Gas is estimated.</b> Calibrated on recent mainnet txs: purchase averages 610k gas (about 12% exceed 1M because they also process earlier requests); settling to ETH about 175k, to FWA about 300k; multiplied by the live gas price.<br>' +
      '<b>5. Refunds are not amortised.</b> Historical refund rate ' + (c.refundRate * 100).toFixed(2) + '%.<br>' +
      '<b>6. Rewards are excluded.</b> Top-listing pot share, epoch $FWA rewards and builder rewards are left out, so the panel is conservative.<br>' +
      '<b>7. Pause windows.</b> Purchases are closed daily 11:45–12:00 and 23:45–24:00 UTC.',
    runTitle: 'This run',
    contract: 'Contract', chainBlock: 'Chain block', indexBlock: 'Indexer block',
    readOnly: 'Read-only: no wallet access, no signing, no data sent anywhere except fwa.fun\'s own endpoints. Research tool, not investment advice.'
};
  const VERSION = '5.0';

  const E = 1e18;
  const E36 = 10n ** 36n;
  const HDR = { 'content-type': 'application/json', 'x-gacha-client': 'web' };
  const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11';
  const DEFAULT_CONTRACT = '0x958c41181182e76f221331b2755b77d9e1426a98';
  const ACTIVE = 1;                          // FWAV2.ListingStatus.Active
  const CHUNK = 200;                         // calls per aggregate3 (site proxy caps the body ~100 KB)
  const PAR = 6;                             // parallel requests
  const SLOT_CAP = 200000;                   // hard stop for the slot scan

  // Selectors (keccak256 of the signature, first 4 bytes)
  const SEL = {
    count: '4681a7c6',      // activeListingCount()
    totalWeight: '96c82e57',// totalWeight()
    wbt: 'd6eb0dbd',        // weightedBackingTotal()
    quote: '987df4cd',      // quoteAcquisitionPrice() → fee, vrf, total
    sdE: 'fb2dd096',        // settlementDiscountBps()
    sdF: '97d69193',        // tokenSettlementDiscountBps()
    nextId: 'aaccf1ec',     // nextListingId()
    blackout: '4d5fe14c',   // isPurchaseBlackout()
    slot: 'e2881eb7',       // slotToListing(uint256)
    listing: 'de74e57b'     // listings(uint256)
  };

  // Tx gas you pay yourself (see header for the calibration)
  const GAS = { acquire: 610000, eth: 175000, fwa: 300000 };

  // Outcome tiers by multiple of the all-in cost
  const BK = [
    [0, 0.30, '#8b2635'], [0.30, 0.60, '#c74a4a'], [0.60, 0.95, '#e0844a'],
    [0.95, 1.05, '#8b929e'], [1.05, 2, '#5fb87a'], [2, 5, '#3fd68c'], [5, Infinity, '#f5c451']
  ];

  /* ══════════════ helpers ══════════════ */
  const F = (x, d = 4) => (x == null || !isFinite(x)) ? '—' : (+x).toFixed(d);
  const PCT = (x, d = 2) => (x == null || !isFinite(x)) ? '—' : (x * 100).toFixed(d) + '%';
  const w64 = n => BigInt(n).toString(16).padStart(64, '0');
  const hexBig = h => (h == null || h === '') ? null : BigInt('0x' + h);
  const word = (h, k) => BigInt('0x' + h.slice(k * 64, k * 64 + 64));
  const bigRatio = (a, b) => Number(a * 1000000000000n / b) / 1e12;   // a/b as float, for big ints

  let onProgress = () => {};

  async function rpc(method, params = [], tries = 3) {
    let last;
    for (let t = 0; t < tries; t++) {
      try {
        const r = await fetch('/api/rpc', { method: 'POST', headers: HDR,
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
        const j = await r.json().catch(() => null);
        if (!r.ok || !j) throw new Error('RPC HTTP ' + r.status);
        if (j.error) throw new Error('RPC ' + (j.error.message || JSON.stringify(j.error)));
        return j.result;
      } catch (e) { last = e; await new Promise(res => setTimeout(res, 400 * (t + 1))); }
    }
    throw last;
  }

  // Multicall3.aggregate3((address target, bool allowFailure, bytes callData)[])
  function encAgg(target, datas) {
    const tgt = target.toLowerCase().replace(/^0x/, '').padStart(64, '0');
    let offs = '', body = '', cur = datas.length * 32;
    for (const d of datas) {
      offs += w64(cur);
      const len = d.length / 2;
      const t = tgt + w64(1) + w64(96) + w64(len) + d.padEnd(Math.ceil(len / 32) * 64, '0');
      body += t; cur += t.length / 2;
    }
    return '0x82ad56cb' + w64(32) + w64(datas.length) + offs + body;
  }
  // returns Result[] as hex strings (no 0x), null for a failed sub-call
  function decAgg(hex) {
    const h = hex.slice(2);
    const W = i => Number(BigInt('0x' + h.slice(i * 2, i * 2 + 64)));
    const a = W(0), n = W(a), base = a + 32, out = [];
    for (let i = 0; i < n; i++) {
      const t = base + W(base + 32 * i);
      const ok = W(t) === 1;
      const bo = t + W(t + 32), len = W(bo);
      out.push(ok ? h.slice((bo + 32) * 2, (bo + 32 + len) * 2) : null);
    }
    return out;
  }
  async function mcall(target, datas, block) {
    return decAgg(await rpc('eth_call', [{ to: MULTICALL3, data: encAgg(target, datas) }, block]));
  }
  async function runPool(tasks, par) {
    const out = new Array(tasks.length); let i = 0;
    await Promise.all(Array.from({ length: Math.min(par, tasks.length) }, async () => {
      while (i < tasks.length) { const k = i++; out[k] = await tasks[k](); }
    }));
    return out;
  }

  /* ══════════════ data: game-config (parameters + indexer view) ══════════════ */
  async function fetchConfig() {
    const r = await fetch('/api/ponder/public/game-config', { headers: HDR });
    if (!r.ok) throw new Error('game-config HTTP ' + r.status);
    const j = await r.json();
    const gs = (j && j.data && j.data.gameState) || (j && j.gameState);
    if (!gs || gs.surchargeBps == null) throw new Error(S.errNoState);
    return gs;
  }
  function contractOf(gs) {
    const m = String(gs.deployment || '').match(/0x[0-9a-fA-F]{40}/);
    return m ? m[0].toLowerCase() : DEFAULT_CONTRACT;
  }

  /* ══════════════ data: chain summary at one block ══════════════ */
  async function chainSummary(C) {
    const block = await rpc('eth_blockNumber');
    const keys = ['count', 'totalWeight', 'wbt', 'quote', 'sdE', 'sdF', 'nextId', 'blackout'];
    const r = await mcall(C, keys.map(k => SEL[k]), block);
    keys.forEach((k, i) => { if (r[i] == null) throw new Error(S.errCall(k)); });
    return {
      block, blockNum: parseInt(block, 16),
      n: Number(hexBig(r[0])), W: hexBig(r[1]), WB: hexBig(r[2]),
      fee: word(r[3], 0), vrf: word(r[3], 1), total: word(r[3], 2),
      sdE: Number(hexBig(r[4])) / 10000, sdF: Number(hexBig(r[5])) / 10000,
      nextId: Number(hexBig(r[6])), blackout: hexBig(r[7]) === 1n
    };
  }

  /* ══════════════ data: full pool enumeration ══════════════ */
  let POOL = null;           // { C, block, nextId, list:[{id,w,v}], mode, ms }
  const CACHE_KEY = 'fwaOddsPanel.pool.v5';

  function loadCache(C) {
    try {
      const o = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null');
      if (o && o.C === C && Array.isArray(o.ids)) return { C, nextId: o.nextId, ids: o.ids.map(BigInt) };
    } catch (e) {}
    return null;
  }
  function saveCache(p) {
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify({ C: p.C, nextId: p.nextId, ids: p.list.map(x => x.id.toString()) }));
    } catch (e) {}
  }

  async function fetchListings(C, ids, block, label) {
    const chunks = [];
    for (let i = 0; i < ids.length; i += CHUNK) chunks.push(ids.slice(i, i + CHUNK));
    let done = 0;
    const res = await runPool(chunks.map(ch => async () => {
      const r = await mcall(C, ch.map(id => SEL.listing + w64(id)), block);
      done += ch.length; onProgress(label + ' ' + done + '/' + ids.length);
      return r.map((h, k) => h == null ? null : { id: ch[k], w: word(h, 4), v: word(h, 5), st: Number(word(h, 10)) });
    }), PAR);
    return res.flat().filter(Boolean);
  }

  async function scanSlots(C, n, block) {
    const ids = []; let slot = 1;
    while (ids.length < n && slot < SLOT_CAP) {
      const tasks = [];
      for (let p = 0; p < PAR; p++) {
        const start = slot + p * CHUNK;
        tasks.push(async () => {
          const ds = []; for (let i = 0; i < CHUNK; i++) ds.push(SEL.slot + w64(start + i));
          return mcall(C, ds, block);
        });
      }
      const rs = await runPool(tasks, PAR);
      for (const h of rs.flat()) { const id = hexBig(h); if (id) ids.push(id); }
      slot += CHUNK * PAR;
      onProgress(S.progScan(ids.length, n, slot - 1));
    }
    return ids;
  }

  function checkPool(list, cs) {
    let sw = 0n, swb = 0n, exact = 0;
    for (const x of list) {
      sw += x.w; swb += x.w * x.v;
      if (x.v > 0n && x.w === E36 / x.v) exact++;
    }
    return { count: list.length === cs.n, sumW: sw === cs.W, sumWB: swb === cs.WB,
             exact, sw, swb, ok: list.length === cs.n && sw === cs.W && swb === cs.WB };
  }

  async function enumeratePool(C, cs) {
    const t0 = performance.now();
    const prev = (POOL && POOL.C === C) ? { nextId: POOL.nextId, ids: POOL.list.map(x => x.id) } : loadCache(C);
    let list = null, mode = 'full', chk = null;

    // Fast path: re-read every previously active id + every id created since, at this block.
    if (prev && prev.ids.length) {
      const cand = prev.ids.slice();
      for (let id = prev.nextId; id < cs.nextId; id++) cand.push(BigInt(id));
      const got = await fetchListings(C, cand, cs.block, S.progRead);
      list = got.filter(x => x.st === ACTIVE);
      chk = checkPool(list, cs);
      mode = 'incremental';
      // An older staged listing activated since last time would be missed — the checks catch it.
      if (!chk.ok) list = null;
    }
    // Full path: walk the slot map.
    if (!list) {
      const ids = await scanSlots(C, cs.n, cs.block);
      const got = await fetchListings(C, ids, cs.block, S.progRead);
      list = got.filter(x => x.st === ACTIVE);
      chk = checkPool(list, cs);
      mode = 'full';
    }
    const p = { C, block: cs.blockNum, nextId: cs.nextId, list, chk, mode, ms: performance.now() - t0, at: Date.now() };
    if (chk.ok) saveCache(p);
    return p;
  }

  /* ══════════════ compute ══════════════ */
  function compute(gs, cs, pool, gasWei) {
    const sur = Number(gs.surchargeBps) / 10000;
    const ticket = Number(cs.total) / E;          // exactly what acquire() charges per draw
    const fee = Number(cs.fee) / E, vrf = Number(cs.vrf) / E;

    // aggregate cross-checks (no enumeration needed)
    const evRatio = bigRatio(cs.WB, cs.W) / E;                        // Σ(w·b)/Σw
    const evHarm = bigRatio(BigInt(cs.n) * E36, cs.W) / E;           // n·1e36/Σw
    const feeAgg = evHarm * (1 + sur);

    const g = (gasWei || 0) / E;
    const gasAcq = g * GAS.acquire;
    const routes = {};
    for (const key of ['eth', 'fwa']) {
      const sd = key === 'eth' ? cs.sdE : cs.sdF;
      const gasSettle = g * GAS[key];
      const allIn = ticket + gasAcq + gasSettle;
      routes[key] = { key, sd, gasSettle, allIn, rtp: sd / (1 + sur), bev: allIn / sd };
    }

    const c = { sur, ticket, fee, vrf, evRatio, evHarm, feeAgg, gasWei, gasAcq, routes, cs, gs,
      n: cs.n, blackout: cs.blackout,
      avgBacking: Number(gs.totalActiveBacking || 0) / E / Math.max(1, cs.n),
      staged: Number(gs.stagedListingCount || 0),
      refundRate: Number(gs.totalAcquisitionsRefunded || 0) / Math.max(1, Number(gs.totalAcquisitions || 0)),
      cfgDrift: { sdE: Number(gs.settlementDiscountBps) / 10000 !== cs.sdE,
                  sdF: Number(gs.tokenSettlementDiscountBps || gs.settlementDiscountBps) / 10000 !== cs.sdF },
      acqEnabled: !!gs.acquisitionsEnabled, whitelist: !!gs.whitelistEnabled,
      tokensEnabled: !!gs.acceptBidAsTokensEnabled,
      topShare: Number(gs.topListingShareBps || 0) / 10000,
      deployment: contractOf(gs), pool: null };

    // distribution from the enumerated pool — only if it reconciled exactly AND is this block's pool
    if (pool && pool.chk.ok && pool.block === cs.blockNum) {
      const L = pool.list, N = L.length;
      const Wf = Number(cs.W);
      const b = new Float64Array(N), p = new Float64Array(N);
      for (let i = 0; i < N; i++) { b[i] = Number(L[i].v) / E; p[i] = Number(L[i].w) / Wf; }
      const ord = Array.from({ length: N }, (_, i) => i).sort((x, y) => b[x] - b[y]);
      const sb = new Float64Array(N), sp = new Float64Array(N), cum = new Float64Array(N);
      let a = 0;
      for (let k = 0; k < N; k++) { const i = ord[k]; sb[k] = b[i]; sp[k] = p[i]; a += p[i]; cum[k] = a; }
      const evEnum = (() => { let s = 0; for (let k = 0; k < N; k++) s += sp[k] * sb[k]; return s; })();
      const q = t => { let lo = 0, hi = N - 1; while (lo < hi) { const m = (lo + hi) >> 1; if (cum[m] < t) lo = m + 1; else hi = m; } return sb[lo]; };

      for (const key of ['eth', 'fwa']) {
        const R = c.routes[key];
        const got = x => x * R.sd;
        let cumP = 0;
        const buckets = BK.map(([lo, hi, col], j) => {
          let pr = 0, cnt = 0, bmin = Infinity, bmax = -Infinity;
          for (let k = 0; k < N; k++) {
            const m = got(sb[k]) / R.allIn;
            if (m >= lo && m < hi) { pr += sp[k]; cnt++; if (sb[k] < bmin) bmin = sb[k]; if (sb[k] > bmax) bmax = sb[k]; }
          }
          cumP += pr;
          return { j, lo, hi, col, p: pr, cum: cumP, cnt, bmin: cnt ? bmin : null, bmax: cnt ? bmax : null };
        });
        const pAtLeast = mult => { let s = 0; for (let k = 0; k < N; k++) if (got(sb[k]) >= mult * R.allIn) s += sp[k]; return s; };
        const top = sb[N - 1], pTop = sp[N - 1];
        R.dist = {
          buckets, pNoLoss: pAtLeast(1), p2: pAtLeast(2), p5: pAtLeast(5), p10: pAtLeast(10),
          q10: got(q(0.10)), q50: got(q(0.50)), q90: got(q(0.90)),
          ev: evEnum * R.sd, net: evEnum * R.sd - R.allIn,
          top: got(top), topMult: got(top) / R.allIn, pTop
        };
      }
      c.pool = { N, block: pool.block, mode: pool.mode, ms: pool.ms, at: pool.at, chk: pool.chk,
        sb, sp, cum, evEnum, feeEnum: evEnum * (1 + sur), minB: sb[0], maxB: sb[N - 1] };
    }
    return c;
  }

  /* ── multi-pull Monte Carlo on the real pool ───────────────────────────
     Draws are treated as independent: each one removes a single listing out of
     thousands, which moves the price by well under 0.1%.                    */
  function multiPull(c, key, NS = [1, 2, 3, 5, 10, 20, 50, 100]) {
    const P = c.pool, R = c.routes[key];
    if (!P) return null;
    const N = P.N, cum = P.cum, sb = P.sb, last = cum[N - 1];
    const pick = () => { const u = Math.random() * last; let lo = 0, hi = N - 1;
      while (lo < hi) { const m = (lo + hi) >> 1; if (cum[m] < u) lo = m + 1; else hi = m; } return lo; };
    const RUNS = 10000;
    return NS.map(n => {
      const res = new Float64Array(RUNS);
      for (let r = 0; r < RUNS; r++) { let v = 0; for (let d = 0; d < n; d++) v += sb[pick()] * R.sd; res[r] = v - n * R.allIn; }
      res.sort();
      const qq = t => res[Math.floor(t * (RUNS - 1))];
      let win = 0; for (let r = 0; r < RUNS; r++) if (res[r] >= 0) win++;
      return { n, cost: n * R.allIn, pNo: win / RUNS, p5: qq(0.05), med: qq(0.5), p95: qq(0.95), exp: n * R.dist.net };
    });
  }

  /* ══════════════ self-tests ══════════════ */
  function selfTests(c) {
    const T = [];
    const add = (name, pass, detail) => T.push({ name, pass, detail });
    const rel = (a, b) => Math.abs(a - b) / Math.max(Math.abs(b), 1e-30);

    add(S.tFee, rel(c.feeAgg, c.fee) < 1e-9,
        F(c.feeAgg, 8) + ' vs ' + F(c.fee, 8) + ' Ξ');
    add(S.tTwoPath, rel(c.evRatio, c.evHarm) < 1e-9,
        S.dev + ' ' + (rel(c.evRatio, c.evHarm) * 100).toExponential(2) + '%');
    add(S.tCfg, !c.cfgDrift.sdE && !c.cfgDrift.sdF,
        (c.cfgDrift.sdE || c.cfgDrift.sdF) ? S.cfgLag : 'OK');
    for (const key of ['eth', 'fwa']) {
      const R = c.routes[key];
      add(S.tRtp(key), Math.abs(R.rtp - R.sd / (1 + c.sur)) < 1e-12, PCT(R.rtp, 4));
    }

    const P = c.pool;
    if (!P) {
      add(S.tPool, null, S.poolPending);
      return T;
    }
    const k = P.chk;
    add(S.tCount, k.count, P.N + ' / ' + c.n);
    add(S.tSumW, k.sumW, S.exactBig);
    add(S.tSumWB, k.sumWB, S.exactBig);
    add(S.tEach, k.exact === P.N, k.exact + '/' + P.N);
    let sp = 0; for (let i = 0; i < P.N; i++) sp += P.sp[i];
    add(S.tSumP, Math.abs(sp - 1) < 1e-9, F(sp, 12));
    add(S.tEnumFee, rel(P.feeEnum, c.fee) < 1e-9, F(P.feeEnum, 8) + ' vs ' + F(c.fee, 8) + ' Ξ');
    for (const key of ['eth', 'fwa']) {
      const D = c.routes[key].dist;
      const sb = D.buckets.reduce((s, x) => s + x.p, 0);
      add(S.tBuckets(key), Math.abs(sb - 1) < 1e-9, F(sb, 12));
      // EV of the distribution must equal ticket·RTP up to the VRF fee and rounding
      const expect = c.fee / (1 + c.sur) * c.routes[key].sd;
      add(S.tEv(key), rel(D.ev, expect) < 1e-6, F(D.ev, 6) + ' vs ' + F(expect, 6));
      const R = c.routes[key];
      const signOK = R.rtp >= 1 ? D.net >= -1e-12 : D.net < 0;
      add(S.tSign(key), signOK, 'RTP ' + PCT(R.rtp) + ' → ' + F(D.net, 5) + ' Ξ');
    }
    // Monte Carlo vs analytic EV
    const N = P.N, cum = P.cum, sb = P.sb, last = cum[N - 1];
    let tot = 0; const RUNS = 150000;
    for (let r = 0; r < RUNS; r++) { const u = Math.random() * last; let lo = 0, hi = N - 1;
      while (lo < hi) { const m = (lo + hi) >> 1; if (cum[m] < u) lo = m + 1; else hi = m; } tot += sb[lo]; }
    add(S.tMc, rel(tot / RUNS, P.evEnum) < 0.02, F(tot / RUNS, 6) + ' vs ' + F(P.evEnum, 6) + ' Ξ');
    return T;
  }

  /* ══════════════ UI ══════════════ */
  const CSS = `
  #fwaP{position:fixed;right:16px;top:16px;z-index:2147483600;width:440px;max-height:88vh;
    background:#0f1216;color:#e6e9ee;border:1px solid #232a33;border-radius:12px;
    font:12px/1.55 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
    box-shadow:0 12px 40px rgba(0,0,0,.55);overflow:hidden;display:flex;flex-direction:column}
  #fwaP .hd{display:flex;align-items:center;gap:8px;padding:9px 11px;background:#151a21;
    border-bottom:1px solid #232a33;cursor:move;user-select:none}
  #fwaP .hd b{font-size:12px;letter-spacing:.3px}
  #fwaP .hd .sp{flex:1}
  #fwaP button{background:transparent;border:1px solid #2c3540;color:#8b929e;
    border-radius:6px;padding:2px 8px;cursor:pointer;font:inherit}
  #fwaP button:hover{color:#e6e9ee;border-color:#3d4a59}
  #fwaP button.on{color:#0f1216;background:#6ea8fe;border-color:#6ea8fe}
  #fwaP .tabs{display:flex;border-bottom:1px solid #232a33;background:#11151a}
  #fwaP .tabs div{flex:1;text-align:center;padding:7px 0;cursor:pointer;color:#7d8590;
    border-bottom:2px solid transparent}
  #fwaP .tabs div.on{color:#6ea8fe;border-bottom-color:#6ea8fe;background:#141a22}
  #fwaP .bd{padding:11px;overflow:auto;flex:1}
  #fwaP .row{display:flex;justify-content:space-between;gap:10px;padding:3px 0}
  #fwaP .row span:first-child{color:#8b929e}
  #fwaP .row span:last-child{text-align:right;font-variant-numeric:tabular-nums}
  #fwaP .big{font-size:19px;font-weight:600;letter-spacing:-.3px}
  #fwaP .g{color:#5fb87a}#fwaP .r{color:#e0574a}#fwaP .y{color:#f5c451}#fwaP .b{color:#6ea8fe}
  #fwaP .mut{color:#6b7280}
  #fwaP h4{margin:13px 0 6px;font-size:11px;color:#6ea8fe;letter-spacing:.6px;
    text-transform:uppercase;border-bottom:1px solid #1e242c;padding-bottom:4px}
  #fwaP h4:first-child{margin-top:0}
  #fwaP .note{color:#6b7280;font-size:11px;line-height:1.6;margin:7px 0}
  #fwaP .warn{background:#2a1416;border:1px solid #5c2226;color:#ff9b91;
    padding:7px 9px;border-radius:7px;margin:8px 0;font-size:11px;line-height:1.6}
  #fwaP .info{background:#12202c;border:1px solid #1f3a52;color:#9ecbff;
    padding:7px 9px;border-radius:7px;margin:8px 0;font-size:11px;line-height:1.6}
  #fwaP table{width:100%;border-collapse:collapse;font-size:11px}
  #fwaP td{padding:3px 4px;border-bottom:1px solid #1a1f26;vertical-align:top}
  #fwaP td:last-child{text-align:right;font-variant-numeric:tabular-nums}
  #fwaP td.num{text-align:right;font-variant-numeric:tabular-nums}
  #fwaP .pass{color:#5fb87a}#fwaP .fail{color:#e0574a}#fwaP .skip{color:#6b7280}
  #fwaP .seg{display:flex;gap:6px;margin:0 0 10px}
  #fwaP .bar{display:grid;grid-template-columns:118px 1fr 58px;gap:8px;align-items:center;padding:3px 0}
  #fwaP .bar .lb{color:#c9ced6;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  #fwaP .bar .tr{height:12px;background:#171c23;border-radius:3px;overflow:hidden}
  #fwaP .bar .fl{height:100%;border-radius:3px}
  #fwaP .bar .pc{text-align:right;font-variant-numeric:tabular-nums}
  #fwaP .kpi{display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px;margin:4px 0 8px}
  #fwaP .kpi div{background:#141a22;border:1px solid #1e2630;border-radius:8px;padding:6px 8px}
  #fwaP .kpi .k{color:#7d8590;font-size:10px}
  #fwaP .kpi .v{font-size:15px;font-weight:600;font-variant-numeric:tabular-nums}
  #fwaP .ft{padding:6px 11px;border-top:1px solid #232a33;background:#11151a;
    color:#6b7280;font-size:10px;display:flex;justify-content:space-between;gap:8px}
  #fwaP .ft .st{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  #fwaP.min .tabs,#fwaP.min .bd,#fwaP.min .ft{display:none}
  `;

  let TAB = 0, ROUTE = 'eth', LAST = null, timer = null, busy = false, MULTI = { key: null, rows: null };

  function el(html) { const d = document.createElement('div'); d.innerHTML = html.trim(); return d.firstChild; }
  const sign = x => (x >= 0 ? '+' : '') + F(x, 5);
  const routeSeg = () => `<div class="seg">
      <button data-route="eth" class="${ROUTE === 'eth' ? 'on' : ''}">${S.routeEth}</button>
      <button data-route="fwa" class="${ROUTE === 'fwa' ? 'on' : ''}">${S.routeFwa}</button></div>`;
  const oneIn = p => p > 0 ? Math.round(1 / p).toLocaleString() : '—';

  function poolStatus(c) {
    if (c.pool) return '';
    if (POOL && !POOL.chk.ok) return `<div class="warn">${S.poolFail(POOL.chk)}</div>`;
    return `<div class="info">${S.poolPending}</div>`;
  }

  function render() {
    const p = document.getElementById('fwaP');
    if (!p) return;
    const bd = p.querySelector('.bd');
    if (!LAST) return;
    if (LAST.err) {
      bd.innerHTML = `<div class="warn"><b>${S.cannotShow}</b><br>${LAST.err}</div><div class="note">${S.refuse}</div>`;
      return;
    }
    const c = LAST.c, tests = LAST.tests;
    const R = c.routes[ROUTE], D = R.dist;
    let h = '';

    if (TAB === 0) {
      const E_ = c.routes.eth, Fw = c.routes.fwa;
      h += `<h4>${S.thisPull}</h4>
      <div class="row"><span>${S.ticketChain}</span><span class="big y">${F(c.ticket, 5)} Ξ</span></div>
      <div class="row"><span>${S.vrfFee}</span><span>${F(c.vrf, 6)} Ξ</span></div>
      <div class="row"><span>${S.gasAcq}</span><span>${F(c.gasAcq, 6)} Ξ <span class="mut">@ ${F(c.gasWei / 1e9, 3)} gwei</span></span></div>
      <h4>${S.expectBack}</h4>
      <table><tr><td class="mut"></td><td class="mut num">${S.routeEth}</td><td class="mut">${S.routeFwa}</td></tr>
      <tr><td>${S.payoutRate}</td><td class="num">${PCT(E_.sd, 2)}</td><td>${PCT(Fw.sd, 2)}</td></tr>
      <tr><td>${S.allIn}</td><td class="num">${F(E_.allIn, 5)}</td><td>${F(Fw.allIn, 5)}</td></tr>
      <tr><td>RTP</td><td class="num ${E_.rtp >= 1 ? 'g' : 'r'}">${PCT(E_.rtp)}</td><td class="${Fw.rtp >= 1 ? 'g' : 'r'}">${PCT(Fw.rtp)}</td></tr>`;
      if (c.pool) {
        const de = E_.dist, df = Fw.dist;
        h += `<tr><td>${S.pNoLoss}</td><td class="num">${PCT(de.pNoLoss, 1)}</td><td>${PCT(df.pNoLoss, 1)}</td></tr>
        <tr><td>${S.median}</td><td class="num">${F(de.q50, 4)}</td><td>${F(df.q50, 4)}</td></tr>
        <tr><td>${S.netExp}</td><td class="num ${de.net < 0 ? 'r' : 'g'}">${sign(de.net)}</td><td class="${df.net < 0 ? 'r' : 'g'}">${sign(df.net)}</td></tr>`;
      }
      h += `</table>${poolStatus(c)}
      <div class="note">${S.rtpNote}</div>
      <h4>${S.breakEven}</h4>
      <div class="row"><span>${S.routeEth}</span><span>backing ≥ ${F(E_.bev, 5)} Ξ</span></div>
      <div class="row"><span>${S.routeFwa}</span><span>backing ≥ ${F(Fw.bev, 5)} Ξ</span></div>
      <div class="row"><span>${S.expBacking}</span><span class="mut">${F(c.evHarm, 5)} Ξ</span></div>
      <div class="row"><span>${S.avgBacking}</span><span class="mut">${F(c.avgBacking, 4)} Ξ</span></div>
      <h4>${S.protocol}</h4>
      <div class="row"><span>${S.active}</span><span>${c.n.toLocaleString()}</span></div>
      <div class="row"><span>${S.surcharge}</span><span>${PCT(c.sur, 1)}</span></div>
      <div class="row"><span>${S.open}</span><span class="${c.acqEnabled && !c.blackout ? 'g' : 'r'}">${!c.acqEnabled ? S.no : c.blackout ? S.blackoutNow : S.yes}</span></div>
      <div class="row"><span>${S.staged}</span><span class="${c.staged ? 'y' : 'mut'}">${c.staged}</span></div>
      <div class="row"><span>${S.refundRate}</span><span>${PCT(c.refundRate)}</span></div>`;
    }

    if (TAB === 1) {
      h += routeSeg();
      if (!D) { h += poolStatus(c); }
      else {
        const maxP = Math.max(...D.buckets.map(x => x.p));
        h += `<div class="kpi">
          <div><div class="k">${S.pNoLoss}</div><div class="v ${D.pNoLoss >= 0.5 ? 'g' : 'r'}">${PCT(D.pNoLoss, 1)}</div></div>
          <div><div class="k">${S.median}</div><div class="v">${F(D.q50, 4)}</div></div>
          <div><div class="k">${S.allIn}</div><div class="v y">${F(R.allIn, 4)}</div></div></div>
        <h4>${S.distTitle}</h4>`;
        for (const x of D.buckets) {
          const w = maxP > 0 ? (x.p / maxP * 100) : 0;
          h += `<div class="bar"><span class="lb">${S.tier[x.j]}</span>
            <span class="tr"><span class="fl" style="display:block;width:${w.toFixed(1)}%;background:${x.col}"></span></span>
            <span class="pc">${PCT(x.p, 2)}</span></div>`;
        }
        h += `<table style="margin-top:8px"><tr><td class="mut">${S.colTier}</td><td class="mut num">${S.colBack}</td><td class="mut num">${S.colCnt}</td><td class="mut">${S.colCum}</td></tr>`;
        for (const x of D.buckets) {
          const range = x.cnt ? F(x.bmin * R.sd, 4) + (x.bmax > x.bmin ? '–' + F(x.bmax * R.sd, 4) : '') : '—';
          h += `<tr><td><span style="color:${x.col}">■</span> ${S.tier[x.j]}</td><td class="num">${range}</td><td class="num">${x.cnt}</td><td>${PCT(x.cum, 1)}</td></tr>`;
        }
        h += `</table>
        <div class="note">${S.distNote(R.allIn)}</div>
        <h4>${S.whereLand}</h4>
        <div class="row"><span>${S.q10}</span><span>${F(D.q10, 4)} Ξ <span class="mut">×${F(D.q10 / R.allIn, 2)}</span></span></div>
        <div class="row"><span>${S.q50}</span><span>${F(D.q50, 4)} Ξ <span class="mut">×${F(D.q50 / R.allIn, 2)}</span></span></div>
        <div class="row"><span>${S.q90}</span><span>${F(D.q90, 4)} Ξ <span class="mut">×${F(D.q90 / R.allIn, 2)}</span></span></div>
        <div class="row"><span>${S.evBack}</span><span>${F(D.ev, 5)} Ξ</span></div>
        <h4>${S.bigPrizes}</h4>
        <div class="row"><span>${S.atLeast(2)}</span><span>${PCT(D.p2, 2)} <span class="mut">${S.oneIn(oneIn(D.p2))}</span></span></div>
        <div class="row"><span>${S.atLeast(5)}</span><span>${PCT(D.p5, 3)} <span class="mut">${S.oneIn(oneIn(D.p5))}</span></span></div>
        <div class="row"><span>${S.atLeast(10)}</span><span>${PCT(D.p10, 3)} <span class="mut">${S.oneIn(oneIn(D.p10))}</span></span></div>
        <div class="row"><span>${S.topPrize}</span><span>${F(D.top, 3)} Ξ <span class="mut">×${F(D.topMult, 0)} · ${S.oneIn(oneIn(D.pTop))}</span></span></div>
        <div class="note">${S.poolLine(c.pool)}</div>`;
      }
    }

    if (TAB === 2) {
      h += routeSeg();
      if (!D) { h += poolStatus(c); }
      else {
        if (MULTI.key !== ROUTE + '@' + c.pool.block) { MULTI = { key: ROUTE + '@' + c.pool.block, rows: multiPull(c, ROUTE) }; }
        h += `<h4>${S.multiTitle}</h4>
        <table><tr><td class="mut">${S.colN}</td><td class="mut num">${S.colCost}</td><td class="mut num">${S.colNoLoss}</td><td class="mut num">${S.colMed}</td><td class="mut">${S.colRange}</td></tr>`;
        for (const r of MULTI.rows) {
          h += `<tr><td>${r.n}</td><td class="num">${F(r.cost, 3)}</td><td class="num ${r.pNo >= 0.5 ? 'g' : ''}">${PCT(r.pNo, 1)}</td>
            <td class="num ${r.med < 0 ? 'r' : 'g'}">${F(r.med, 3)}</td><td>${F(r.p5, 3)} ~ ${F(r.p95, 3)}</td></tr>`;
        }
        h += `</table><div class="note">${S.multiNote}</div>`;
      }
    }

    if (TAB === 3) {
      h += `<h4>${S.derivTitle}</h4>
      <table>
      <tr><td>${S.d1}</td><td>w = 1e36 ÷ backing</td></tr>
      <tr><td>${S.d2}</td><td>p_i = w_i ÷ Σw</td></tr>
      <tr><td>${S.d3}</td><td>Σ(w·b) ÷ Σw = ${F(c.evRatio, 6)} Ξ</td></tr>
      <tr><td>${S.d4}</td><td>× (1 + ${PCT(c.sur, 1)}) = ${F(c.feeAgg, 6)} Ξ</td></tr>
      <tr><td>${S.d5}</td><td>${F(c.fee, 6)} + ${F(c.vrf, 6)} Ξ</td></tr>
      <tr><td>${S.d6}</td><td>backing × ${PCT(c.routes.eth.sd, 1)} / ${PCT(c.routes.fwa.sd, 1)}</td></tr>
      <tr><td>${S.d7}</td><td>${PCT(c.routes.eth.rtp)} / ${PCT(c.routes.fwa.rtp)}</td></tr>
      </table>
      <h4>${S.enumTitle}</h4>
      <div class="note">${S.enumText}</div>
      <h4>${S.distHow}</h4>
      <div class="note">${S.distHowText}</div>`;
    }

    if (TAB === 4) {
      h += `<h4>${S.testsTitle}</h4><table>`;
      for (const t of tests) {
        const cls = t.pass === null ? 'skip' : (t.pass ? 'pass' : 'fail');
        const mark = t.pass === null ? 'SKIP' : (t.pass ? 'PASS' : 'FAIL');
        h += `<tr><td>${t.name}</td><td class="${cls}">${mark}<br><span class="mut">${t.detail}</span></td></tr>`;
      }
      h += `</table>`;
      const bad = tests.filter(t => t.pass === false).length;
      h += bad ? `<div class="warn">${S.testsBad(bad)}</div>` : `<div class="note">${S.testsOk}</div>`;
    }

    if (TAB === 5) {
      h += `<h4>${S.limitsTitle}</h4><div class="note">${S.limits(c)}</div>
      <h4>${S.runTitle}</h4>
      <div class="row"><span>${S.contract}</span><span class="mut" style="word-break:break-all">${c.deployment}</span></div>
      <div class="row"><span>${S.chainBlock}</span><span>${c.cs.blockNum}</span></div>
      <div class="row"><span>${S.indexBlock}</span><span>${c.gs.sourceBlock || '—'}</span></div>
      <div class="note">${S.readOnly}</div>`;
    }

    bd.innerHTML = h;
    bd.querySelectorAll('[data-route]').forEach(b => b.onclick = () => { ROUTE = b.dataset.route; render(); });
  }

  /* ══════════════ main loop ══════════════ */
  async function refresh() {
    const p = document.getElementById('fwaP');
    if (!p || busy) return;
    busy = true;
    const st = p.querySelector('.st');
    onProgress = m => { if (st) st.textContent = m; };
    try {
      onProgress(S.progState);
      const gs = await fetchConfig();
      const C = contractOf(gs);
      let cs = await chainSummary(C);
      let gasWei = 0;
      try { gasWei = parseInt(await rpc('eth_gasPrice'), 16); } catch (e) {}

      // 1) show aggregates right away
      let c = compute(gs, cs, null, gasWei);
      LAST = { c, tests: selfTests(c) };
      render();

      // 2) enumerate the pool at the same block, then redraw with the distribution
      POOL = await enumeratePool(C, cs);
      c = compute(gs, cs, POOL, gasWei);
      LAST = { c, tests: selfTests(c) };
      render();
      onProgress(S.updated(new Date().toLocaleTimeString(), cs.blockNum, POOL));
    } catch (e) {
      if (!LAST || !LAST.c) LAST = { err: String(e && e.message || e) };
      render();
      onProgress(S.errShort + ': ' + String(e && e.message || e).slice(0, 80));
    } finally { busy = false; }
  }

  function mount() {
    const style = document.createElement('style');
    style.textContent = CSS;
    document.head.appendChild(style);

    const p = el(`<div id="fwaP">
      <div class="hd"><b>${S.title}</b><span class="sp"></span>
        <button class="mn">—</button><button class="rf">${S.refresh}</button><button class="cl">×</button></div>
      <div class="tabs">${S.tabs.map((t, i) => `<div class="${i === 0 ? 'on' : ''}">${t}</div>`).join('')}</div>
      <div class="bd"><div class="note">${S.starting}</div></div>
      <div class="ft"><span class="st">${S.starting}</span><span>v${VERSION}</span></div>
    </div>`);
    document.body.appendChild(p);

    const tabs = [...p.querySelectorAll('.tabs div')];
    tabs.forEach((t, i) => t.onclick = () => {
      TAB = i; tabs.forEach(x => x.classList.remove('on')); t.classList.add('on'); render();
    });
    p.querySelector('.rf').onclick = refresh;
    p.querySelector('.mn').onclick = () => p.classList.toggle('min');
    p.querySelector('.cl').onclick = () => {
      if (timer) clearInterval(timer);
      p.remove(); delete window.__fwaPanel;
    };

    const hd = p.querySelector('.hd');
    let dx = 0, dy = 0, drag = false;
    hd.onmousedown = e => {
      if (e.target.tagName === 'BUTTON') return;
      drag = true; const r = p.getBoundingClientRect();
      dx = e.clientX - r.left; dy = e.clientY - r.top;
      p.style.right = 'auto'; e.preventDefault();
    };
    document.addEventListener('mousemove', e => {
      if (!drag) return;
      p.style.left = Math.max(0, e.clientX - dx) + 'px';
      p.style.top = Math.max(0, e.clientY - dy) + 'px';
    });
    document.addEventListener('mouseup', () => drag = false);

    window.__fwaPanel = { refresh, state: () => LAST };
    refresh();
    timer = setInterval(refresh, 60000);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
  else mount();
})();
