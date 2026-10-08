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

Opens on **Tiers** and remembers your last tab and ETH / FWA choice. Draggable, collapsible. Refreshes every 60 s while the browser tab is visible; the previous result stays on screen (scroll position included) until the new one has been verified, so a refresh never interrupts reading.

### How the pool is read

The site has no endpoint that lists the pool (that is why v4.0 dropped the distribution). v5.0 reads the contract directly:

```
slotToListing(slot) → listingId     public mapping; slots start at 1 and are reused, so the range has holes
listings(id)        → weight, value (backing), status
```

To make this fast, the panel sends the init code of a small read-only scanner, [`src/PoolReader.sol`](src/PoolReader.sol), as an `eth_call` with no `to`. The node runs its constructor against live state: it walks every slot, calls `listings()` on each occupied one and reverts with the packed result (revert data, because returned init-code output is capped at 24 KB by EIP-170). Nothing is deployed, signed or paid for. **The whole pool comes back in one call, about 1 s.**

Everything goes through the site's own `/api/rpc`, pinned to **one block**. If the scanner path fails, the panel falls back to batched Multicall3 reads of the same two functions (about 25 s the first time, 5–10 s after that); the result has to pass the same checks either way.

`src/PoolReader.hex` is reproducible: `npm i solc@0.8.26 && node src/compile-reader.cjs` gives the same bytes.

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

### Changes in v5.1

- **Pool read in one call (~1 s instead of 25–40 s)** via the PoolReader scanner; Multicall3 kept as fallback.
- **Refreshes no longer interrupt you**: the last verified view stays up until the new one is ready, scroll position is kept, and auto-refresh pauses while the browser tab is hidden.
- **Opens on the Tiers tab** and remembers the tab and settlement route you last used.

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

writes `fwa-odds-panel.zh.user.js` and `fwa-odds-panel.en.user.js` from `src/panel.js`, `src/strings.{zh,en}.js` and `src/PoolReader.hex`.

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

默认打开**档位分布**，并记住你上次停留的页签和 ETH / FWA 选择。面板可拖动、可折叠。浏览器标签页在前台时每 60 秒刷新一次；新结果对账通过之前，旧结果（连同滚动位置）一直留在屏幕上，刷新不会打断阅读。

### 全池是怎么拿到的

网站没有列出全池的接口（v4.0 因此删掉了分布）。v5.0 直接读合约：

```
slotToListing(slot) → 仓位 id        公开 mapping；槽位从 1 开始，释放后复用，中间有空洞
listings(id)        → weight、value（backing）、状态
```

为了快，面板把一个只读小扫描器 [`src/PoolReader.sol`](src/PoolReader.sol) 的初始化代码当作不带 `to` 的 `eth_call` 发给节点。节点在链上状态里执行它的构造函数：遍历全部槽位，对有仓位的槽位调 `listings()`，再把打包好的结果放在 revert 数据里带回（构造函数正常返回的数据受 EIP-170 的 24KB 上限限制）。不部署合约、不签名、不花钱。**一次调用拿回整个池子，约 1 秒。**

所有读取走站点自己的 `/api/rpc`，钉在**同一个区块**。扫描器这条路走不通时，自动改用 Multicall3 分批读同样两个函数（首次约 25 秒，之后 5–10 秒），结果一样要过对账。

`src/PoolReader.hex` 可复现：`npm i solc@0.8.26 && node src/compile-reader.cjs` 得到相同字节。

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

### v5.1 改动

- **一次调用读完全池（约 1 秒，原来 25–40 秒）**，靠 PoolReader 扫描器；Multicall3 保留为备用通道。
- **刷新不再打断阅读**：新结果就绪前保留上一次已验证的画面和滚动位置；浏览器标签页在后台时暂停自动刷新。
- **默认打开档位分布页**，并记住上次用的页签和结算口径。

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

由 `src/panel.js`、`src/strings.{zh,en}.js` 和 `src/PoolReader.hex` 生成 `fwa-odds-panel.zh.user.js` 与 `fwa-odds-panel.en.user.js`。

### 说明

**只读。** 不请求钱包、不签名，除了 fwa.fun 自己的接口不向任何地方发数据。研究工具，非投资建议。
