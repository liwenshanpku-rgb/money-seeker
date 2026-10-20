"""多策略研究：样本内选参数，样本外检验，再换一个币种交叉验证。

流程（避免“一直试到赚钱为止”的过拟合）：
1. 每个策略在样本内（IS）跑完整个参数网格，按 IS 夏普选出一组参数；
2. 只用这组参数在样本外（OOS）评估，OOS 数据不参与任何选择；
3. 同一组参数原样搬到另一个币种上，看是否仍然有效；
4. 同时报告全部参数在 OOS 的盈利比例和夏普中位数，衡量是否只是挑中了幸运参数。
"""

from __future__ import annotations

from dataclasses import dataclass
from itertools import product
from typing import Callable

import numpy as np
import pandas as pd

from .metrics import summarize
from .signals import PARAM_GRIDS, run_positions
from .strategy import GridConfig, run_grid_backtest

PERIODS = {"D": 365, "W": 52}
GRID_PARAMS = {
    "D": [dict(range_pct=r, n_grids=n, reset=k) for r, n, k in
          product((0.1, 0.2, 0.3), (10, 20), (None, 30, 90, 365))],
    "W": [dict(range_pct=r, n_grids=n, reset=k) for r, n, k in
          product((0.1, 0.2, 0.3), (10, 20), (None, 4, 13, 52))],
}


def grid_equity(
    df: pd.DataFrame, range_pct: float, n_grids: int, reset: int | None,
    capital: float = 10_000.0, fee_rate: float = 0.001,
) -> pd.Series:
    """等比网格。reset 不为空时每 reset 根 K 线清仓、以当前价为中心重新布网格。"""
    chunks = [df] if reset is None else [df.iloc[i : i + reset + 1] for i in range(0, len(df) - 1, reset)]
    parts = []
    for chunk in chunks:
        p0 = float(chunk["open"].iloc[0])
        cfg = GridConfig(p0 * (1 - range_pct), p0 * (1 + range_pct), n_grids,
                         capital=capital, fee_rate=fee_rate, geometric=True)
        res = run_grid_backtest(chunk, cfg)
        eq = res.equity.copy()
        t = res.trades
        base = float((np.where(t["side"] == "buy", 1, -1) * t["qty"]).sum()) if len(t) else 0.0
        # 清仓手续费
        eq.iloc[-1] -= base * float(chunk["close"].iloc[-1]) * fee_rate
        parts.append(eq if not parts else eq.iloc[1:])
        capital = float(eq.iloc[-1])
    return pd.concat(parts)


def weekly_signal_daily_exec(
    daily: pd.DataFrame, fn: Callable, params: dict, start: str, end: str | None,
    delay_days: int = 1,
) -> pd.Series:
    """周线收盘算信号，delay_days 天后按日线收盘成交，按日线计算盈亏。更接近实盘。"""
    pos_w = fn(_resample_close(daily)["close"], **params)
    pos_d = pos_w.reindex(daily.index).ffill().fillna(0.0)
    sl = daily.loc[start:end]
    return run_positions(sl["close"], pos_d.loc[sl.index], lag=delay_days)


@dataclass
class Candidate:
    family: str
    params: dict
    equity_fn: Callable[[pd.DataFrame, int], pd.Series]  # (区间行情, lag) -> 权益


def candidates(freq: str, full: dict[str, pd.DataFrame]) -> list[Candidate]:
    """生成所有（策略, 参数）组合。信号在完整历史上计算，再截取区间，保证有预热数据。"""
    out: list[Candidate] = []
    for family, (fn, grid) in PARAM_GRIDS[freq].items():
        for params in grid:
            def eq(df, lag, fn=fn, params=params):
                pos = fn(full[df.attrs["asset"]]["close"], **params)
                return run_positions(df["close"], pos.loc[df.index], lag=lag)
            out.append(Candidate(family, params, eq))
    for params in GRID_PARAMS[freq]:
        out.append(Candidate("grid", params, lambda df, lag, p=params: grid_equity(df, **p)))
    return out


def _slice(df: pd.DataFrame, start: str, end: str | None, asset: str) -> pd.DataFrame:
    out = df.loc[start:end].copy()
    out.attrs["asset"] = asset
    return out


