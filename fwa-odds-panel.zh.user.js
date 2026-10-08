// ==UserScript==
// @name         FWA V2 抽奖赔率实时面板
// @namespace    fwa.monitor
// @version      5.1
// @description  在 fwa.fun V2 页面内实时计算：真实花费、两种结算的期望回报、七档结果分布与不亏概率、连抽模拟。全池从链上合约逐条读取，并与合约合计逐位对账。
// @match        https://www.fwa.fun/*
// @match        https://fwa.fun/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==
/* ═══════════════════════════════════════════════════════════════════════════
 *  FWA V2 Odds Panel — v5.1
 *
 *  v5.0 brought back the full outcome distribution. v4.0 dropped it because the
 *  site has no endpoint that enumerates the pool. The pool is read straight from
 *  the FWAV2 contract instead:
 *
 *    slotToListing(slot) → listingId      (public mapping, slots start at 1,
 *                                          freed slots are reused, so the range
 *                                          has holes)
 *    listings(id)        → weight, value (backing), status, …
 *
 *  v5.1 reads the whole pool in ONE eth_call (~1 s instead of 25–40 s): the call
 *  carries the init code of src/PoolReader.sol and no `to`, so the node runs its
 *  constructor against live state; it walks the slots, calls listings() on each
 *  occupied one and reverts with the packed result (revert data, because returned
 *  init-code output is capped at 24 KB). Nothing is deployed or signed. If that
 *  path fails, the v5.0 Multicall3 scan is used instead.
 *
 *  Everything goes through the site's own /api/rpc proxy, pinned to ONE block
 *  number. Every enumeration has to pass three exact BigInt checks against the
 *  contract's own totals at that same block before any distribution is drawn:
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
    title: 'FWA V2 赔率面板',
    refresh: '刷新',
    starting: '启动中…',
    tabs: ['概览', '档位分布', '连抽', '原理', '自检', '局限'],
    routeEth: '拿 ETH',
    routeFwa: '拿 FWA',
    yes: '是', no: '否',

    errNoState: '找不到 gameState —— fwa.fun 可能改了结构。面板拒绝显示可能错误的数字。',
    errCall: k => '合约调用 ' + k + ' 失败 —— 合约可能已升级。',
    errShort: '出错',
    cannotShow: '无法显示',
    refuse: '面板宁可不显示，也不显示可能错误的数字。',

    progState: '读取协议状态…',
    progRead: '读取仓位',
    progReader: (f, n) => '读取全池 ' + f + '/' + n + '…',
    poolFailShort: '本次全池对账未通过，仍显示上一次的结果',
    progScan: (f, n, s) => '扫描槽位 ' + f + '/' + n + '（已扫到第 ' + s + ' 号）',
    updated: (t, b, p) => '更新于 ' + t + ' · 区块 ' + b + ' · 读池 ' + (p.ms / 1000).toFixed(1) + 's' + (p.mode === 'reader' ? '' : '（备用通道）') + ' · 每 60 秒刷新',

    poolPending: '正在从链上读取全池（通常 1–3 秒）。档位分布、不亏概率和连抽会在完成后出现。',
    poolFail: k => '<b>全池枚举未通过对账，分布不予显示。</b><br>数量 ' + (k.count ? '✓' : '✗') +
      ' · Σweight ' + (k.sumW ? '✓' : '✗') + ' · Σ(w·b) ' + (k.sumWB ? '✓' : '✗') + '。下次刷新会自动重试。',

    thisPull: '这一抽',
    ticketChain: '票价（合约报价）',
    vrfFee: '其中 VRF 服务费',
    gasAcq: '下单 gas（估）',
    expectBack: '两种结算对比',
    payoutRate: '回售比例',
    allIn: '全部花费 Ξ',
    pNoLoss: '不亏概率',
    median: '中位数拿回 Ξ',
    netExp: '期望净值 Ξ',
    rtpNote: 'RTP = 回售比例 ÷ (1 + 加价)，与池子大小、构成、何时抽全都无关。「全部花费」已含下单和结算两笔 gas，所以「不亏」的门槛比票价略高。',
    breakEven: '打平需要抽到多大的仓位',
    expBacking: '池子期望 backing（调和均值）',
    avgBacking: '池子平均 backing（算术均值）',
    protocol: '协议状态',
    active: '活跃仓位',
    surcharge: '加价',
    open: '可以下单',
    blackoutNow: '暂停窗口中',
    staged: '排队待入池仓位',
    refundRate: '历史退款率',

    distTitle: '这一抽会落在哪一档',
    tier: ['血亏 <30%', '大亏 30–60%', '小亏 60–95%', '打平 ±5%', '小赚 1.05–2×', '翻倍 2–5×', '大奖 ≥5×'],
    colTier: '档位', colBack: '拿回 Ξ', colCnt: '仓位数', colCum: '累计',
    distNote: a => '档位按「拿回 ÷ 全部花费（' + a.toFixed(5) + ' Ξ）」划分。概率 = 该档所有仓位的 weight 之和 ÷ 总 weight，逐条来自链上。',
    whereLand: '拿回金额落点',
    q10: '10% 的情况低于', q50: '一半的情况低于（中位数）', q90: '90% 的情况低于',
    evBack: '期望拿回',
    bigPrizes: '大奖概率',
    atLeast: m => '拿回 ≥ ' + m + '× 花费',
    oneIn: s => '约 1/' + s,
    topPrize: '池中最大仓位',
    poolLine: p => '全池 ' + p.N.toLocaleString() + ' 条，区块 ' + p.block + '，backing ' + p.minB.toFixed(3) + ' ~ ' + p.maxB.toFixed(2) + ' Ξ。三项精确对账全部通过（见自检页）。',

    multiTitle: '连抽 n 次（蒙特卡洛 1 万轮，基于真实全池）',
    colN: '次数', colCost: '花费 Ξ', colNoLoss: '不亏概率', colMed: '中位净 Ξ', colRange: '90% 区间 Ξ',
    multiNote: '「不亏」= 累计拿回 ≥ 累计花费。抽得越多，结果越向期望值（负数）收敛，不亏概率随之下降——连抽不会改变每抽的期望，只改变波动。各抽视为独立：每抽只拿走几千条中的一条，票价变化远小于 0.1%。',

    derivTitle: '推导（代入当前链上数字）',
    d1: '① 权重', d2: '② 抽中概率', d3: '③ 期望 backing', d4: '④ 票价公式',
    d5: '⑤ 合约实际报价', d6: '⑥ 回售所得', d7: '⑦ RTP（ETH / FWA）',
    enumTitle: '全池是怎么拿到的',
    enumText: 'fwa.fun 网站不提供全池列表（v4.0 因此删掉了分布）。v5.0 直接读 FWAV2 合约：' +
      '<code>slotToListing(slot)</code> 给出每个槽位上的仓位 id（槽位从 1 开始，释放后会复用，所以中间有空洞），' +
      '<code>listings(id)</code> 给出 weight、backing 和状态。' +
      '为了快，面板把一小段只读扫描代码（仓库 src/PoolReader.sol）随 eth_call 发给节点，由节点在链上状态里一次跑完全部槽位，约 1 秒返回整个池子——不部署合约、不签名、不花钱。' +
      '所有读取走站点自己的 /api/rpc，钉在<b>同一个区块</b>。这条路走不通时自动改用 Multicall3 逐批读取（慢，但结果一样要过对账）。',
    distHow: '为什么分布可信',
    distHowText: '每次枚举必须与合约自己的合计在同一区块<b>逐位相等</b>：仓位数 = activeListingCount，Σweight = totalWeight，' +
      'Σ(weight×backing) = weightedBackingTotal（合约内 _evOf = w·v）。任何一条漏读或读错，这三个等式都不可能同时成立。' +
      '不通过就不显示分布。',

    testsTitle: '自检（每次刷新现场重跑）',
    tFee: '票价公式 == 合约报价 acquisitionFee',
    tTwoPath: '双路径期望 backing 一致',
    tCfg: '链上参数 == 索引器参数',
    cfgLag: '索引器尚未同步，面板以链上为准',
    dev: '偏差',
    tRtp: k => 'RTP(' + (k === 'eth' ? 'ETH' : 'FWA') + ') == 回售 ÷ (1+加价)',
    tPool: '全池枚举',
    tCount: '枚举条数 == activeListingCount',
    tSumW: 'Σweight == totalWeight',
    tSumWB: 'Σ(w·b) == weightedBackingTotal',
    exactBig: 'BigInt 逐位相等',
    tEach: '每条 weight == 1e36 ÷ backing',
    tSumP: '中签概率之和 = 1',
    tEnumFee: '枚举算出的票价 == 合约报价',
    tBuckets: k => '分档概率之和 = 1（' + (k === 'eth' ? 'ETH' : 'FWA') + '）',
    tEv: k => '分布期望 == 票价 × RTP（' + (k === 'eth' ? 'ETH' : 'FWA') + '）',
    tSign: k => '净值符号与 RTP 一致（' + (k === 'eth' ? 'ETH' : 'FWA') + '）',
    tMc: '蒙特卡洛 15 万次 vs 解析期望',
    testsBad: n => '<b>' + n + ' 项未通过</b> —— 面板数字可能不可靠，请以官方 UI 为准。',
    testsOk: '全部通过。全池三项精确对账通过，意味着分布用的就是此刻链上的完整池子，一条不多一条不少。',

    limitsTitle: '这个面板算不出来什么',
    limits: c => '<b>1. 留下 NFT 这条路没有算。</b>拿不到可靠的地板价（挂单价不是成交价），所以档位只按回售 ETH / FWA 计。<br>' +
      '<b>2. FWA 路径按「花掉的 ETH」计。</b>合约用回售额去池子买 FWA，兑换滑点和手续费没扣，实际到手价值通常略低。<br>' +
      '<b>3. 分布是下单那一刻的池子。</b>合约在 VRF 回调后按顺序结算，期间别人的抽奖、存入、取回会让池子变化；排队待入池的仓位（当前 ' + c.staged + ' 条）也会在抽选前加入。几千条的池子里这种变化很小，但不为零。<br>' +
      '<b>4. gas 是估算。</b>按主网近期交易标定：下单平均 61 万 gas（约 12% 的交易因顺带处理前面的请求超过 100 万），结算 ETH 约 17.5 万、FWA 约 30 万，乘实时 gas 价。<br>' +
      '<b>5. 退款没摊进期望。</b>历史退款率 ' + (c.refundRate * 100).toFixed(2) + '%。<br>' +
      '<b>6. 奖励没算。</b>顶部仓位奖池分成、epoch $FWA 奖励、builder 奖励都没计入，所以面板偏保守。<br>' +
      '<b>7. 暂停窗口。</b>每天 UTC 11:45–12:00、23:45–24:00 不能下单（北京时间 19:45–20:00、7:45–8:00）。',
    runTitle: '本次运行',
    contract: '合约', chainBlock: '链上区块', indexBlock: '索引器区块',
    readOnly: '只读脚本：不请求钱包、不签名，除了 fwa.fun 自己的接口不向任何地方发数据。研究工具，非投资建议。'
};
  const VERSION = '5.1';

  const E = 1e18;
  const E36 = 10n ** 36n;
  const HDR = { 'content-type': 'application/json', 'x-gacha-client': 'web' };
  const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11';
  const DEFAULT_CONTRACT = '0x958c41181182e76f221331b2755b77d9e1426a98';
  const ACTIVE = 1;                          // FWAV2.ListingStatus.Active
  const CHUNK = 200;                         // calls per aggregate3 (site proxy caps the body ~100 KB)
  const PAR = 6;                             // parallel requests
  const SLOT_CAP = 200000;                   // hard stop for the slot scan
  const READER_SPAN = 20000;                 // slots per PoolReader call (~1 s each)
  const READER_MAGIC = '465741504f4f4c31';   // "FWAPOOL1"
  const READER_CODE = '608060405234801561000f575f80fd5b5060405161043538038061043583398101604081905261002e91610282565b5f61003983836102ca565b90505f6100478260206102e3565b6100529060206102fa565b6001600160401b038111156100695761006961030d565b6040519080825280601f01601f191660200182016040528015610093576020820181803683370190505b5090505f845b8481101561024d5760405163e2881eb760e01b8152600481018290525f906001600160a01b0389169063e2881eb790602401602060405180830381865afa1580156100e6573d5f803e3d5ffd5b505050506040513d601f19601f8201168201806040525081019061010a9190610321565b9050805f036101195750610245565b5f805f8a6001600160a01b031663de74e57b856040518263ffffffff1660e01b815260040161014a91815260200190565b61016060405180830381865afa158015610166573d5f803e3d5ffd5b505050506040513d601f19601f8201168201806040525081019061018a919061034d565b9a505050505096509650505050508060ff166001146101ac5750505050610245565b640100000000841080156101cc57506c0100000000000000000000000082105b80156101db5750600160801b83105b61021b5760405162461bcd60e51b815260206004820152600d60248201526c7061636b206f766572666c6f7760981b604482015260640160405180910390fd5b60e084901b608083901b17831760208702880160400181905261023d8761041c565b965050505050505b600101610099565b5067465741504f4f4c3160c01b602083810182815283820290910190fd5b6001600160a01b038116811461027f575f80fd5b50565b5f805f60608486031215610294575f80fd5b835161029f8161026b565b602085015160409095015190969495509392505050565b634e487b7160e01b5f52601160045260245ffd5b818103818111156102dd576102dd6102b6565b92915050565b80820281158282048414176102dd576102dd6102b6565b808201808211156102dd576102dd6102b6565b634e487b7160e01b5f52604160045260245ffd5b5f60208284031215610331575f80fd5b5051919050565b805160ff81168114610348575f80fd5b919050565b5f805f805f805f805f805f6101608c8e031215610368575f80fd5b8b516103738161026b565b60208d0151909b506103848161026b565b60408d0151909a506103958161026b565b809950505f60608d01519050809850505f60808d01519050809750505f60a08d01519050809650505f60c08d01519050809550505f60e08d01519050809450505f6101008d01519050809350506101208c015160018060401b03811681146103fb575f80fd5b915061040a6101408d01610338565b90509295989b509295989b9093969950565b5f6001820161042d5761042d6102b6565b506001019056fe';        // init code of src/PoolReader.sol (solc 0.8.26, opt 200)

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

  /* Fast path: one eth_call per READER_SPAN slots. The call has no `to`, so the node runs
     PoolReader's init code (src/PoolReader.sol) against live state at the pinned block; the
     constructor reads slotToListing + listings for every slot and reverts with the packed
     result. Nothing is deployed and nothing is signed — it is a read like any other eth_call. */
  async function readerScan(C, cs) {
    const list = []; let from = 1;
    while (list.length < cs.n && from < SLOT_CAP) {
      const to = from + READER_SPAN;
      onProgress(S.progReader(list.length, cs.n));
      const data = '0x' + READER_CODE + w64(C) + w64(from) + w64(to);
      const r = await fetch('/api/rpc', { method: 'POST', headers: HDR,
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ data }, cs.block] }) });
      const j = await r.json().catch(() => null);
      const d = j && j.error && j.error.data;
      const out = typeof d === 'string' ? d : (d && d.data);   // some nodes nest it
      if (!out || out.slice(2, 18) !== READER_MAGIC) throw new Error('reader: ' + JSON.stringify(j).slice(0, 120));
      const h = out.slice(66);
      for (let i = 0; i + 64 <= h.length; i += 64) {
        const x = BigInt('0x' + h.slice(i, i + 64));
        list.push({ id: x >> 224n, v: (x >> 128n) & ((1n << 96n) - 1n), w: x & ((1n << 128n) - 1n), st: ACTIVE });
      }
      from = to;
    }
    return list;
  }

  async function enumeratePool(C, cs) {
    const t0 = performance.now();
    let list = null, mode = 'reader', chk = null;

    try {
      list = await readerScan(C, cs);
      chk = checkPool(list, cs);
      if (!chk.ok) list = null;
    } catch (e) { list = null; }
    if (list) {
      const p = { C, block: cs.blockNum, nextId: cs.nextId, list, chk, mode, ms: performance.now() - t0, at: Date.now() };
      saveCache(p);
      return p;
    }

    // Fallback: Multicall3 over slotToListing / listings.
    const prev = (POOL && POOL.C === C) ? { nextId: POOL.nextId, ids: POOL.list.map(x => x.id) } : loadCache(C);
    mode = 'full';
    // Re-read every previously active id + every id created since, at this block.
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

  const PREF_KEY = 'fwaOddsPanel.prefs';
  const prefs = (() => { try { return JSON.parse(localStorage.getItem(PREF_KEY) || '{}'); } catch (e) { return {}; } })();
  const savePrefs = () => { try { localStorage.setItem(PREF_KEY, JSON.stringify({ tab: TAB, route: ROUTE })); } catch (e) {} };
  const REFRESH_MS = 60000;

  // Opens on the tier distribution by default; remembers the last tab and route.
  let TAB = Number.isInteger(prefs.tab) && prefs.tab >= 0 && prefs.tab < S.tabs.length ? prefs.tab : 1;
  let ROUTE = prefs.route === 'fwa' ? 'fwa' : 'eth';
  let LAST = null, timer = null, busy = false, MULTI = { key: null, rows: null }, lastOk = 0, renderedTab = -1;

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

    // Keep the reader's place: a background refresh must not jump the view back to the top.
    const keep = renderedTab === TAB ? bd.scrollTop : 0;
    bd.innerHTML = h;
    bd.scrollTop = keep;
    renderedTab = TAB;
    bd.querySelectorAll('[data-route]').forEach(b => b.onclick = () => { ROUTE = b.dataset.route; savePrefs(); render(); });
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
      const cs = await chainSummary(C);
      let gasWei = 0;
      try { gasWei = parseInt(await rpc('eth_gasPrice'), 16); } catch (e) {}

      // First load only: show the aggregates while the pool is read. On later refreshes the
      // previous verified view stays on screen until the new one is ready — no flicker.
      const hadPool = !!(LAST && LAST.c && LAST.c.pool);
      if (!hadPool) {
        const c0 = compute(gs, cs, null, gasWei);
        LAST = { c: c0, tests: selfTests(c0) };
        render();
      }

      const pool = await enumeratePool(C, cs);
      POOL = pool;
      const c = compute(gs, cs, pool, gasWei);
      if (c.pool || !hadPool) {
        LAST = { c, tests: selfTests(c) };
        render();
      }
      if (c.pool) lastOk = Date.now();
      onProgress(c.pool ? S.updated(new Date().toLocaleTimeString(), cs.blockNum, pool)
                        : S.poolFailShort);
    } catch (e) {
      if (!LAST || !LAST.c) { LAST = { err: String(e && e.message || e) }; render(); }
      onProgress(S.errShort + ': ' + String(e && e.message || e).slice(0, 80));
    } finally { busy = false; }
  }

  // Auto-refresh only while the tab is visible; catch up as soon as it comes back.
  function tick() { if (!document.hidden) refresh(); }
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && Date.now() - lastOk > REFRESH_MS) refresh();
  });

  function mount() {
    const style = document.createElement('style');
    style.textContent = CSS;
    document.head.appendChild(style);

    const p = el(`<div id="fwaP">
      <div class="hd"><b>${S.title}</b><span class="sp"></span>
        <button class="mn">—</button><button class="rf">${S.refresh}</button><button class="cl">×</button></div>
      <div class="tabs">${S.tabs.map((t, i) => `<div class="${i === TAB ? 'on' : ''}">${t}</div>`).join('')}</div>
      <div class="bd"><div class="note">${S.starting}</div></div>
      <div class="ft"><span class="st">${S.starting}</span><span>v${VERSION}</span></div>
    </div>`);
    document.body.appendChild(p);

    const tabs = [...p.querySelectorAll('.tabs div')];
    tabs.forEach((t, i) => t.onclick = () => {
      TAB = i; tabs.forEach(x => x.classList.remove('on')); t.classList.add('on'); savePrefs(); render();
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
    timer = setInterval(tick, REFRESH_MS);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
  else mount();
})();
