"""经典择时策略（现货只做多：仓位 1 = 满仓，0 = 空仓）。

每个函数只用到当根及以前的收盘价，返回每根 K 线收盘时的目标仓位。
"""

from __future__ import annotations

import numpy as np
import pandas as pd


def buy_hold(close: pd.Series) -> pd.Series:
    return pd.Series(1.0, index=close.index)


def tsmom(close: pd.Series, lookback: int) -> pd.Series:
    """时间序列动量：过去 lookback 根收益为正则持有。"""
    return (close.pct_change(lookback) > 0).astype(float)


def sma_cross(close: pd.Series, fast: int, slow: int) -> pd.Series:
    """均线交叉：快线在慢线上方持有。"""
    ok = close.rolling(slow).mean().notna()
    return ((close.rolling(fast).mean() > close.rolling(slow).mean()) & ok).astype(float)


def trend_sma(close: pd.Series, n: int) -> pd.Series:
    """趋势过滤：收盘价在 n 均线上方持有。"""
    return (close > close.rolling(n).mean()).astype(float)


def _stateful(enter: pd.Series, exit_: pd.Series) -> pd.Series:
    pos = np.zeros(len(enter))
    held = 0.0
    for i, (e, x) in enumerate(zip(enter.to_numpy(), exit_.to_numpy())):
        if held == 0 and e:
            held = 1.0
        elif held == 1 and x:
            held = 0.0
        pos[i] = held
    return pd.Series(pos, index=enter.index)


def donchian(close: pd.Series, entry: int, exit: int) -> pd.Series:
    """唐奇安通道突破（海龟）：创 entry 根新高买入，跌破 exit 根新低卖出。"""
    hi = close.shift(1).rolling(entry).max()
    lo = close.shift(1).rolling(exit).min()
    return _stateful(close > hi, close < lo)


def rsi(close: pd.Series, n: int = 14) -> pd.Series:
    delta = close.diff()
    up = delta.clip(lower=0).ewm(alpha=1 / n, adjust=False).mean()
    down = (-delta.clip(upper=0)).ewm(alpha=1 / n, adjust=False).mean()
    return 100 - 100 / (1 + up / down)


def rsi_reversion(close: pd.Series, n: int, low: float, high: float) -> pd.Series:
    """RSI 均值回归：RSI 低于 low 买入，高于 high 卖出。"""
    r = rsi(close, n)
    return _stateful(r < low, r > high)


def bollinger_reversion(close: pd.Series, n: int, k: float) -> pd.Series:
    """布林带均值回归：跌破下轨买入，回到中轨卖出。"""
    mid = close.rolling(n).mean()
    sd = close.rolling(n).std()
    return _stateful(close < mid - k * sd, close > mid)


# 各周期的参数网格。日线以“天”为单位，周线以“周”为单位。
PARAM_GRIDS: dict[str, dict[str, tuple]] = {
    "D": {
        "tsmom": (tsmom, [dict(lookback=n) for n in (20, 60, 90, 120, 180, 250)]),
        "sma_cross": (sma_cross, [dict(fast=f, slow=s) for f, s in
                                  ((10, 30), (20, 60), (20, 100), (50, 100), (50, 200))]),
        "trend_sma": (trend_sma, [dict(n=n) for n in (20, 50, 100, 150, 200)]),
        "donchian": (donchian, [dict(entry=e, exit=x) for e, x in
                                ((20, 10), (55, 20), (100, 50), (200, 100))]),
        "rsi_reversion": (rsi_reversion, [dict(n=14, low=lo, high=hi) for lo, hi in
                                          ((30, 50), (30, 70), (25, 60), (20, 50))]),
        "bollinger_reversion": (bollinger_reversion, [dict(n=n, k=k) for n, k in
                                                      ((20, 2.0), (20, 2.5), (50, 2.0))]),
    },
    "W": {
        "tsmom": (tsmom, [dict(lookback=n) for n in (4, 8, 13, 26, 52)]),
        "sma_cross": (sma_cross, [dict(fast=f, slow=s) for f, s in
                                  ((4, 12), (5, 20), (10, 30), (10, 40))]),
        "trend_sma": (trend_sma, [dict(n=n) for n in (10, 20, 30, 40)]),
        "donchian": (donchian, [dict(entry=e, exit=x) for e, x in
                                ((4, 2), (8, 4), (13, 8), (26, 13))]),
        "rsi_reversion": (rsi_reversion, [dict(n=14, low=lo, high=hi) for lo, hi in
                                          ((30, 50), (30, 70), (40, 60))]),
        "bollinger_reversion": (bollinger_reversion, [dict(n=n, k=k) for n, k in
                                                      ((20, 2.0), (20, 1.5), (10, 2.0))]),
    },
}


def run_positions(
    close: pd.Series, pos: pd.Series, capital: float = 10_000.0, fee_rate: float = 0.001,
    lag: int = 0,
) -> pd.Series:
    """按目标仓位回测，返回权益曲线。

    第 t 根收盘时算出信号并在该收盘价成交（lag=1 表示晚一根 K 线才成交），
    持仓赚取下一根的涨跌；仓位每变化 1 个单位收取 fee_rate 手续费。
    首根 K 线视为空仓起步。
    """
    held = pos.shift(1 + lag).fillna(0.0).clip(0, 1)
    held.iloc[0] = 0.0
    ret = close.pct_change().fillna(0.0)
    cost = held.diff().abs().fillna(0.0) * fee_rate
    return (capital * ((1 - cost) * (1 + held * ret)).cumprod()).rename("equity")
