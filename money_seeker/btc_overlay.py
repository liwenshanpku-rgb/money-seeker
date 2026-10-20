"""持有 BTC 时的增强操作：在保留（大部分）上涨敞口的前提下多赚一点。

三类做法：
A. 现货 vs 合成多头：同样 1 倍 BTC 敞口，可以拿现货，也可以“现金买美债 + 1 倍永续多单”。
   合成多头要付资金费，但现金能赚利息；资金费率低于利息时，合成多头在敞口相同的情况下多赚利差。
B. 备兑看涨（covered call）：持有 BTC，同时每月卖出虚值看涨期权收权利金，代价是放弃行权价以上的涨幅。
   没有历史隐含波动率数据，用“过去 30 天实际波动率 × 系数”近似，属于模型估算。
C. 部分趋势仓位：始终保留核心仓位，只对一部分仓位按趋势择时，空出来的资金买美债。
"""

from __future__ import annotations

from math import erf, exp, log, sqrt

import numpy as np
import pandas as pd

from .carry import load_new_funding, new_daily, old_daily, tbill_rate
from .data import load_or_fetch_coinmetrics
from .signals import _stateful


# ---------------------------------------------------------------- 数据

def btc_price(data_dir: str = "data") -> pd.Series:
    """BTC 日收盘价：Coin Metrics（D 日 = D+1 日 00:00 UTC），之后用 Binance 永续标记价格接上。"""
    cm = load_or_fetch_coinmetrics("btc", data_dir)["close"]
    b = load_new_funding("binance", data_dir)
    mark = b[(b["symbol"] == "BTCUSDT") & (b["ts"].dt.hour == 0)].set_index("ts")["mark_price"]
    mark.index = mark.index - pd.Timedelta(days=1)  # 对齐 Coin Metrics 的标签方式
    tail = mark.loc[cm.index[-1] + pd.Timedelta(days=1):]
    return pd.concat([cm, tail]).sort_index().rename("close")


def tbill_daily(index: pd.DatetimeIndex) -> pd.Series:
    return pd.Series([tbill_rate(d) / 365 for d in index], index=index)


def btc_funding_daily(data_dir: str = "data") -> pd.DataFrame:
    """Binance BTCUSDT 每日资金费率合计与覆盖率：2020–2023 + 2025-08 起（中间缺口）。"""
    old = old_daily("BTC", "binance", data_dir)
    new = new_daily(load_new_funding("binance", data_dir), "BTCUSDT")
    return pd.concat([old, new]).sort_index()


# ---------------------------------------------------------------- A. 现货 vs 合成多头

