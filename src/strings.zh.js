{
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
    progScan: (f, n, s) => '扫描槽位 ' + f + '/' + n + '（已扫到第 ' + s + ' 号）',
    updated: (t, b, p) => '更新于 ' + t + ' · 区块 ' + b + ' · 枚举 ' + (p.ms / 1000).toFixed(1) + 's' + (p.mode === 'full' ? '（全量）' : ''),

    poolPending: '正在从链上枚举全池（首次约 30–40 秒，之后约 10 秒）。档位分布、不亏概率和连抽会在完成后出现。',
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
      '<code>listings(id)</code> 给出 weight、backing 和状态。调用经 Multicall3 打包、走站点自己的 /api/rpc，' +
      '所有读取钉在<b>同一个区块</b>。之后只重读已知 id 和新建 id（约 10 秒），对账不通过就自动回退全量扫描。',
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
}
