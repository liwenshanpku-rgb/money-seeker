"""现货网格策略回测（只做多，不加杠杆）。

规则：
- 在 [lower, upper] 之间划 n_grids 个格子（等差或等比），共 n_grids + 1 条价格线。
- 每格分配相同的计价币资金 per_grid；格子 i 的下沿是买入价、上沿是卖出价。
- 开仓时，当前价下方的格子挂买单（空仓），上方的格子按开盘价直接买入（持仓），
  这样价格上涨时有币可卖。
- 日线内部路径假设：阳线 open -> low -> high -> close，阴线 open -> high -> low -> close。
  价格向下穿过空仓格的下沿则买入，向上穿过持仓格的上沿则卖出。
- 价格跑出区间后不再成交（网格“破网”），持仓随行情浮动。
"""

from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np
import pandas as pd


@dataclass
class GridConfig:
    lower: float
    upper: float
    n_grids: int = 20
    capital: float = 10_000.0
    fee_rate: float = 0.001  # 单边手续费，Binance 现货默认 0.1%
    geometric: bool = False

    def __post_init__(self) -> None:
        if not 0 < self.lower < self.upper:
            raise ValueError("需要满足 0 < lower < upper")
        if self.n_grids < 1:
            raise ValueError("n_grids 至少为 1")
        if self.capital <= 0:
            raise ValueError("capital 必须为正")
        if not 0 <= self.fee_rate < 0.1:
            raise ValueError("fee_rate 需在 [0, 0.1) 内")

    def levels(self) -> np.ndarray:
        if self.geometric:
            return np.geomspace(self.lower, self.upper, self.n_grids + 1)
        return np.linspace(self.lower, self.upper, self.n_grids + 1)


@dataclass
class BacktestResult:
    equity: pd.Series  # 每日收盘权益（计价币）
    trades: pd.DataFrame  # 成交明细
    config: GridConfig
    stats: dict = field(default_factory=dict)


def _bar_path(o: float, h: float, l: float, c: float) -> list[float]:
    return [o, l, h, c] if c >= o else [o, h, l, c]


def run_grid_backtest(df: pd.DataFrame, config: GridConfig) -> BacktestResult:
    if df.empty:
        raise ValueError("行情数据为空")
    levels = config.levels()
    n = config.n_grids
    fee = config.fee_rate
    # 预留手续费，保证全部格子都能买入时现金不为负
    per_grid = config.capital / (n * (1 + fee))
    qty = per_grid / levels[:-1]  # 每格固定的币数量，以买入价计
    holding = np.zeros(n, dtype=bool)

    cash = config.capital
    base = 0.0
    trades: list[dict] = []

    def trade(date, side: str, i: int, price: float) -> None:
        nonlocal cash, base
        notional = qty[i] * price
        if side == "buy":
            cash -= notional * (1 + fee)
            base += qty[i]
        else:
            cash += notional * (1 - fee)
            base -= qty[i]
        holding[i] = side == "buy"
        trades.append(
            {"date": date, "side": side, "grid": i, "price": price,
             "qty": qty[i], "fee": notional * fee}
        )

    first_date = df.index[0]
    p0 = float(df["open"].iloc[0])
    for i in range(n):
        if levels[i] > p0:  # 当前价上方的格子：开盘直接买入
            trade(first_date, "buy", i, p0)

    equity = np.empty(len(df))
    bars = df[["open", "high", "low", "close"]].to_numpy(dtype=float)
    for t, (date, (o, h, l, c)) in enumerate(zip(df.index, bars)):
        path = _bar_path(o, h, l, c)
        for a, b in zip(path[:-1], path[1:]):
            if b < a:  # 下跌段：从高到低依次触发买单
                for i in range(n - 1, -1, -1):
                    if not holding[i] and b <= levels[i] < a:
                        trade(date, "buy", i, levels[i])
            elif b > a:  # 上涨段：从低到高依次触发卖单
                for i in range(n):
                    if holding[i] and a < levels[i + 1] <= b:
                        trade(date, "sell", i, levels[i + 1])
        equity[t] = cash + base * c

    trades_df = pd.DataFrame(
        trades, columns=["date", "side", "grid", "price", "qty", "fee"]
    )
    return BacktestResult(
        equity=pd.Series(equity, index=df.index, name="equity"),
        trades=trades_df,
        config=config,
    )


def buy_and_hold(df: pd.DataFrame, capital: float, fee_rate: float = 0.001) -> pd.Series:
    """基准：第一天开盘全仓买入并持有。"""
    units = capital * (1 - fee_rate) / float(df["open"].iloc[0])
    return (df["close"] * units).rename("buy_and_hold")
