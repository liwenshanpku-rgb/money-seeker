# money-seeker

虚拟币日线数据拉取 + 现货网格策略回测的最小 Python 骨架。输出收益曲线图、夏普比率等指标，并与「买入持有」做对比。

## 目录结构

```
money_seeker/
  data.py       # Binance 日线（自动分页）、Coin Metrics 收盘价、CSV 缓存、周线聚合、模拟数据
  strategy.py   # 网格策略回测 + 买入持有基准
  signals.py    # 动量 / 均线 / 突破 / 均值回归等择时信号 + 按仓位回测
  research.py   # 多策略样本内选参、样本外检验、跨币种验证
  universe.py   # 多币种验证周线动量：逐币、安慰剂检验、等权组合
  rotation.py   # 横截面动量轮动：组合回测引擎、参数扫描、随机选币安慰剂
  funding.py    # 资金费率：期现套利、资金费率择时
  onchain.py    # 链上数据：MVRV、Puell、算力、交易所余额、活跃地址
  carry.py      # 期现套利细化：新数据、账户模式、杠杆与强平、基差、轮动
  btc_overlay.py # BTC 持仓增强：合成多头、备兑看涨、部分趋势仓位
  metrics.py    # 夏普比率、最大回撤、年化收益/波动
  plot.py       # 收益曲线图（matplotlib）
  cli.py        # 命令行入口
tests/          # pytest 单元测试
reports/        # 研究报告与图表
```

## 安装

需要 Python 3.10+。

```bash
python -m venv .venv
source .venv/bin/activate          # Windows: .venv\Scripts\activate
pip install -r requirements-dev.txt   # 只跑回测可用 requirements.txt
```

## 运行

### 1. 离线演示（不需要联网）

```bash
python -m money_seeker backtest --demo
```

用几何布朗运动生成两年的模拟日线跑一遍，结果写到 `output/`。

### 2. 拉真实数据并回测

```bash
# 只拉数据，保存到 data/BTCUSDT_1d.csv
python -m money_seeker fetch --symbol BTCUSDT --start 2022-01-01

# 回测（本地没有缓存或缓存不够时会自动拉取）
python -m money_seeker backtest --symbol BTCUSDT --start 2023-01-01 \
    --lower 20000 --upper 80000 --grids 30 --geometric
```

数据来自 Binance 公共行情接口（`data-api.binance.vision`，主站 `api.binance.com` 作备用），无需 API Key。
所在网络访问不了 Binance 时，可以自己准备 CSV：

```bash
python -m money_seeker backtest --csv path/to/ETHUSDT.csv
```

CSV 需要包含 `date,open,high,low,close` 列（`volume` 可选）。

### 常用参数

| 参数 | 默认值 | 说明 |
| --- | --- | --- |
| `--symbol` | `BTCUSDT` | Binance 交易对 |
| `--start` / `--end` | `2023-01-01` / 昨天 | 回测区间 |
| `--lower` / `--upper` | 首日开盘价 ±`--range-pct` | 网格上下沿 |
| `--range-pct` | `0.3` | 未指定上下沿时的区间宽度 |
| `--grids` | `20` | 网格数量 |
| `--geometric` | 关 | 等比网格（默认等差） |
| `--capital` | `10000` | 初始资金（USDT） |
| `--fee` | `0.001` | 单边手续费率 |
| `--risk-free` | `0` | 年化无风险利率，用于夏普比率 |
| `--out-dir` | `output` | 输出目录 |
| `--refresh` | 关 | 忽略缓存重新拉数据 |

`python -m money_seeker backtest -h` 查看全部参数。也可以 `pip install -e .` 后直接用 `money-seeker backtest ...`。

### 输出

终端会打印网格策略和买入持有的指标（总收益、年化收益、年化波动、夏普比率、最大回撤、成交笔数），`output/` 下生成：

- `<SYMBOL>_equity.png`：收益曲线（上）与价格、网格区间（下）
- `<SYMBOL>_equity.csv`：每日权益（网格 vs 买入持有）
- `<SYMBOL>_trades.csv`：成交明细
- `<SYMBOL>_stats.json`：参数和指标

## 策略与指标说明

**网格规则**（只做多现货，不加杠杆）：

- 在 `[lower, upper]` 划 `n` 个格子，每格分到同样的资金。格子下沿是买入价，上沿是卖出价。
- 开仓时，开盘价上方的格子直接按开盘价买入（之后价格上涨有币可卖），下方的格子挂买单等成交。
- 价格向下穿过空仓格的下沿就买入，向上穿过持仓格的上沿就卖出，每次成交都扣手续费。
- 价格跑出区间后不再成交，持仓随行情浮动。

