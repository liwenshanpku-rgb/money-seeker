"""用 BTC 作抵押借钱：强平风险和收益测算。

两件事：
1. 强平概率：以初始借款比例 ltv 借出美元/稳定币，利息按 borrow_rate 累加到负债上；
   BTC 跌到负债 / 抵押品价值 >= liq_threshold 时被强平。统计历史上从每个起点开始、
   在 horizon_days 天内被强平的比例。
2. 借钱买更多 BTC（加杠杆）：核心仓位抵押借款，再买入 BTC 并一起作为抵押品；
   被强平时卖出抵押品还清负债并支付罚金，之后不再加杠杆。

只用日收盘价，看不到日内插针，真实强平风险会更高。
"""

from __future__ import annotations

import numpy as np
import pandas as pd


def liquidation_drop(ltv: float, liq_threshold: float = 0.80) -> float:
    """不计利息时，BTC 从借款时下跌多少会触发强平。"""
    return 1.0 - ltv / liq_threshold


def liquidation_frequency(
    price: pd.Series, ltv: float, horizon_days: int = 365, borrow_rate: float = 0.05,
    liq_threshold: float = 0.80, start: str | None = None, step: int = 1,
) -> dict:
    """从每个起点借款、之后不还不补仓，在 horizon_days 天内被强平的比例与最快被强平的天数。"""
    px = price.loc[start:]
    values = px.to_numpy()
    days = (px.index - px.index[0]).days.to_numpy()
    hits, first_days = 0, []
    n = 0
    for i in range(0, len(px), step):
        end_day = days[i] + horizon_days
        if end_day > days[-1]:
            break
        j_end = np.searchsorted(days, end_day, side="right")
        seg = values[i:j_end]
        t = (days[i:j_end] - days[i]) / 365
        debt = ltv * values[i] * (1 + borrow_rate) ** t  # 抵押 1 BTC，负债按复利增长
        breach = np.flatnonzero(debt / seg >= liq_threshold)
        n += 1
        if breach.size:
            hits += 1
            first_days.append(int(days[i + breach[0]] - days[i]))
    return {"ltv": ltv, "horizon_days": horizon_days, "start_dates": n,
            "liquidated_share": hits / n if n else np.nan,
            "fastest_liquidation_days": min(first_days) if first_days else None}


def leveraged_hold(
    price: pd.Series, borrow_frac: float, borrow_rate: float = 0.05, liq_threshold: float = 0.80,
    penalty: float = 0.05, start: str | None = None, end: str | None = None,
) -> tuple[pd.Series, list[pd.Timestamp]]:
    """抵押 1 份 BTC，借出其价值 borrow_frac 比例的美元全部买成 BTC（也作抵押品），之后不调整。

    此时 负债 / 抵押品 = borrow_frac / (1 + borrow_frac)。
    返回净值（初始 = 1 份 BTC 的价格，归一化为 1）和强平日期。
    强平：卖出抵押品还清负债，并按负债的 penalty 比例支付罚金，之后不再加杠杆；
    一天内跌穿到资不抵债时，最多亏光抵押品（不计追偿）。
    """
    px = price.loc[start:end]
    p0 = float(px.iloc[0])
    btc = 1.0 + borrow_frac
    debt = borrow_frac * p0
    daily = (1 + borrow_rate) ** (1 / 365) - 1
    values, liquidations = [], []
    prev = px.index[0]
    for day, p in px.items():
        gap = (day - prev).days
        debt *= (1 + daily) ** gap
        prev = day
        if debt > 0 and debt / (btc * p) >= liq_threshold:
            btc = max(btc - debt * (1 + penalty) / p, 0.0)
            debt = 0.0
            liquidations.append(day)
        values.append((btc * p - debt) / p0)
    return pd.Series(values, index=px.index, name="equity"), liquidations


def levered_trend(
    price: pd.Series, core: float = 0.5, borrow_frac: float = 0.5, borrow_rate: float = 0.05,
    sma_days: int = 200, band: float = 0.03, liq_threshold: float = 0.80, penalty: float = 0.05,
    fee: float = 0.001, start: str | None = None, end: str | None = None,
) -> tuple[pd.Series, list[pd.Timestamp]]:
    """“核心 + 趋势”组合上叠加借款：只在上涨趋势里抵押核心仓位借款买 BTC，趋势转弱时还清。

    - 趋势向上（价格在均线 × (1 + band) 上方后）：全部资金买 BTC，并按核心仓位价值的 borrow_frac 借款再买 BTC；
    - 趋势向下：卖出非核心部分换成美债，并用这笔钱先还清借款；
    - 每天检查强平（负债 / 全部 BTC 价值 >= liq_threshold）。
    只在信号切换时调仓，期间仓位随价格漂移。返回净值（初始 1）和强平日期。
    """
    from .btc_overlay import tbill_daily, trend_weight

    w = trend_weight(price, sma_days, core, band)  # core 或 1.0，已含次日成交延迟
    px = price.loc[start:end]
    w = w.loc[px.index]
    tb = tbill_daily(px.index).fillna(0.0)
    daily_rate = (1 + borrow_rate) ** (1 / 365) - 1
    equity0 = 1.0
    btc = cash = debt = 0.0
    state = None
    values, liquidations = [], []
    prev = px.index[0]
    for day, p in px.items():
        gap = (day - prev).days
        debt *= (1 + daily_rate) ** gap
        cash *= (1 + tb.loc[day]) ** gap
        prev = day
        up = w.loc[day] > core
        if state != up:  # 信号切换（或第一天）：按新状态重新配置
            e = equity0 if state is None else btc * p + cash - debt
            target_btc = e * (1 + borrow_frac * core) if up else e * core
            traded = abs(target_btc - btc * p)
            e -= traded * fee
            if up:
                btc, debt, cash = e * (1 + borrow_frac * core) / p, e * borrow_frac * core, 0.0
            else:
                btc, debt, cash = e * core / p, 0.0, e * (1 - core)
            state = up
        if debt > 0 and debt / (btc * p) >= liq_threshold:
            btc = max(btc - debt * (1 + penalty) / p, 0.0)
            debt = 0.0
            liquidations.append(day)
        values.append(btc * p + cash - debt)
    return pd.Series(values, index=px.index, name="equity"), liquidations


def worst_ltv_levered_trend(
    price: pd.Series, core: float = 0.5, borrow_frac: float = 0.5, sma_days: int = 200,
    band: float = 0.03, start: str | None = None,
) -> tuple[float, pd.Timestamp | None]:
    """levered_trend 在历史上达到过的最高 负债 / BTC 抵押品 比例（不触发强平，只看离强平多近）。"""
    from .btc_overlay import trend_weight

    w = trend_weight(price, sma_days, core, band)
    px = price.loc[start:]
    state, btc, debt, cash = None, 0.0, 0.0, 0.0
    worst, when = 0.0, None
    for day, p in px.items():
        up = w.loc[day] > core
        if state != up:
            e = 1.0 if state is None else btc * p + cash - debt
            if up:
                btc, debt, cash = e * (1 + borrow_frac * core) / p, e * borrow_frac * core, 0.0
            else:
                btc, debt, cash = e * core / p, 0.0, e * (1 - core)
            state = up
        if debt > 0 and debt / (btc * p) > worst:
            worst, when = debt / (btc * p), day
    return worst, when
