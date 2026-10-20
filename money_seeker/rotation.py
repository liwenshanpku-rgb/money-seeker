"""横截面动量轮动：每周持有过去涨得最多的 K 个币。

规则：
- 每周日收盘，按过去 lookback 周的涨跌幅给所有“可交易”币排序，取前 top_k 个等权持有；
  可交易 = 当天有价格、且上市满 min_history 周（避免刚上市的币暴涨暴跌干扰排序）。
- 过滤（可选）：
  - "abs"：只持有自身涨幅为正的赢家，其余仓位放现金；
  - "btc_trend"：BTC 收盘价低于 20 周均线时全部空仓。
- 周一收盘按日线成交（信号延迟 1 天），持仓在一周内随价格漂移，
  调仓时按实际换手金额收取手续费。
"""

from __future__ import annotations

import numpy as np
import pandas as pd

from .metrics import summarize

FILTERS = ("none", "abs", "btc_trend")


def price_panel(data: dict[str, pd.DataFrame]) -> pd.DataFrame:
    """各币日收盘价拼成宽表（未上市或停更为 NaN）。"""
    return pd.DataFrame({a: d["close"] for a, d in data.items()}).sort_index()


def _sundays(prices: pd.DataFrame) -> pd.DatetimeIndex:
    return prices.index[prices.index.dayofweek == 6]


def eligibility(prices: pd.DataFrame, min_history: int = 26) -> pd.DataFrame:
    """每个周日哪些币可交易。"""
    sun = _sundays(prices)
    first = prices.apply(lambda s: s.first_valid_index())
    age_weeks = pd.DataFrame(
        {a: (sun - first[a]).days / 7 for a in prices.columns}, index=sun
    )
    return prices.loc[sun].notna() & (age_weeks >= min_history)


def target_weights(
    prices: pd.DataFrame, lookback: int, top_k: int, filt: str = "none",
    min_history: int = 26, btc: str = "btc", btc_ma: int = 20,
) -> pd.DataFrame:
    """每个周日收盘时的目标权重（行和 <= 1，余下为现金）。"""
    if filt not in FILTERS:
        raise ValueError(f"filt 必须是 {FILTERS} 之一")
    sun = _sundays(prices)
    weekly = prices.loc[sun]
    mom = weekly / weekly.shift(lookback) - 1
    elig = eligibility(prices, min_history) & mom.notna()
    score = mom.where(elig)
    rank = score.rank(axis=1, ascending=False, method="first")
    picked = rank <= top_k
    if filt == "abs":
        picked &= score > 0
    weights = picked.astype(float) / top_k
    if filt == "btc_trend":
        b = weekly[btc]
        risk_on = b > b.rolling(btc_ma).mean()
        weights = weights.mul(risk_on.astype(float), axis=0)
    return weights


def equal_weight_targets(prices: pd.DataFrame, min_history: int = 26) -> pd.DataFrame:
    """基准：所有可交易币等权，每周再平衡。"""
    elig = eligibility(prices, min_history)
    n = elig.sum(axis=1).replace(0, np.nan)
    return elig.astype(float).div(n, axis=0).fillna(0.0)


def simulate(
    prices: pd.DataFrame, weights: pd.DataFrame, start: str | None = None,
    end: str | None = None, fee_rate: float = 0.001, delay_days: int = 1,
) -> pd.DataFrame:
    """按周目标权重做日线组合回测。

    返回 DataFrame：equity（初始 1）和 turnover（当天成交额 / 组合净值）。
    停更的币（之后价格为 NaN）视为在最后价格卖出转为现金。
    """
    px = prices.loc[start:end]
    rets = px.pct_change().fillna(0.0).to_numpy()
    alive = px.notna().to_numpy()
    # 信号在周日收盘产生，delay_days 天后的收盘成交
    trade_dates = weights.index + pd.Timedelta(days=delay_days)
    tgt = weights.set_axis(trade_dates).reindex(columns=px.columns, fill_value=0.0)
    tgt = tgt[(tgt.index >= px.index[0]) & (tgt.index <= px.index[-1])]
    tgt_pos = {px.index.get_loc(d): w.to_numpy() for d, w in tgt.iterrows() if d in px.index}

    n = len(px)
    hold = np.zeros(px.shape[1])  # 各币持仓市值
    cash = 1.0
    equity = np.empty(n)
    turnover = np.zeros(n)
    for t in range(n):
        if t > 0:
            hold *= 1 + rets[t]
            dead = ~alive[t] & (hold != 0)
            if dead.any():  # 停更：按最后价格转为现金
                cash += hold[dead].sum()
                hold[dead] = 0.0
        nav = cash + hold.sum()
        if t in tgt_pos:
            w = np.where(alive[t], tgt_pos[t], 0.0)
            new_hold = w * nav
            traded = np.abs(new_hold - hold).sum()
            fee = traded * fee_rate
            nav -= fee
            new_hold = w * nav
            cash = nav - new_hold.sum()
            hold = new_hold
            turnover[t] = traded / (nav + fee)
        equity[t] = cash + hold.sum()
    return pd.DataFrame({"equity": equity, "turnover": turnover}, index=px.index)


