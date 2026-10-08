{
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
    progReader: (f, n) => 'Reading pool ' + f + '/' + n + '…',
    poolFailShort: 'This read did not reconcile; still showing the previous result',
    progScan: (f, n, s) => 'Scanning slots ' + f + '/' + n + ' (up to slot ' + s + ')',
    updated: (t, b, p) => 'Updated ' + t + ' · block ' + b + ' · pool read in ' + (p.ms / 1000).toFixed(1) + 's' + (p.mode === 'reader' ? '' : ' (fallback)') + ' · every 60 s',

    poolPending: 'Reading the full pool from the chain (usually 1–3 s). Tiers, chance of not losing and multi-pull appear once it finishes.',
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
      'and <code>listings(id)</code> gives weight, backing and status. ' +
      'For speed, the panel sends a small read-only scanner (src/PoolReader.sol in the repo) with an eth_call; the node runs it over every slot against live state and returns the whole pool in about 1 s — nothing is deployed, signed or paid for. ' +
      'Everything goes through the site\'s own /api/rpc, pinned to <b>one block</b>. If that path fails, the panel falls back to batched Multicall3 reads (slower, and the result must pass the same reconciliation).',
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
}
