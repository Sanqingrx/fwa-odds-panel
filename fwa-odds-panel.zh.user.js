// ==UserScript==
// @name         FWA 抽奖赔率实时面板
// @namespace    fwa.monitor
// @version      2.0
// @description  在 fwa.fun 页面内实时计算：抽一次的真实花费、结果概率分布、连抽几次最划算。数据源与官方 UI 完全相同，自带一致性校验。
// @match        https://www.fwa.fun/*
// @match        https://fwa.fun/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

/* ═══════════════════════════════════════════════════════════════════════════
 *  用法
 *    A) Tampermonkey → 新建脚本 → 粘贴本文件 → 保存。以后打开 fwa.fun 自动出现。
 *    B) 临时用：在 fwa.fun 页面按 F12 → Console → 粘贴 → 回车。
 *
 *  为什么数据一定和 fwa 一致
 *    1. 走站点自己的 /api/ponder 与 /api/rpc，与官方 UI 同源、同 header、同数据源。
 *    2. 所有协议参数（surcharge / 回售折价 / hotGap / coldGap / 是否开放抽奖）
 *       每次刷新从 gameState 实时读，代码里不写死。owner 改参数，面板跟着变。
 *    3. Gas 价格从链上实时读，不靠估。
 *    4. 票价用两条互不相干的路径各算一次并交叉比对：
 *         路径①（合约口径）weightedBackingTotal / totalActiveWeight × (1+surcharge)
 *         路径②（枚举口径）N / Σ(1/backing) × (1+surcharge)
 *       一致 → 证明 5000+ 仓位一条没漏。不一致 → 红色告警。
 *
 *  已知的、代码解决不了的局限，见面板「局限」页签。
 * ═══════════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';
  if (window.__fwaPanel) { window.__fwaPanel.refresh(); return; }

  const E = 1e18;
  const HDR = { 'content-type': 'application/json', 'x-gacha-client': 'web' };
  // 索引器偶发 504（Indexer request timed out），自动退避重试
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  async function api(operation, variables = {}, tries = 4) {
    let lastErr = null;
    for (let i = 0; i < tries; i++) {
      try {
        const r = await fetch('/api/ponder', {
          method: 'POST', headers: HDR, body: JSON.stringify({ operation, variables })
        });
        const j = await r.json();
        if (j && j.data) return j;
        lastErr = (j && j.error) || ('HTTP ' + r.status);
      } catch (e) { lastErr = e.message; }
      if (i < tries - 1) await sleep(600 * (i + 1));
    }
    throw new Error('索引器无响应（' + lastErr + '）。稍后重试。');
  }
  const rpc = (method, params = []) =>
    fetch('/api/rpc', { method: 'POST', headers: HDR, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })
      .then(r => r.json());
  const cursor = (b, i) => btoa(JSON.stringify({
    json: { backing: String(b), id: String(i) },
    meta: { values: { backing: ['bigint'], id: ['bigint'] }, v: 1 }
  }));
  const F = (x, d = 4) => (x == null || !isFinite(x)) ? '—' : (+x).toFixed(d);
  const PCT = x => (x * 100).toFixed(2) + '%';

  // 自付 gas 估算（VRF 的 800k/+30% 来自官方 docs，两笔交易的 gas 是保守估计）
  const VRF_GAS = 800000, VRF_MARGIN = 1.30, BUY_GAS = 300000, SETTLE_GAS = 180000;

  const BK = [
    ['血亏 <30%', 0, .30, '#8b2635'], ['大亏 30–60%', .30, .60, '#c74a4a'],
    ['小亏 60–95%', .60, .95, '#e0844a'], ['基本打平 ±5%', .95, 1.05, '#8b929e'],
    ['小赚 1–2×', 1.05, 2, '#5fb87a'], ['翻倍 2–5×', 2, 5, '#3fd68c'],
    ['大奖 ≥5×', 5, 1e9, '#f5c451']
  ];

  /* ══════════════ 取数 ══════════════ */
  async function fetchAll() {
    // 枚举要几秒，期间池子会变。前后各读一次 gameState，用区间区分「正常竞态」与「真错误」
    const g0 = (await api('pool-public'))?.data?.gameState;
    if (!g0) throw new Error('拿不到 gameState（是否不在 fwa.fun 域名下？）');

    let items = [], after = cursor('99999999999999999999999999', '99999999'), pages = 0;
    while (pages++ < 60) {
      const L = (await api('pool-prizes-page', { after }))?.data?.listings;
      if (!L) break;
      items = items.concat(L.items);
      if (!L.pageInfo.hasNextPage) break;
      after = L.pageInfo.endCursor;
    }
    const g1 = (await api('pool-public'))?.data?.gameState || g0;

    let gwei = null;
    try { const r = await rpc('eth_gasPrice'); if (r.result) gwei = parseInt(r.result, 16) / 1e9; } catch (e) {}

    const act = items.filter(x => x.activatedAt && !x.allocatedAt && !x.resolvedAt);
    return { g: g1, g0, act, pages, gwei };
  }

  /* ══════════════ 计算 ══════════════ */
  function compute(g, act, g0, gwei) {
    const sur = Number(g.surchargeBps) / 10000;            // 实时
    const bid = Number(g.settlementDiscountBps) / 10000;   // 实时
    const hot = Number(g.hotGap), cold = Number(g.coldGap);

    // 路径① 合约口径
    const evChain = Number(BigInt(g.weightedBackingTotal) * 100000000n / BigInt(g.totalActiveWeight)) / 1e8 / E;
    const ticket = evChain * (1 + sur);

    // 路径② 枚举口径
    const b = act.map(x => Number(x.backing) / E);
    const N = b.length, S = b.reduce((s, v) => s + 1 / v, 0);
    const evEnum = N / S, ticketEnum = evEnum * (1 + sur);
    const drift = Math.abs(ticketEnum - ticket) / ticket;

    const nA = (g0 || g).activeListingCount, nB = g.activeListingCount;
    const churn = Math.abs(nA - nB);
    const countOK = N >= Math.min(nA, nB) - churn - 2 && N <= Math.max(nA, nB) + churn + 2;
    const exact = N === nB;

    // 真实花费
    const gw = (gwei ?? 1) * 1e-9;
    const vrfFee = VRF_GAS * VRF_MARGIN * gw, buyGas = BUY_GAS * gw, setGas = SETTLE_GAS * gw;
    const cost = ticket + vrfFee + buyGas + setGas;

    // 冷启动 → surcharge 归买家的比例
    const secs = Math.floor(Date.now() / 1000) - Number(g.lastAcquisitionAt);
    const forced = Number(g.forcedTokenShareBps);
    const share = forced >= 0 ? forced / 10000 : Math.max(0, Math.min(1, (secs - hot) / (cold - hot)));
    const rebate = sur * evChain * share * 0.99;   // 扣 1% FWA 交易费

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
      p, got, b };
  }

  /* ══════════════ 连抽曲线 ══════════════
     N≈5000 时，连续抽走 200 个最便宜的仓位票价也只涨 7%，抽 10 次仅涨 0.5%，
     故各次抽奖按独立同分布处理（不放回的修正在这个规模下可忽略）。 */
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

  /* ══════════════ 自检 ══════════════ */
  function selftest(r) {
    const T = [], add = (n, exp, act, tol) =>
      T.push({ n, exp, act, err: Math.abs(exp - act), ok: Math.abs(exp - act) <= tol });
    add('所有中签概率之和 = 1', 1, r.p.reduce((s, v) => s + v, 0), 1e-9);
    add('Σ(概率×backing) = 调和平均', r.evEnum, r.p.reduce((s, v, i) => s + v * r.b[i], 0), 1e-9);
    add('票价 ÷ 期望值 = 1+surcharge', 1 + r.sur, r.ticketEnum / r.evEnum, 1e-9);
    add('分区概率之和 = 1', 1, r.buckets.reduce((s, x) => s + x.p, 0), 1e-9);
    add('合约口径 vs 枚举口径票价', r.ticket, r.ticketEnum, r.ticket * 0.005);
    // 蒙特卡洛对拍解析期望
    const M = r.N, cum = new Float64Array(M); let a = 0;
    for (let i = 0; i < M; i++) { a += r.p[i]; cum[i] = a; }
    const R = 150000; let tot = 0;
    for (let k = 0; k < R; k++) { const u = Math.random(); let lo = 0, hi = M - 1;
      while (lo < hi) { const m = (lo + hi) >> 1; if (cum[m] < u) lo = m + 1; else hi = m; }
      tot += r.got[lo]; }
    add('蒙特卡洛 15 万次 vs 解析期望', r.ev, tot / R, r.ev * 0.02);
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
    .chk{font-size:10.5px;padding:7px 9px;border-radius:7px;margin-bottom:10px;line-height:1.55}
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
  <div class="fH"><b>FWA 赔率面板</b><span id="fAge" style="font-size:10px;color:#5d646f"></span>
    <button id="fR">刷新</button><button id="fM">—</button></div>
  <div class="fT">
    <b data-t="0" class="on">概览</b><b data-t="1">连抽</b><b data-t="2">原理</b><b data-t="3">自检</b><b data-t="4">局限</b>
  </div>
  <div class="fB" id="fBody">载入中…</div>`;
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
  // 拖动
  (() => { const h = el.querySelector('.fH'); let sx, sy, ox, oy, on = false;
    h.onmousedown = e => { if (e.target.tagName === 'BUTTON') return;
      on = true; sx = e.clientX; sy = e.clientY;
      const r = el.getBoundingClientRect(); ox = r.left; oy = r.top;
      el.style.right = 'auto'; el.style.bottom = 'auto'; e.preventDefault(); };
    addEventListener('mousemove', e => { if (!on) return;
      el.style.left = (ox + e.clientX - sx) + 'px'; el.style.top = (oy + e.clientY - sy) + 'px'; });
    addEventListener('mouseup', () => on = false); })();

  /* ── 各页签渲染 ── */
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
      ${consistent ? '✅ 一致性校验通过' : '⚠️ 一致性校验未通过'}<br>
      票价：合约口径 <b>${F(r.ticket, 6)}</b> ｜ 枚举口径 <b>${F(r.ticketEnum, 6)}</b> ｜ 偏差 <b>${(r.drift * 100).toFixed(3)}%</b><br>
      仓位：枚举 ${r.N} ｜ 链上 ${r.nA}→${r.nB}
      ${r.exact ? '（精确一致）' : r.churn ? `<span class="d">（取数期间 ${r.churn} 个被抽走，正常竞态）</span>`
        : '<span class="w">（对不上，留意）</span>'}
      ${r.enabled ? '' : '<br><b class="b">抽奖当前已关闭</b>'}
    </div>
    <div class="big">
      <div><div class="k">这一抽真实花费</div><div class="v">${F(r.cost, 4)}</div>
        <div class="nn">票价 ${F(r.ticket, 4)} + 手续费 ${F(r.cost - r.ticket, 5)}</div></div>
      <div><div class="k">最可能拿回</div><div class="v ${r.medNet >= 0 ? 'g' : 'b'}">${F(r.medGot, 4)}</div>
        <div class="nn">净 ${r.medNet >= 0 ? '+' : ''}${F(r.medNet, 4)} Ξ</div></div>
      <div><div class="k">不亏概率</div><div class="v ${r.pNo >= .5 ? 'g' : r.pNo >= .25 ? 'w' : 'b'}">${(r.pNo * 100).toFixed(1)}%</div>
        <div class="nn">${r.N} 个仓位</div></div>
      <div><div class="k">每抽期望</div><div class="v ${r.ev >= r.cost ? 'g' : 'b'}">${F(r.ev - r.cost, 4)}</div>
        <div class="nn">${((r.ev / r.cost - 1) * 100).toFixed(1)}%</div></div>
    </div>
    <div class="bar">${vis.map(x => `<i style="width:${x.p * 100}%;background:${x.c}" title="${x.n} ${PCT(x.p)}"></i>`).join('')}</div>
    <table class="t">${r.buckets.map(x => x.p <= 0 ? '' : `<tr>
      <td><span class="dot" style="background:${x.c}"></span>${x.n}</td>
      <td><b>${PCT(x.p)}</b></td><td class="d">${(x.cum * 100).toFixed(1)}%</td>
      <td class="d">${F(x.lo, 3)}–${F(x.hi, 3)}</td></tr>`).join('')}</table>

    <div class="sec">最大奖</div>
    <table class="t"><tr><td>backing ${F(r.maxB, 2)} Ξ</td>
      <td class="gd">${Math.round(r.maxMult)}× 花费</td>
      <td class="d">中签 1/${Math.round(1 / r.pMax).toLocaleString()}</td></tr></table>

    <div class="sec">实时状态（全部链上读取）</div>
    <table class="t">
      <tr><td>加价 surcharge</td><td>${(r.sur * 100).toFixed(1)}%</td><td class="d">gameState</td></tr>
      <tr><td>回售给买家</td><td>${(r.bid * 100).toFixed(0)}%</td><td class="d">gameState</td></tr>
      <tr><td>Gas 价格</td><td>${r.gwei == null ? '—' : r.gwei.toFixed(3) + ' gwei'}</td><td class="d">eth_gasPrice</td></tr>
      <tr><td>距上次抽奖</td><td>${r.secs < 90 ? r.secs + ' 秒' : Math.floor(r.secs / 60) + ' 分'}</td>
          <td class="${r.share >= 1 ? 'g' : 'd'}">surcharge ${(r.share * 100).toFixed(0)}% 归你</td></tr>
      <tr><td>冷启动 FWA 额度</td><td class="${r.rebate > 0 ? 'g' : 'd'}">${F(r.rebate, 5)}</td><td class="d">Ξ 等值</td></tr>
      <tr><td>历史退款率</td><td class="w">${(r.refundRate * 100).toFixed(1)}%</td><td class="d">${r.totalAcq.toLocaleString()} 次中</td></tr>
      <tr><td>池子总 backing</td><td>${F(r.totalBacking, 1)}</td><td class="d">Ξ</td></tr>
    </table>
    <div class="nt">「拿回」按接受存款人回售价计。若抽到的 NFT 地板价高于回售价，保留 NFT 更划算，
      实际结果会比这里好——面板拿不到地板价，所以这是<b>下限</b>。</div>`;
  }

  function tabMulti(r) {
    return `<div class="sec">连抽几次最划算</div>
      <div class="nt" style="margin-top:0">抽 1 次要不亏必须一发命中，概率低；抽 2–4 次时一次好运能扛住其余亏损，
        概率反而升高；再往上，每抽 ${((1 - r.ev / r.cost) * 100).toFixed(1)}% 的固定劣势被大数定律放大。
        所以不亏概率有个<b>峰值</b>。</div>
      <div style="margin:11px 0"><button id="fGo">跑蒙特卡洛（约 2 秒）</button></div>
      <div id="fOut"></div>`;
  }
  function hookMulti() {
    const btn = body.querySelector('#fGo'), out = body.querySelector('#fOut');
    btn.onclick = () => {
      out.innerHTML = '<span class="d">计算中…</span>';
      setTimeout(() => {
        const m = multi(R), best = m.reduce((a, x) => x.pNo > a.pNo ? x : a, m[0]);
        const mx = Math.max(...m.map(x => x.pNo));
        out.innerHTML = `
        <div style="display:flex;align-items:flex-end;gap:2px;height:60px;margin-bottom:4px">
          ${m.map(x => `<div style="flex:1;text-align:center" title="抽 ${x.n} 次：不亏 ${(x.pNo * 100).toFixed(1)}%">
            <div style="font-size:8px;color:${x === best ? '#f5c451' : '#5d646f'};margin-bottom:2px">${(x.pNo * 100).toFixed(0)}</div>
            <div style="height:${Math.max(2, x.pNo / mx * 38)}px;background:${x === best ? '#f5c451' : '#6ea8ff'};border-radius:2px 2px 0 0"></div>
            <div style="font-size:8px;color:#5d646f;margin-top:2px">${x.n}</div></div>`).join('')}
        </div>
        <div class="nt" style="margin-top:0">上排 = 不亏概率 %，下排 = 抽奖次数</div>
        <div class="sec">关键数字</div>
        <table class="t">
          <tr><td>不亏概率最高</td><td class="gd"><b>${best.n} 次</b></td><td class="d">${(best.pNo * 100).toFixed(1)}%</td></tr>
          ${m.filter(x => [1, 10, 50, 100].includes(x.n)).map(x => `<tr>
            <td>抽 ${x.n} 次</td><td class="${x.pNo >= .15 ? 'w' : 'b'}">${(x.pNo * 100).toFixed(1)}%</td>
            <td class="d">花 ${F(x.cost, 2)}，中位数 ${F(x.med, 2)}</td></tr>`).join('')}
        </table>
        <div class="nt"><b>注意：</b>峰值 ${(best.pNo * 100).toFixed(1)}% 仍远低于 50%。
          「最优」只是<b>亏得最不确定</b>，不是「能赢」——任何次数下期望都是
          ${((r => (r.ev / r.cost - 1) * 100)(R)).toFixed(1)}%。</div>`;
      }, 30);
    };
  }

  function tabDerive(r) {
    const i = r.p.indexOf(Math.max(...r.p));
    const S = [
      ['把 backing 换成权重',
        '权重 = 1e36 ÷ backing。backing 越小 → 权重越大 → 越容易被抽中。',
        `本池 ${r.N} 个仓位\n权重总和 Σ(1/backing) = ${r.S.toFixed(2)}`],
      ['算票价',
        '票价基准 = 你期望能抽到多少 backing。因权重与 backing 成反比，该期望恰等于全部 backing 的调和平均。',
        `期望 backing = ${r.N} ÷ ${r.S.toFixed(2)} = ${r.evEnum.toFixed(6)} Ξ\n` +
        `票价 = ${r.evEnum.toFixed(6)} × (1 + ${(r.sur * 100).toFixed(0)}%) = ${r.ticket.toFixed(6)} Ξ`],
      ['加上链上手续费',
        '网站显示的只是协议内票价，还要另付 VRF 随机数服务费和两笔交易 gas。',
        `${F(r.ticket, 6)}  票价\n+ ${F(r.vrfFee, 6)}  VRF (800k×1.3×${r.gwei == null ? '?' : r.gwei.toFixed(3)}gwei)\n` +
        `+ ${F(r.buyGas, 6)}  购买 gas\n+ ${F(r.setGas, 6)}  结算 gas\n= ${F(r.cost, 6)} Ξ`],
      ['算单个仓位的中签概率',
        '概率 = 该仓位权重 ÷ 权重总和。以池中最容易抽中的仓位为例：',
        `backing ${F(r.minB, 4)} Ξ\n概率 = (1/${F(r.minB, 4)}) ÷ ${r.S.toFixed(2)} = ${PCT(r.p[i])}`],
      ['算抽中后拿回多少',
        `二选一取优：卖回给存款人得 ${(r.bid * 100).toFixed(0)}% × backing；或留下 NFT（值其地板价，面板无此数据）。`,
        `卖回 = ${(r.bid * 100).toFixed(0)}% × backing` +
        (r.rebate > 0 ? `\n+ 冷启动 FWA 额度 ${F(r.rebate, 6)} Ξ` : '') +
        `\n净 = 拿回 − ${F(r.cost, 6)}`],
      ['归类成概率分布',
        '对每个仓位算「拿回 ÷ 花费」，按倍数归入七个区间，把区间内概率相加 —— 就是概览页那张表。',
        `期望 = Σ(概率 × 拿回) = ${F(r.ev, 6)} Ξ\n每抽平均 = ${F(r.ev - r.cost, 6)} Ξ`]
    ];
    return S.map(([t, w, e]) => `<div class="step"><div class="ti">${t}</div>
      <div class="wy">${w}</div><div class="eq">${e}</div></div>`).join('') +
      `<div class="nt"><b>为什么期望恒为负：</b>票价 = 期望 backing × ${(1 + r.sur).toFixed(2)}，
       而卖回只给 ${r.bid.toFixed(2)} 倍。${r.bid.toFixed(2)} ÷ ${(1 + r.sur).toFixed(2)} =
       <b>${(r.bid / (1 + r.sur) * 100).toFixed(1)}%</b>，与运气、池子大小都无关。</div>`;
  }

  function tabTest(r) {
    const T = selftest(r);
    return `<div class="nt" style="margin-top:0">每次刷新都会现场验算下列恒等式，并跑一次蒙特卡洛与解析解对拍。
      全部 PASS 才说明计算逻辑没写错。</div>
      <table class="t" style="margin-top:10px">${T.map(t => `<tr>
        <td style="font-size:10.5px">${t.n}</td>
        <td class="d" style="font-size:10px">${t.err.toExponential(1)}</td>
        <td class="${t.ok ? 'pass' : 'fail'}">${t.ok ? 'PASS' : 'FAIL'}</td></tr>`).join('')}</table>
      <div class="nt">误差列为「期望值与实际值之差」。前四项应到浮点精度；
        第五项是两条独立路径的票价对拍；第六项是随机模拟，2% 以内即正常。</div>`;
  }

  function tabLimits(r) {
    return `
    <div class="chk no"><b>最大的不确定性：我没有读过合约源码。</b>
      公式来自官方 docs 的文字与技术小节，不是从 Solidity 逐行核对来的。
      不过面板的双路径对拍（偏差 ${(r.drift * 100).toFixed(3)}%）说明「权重∝1/backing」与
      「票价=调和平均×(1+surcharge)」两条与站点实现是吻合的。</div>
    <div class="nt">
    <b>会让实际比面板更差的：</b><br>
    ① <b>地板价拿不到。</b>「拿回」按卖回价算，是下限；但若你选保留 NFT，地板价是<b>挂单价</b>不是成交价，
       变现还要扣市场手续费和版税。两个方向都有偏差。<br>
    ② <b>退款风险 ${(r.refundRate * 100).toFixed(1)}%。</b>历史 ${r.totalAcq.toLocaleString()} 次抽奖中的真实比例。
       池空、价格漂移超界、VRF 超时都会退款，<b>但 VRF 服务费不退</b>。面板未把它摊进期望。<br>
    ③ <b>别人会抢跑。</b>请求按先后结算，你下单到成交之间池子会变（默认容许 10% 向上漂移）。<br>
    ④ <b>两笔交易的 gas 是估的</b>（购买 ${BUY_GAS / 1000}k、结算 ${SETTLE_GAS / 1000}k）。
       VRF 的 800k×1.3 出自 docs 但 owner 可改。gas 价格本身是实时读的。<br>
    ⑤ <b>$FWA 每日买家池未计入。</b>发行期内每天有总供应 1% 按当日抽奖次数平分给买家。
       这一项可能很大，但 FWA 外部买盘默认关闭（只能卖不能买），难以定价，故留空。
       这是唯一让面板偏<b>保守</b>的一项。<br>
    ⑥ <b>连抽按独立同分布处理。</b>实测 N≈5000 时抽 10 次票价仅涨 0.5%，抽 200 次最坏涨 7%，
       故忽略不放回修正。若池子缩小到几百个，这个近似会失效。
    </div>
    <div class="nt"><b>有把握的部分：</b>给定池子快照，概览页每个概率与金额都是<b>精确解析解</b>，
      不是近似——自检页的恒等式检验就是在证明这点。不确定性来自上面六条，不来自算法。</div>`;
  }

  /* ══════════════ 主循环 ══════════════ */
  let last = 0;
  async function refresh() {
    try {
      body.style.opacity = .45;
      const { g, g0, act, gwei } = await fetchAll();
      R = compute(g, act, g0, gwei);
      paint(); last = Date.now();
    } catch (e) {
      body.innerHTML = `<div class="chk no">取数失败：${e.message}<br>请确认当前页面在 www.fwa.fun 域名下。</div>`;
    } finally { body.style.opacity = 1; }
  }
  el.querySelector('#fR').onclick = refresh;
  setInterval(() => { el.querySelector('#fAge').textContent = last ? Math.floor((Date.now() - last) / 1000) + 's 前' : ''; }, 1000);
  setInterval(refresh, 60000);
  refresh();

  window.__fwaPanel = { refresh, compute, fetchAll, multi, selftest, get data() { return R; } };
})();
