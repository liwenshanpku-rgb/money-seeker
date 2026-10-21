# 公开信号文件 `signal/latest.json`

给本地下单程序（例如 schwab 项目）读的**唯一**接口。GitHub Actions 每天 00:45 UTC（北京时间 08:45）生成，
提交到 `ai-journal` 分支：

- 最新：<https://raw.githubusercontent.com/liwenshanpku-rgb/money-seeker/ai-journal/signal/latest.json>
- 历史（每天一行）：`signal/history.jsonl`，在同一分支

只包含行情推导出来的信号，**没有余额、净值、下单数量**（仓库是公开的）。下单数量由本地程序用自己读到的
Kraken 余额算：`目标 BTC 数量 = 净值 × target_pct / 100 / price`。

## 三个可选信号

| 来源 | 含义 | 取值 |
|---|---|---|
| `plan_b` | 方案 B：50% 核心永远持有 + 50% 跟随 200 日均线（±3% 缓冲区），不借款 | 上涨模式 100，下跌模式 50 |
| `plan_c` | 方案 C：方案 B + 上涨模式借入“核心价值 × 50%”的稳定币加仓 | 上涨模式 125，下跌模式 50 |
| `ai` | AI 仓位顾问（每周一更新，目前是模拟盘验证期） | 0–150 |

`target_pct` 统一表示 **BTC 市值 / 净值 × 100**（净值 = BTC 市值 + 现金 − 借款）。大于 100 表示需要借款。

## 字段

```json
{
  "schema_version": 1,                       // 结构有不兼容变化时才加 1；读取程序遇到不认识的版本必须拒绝
  "generated_at": "2026-10-21T00:46:12+00:00",
  "as_of_close_utc": "2026-10-20",           // 基于哪天的日线收盘（= 2026-10-21 00:00 UTC 的价格）
  "price": 108000.0,                         // 该收盘价（Kraken XBTUSD 日线）
  "price_source": "kraken XBTUSD 1d",
  "plan_b": {
    "mode": "UP",                            // UP / DOWN
    "mode_since": "2026-09-30",
    "switched_today": false,                 // true = 今天刚切换，需要调仓
    "target_pct": 100.0,
    "sma": 101500.0, "upper": 104545.0, "lower": 98455.0,
    "distance_to_switch": -0.0884,           // 价格再变动多少会切换（上涨模式为负）
    "params": {"core": 0.5, "sma_days": 200, "band": 0.03}
  },
  "plan_c": {"target_pct": 125.0, "borrow_frac": 0.5},
  "ai": {                                    // 没有 AI 决定时为 null
    "target_pct": 85,
    "as_of_close_utc": "2026-10-19",
    "decided_at": "2026-10-20T00:41:03+00:00",
    "confidence": "low",                     // low / medium / high
    "stance": "……一句话理由……",
    "age_days": 2,
    "stale": false                           // 超过 9 天没更新 = 周更任务失败，不要用
  }
}
```

新增字段不会升级 `schema_version`，读取程序应忽略不认识的字段。

## 读取程序必须做的校验（fail closed）

示例代码：[`examples/read_signal.py`](../examples/read_signal.py)，只依赖 `requests`，可以直接复制。

1. 网络失败、JSON 解析失败、缺字段 → **今天不动**，不要沿用昨天的信号去下单。
2. `schema_version` 不是 1 → 拒绝。
3. `generated_at` 超过 36 小时 → 当天的任务失败了，拒绝（去 Actions 页面看原因）。
4. 数值范围：`plan_b` 0–100，`plan_c`、`ai` 0–150；超出即拒绝。
5. 用 `ai` 时：`stale` 为 true 或 `ai` 为 null → 拒绝。
6. 同一个 `as_of_close_utc` 只执行一次（本地记下上次执行的日期），避免重复下单。
7. 建议本地再加单次变动上限（示例 `limit_step`，默认 25 个百分点）和“干跑开关 + 确认文件”，
   跟 pm-maker 的习惯一致。方案 B 切换时一次就是 50 个百分点，用方案 B 时上限要相应放宽。

方案 B / C 只在 `switched_today` 为 true 那天需要调仓；其他日子当前仓位已经接近目标，程序算出的差额很小，
可以设一个最小交易额（例如净值的 5%）避免来回小额交易。

## 安全

- 只有能往本仓库推送的人（你自己和 GitHub Actions）能改这个文件；读取走 HTTPS。
  如果以后担心 GitHub 账号被盗后被改信号，可以再加 HMAC 签名（密钥放 GitHub Secret 和本地 `.env`），
  当前的数值范围校验 + 单次变动上限已经能限制最坏情况。
- raw.githubusercontent.com 有几分钟缓存，08:50 以后读即可。