def run_research(
    data: dict[str, pd.DataFrame],
    main_asset: str,
    is_period: tuple[str, str],
    oos_period: tuple[str, str | None],
    freqs: tuple[str, ...] = ("D", "W"),
) -> pd.DataFrame:
    """返回每个（周期, 策略族）的汇总表。data 为各币种的日线。"""
    rows = []
    for freq in freqs:
        full = {a: (d if freq == "D" else _resample_close(d)) for a, d in data.items()}
        periods = PERIODS[freq]
        is_df = _slice(full[main_asset], *is_period, main_asset)
        oos = {a: _slice(full[a], *oos_period, a) for a in full}

        cands = candidates(freq, full)
        scored = []
        for c in cands:
            is_stats = summarize(c.equity_fn(is_df, 0), periods=periods)
            oos_stats = summarize(c.equity_fn(oos[main_asset], 0), periods=periods)
            scored.append((c, is_stats, oos_stats))

        bh = {a: summarize(df["close"] / df["close"].iloc[0], periods=periods) for a, df in oos.items()}
        families = dict.fromkeys(c.family for c in cands)
        for family in families:
            group = [s for s in scored if s[0].family == family]
            best, is_stats, oos_stats = max(
                group, key=lambda s: np.nan_to_num(s[1]["sharpe"], nan=-np.inf)
            )
            row = {
                "freq": freq,
                "strategy": family,
                "params": _fmt_params(best.params),
                "IS_sharpe": is_stats["sharpe"],
                "IS_ann_ret": is_stats["annual_return"],
                "OOS_total_ret": oos_stats["total_return"],
                "OOS_ann_ret": oos_stats["annual_return"],
                "OOS_sharpe": oos_stats["sharpe"],
                "OOS_max_dd": oos_stats["max_drawdown"],
                "OOS_sharpe_lag1": summarize(best.equity_fn(oos[main_asset], 1), periods=periods)["sharpe"],
                "OOS_share_profitable": np.mean([s[2]["total_return"] > 0 for s in group]),
                "OOS_median_sharpe": float(np.nanmedian([s[2]["sharpe"] for s in group])),
            }
            if freq == "W" and family in PARAM_GRIDS["W"]:
                eq = weekly_signal_daily_exec(
                    data[main_asset], PARAM_GRIDS["W"][family][0], best.params, *oos_period
                )
                row["OOS_sharpe_next_day_exec"] = summarize(eq)["sharpe"]
            for a in oos:
                if a == main_asset:
                    continue
                st = summarize(best.equity_fn(oos[a], 0), periods=periods)
                row[f"{a}_OOS_total_ret"] = st["total_return"]
                row[f"{a}_OOS_sharpe"] = st["sharpe"]
                row[f"{a}_OOS_max_dd"] = st["max_drawdown"]
            rows.append(row)
        bh_row = {"freq": freq, "strategy": "buy_hold", "params": "",
                  "OOS_total_ret": bh[main_asset]["total_return"],
                  "OOS_ann_ret": bh[main_asset]["annual_return"],
                  "OOS_sharpe": bh[main_asset]["sharpe"],
                  "OOS_max_dd": bh[main_asset]["max_drawdown"]}
        for a in oos:
            if a != main_asset:
                bh_row[f"{a}_OOS_total_ret"] = bh[a]["total_return"]
                bh_row[f"{a}_OOS_sharpe"] = bh[a]["sharpe"]
                bh_row[f"{a}_OOS_max_dd"] = bh[a]["max_drawdown"]
        rows.append(bh_row)
    return pd.DataFrame(rows)


def best_equities(
    data: dict[str, pd.DataFrame], table: pd.DataFrame, asset: str,
    oos_period: tuple[str, str | None], freq: str,
) -> dict[str, pd.Series]:
    """按汇总表中选出的参数，重新生成某周期下各策略的 OOS 权益曲线（用于画图）。"""
    full = {a: (d if freq == "D" else _resample_close(d)) for a, d in data.items()}
    oos = _slice(full[asset], *oos_period, asset)
    sel = table[(table["freq"] == freq) & (table["strategy"] != "buy_hold")]
    curves = {"buy_hold": 10_000 * oos["close"] / oos["close"].iloc[0]}
    for c in candidates(freq, full):
        match = sel[(sel["strategy"] == c.family) & (sel["params"] == _fmt_params(c.params))]
        if len(match):
            curves[c.family] = c.equity_fn(oos, 0)
    return curves


def _resample_close(df: pd.DataFrame) -> pd.DataFrame:
    from .data import close_only, resample

    return close_only(resample(df)["close"])


def _fmt_params(p: dict) -> str:
    return ", ".join(f"{k}={v}" for k, v in p.items())
