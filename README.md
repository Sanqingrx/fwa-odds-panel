# FWA Odds Panel

A userscript that computes live odds for **fwa.fun V2** inside the page: what one pull really costs, which outcome tier it lands in and how likely each tier is, your chance of not losing, and what a run of pulls adds up to.

The whole pool is read listing by listing from the FWAV2 contract and reconciled **exactly** against the contract's own totals before any distribution is shown.

[English](#english) · [中文](#中文)

---

## English

### Install

**Tampermonkey (recommended)** — install Tampermonkey, then Dashboard → **+** (new script) → paste the contents of `fwa-odds-panel.en.user.js` → Ctrl+S. The panel appears whenever you open fwa.fun.

**One-off** — on fwa.fun press F12 → Console → paste the same file → Enter.

Chinese interface: use `fwa-odds-panel.zh.user.js`. Both files are built from the same source in `src/` and differ only in language.

### What it shows

| Tab | Contents |
| --- | --- |
| **Overview** | Ticket (the contract's own quote), all-in cost, ETH vs FWA settlement side by side: RTP, chance of not losing, median return, expected net |
| **Tiers** | Seven outcome tiers (wipeout → jackpot) with probability bars, listing counts and return ranges; 10/50/90% return quantiles; odds of ≥2×, ≥5×, ≥10× |
| **Multi-pull** | 10,000-run Monte Carlo on the real pool for 1–100 pulls: chance of not losing, median net, 90% range |
| **Method** | Derivation with live numbers, how the pool is read, why the distribution can be trusted |
| **Self-test** | 18 checks re-run on every refresh, each with PASS/FAIL and the numbers behind it |
| **Limits** | What this tool cannot tell you |

Tiers and multi-pull have an ETH / FWA switch. Draggable, collapsible, refreshes every 60 s.

### How the pool is read

The site has no endpoint that lists the pool (that is why v4.0 dropped the distribution). v5.0 reads the contract directly:

```
slotToListing(slot) → listingId     public mapping; slots start at 1 and are reused, so the range has holes
listings(id)        → weight, value (backing), status
```

Calls are batched through Multicall3 over the site's own `/api/rpc`, all pinned to **one block**. The first load walks every slot (about 25–40 s); after that the panel re-reads only the known ids plus newly created ones (about 5–10 s), and falls back to a full scan if that does not reconcile. Known ids are cached in `localStorage`.

### Why the numbers can be trusted

Every enumeration has to pass three exact BigInt checks against the contract at the same block:

```
listings read      == activeListingCount
Σ weight           == totalWeight
Σ weight × backing == weightedBackingTotal      (the contract's _evOf = w·v)
```

If even one listing were missed or misread, the three could not all hold. If they don't, the Tiers tab says so and shows nothing.

The ticket is `quoteAcquisitionPrice().total`, read from the contract — exactly what `acquire()` charges. The panel also recomputes it two other ways (from the aggregates and from the enumerated pool) and checks all three agree.

### The core identity

```
ticket = expected backing × (1 + surcharge)        expected backing = Σ(w·b)/Σw = harmonic mean
payout = backing × buyback rate                     (FWAV2._settleBackingToPurchaser)
RTP    = buyback rate ÷ (1 + surcharge)
```

RTP does not depend on pool size, composition or timing. It depends only on the parameters, which the owner can change — the panel reads them live from the contract. At the time of writing (2026-10-08): surcharge 5%, ETH buyback 90% → RTP **85.71%**, FWA buyback 91.5% → RTP **87.14%**.

What *does* depend on the pool is the **shape**: with inverse weights, small listings are drawn far more often, so the median pull returns well under the ticket while a thin tail of large listings carries the expectation. Measured on the live pool: chance of not losing ≈ 26%, median return ≈ 0.75× cost.

### Changes in v5.0

- **Tier distribution is back**, computed from the full on-chain pool with exact reconciliation.
- **Multi-pull Monte Carlo is back** (v4.0 could only list expected values).
- **Ticket = contract quote.** v4.0 added an estimated self-paid VRF gas (800k × 1.3). In V2 the VRF cost is the on-chain `vrfServiceFee`, already inside the quote, so v4.0 over-counted.
- **Gas calibrated on mainnet**: purchase averages 610k gas over 76 recent single-pull txs; settling to ETH ~175k, to FWA ~300k.
- **On-chain parameters take precedence** over the indexer; a self-test flags any lag between the two.

### Limitations

The Limits tab lists these with live numbers. In short: keeping the NFT is not modelled (no reliable floor price); the FWA route is valued at the ETH spent, before swap slippage; the pool can change between purchase and selection; gas is an estimate; refunds are not amortised; rewards (top-listing pot, epoch $FWA, builder rewards) are excluded, so the panel is conservative; purchases pause daily 11:45–12:00 and 23:45–24:00 UTC.

### Build

```
node src/build.mjs
```

writes `fwa-odds-panel.zh.user.js` and `fwa-odds-panel.en.user.js` from `src/panel.js` and `src/strings.{zh,en}.js`.

### Notes

**Read-only.** No wallet access, no signing, no data sent anywhere except fwa.fun's own endpoints. Research tool, not investment advice.

---

## 中文

### 安装

**油猴（推荐）** —— 装好 Tampermonkey，打开管理面板 → **+**（新建脚本）→ 粘贴 `fwa-odds-panel.zh.user.js` 的全部内容 → Ctrl+S。之后每次打开 fwa.fun，面板自动出现。

**临时用** —— 在 fwa.fun 页面按 F12 → Console → 粘贴同一个文件 → 回车。

要英文界面就用 `fwa-odds-panel.en.user.js`。两个文件由 `src/` 里同一份源码生成，只有界面语言不同。

### 面板内容

| 页签 | 内容 |
| --- | --- |
| **概览** | 票价（合约报价）、全部花费，拿 ETH 和拿 FWA 两种结算并排对比：RTP、不亏概率、中位数拿回、期望净值 |
| **档位分布** | 七档结果（血亏 → 大奖）的概率条形图、各档仓位数和拿回区间；10% / 50% / 90% 落点；拿回 ≥2×、≥5×、≥10× 的概率 |
| **连抽** | 基于真实全池的 1 万轮蒙特卡洛，1–100 连抽的不亏概率、中位净值、90% 区间 |
| **原理** | 代入实时数字的推导、全池怎么读、分布为什么可信 |
| **自检** | 18 项检验，每次刷新现场重跑，显示 PASS/FAIL 和对应数字 |
| **局限** | 这个工具算不出来的东西 |

档位分布和连抽可切换 ETH / FWA 口径。面板可拖动、可折叠，每 60 秒自动刷新。

### 全池是怎么拿到的

网站没有列出全池的接口（v4.0 因此删掉了分布）。v5.0 直接读合约：

```
slotToListing(slot) → 仓位 id        公开 mapping；槽位从 1 开始，释放后复用，中间有空洞
listings(id)        → weight、value（backing）、状态
```

调用经 Multicall3 打包，走站点自己的 `/api/rpc`，全部钉在**同一个区块**。首次加载扫描全部槽位（约 25–40 秒）；之后只重读已知 id 和新建 id（约 5–10 秒），对账不通过就自动回退全量扫描。已知 id 缓存在 `localStorage`。

### 为什么数字可信

每次枚举都要在同一区块与合约通过三项 BigInt 精确对账：

```
读到的仓位数        == activeListingCount
Σ weight            == totalWeight
Σ weight × backing  == weightedBackingTotal      （合约内 _evOf = w·v）
```

只要漏读或读错一条，这三个等式就不可能同时成立。不成立时，档位分布页会直接说明，不显示任何分布。

票价取合约 `quoteAcquisitionPrice().total`，就是 `acquire()` 实际收的钱。面板还用聚合量和枚举结果各算一遍，三者必须一致。

### 核心恒等式

```
票价 = 期望 backing × (1 + 加价)          期望 backing = Σ(w·b)/Σw = 调和均值
回售 = backing × 回售比例                  （FWAV2._settleBackingToPurchaser）
RTP  = 回售比例 ÷ (1 + 加价)
```

RTP 与池子大小、构成、什么时候抽都无关，只由参数决定，而参数 owner 可改——面板每次从合约实时读。写作时（2026-10-08）：加价 5%，拿 ETH 回售 90% → RTP **85.71%**，拿 FWA 回售 91.5% → RTP **87.14%**。

真正取决于池子的是**分布形状**：反比权重下小仓位被抽中的概率高得多，所以中位数那一抽拿回的远低于票价，期望值靠一条很薄的大仓位尾巴撑起来。实测当前池子：不亏概率约 26%，中位数拿回约为花费的 0.75 倍。

### v5.0 改动

- **档位分布回来了**，基于链上全池计算，并经过精确对账。
- **连抽蒙特卡洛回来了**（v4.0 只能列期望值）。
- **票价改用合约报价。** v4.0 额外估了一笔自付 VRF gas（800k × 1.3）。V2 的 VRF 成本是链上的 `vrfServiceFee`，已经含在报价里，v4.0 多算了。
- **gas 按主网实测标定**：近期 76 笔单抽 `acquire` 平均 61 万 gas；结算拿 ETH 约 17.5 万，拿 FWA 约 30 万。
- **链上参数优先于索引器**，两者不一致时自检会标出来。

### 局限

局限页签会带着实时数字逐条列出。简要说：没算「留下 NFT」这条路（拿不到可靠的地板价）；FWA 口径按花掉的 ETH 计，未扣兑换滑点；下单到抽选之间池子可能变化；gas 是估算；退款未摊进期望；奖励（顶部仓位奖池、epoch $FWA、builder 奖励）未计入，因此面板偏保守；每天 UTC 11:45–12:00、23:45–24:00（北京时间 19:45–20:00、7:45–8:00）暂停下单。

### 构建

```
node src/build.mjs
```

由 `src/panel.js` 和 `src/strings.{zh,en}.js` 生成 `fwa-odds-panel.zh.user.js` 与 `fwa-odds-panel.en.user.js`。

### 说明

**只读。** 不请求钱包、不签名，除了 fwa.fun 自己的接口不向任何地方发数据。研究工具，非投资建议。