**日线内路径假设**：日线看不到盘中先到高点还是低点，这里假设阳线走 `开 → 低 → 高 → 收`，阴线走 `开 → 高 → 低 → 收`。这会让日内来回震荡的成交被低估或高估，想要更精确就换成小时线或分钟线。

**指标**：加密货币全年交易，年化按 365 天。

- 夏普比率 = 日超额收益均值 / 日超额收益标准差 × √365
- 最大回撤 = 权益相对历史最高点的最大跌幅

### 3. 多策略研究（样本内选参 → 样本外检验）

```bash
python -m money_seeker research --out-dir reports
```

使用 Coin Metrics 公开的每日收盘价（托管在 GitHub，无需 API Key），比较网格、时间序列动量、均线交叉、趋势过滤、唐奇安突破、RSI 回归、布林带回归七类策略，日线和周线两个周期都跑。
流程是：在 BTC 2016–2021 上选参数，在 2022 年至今的 BTC 上检验，再把同一组参数搬到 ETH 上验证。
结论和图表见 [`reports/README.md`](reports/README.md)。

### 4. 多币种验证周线动量

```bash
python -m money_seeker universe --out-dir reports
```

参数固定为周线 4 周动量，在另外 23 个币上逐币对比买入持有，同时做安慰剂检验（循环平移仓位、打乱择时）和等权组合回测。
结论见 [`reports/universe.md`](reports/universe.md)：**多币种上没有通过**，它更适合作为减小回撤的风控层，而不是收益来源。

### 5. 横截面动量轮动

```bash
python -m money_seeker rotation --universe 42 --out-dir reports            # 42 个币（含崩盘币）
python -m money_seeker rotation --universe 25 --exclude zec --out-dir reports
```

每周持有过去 L 周涨幅前 K 名的币。在样本内选参数、样本外检验，并用随机选币做安慰剂对照。
结论见 [`reports/rotation.md`](reports/rotation.md)：**样本外失败**。在幸存者偏差更小的 42 币池上亏 62%，54 组参数里只有 2 组盈利。

### 6. 资金费率策略

```bash
python -m money_seeker funding --out-dir reports
```

数据为 BTC、ETH 永续合约在 Binance / Bybit / Gate 上 2020–2023 年的 8 小时资金费率（GitHub 公开数据）。测试了两类策略：期现套利（常开 / 条件开关）和资金费率择时。
结论见 [`reports/funding.md`](reports/funding.md)：
- **常开期现套利每年都赚钱**，但熊市里收益接近美债，主要风险是交易所倒闭和强平；
- 条件开关和资金费率择时都没有带来改进。

### 7. 链上数据策略

```bash
python -m money_seeker onchain --out-dir reports
```

测试了 MVRV、MVRV Z 分数、Puell 倍数、算力带、交易所余额、活跃地址等链上信号。在 BTC 2012–2021 上选参数，2022 年后检验，再搬到 ETH 和另外 32 个币上验证。
结论见 [`reports/onchain.md`](reports/onchain.md)：**没有可靠的盈利策略**。
- 链上活动类信号样本外失败；
- MVRV 类估值信号事后很漂亮，但样本外只有 1 笔交易，而且周期顶部在逐轮降低，固定卖出阈值已经失效。

### 8. 期现套利细化（含 2025–2026 数据）

```bash
python -m money_seeker carry --out-dir reports
```

补上 2025-08 ~ 2026-10 的 Binance / Bybit / Hyperliquid 资金费率（GitHub 公开数据），并细化以下几项：手续费与滑点、统一账户和分账户的资金利用率、空单强平风险、基差、各币横截面与轮动，与美债对比。
结论见 [`reports/carry.md`](reports/carry.md)：**2026 年 BTC/ETH 期现套利扣成本后年化约 1–2%，低于美债的 3.6–3.9%**；换山寨币或轮动更差。
2024-01 ~ 2025-08 没有可用的公开数据。

### 9. 持有 BTC 时的增强操作

```bash
python -m money_seeker btc --out-dir reports
```

在保留 BTC 上涨敞口的前提下，比较三种做法：现货 vs 合成多头（美债 + 永续多单）、备兑看涨（模型估算）、部分趋势仓位（核心仓位 + 200 日均线）。
结论见 [`reports/btc.md`](reports/btc.md)：
- **“50% 核心 + 50% 跟随 200 日均线”** 在 2014–2026 年年化 57.6%（买入持有 48.7%），回撤更小；但在 V 型反弹和持续牛市里会少赚；
- 合成多头基本没有超额；
- 备兑看涨长期跑输。

## 测试

```bash
python -m pytest
```

## 注意

本项目仅用于学习和研究，回测结果不代表未来收益，也不构成投资建议。回测没有考虑滑点、挂单排队、交易所最小下单量等实盘因素。