def random_weights(
    weights: pd.DataFrame, elig: pd.DataFrame, rng: np.random.Generator
) -> pd.DataFrame:
    """安慰剂：每周持有的币数与真实策略相同，但从可交易币中随机挑选。"""
    out = np.zeros(weights.shape)
    w = weights.to_numpy()
    e = elig.reindex(index=weights.index, columns=weights.columns, fill_value=False).to_numpy()
    for i in range(len(w)):
        k = int((w[i] > 0).sum())
        cand = np.flatnonzero(e[i])
        if k and len(cand):
            pick = rng.choice(cand, size=min(k, len(cand)), replace=False)
            out[i, pick] = w[i][w[i] > 0][0]
    return pd.DataFrame(out, index=weights.index, columns=weights.columns)


def param_grid() -> list[dict]:
    return [dict(lookback=lb, top_k=k, filt=f)
            for lb in (1, 2, 4, 8, 13, 26) for k in (1, 3, 5) for f in FILTERS]


def scan(
    prices: pd.DataFrame, is_period: tuple[str, str], oos_period: tuple[str, str | None],
    fee_rate: float = 0.001,
) -> pd.DataFrame:
    """跑完整参数网格，返回每组参数的样本内 / 样本外指标。"""
    rows = []
    for p in param_grid():
        w = target_weights(prices, **p)
        row = {"lookback_w": p["lookback"], "top_k": p["top_k"], "filter": p["filt"]}
        for name, (s, e) in (("IS", is_period), ("OOS", oos_period)):
            sim = simulate(prices, w, s, e, fee_rate)
            st = summarize(sim["equity"])
            row |= {f"{name}_total_ret": st["total_return"], f"{name}_ann_ret": st["annual_return"],
                    f"{name}_sharpe": st["sharpe"], f"{name}_max_dd": st["max_drawdown"],
                    f"{name}_turnover_yr": sim["turnover"].sum() / (len(sim) / 365)}
        rows.append(row)
    return pd.DataFrame(rows)


def placebo_pctile(
    prices: pd.DataFrame, weights: pd.DataFrame, start: str, end: str | None,
    n: int = 300, seed: int = 0, fee_rate: float = 0.001,
) -> tuple[float, float]:
    """真实夏普在随机选币中的分位，以及随机选币的夏普中位数。"""
    real = summarize(simulate(prices, weights, start, end, fee_rate)["equity"])["sharpe"]
    elig = eligibility(prices)
    rng = np.random.default_rng(seed)
    sharpes = np.array([
        summarize(simulate(prices, random_weights(weights, elig, rng), start, end, fee_rate)["equity"])["sharpe"]
        for _ in range(n)
    ])
    return float(np.mean(sharpes < real)), float(np.nanmedian(sharpes))


# 横截面排序需要足够多的币。在 universe.EXTRA_ASSETS 之外再加 17 个币，
# 其中包括 FTT、SRM、BTG、OMG、FLOW 等后来崩盘或没落的币，进一步减小幸存者偏差。
# （LUNA 在数据源里没有价格，仍然缺失。）
ROTATION_EXTRA_ASSETS = (
    "ftt", "srm", "omg", "btg", "mana", "bat", "zrx", "knc", "snx", "comp", "yfi",
    "sushi", "crv", "1inch", "dgb", "flow", "ldo",
)
