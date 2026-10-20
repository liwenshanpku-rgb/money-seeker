"""多币种验证周线时间序列动量。

参数（回看期）在 BTC 样本内已经选定，这里不再调参，只检验它在其他币种上是否成立：
1. 逐币对比动量策略与买入持有；
2. 安慰剂检验：把每个币的周线仓位整体循环平移（持仓占比、换手次数不变，
   择时被打乱），遍历所有平移量，看真实择时的夏普排在第几。用来排除“只是因为一半时间空仓，
   在熊市里少亏”这种不需要择时能力的解释；
3. 等权组合：所有币各分一份资金，比较动量组合与买入持有组合。
"""

from __future__ import annotations

import numpy as np
import pandas as pd

from .metrics import summarize
from .research import _resample_close
from .signals import run_positions, tsmom

# Coin Metrics 社区版里有 PriceUSD 的币种（不含 BTC、ETH）。
# 特意包含 LTC、BCH、DASH、EOS、NEO、BSV 等后来没落的老币，减少幸存者偏差。
EXTRA_ASSETS = (
    "ltc", "xrp", "bch", "ada", "doge", "link", "dot", "xlm", "etc", "trx", "bnb", "xmr",
    "dash", "zec", "uni", "eos", "neo", "xtz", "algo", "aave", "mkr", "bsv", "icp",
)


def weekly_positions(daily: pd.DataFrame, lookback: int) -> pd.Series:
    """周线动量信号映射到日线：周日收盘出信号，仓位从周日起生效（成交延迟另行设置）。"""
    pos_w = tsmom(_resample_close(daily)["close"], lookback)
    return pos_w.reindex(daily.index).ffill().fillna(0.0)


def _shifted_positions(pos_d: pd.Series, shift: int) -> pd.Series:
    """把周线仓位序列整体循环平移 shift 周：持仓占比和换手次数都不变，只破坏择时。"""
    week = pos_d.index.to_period("W-SAT")  # 信号在周日收盘生效，一周 = 周日至周六
    weekly = pos_d.groupby(week).first()
    rolled = pd.Series(np.roll(weekly.to_numpy(), shift), index=weekly.index)
    return pd.Series(rolled.loc[week].to_numpy(), index=pos_d.index)


def evaluate_asset(
    daily: pd.DataFrame, lookback: int, start: str | None, end: str | None,
    delay_days: int = 1, fee_rate: float = 0.001, placebo: bool = False,
) -> dict:
    pos_d = weekly_positions(daily, lookback)
    sl = daily.loc[start:end]
    # 留出一个回看期的预热，信号可用之后再开始统计
    first_valid = _resample_close(daily)["close"].index[lookback] if len(daily) > 7 * lookback else None
    if first_valid is not None and sl.index[0] < first_valid:
        sl = sl.loc[first_valid:]
    close, pos = sl["close"], pos_d.loc[sl.index]
    eq = run_positions(close, pos, fee_rate=fee_rate, lag=delay_days)
    st = summarize(eq)
    bh = summarize(close / close.iloc[0])
    row = {
        "start": st["start"], "end": st["end"],
        "total_ret": st["total_return"], "sharpe": st["sharpe"], "max_dd": st["max_drawdown"],
        "bh_total_ret": bh["total_return"], "bh_sharpe": bh["sharpe"], "bh_max_dd": bh["max_drawdown"],
        "exposure": float(pos.mean()),
    }
    if placebo:
        n_weeks = pos.index.to_period("W-SAT").nunique()
        gap = 2 * lookback  # 平移太少会和原信号几乎重合
        sharpes = np.array([
            summarize(run_positions(close, _shifted_positions(pos, k),
                                    fee_rate=fee_rate, lag=delay_days))["sharpe"]
            for k in range(gap, n_weeks - gap)
        ])
        # 真实夏普在“随机择时”中的分位，越接近 1 说明择时越有效
        row["placebo_pctile"] = float(np.mean(sharpes < st["sharpe"]))
        row["placebo_median_sharpe"] = float(np.nanmedian(sharpes))
    return row


def evaluate_universe(
    data: dict[str, pd.DataFrame], lookbacks=(4, 8, 13, 26, 52),
    periods: dict[str, tuple[str | None, str | None]] | None = None,
    main_lookback: int = 4,
) -> pd.DataFrame:
    """所有币种 × 所有回看期 × 所有区间的结果表。安慰剂检验只对 main_lookback 做。"""
    periods = periods or {"oos_2022+": ("2022-01-01", None), "full": (None, None)}
    rows = []
    for asset, daily in data.items():
        for pname, (start, end) in periods.items():
            if start and daily.index[0] > pd.Timestamp(start):
                continue  # 区间开始时还没有数据，避免拿上市初期的暴涨暴跌凑数
            for lb in lookbacks:
                row = evaluate_asset(daily, lb, start, end,
                                     placebo=lb == main_lookback)
                rows.append({"asset": asset, "period": pname, "lookback_w": lb, **row})
    return pd.DataFrame(rows)


def equal_weight_portfolio(
    data: dict[str, pd.DataFrame], lookback: int, start: str, end: str | None = None,
    delay_days: int = 1, fee_rate: float = 0.001, exclude: tuple[str, ...] = (),
) -> pd.DataFrame:
    """等权组合：开始时资金均分给每个币，之后各自独立运行、不再平衡。

    返回动量组合与买入持有组合的权益曲线（初始为 1）。只纳入区间开始前已有数据的币。
    """
    strat, hold = {}, {}
    for asset, daily in data.items():
        if asset in exclude or daily.index[0] > pd.Timestamp(start):
            continue
        sl = daily.loc[start:end]
        eq = run_positions(sl["close"], weekly_positions(daily, lookback).loc[sl.index],
                           capital=1.0, fee_rate=fee_rate, lag=delay_days)
        strat[asset] = eq
        hold[asset] = sl["close"] / sl["close"].iloc[0]
    # 有币在区间内停更（如 MKR 改名 SKY），之后按最后价值持有现金处理
    out = pd.DataFrame({
        "momentum": pd.DataFrame(strat).ffill().mean(axis=1),
        "buy_hold": pd.DataFrame(hold).ffill().mean(axis=1),
    })
    out.attrs["n_assets"] = len(strat)
    return out
