# FWA Odds Panel

A userscript that computes live odds for [fwa.fun](https://www.fwa.fun) inside the page itself: the true all-in cost of one pull, the full outcome distribution, and how many pulls is actually optimal.

It reads the site's own API, so the numbers match the official UI by construction. It cross-checks the ticket price via two independent paths and shows a red warning if they disagree.

**[English](#english) · [中文](#中文)**

---

<a name="english"></a>
## English

### Install

**Tampermonkey (recommended)** — install [Tampermonkey](https://www.tampermonkey.net/), then Dashboard → **+** (new script) → paste the contents of **[`fwa-odds-panel.en.user.js`](fwa-odds-panel.en.user.js)** → Ctrl+S. The panel appears automatically whenever you open fwa.fun.

**One-off** — on fwa.fun press F12 → Console → paste the same file → Enter.

> Chinese speakers: use [`fwa-odds-panel.zh.user.js`](fwa-odds-panel.zh.user.js) instead. The two files are functionally identical; only the interface language differs.

### What it shows

Five tabs:

| Tab | Contents |
|---|---|
| **Overview** | True cost per pull, most likely return, chance of not losing, expected value, plus a seven-bucket outcome distribution and live protocol state |
| **Multi-pull** | Monte Carlo curve of "chance of not losing" vs number of pulls, with the peak marked |
| **Method** | Six-step derivation with the current live numbers substituted in, so you can check it by hand |
| **Self-test** | Six identity checks re-run on every refresh, each showing PASS/FAIL and the numeric error |
| **Limits** | What this tool cannot tell you (read this one) |

The panel is draggable, collapsible, and auto-refreshes every 60 seconds.

### Why the numbers match fwa.fun

1. **Same data source.** It calls the site's own `/api/ponder` and `/api/rpc` — same origin, same headers, same endpoints the official UI uses.
2. **Nothing hardcoded.** Every protocol parameter (surcharge, settlement discount, `hotGap`, `coldGap`, whether acquisitions are enabled) is read live from `gameState` on each refresh. If the owner changes a parameter, the panel follows.
3. **Live gas.** Gas price comes from `eth_gasPrice`, not an estimate.
4. **Dual-path cross-check.** The ticket price is computed twice by unrelated routes:

   ```
   Path A (contract view):  weightedBackingTotal / totalActiveWeight × (1 + surcharge)
   Path B (enumeration):    N / Σ(1/backing)                        × (1 + surcharge)
   ```

   Agreement proves not one of the 7000+ listings was missed during pagination. Disagreement triggers a red alert. In testing the drift is consistently 0.0000%.

### The core finding

Expected return is a fixed identity, not a variable:

```
ticket price = expected backing × 1.10
sell-back    = backing × 0.85
              0.85 / 1.10 = 77.3%
```

This holds regardless of pool size, pool composition, or when you pull. The only paths above it are keeping an NFT whose floor exceeds its backing (roughly 5% of settlements in practice) and the cold-start FWA credit, which caps the figure at **86.3%** — still below break-even.

The "Multi-pull" tab surfaces a less obvious result: the chance of *not losing* peaks at around 3 pulls, then declines monotonically. Optimal means **most uncertain**, not profitable.

### Limitations

The panel's own **Limits** tab spells these out at runtime with live numbers. In short:

- **I have not read the contract source.** The formulas come from the prose and technical notes in the official docs, not a line-by-line reading of the Solidity. The dual-path cross-check does confirm that weighting and pricing match the live implementation, but that is not the same as auditing the code.
- **No floor-price feed.** "Return" uses the sell-back bid, a lower bound. If you keep the NFT instead, note that a floor is an ask, not a fill.
- **Refund risk is not amortised** into expected value. Historically around 7% of pulls refund; the VRF service fee is not returned on those.
- **Two gas figures are estimates** (purchase and settlement). The VRF 800k × 1.3 comes from the docs but the owner can change it.
- **The daily $FWA purchaser pot is excluded** — hard to price while external buys are disabled. This is the one omission that makes the panel conservative.
- **Multi-pull assumes i.i.d. draws.** Valid at current pool size; breaks down if the pool shrinks to a few hundred listings.

For a given pool snapshot, every probability and amount on the Overview tab is an exact analytic solution, not an approximation. The uncertainty lives in the items above, not in the maths.

### Notes

Reads only. The script never requests wallet access, signs anything, or sends data anywhere. It runs entirely in your browser.

The indexer occasionally returns `504 Indexer request timed out`; the script retries with backoff and reports a readable message if it still fails.

Research tool, not investment advice.

---

<a name="中文"></a>
## 中文

### 安装

**油猴（推荐）**——装好 [Tampermonkey](https://www.tampermonkey.net/)，打开管理面板 → **+**（新建脚本）→ 粘贴 **[`fwa-odds-panel.zh.user.js`](fwa-odds-panel.zh.user.js)** 的全部内容 → Ctrl+S。之后每次打开 fwa.fun，面板自动出现。

**临时用**——在 fwa.fun 页面按 F12 → Console → 粘贴同一个文件 → 回车。

> 要英文界面就用 [`fwa-odds-panel.en.user.js`](fwa-odds-panel.en.user.js)。两个文件功能完全一致，只有界面语言不同。

### 面板内容

五个页签：

| 页签 | 内容 |
|---|---|
| **概览** | 这一抽的真实花费、最可能拿回多少、不亏概率、每抽期望，外加七档结果分布和实时协议状态 |
| **连抽** | 蒙特卡洛跑出的「不亏概率 vs 抽奖次数」曲线，峰值标金色 |
| **原理** | 六步推导，每步代入当下的真实数字，你可以拿计算器复核 |
| **自检** | 六项恒等式检验，每次刷新现场重跑，显示 PASS/FAIL 和数值误差 |
| **局限** | 这个工具算不出来的东西（建议先读这页） |

面板可拖动、可折叠，每 60 秒自动刷新。

### 为什么数据一定和 fwa.fun 一致

1. **同一个数据源。**走站点自己的 `/api/ponder` 与 `/api/rpc`，与官方 UI 同源、同 header、同接口。
2. **没有硬编码。**所有协议参数（surcharge、回售折价、`hotGap`、`coldGap`、是否开放抽奖）每次刷新都从 `gameState` 实时读取。owner 改参数，面板跟着变。
3. **Gas 实时读。**取自 `eth_gasPrice`，不靠估算。
4. **双路径交叉验证。**票价用两条互不相干的路径各算一次：

   ```
   路径 A（合约口径）：weightedBackingTotal / totalActiveWeight × (1 + surcharge)
   路径 B（枚举口径）：N / Σ(1/backing)                        × (1 + surcharge)
   ```

   两者一致，就证明翻页过程中 7000 多个仓位一条没漏；不一致则红色告警。实测偏差稳定在 0.0000%。

### 核心结论

期望回报是个恒等式，不是变量：

```
票价   = 期望 backing × 1.10
卖回去 = backing × 0.85
        0.85 / 1.10 = 77.3%
```

这个数与池子大小、池子构成、什么时候抽全都无关。能高过它的路只有两条：抽到地板价高于押金的 NFT 并选择留下（实际只有约 5% 的结算走这条路），以及冷启动的 FWA 额度——后者把上限抬到 **86.3%**，仍然不到打平。

「连抽」页签会给出一个不那么直观的结果：**不亏概率在 3 次左右见顶**，之后单调下滑。所谓「最优」，指的是**亏得最不确定**，不是能赢。

### 局限

面板的**局限**页签会在运行时带着实时数字逐条列出。简要说：

- **我没有读过合约源码。**公式来自官方 docs 的文字与技术小节，不是从 Solidity 逐行核对来的。双路径对拍确实证明了权重与定价和线上实现吻合，但这不等于审计过代码。
- **拿不到地板价。**「拿回」按卖回价计，是下限。若你选择留下 NFT，注意地板价是挂单价，不是成交价。
- **退款风险未摊进期望。**历史上约 7% 的抽奖会退款，且这些情况下 VRF 服务费不退。
- **两笔交易的 gas 是估算**（购买与结算）。VRF 的 800k × 1.3 出自 docs，但 owner 可改。
- **每日 $FWA 买家池未计入**——外部买盘关闭期间难以定价。这是唯一让面板偏保守的一项。
- **连抽按独立同分布处理。**当前池子规模下成立；若池子缩到几百个仓位，这个近似会失效。

给定池子快照，概览页上每个概率和金额都是**精确解析解**，不是近似。不确定性来自上面这几条，不来自算法本身。

### 说明

只读。脚本从不请求钱包授权、不签名、不外发任何数据，全部在你的浏览器里运行。

索引器偶尔会返回 `504 Indexer request timed out`，脚本会自动退避重试，若仍失败则给出可读的提示。

仅供研究，不构成投资建议。

---

## License

MIT — see [LICENSE](LICENSE).

Not affiliated with TokenWorks or fwa.fun.