def synthetic_excess(
    funding: pd.DataFrame, rule: str = "always", lookback: int = 30, hurdle: float = 0.0,
    collateral_haircut: float = 0.0025, switch_cost: float = 0.0019,
) -> pd.DataFrame:
    """合成多头相对现货的每日超额收益（敞口相同，所以 BTC 涨跌抵消，只剩利息 - 资金费 - 切换成本）。

    collateral_haircut：现金抵押品年化收益比美债少多少（代币化美债的管理费等）。
    rule：
      - "always"：一直用合成多头；
      - "switch"：过去 lookback 天资金费年化 < 抵押品收益 - hurdle 时用合成多头，否则换回现货。
    只在有资金费数据的日子计算。
    """
    ok = funding["coverage"] >= 0.99
    f = funding["sum"].where(ok)
    y = tbill_daily(funding.index) - collateral_haircut / 365
    if rule == "always":
        use = pd.Series(1.0, index=funding.index)
    elif rule == "switch":
        trailing = f.rolling(lookback, min_periods=lookback // 2).mean() * 365
        signal = (trailing < (y * 365 - hurdle)).astype(float)
        use = signal.shift(1).fillna(0.0)  # 次日才切换
    else:
        raise ValueError(rule)
    excess = use * (y - f)
    cost = use.diff().abs().fillna(use.iloc[0]) * switch_cost
    return pd.DataFrame({"excess": (excess - cost).where(ok), "use_synthetic": use, "funding": f, "collateral": y})


# ---------------------------------------------------------------- B. 备兑看涨

def _norm_cdf(x: float) -> float:
    return 0.5 * (1 + erf(x / sqrt(2)))


def bs_call(s: float, k: float, t: float, vol: float, r: float = 0.0) -> float:
    if t <= 0 or vol <= 0:
        return max(s - k, 0.0)
    d1 = (log(s / k) + (r + 0.5 * vol * vol) * t) / (vol * sqrt(t))
    d2 = d1 - vol * sqrt(t)
    return s * _norm_cdf(d1) - k * exp(-r * t) * _norm_cdf(d2)


def covered_call(
    price: pd.Series, otm: float = 0.10, days: int = 30, iv_ratio: float = 1.15,
    coverage: float = 1.0, fee_rate: float = 0.0003, spread: float = 0.03,
    start: str | None = None, end: str | None = None,
) -> pd.DataFrame:
    """每 days 天卖一张 days 天到期、行权价 = 现价 × (1 + otm) 的看涨期权（按 BTC 结算）。

    隐含波动率 = 过去 30 天年化实际波动率 × iv_ratio（BTC 隐含波动率长期略高于实际波动率）。
    成本：期权手续费 min(fee_rate × 标的, 12.5% × 权利金) + 买卖价差（权利金的 spread 比例）。
    返回每日：以美元计的组合价值（初始 = 1 份 BTC 的价格）与 BTC 持有数量。
    """
    rv = np.log(price).diff().rolling(30).std() * np.sqrt(365)
    px = price.loc[start:end]
    btc = 1.0
    values, units = [], []
    strike = expiry = None
    for i, (day, s) in enumerate(px.items()):
        if expiry is not None and day >= expiry:  # 到期结算：被行权时支付 (S - K) 等值的 BTC
            payoff_btc = coverage * max(s - strike, 0.0) / s
            btc -= payoff_btc * btc_at_sale
            strike = expiry = None
        if expiry is None and np.isfinite(rv.get(day, np.nan)):
            vol = rv.loc[day] * iv_ratio
            k = s * (1 + otm)
            prem = bs_call(s, k, days / 365, vol)
            fee = min(fee_rate * s, 0.125 * prem) + spread * prem
            btc_at_sale = btc
            btc += coverage * btc_at_sale * (prem - fee) / s  # 权利金收的是 BTC
            strike, expiry = k, day + pd.Timedelta(days=days)
        values.append(btc * s)
        units.append(btc)
    return pd.DataFrame({"value": values, "btc": units}, index=px.index)


# ---------------------------------------------------------------- C. 部分趋势仓位

def trend_overlay(
    price: pd.Series, sma_days: int = 200, core: float = 0.5, band: float = 0.0, weekly: bool = False,
    cash_yield: bool = True, fee: float = 0.001, start: str | None = None, end: str | None = None,
) -> pd.Series:
    """价格在 sma_days 日均线上方时 100% 持有 BTC，下方时只保留 core 比例，其余放美债。

    band > 0 时需要涨破均线 × (1 + band) 才加满、跌破均线 × (1 - band) 才减仓，减少来回切换；
    weekly=True 时只在每周日收盘检查信号。信号在当天收盘算出，次日收盘调仓。返回组合价值（初始 1）。
    """
    weight = trend_weight(price, sma_days, core, band, weekly)
    px = price.loc[start:end]
    w = weight.loc[px.index]
    r = px.pct_change().fillna(0.0)
    y = tbill_daily(px.index) if cash_yield else pd.Series(0.0, index=px.index)
    turn = w.diff().abs().fillna(0.0) * fee
    return ((1 - turn) * (1 + w * r + (1 - w) * y)).cumprod().rename("value")


def trend_weight(
    price: pd.Series, sma_days: int = 200, core: float = 0.5, band: float = 0.0, weekly: bool = False,
) -> pd.Series:
    """每天实际持有的 BTC 比例（已包含次日成交的延迟）。"""
    sma = price.rolling(sma_days).mean()
    if band > 0:
        above = _stateful((price > sma * (1 + band)).fillna(False), (price < sma * (1 - band)).fillna(False))
    else:
        above = (price > sma).astype(float)
    if weekly:
        above = above.where(price.index.dayofweek == 6).ffill().fillna(0.0)
    # 首日之前没有信号时按满仓处理；shift(2)：当天收盘出信号、次日收盘成交、再下一天起生效
    return (core + (1 - core) * above).shift(2).fillna(1.0)


def trades(weight: pd.Series) -> int:
    return int((weight.diff().abs() > 0).sum())
