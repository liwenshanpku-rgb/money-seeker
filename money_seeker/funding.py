"""资金费率策略。

数据：supervik/historical-funding-rates-fetcher 在 GitHub 上公开的 8 小时资金费率，
BTC、ETH 的 USDT 永续合约，Binance / Bybit / Gate，2020（Bybit 从 2021）~ 2023 年底。

两类策略：
A. 期现套利（cash-and-carry）：买现货 + 等量做空永续，价格涨跌对冲掉，赚资金费。
   资金费率为正时多头付钱给空头，空头收钱；为负时空头付钱。
   - 常开：一直持有；
   - 条件开关：最近 window 次资金费率均值 > enter 时开仓，< exit 时平仓（带滞后，避免频繁切换）。
   只计资金费和手续费，**没有计入**交易所倒闭、强平、开平仓时的基差损益等风险。
B. 资金费率择时（现货只做多）：
   - avoid_overheat：持有现货，但最近 N 天平均资金费率过高（多头拥挤）时空仓；
   - contrarian：只在平均资金费率偏低 / 为负（恐慌）时持有。
"""

from __future__ import annotations

from io import StringIO
from itertools import product
from pathlib import Path

import numpy as np
import pandas as pd
import requests

from .metrics import summarize
from .signals import _stateful, run_positions

FUNDING_URL = (
    "https://raw.githubusercontent.com/supervik/historical-funding-rates-fetcher/main/"
    "data/{coin}-USDT/{coin}-USDT_{exchange}_{start}-01-01_2024-01-01_funding_history.csv"
)
EXCHANGE_START = {"binance": 2020, "bybit": 2021, "gate": 2020}
PER_DAY = 3  # 每 8 小时结算一次


def load_funding(
    coin: str = "BTC", exchange: str = "binance", data_dir: str | Path = "data",
    refresh: bool = False,
) -> pd.Series:
    """8 小时资金费率序列（小数，0.0001 = 0.01%），按结算时间排序。"""
    coin = coin.upper()
    path = Path(data_dir) / f"funding_{coin}_{exchange}.csv"
    if not path.exists() or refresh:
        url = FUNDING_URL.format(coin=coin, exchange=exchange, start=EXCHANGE_START[exchange])
        resp = requests.get(url, timeout=120)
        resp.raise_for_status()
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(resp.text)
    raw = pd.read_csv(path)
    ts = pd.to_datetime(raw["Date"], format="mixed").dt.floor("h")
    rate = pd.Series(raw["Funding Rate"].to_numpy(dtype=float), index=ts, name="funding")
    return rate[~rate.index.duplicated(keep="last")].sort_index()


# ---------------------------------------------------------------- A. 期现套利

def carry_positions(rate: pd.Series, window: int | None, enter: float, exit: float) -> pd.Series:
    """每次结算后决定下一期是否持有套利仓位。window=None 表示常开。"""
    if window is None:
        return pd.Series(1.0, index=rate.index)
    avg = rate.rolling(window).mean()
    return _stateful(avg > enter, avg < exit)


def run_carry(
    rate: pd.Series, pos: pd.Series, notional: float = 0.5,
    spot_fee: float = 0.001, perp_fee: float = 0.0005,
) -> pd.Series:
    """期现套利权益曲线（初始 1，按 8 小时步进）。

    notional：每条腿的名义金额 / 总资金。默认 0.5，即一半资金买现货、一半做 1 倍空单保证金。
    第 t 次结算后定下的仓位，赚取第 t+1 次的资金费。开或平一次，两条腿各付一次手续费。
    """
    held = pos.shift(1).fillna(0.0)
    switch = held.diff().abs().fillna(held.iloc[0])
    cost = switch * notional * (spot_fee + perp_fee)
    return ((1 - cost) * (1 + held * rate * notional)).cumprod().rename("equity")


def daily(equity: pd.Series) -> pd.Series:
    return equity.resample("D").last().dropna()


CARRY_GRID = [dict(window=None, enter=0.0, exit=0.0)] + [
    dict(window=w, enter=e, exit=x)
    for w, e, x in product((3, 9, 21), (0.0, 0.00005, 0.0001, 0.0002), (-0.00005, 0.0, 0.00005))
    if x <= e
]


# 3 个月美债年化收益的年均值（近似值，用作期现套利的无风险基准）
TBILL = {2020: 0.0037, 2021: 0.0005, 2022: 0.0202, 2023: 0.0507}


def tbill_curve(index: pd.DatetimeIndex) -> pd.Series:
    r = pd.Series([TBILL.get(d.year, 0.0) / 365 for d in index], index=index)
    return (1 + r).cumprod()


# ---------------------------------------------------------------- B. 择时

def daily_funding(rate: pd.Series) -> pd.Series:
    """每日平均资金费率（每 8 小时一档）。"""
    return rate.resample("D").mean()


def overheat_positions(fd: pd.Series, n: int, high: float) -> pd.Series:
    """持有现货，最近 n 天平均资金费率高于 high 时空仓。"""
    avg = fd.rolling(n).mean()
    return (avg <= high).astype(float).where(avg.notna(), 1.0)


def contrarian_positions(fd: pd.Series, n: int, low: float, exit_high: float) -> pd.Series:
    """平均资金费率低于 low（恐慌）时买入，高于 exit_high 时卖出。"""
    avg = fd.rolling(n).mean()
    return _stateful(avg < low, avg > exit_high)


TIMING_GRID = (
    [("overheat", dict(n=n, high=h)) for n, h in product((1, 3, 7, 14), (0.0002, 0.0003, 0.0005, 0.001))]
    + [("contrarian", dict(n=n, low=lo, exit_high=hi))
       for n, lo, hi in product((1, 3, 7), (0.0, 0.00005, 0.0001), (0.0002, 0.0005))]
)
TIMING_FUNCS = {"overheat": overheat_positions, "contrarian": contrarian_positions}


def timing_equity(
    close: pd.Series, fd: pd.Series, family: str, params: dict,
    start: str, end: str, lag: int = 1,
) -> pd.Series:
    """择时策略在 [start, end] 的权益。lag=1：当天的资金费率次日收盘才据此成交。"""
    pos = TIMING_FUNCS[family](fd, **params).reindex(close.index).ffill().fillna(1.0 if family == "overheat" else 0.0)
    sl = close.loc[start:end]
    return run_positions(sl, pos.loc[sl.index], lag=lag)


def shift_placebo(
    close: pd.Series, pos: pd.Series, start: str, end: str, lag: int = 1, min_shift: int = 30,
) -> tuple[float, float]:
    """把日度仓位循环平移（持仓占比、换手不变），返回真实夏普的分位和平移后的夏普中位数。"""
    sl = close.loc[start:end]
    p = pos.reindex(sl.index).ffill().fillna(0.0)
    real = summarize(run_positions(sl, p, lag=lag))["sharpe"]
    n = len(p)
    sharpes = np.array([
        summarize(run_positions(sl, pd.Series(np.roll(p.to_numpy(), k), index=p.index), lag=lag))["sharpe"]
        for k in range(min_shift, n - min_shift, 3)
    ])
    return float(np.mean(sharpes < real)), float(np.nanmedian(sharpes))
