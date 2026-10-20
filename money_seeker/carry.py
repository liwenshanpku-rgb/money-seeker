"""期现套利（买现货 + 做空永续）细化版。

相比 funding.py 里的简化模型，这里补上：
1. 数据：2025-08 ~ 2026-10 的 Binance / Bybit / Hyperliquid 资金费率（ZuShen168/funding_rate_data），
   与 2020–2023 的旧数据合并；2024-01 ~ 2025-08 没有可用的公开数据，作为缺口保留，不做填补；
2. 资金利用率与爆仓风险：
   - unified：统一账户，现货直接作空单保证金，几乎全部资金都能做名义仓位；
   - separate：现货与合约保证金分开，空单杠杆 L，名义仓位 = L / (L + 1)；
     价格每偏离上次调仓 band 就把现货盈利挪去补保证金（两条腿各交易一次，计手续费）；
3. 每个币 / 每个交易所的收益横截面，以及按近期资金费率轮动；
4. 无风险基准：3 个月美债。

收益只计资金费、手续费、滑点和调仓成本。交易所倒闭、提币冻结、自动减仓（ADL）、
开平仓基差等风险不在收益里，单独在报告中讨论（基差用 Binance 标记价格做了估算）。
"""

from __future__ import annotations

from pathlib import Path

import numpy as np
import pandas as pd
import requests

from .funding import load_funding

ZUSHEN_URL = ("https://raw.githubusercontent.com/ZuShen168/funding_rate_data/main/"
              "data/funding/venue={venue}/data.parquet")
NEW_VENUES = ("binance", "bybit", "hyperliquid")

# 3 个月美债收益率（年化）。2020–2024 为年均值近似；2025 年为年均 4.07%；
# 2026 年为 FRED TB3MS 月均值（10 月沿用 9 月）。
TBILL_YEARLY = {2020: 0.0037, 2021: 0.0005, 2022: 0.0202, 2023: 0.0507, 2024: 0.0497, 2025: 0.0407}
TBILL_2026_MONTHLY = {1: 0.0357, 2: 0.0360, 3: 0.0361, 4: 0.0361, 5: 0.0360, 6: 0.0366,
                      7: 0.0373, 8: 0.0372, 9: 0.0394, 10: 0.0394, 11: 0.0394, 12: 0.0394}


def tbill_rate(d: pd.Timestamp) -> float:
    if d.year == 2026:
        return TBILL_2026_MONTHLY[d.month]
    return TBILL_YEARLY.get(d.year, np.nan)


# ---------------------------------------------------------------- 数据

def load_new_funding(venue: str, data_dir: str | Path = "data", refresh: bool = False) -> pd.DataFrame:
    """2025-08 起的资金费率（每次结算一行）：coin、quote、ts、rate、interval_hours、mark_price。"""
    path = Path(data_dir) / f"funding_zushen_{venue}.parquet"
    if not path.exists() or refresh:
        resp = requests.get(ZUSHEN_URL.format(venue=venue), timeout=180)
        resp.raise_for_status()
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(resp.content)
    df = pd.read_parquet(path)
    df = df[~df["is_predicted"]]
    base_quote = df["canonical_symbol"].str.extract(r"^([A-Z0-9]+)-([A-Z]+)-PERP$")
    out = pd.DataFrame({
        "venue": venue,
        "coin": base_quote[0],
        "quote": base_quote[1],
        "symbol": df["venue_symbol"],
        "ts": df["settlement_ts"].dt.floor("h").dt.tz_localize(None),
        "rate": df["rate_raw"].astype(float),
        "interval_hours": df["interval_hours"].astype(float),
        "mark_price": pd.to_numeric(df["mark_price"], errors="coerce"),
    })
    return out.drop_duplicates(["symbol", "ts"]).sort_values(["symbol", "ts"]).reset_index(drop=True)


def daily_funding_sum(rate: pd.Series, interval_hours: float | pd.Series) -> pd.DataFrame:
    """把逐次结算的资金费率汇总成每日：sum（当天合计）与 coverage（当天覆盖的小时数 / 24）。

    数据缺口的日子 coverage < 1，回测时这些天不计收益、也不计入年化天数。
    """
    hours = interval_hours if isinstance(interval_hours, pd.Series) else pd.Series(interval_hours, index=rate.index)
    day = rate.index.floor("D")
    out = pd.DataFrame({"sum": rate.groupby(day).sum(), "coverage": hours.groupby(day).sum() / 24})
    full = pd.date_range(out.index.min(), out.index.max(), freq="D")
    return out.reindex(full).fillna({"sum": 0.0, "coverage": 0.0})


def old_daily(coin: str, venue: str, data_dir: str | Path = "data") -> pd.DataFrame:
    r = load_funding(coin, venue, data_dir)
    return daily_funding_sum(r, 8.0)


def new_daily(df: pd.DataFrame, symbol: str) -> pd.DataFrame:
    x = df[df["symbol"] == symbol].set_index("ts")
    return daily_funding_sum(x["rate"], x["interval_hours"])


# ---------------------------------------------------------------- 回测

FEES = {  # 现货 taker、永续 taker（不含 VIP / 平台币折扣）
    "binance": (0.0010, 0.0005),
    "bybit": (0.0010, 0.00055),
    "gate": (0.0010, 0.0005),
    "hyperliquid": (0.0010, 0.00045),  # 现货腿放在 CEX
}


def notional_fraction(mode: str, leverage: float = 1.0, buffer: float = 0.1) -> float:
    """每条腿名义金额 / 总资金。unified 留 buffer 作保证金缓冲。"""
    if mode == "unified":
        return 1.0 / (1.0 + buffer)
    if mode == "separate":
        return leverage / (leverage + 1.0)
    raise ValueError(mode)


def simulate_carry(
    daily: pd.DataFrame, price: pd.Series | None = None, *, venue: str = "binance",
    mode: str = "separate", leverage: float = 1.0, band: float = 0.1, slippage: float = 0.0002,
    maint_margin: float = 0.005, start: str | None = None, end: str | None = None,
) -> dict:
    """常开期现套利的日度回测。

    daily：daily_funding_sum 的输出；price：日收盘价（separate 模式计算调仓与爆仓用）。
    返回 equity（只含有数据的日子）、年化收益、调仓次数、离强平最近时的价格涨幅比例等。
    """
    d = daily.loc[start:end]
    spot_fee, perp_fee = FEES[venue]
    leg_cost = spot_fee + perp_fee + 2 * slippage
    nf = notional_fraction(mode, leverage)

    covered = d["coverage"] >= 0.99
    funding = d["sum"].where(covered, 0.0).to_numpy()
    eq = 1.0 - nf * leg_cost  # 建仓
    equity = np.empty(len(d))
    rebalances, cost_rebal = 0, 0.0
    worst_margin_use = 0.0  # 最大“已用掉的强平距离”比例
    if mode == "separate" and price is not None:
        px = price.reindex(d.index).ffill().to_numpy()
        last = px[0]
        liq_move = (1.0 / leverage - maint_margin) / (1 + maint_margin)  # 价格涨这么多会被强平
    for i in range(len(d)):
        eq *= 1 + nf * funding[i]
        if mode == "separate" and price is not None and i > 0 and np.isfinite(px[i]) and np.isfinite(last):
            move = px[i] / last - 1
            worst_margin_use = max(worst_margin_use, move / liq_move)
            if abs(move) >= band:  # 把现货盈利挪去补保证金（或反向），两条腿按 |move| 交易
                c = nf * abs(move) * leg_cost
                eq *= 1 - c
                cost_rebal += c
                rebalances += 1
                last = px[i]
        equity[i] = eq
    eq_s = pd.Series(equity, index=d.index)
    eq_end = eq_s.iloc[-1] * (1 - nf * leg_cost)  # 平仓
    days = int(covered.sum())
    total = eq_end - 1
    tb = np.array([tbill_rate(t) for t in d.index[covered]])
    return {
        "start": d.index[0].date().isoformat(), "end": d.index[-1].date().isoformat(),
        "covered_days": days, "notional": nf,
        "funding_apr": float(np.mean(funding[covered.to_numpy()]) * 365) if days else np.nan,
        "net_return": float(total),
        "net_apr": float((1 + total) ** (365 / days) - 1) if days else np.nan,
        "tbill_apr": float(tb.mean()) if days else np.nan,
        "rebalances": rebalances, "rebalance_cost": float(cost_rebal),
        "worst_liq_distance_used": float(worst_margin_use),
        "equity": eq_s.where(covered.to_numpy()).dropna(),
    }


def max_daily_rise(price: pd.Series, horizon: int = 1) -> float:
    """历史上最大的 horizon 日收盘涨幅（估算空单爆仓风险用，日内影线会更大）。"""
    return float((price / price.shift(horizon) - 1).max())


def safe_leverage(max_rise: float, band: float, maint_margin: float = 0.005, cushion: float = 1.5) -> float:
    """在“调仓阈值 band + 历史最大单日涨幅 × cushion”下不会爆仓的最大空单杠杆。"""
    need = (band + max_rise * cushion) * (1 + maint_margin) + maint_margin
    return float(1.0 / need)


# ---------------------------------------------------------------- 轮动

def funding_panel(df: pd.DataFrame, quote: str = "USDT") -> tuple[pd.DataFrame, pd.DataFrame]:
    """各币每日资金费率合计与覆盖率（宽表）。"""
    sums, cov = {}, {}
    for sym, g in df[df["quote"] == quote].groupby("symbol"):
        dd = daily_funding_sum(g.set_index("ts")["rate"], g.set_index("ts")["interval_hours"])
        coin = g["coin"].iloc[0]
        sums[coin], cov[coin] = dd["sum"], dd["coverage"]
    return pd.DataFrame(sums), pd.DataFrame(cov)


def rotation_carry(
    sums: pd.DataFrame, cov: pd.DataFrame, top_k: int = 3, lookback: int = 14,
    universe: list[str] | None = None, venue: str = "binance", slippage: float = 0.0005,
    nf: float = 0.5, every_weeks: int = 1,
) -> pd.DataFrame:
    """每 every_weeks 周按过去 lookback 天平均资金费率选前 top_k 个币做期现套利（等权）。

    换币要平掉旧币两条腿、开新币两条腿；只在全部候选币当天都有完整数据时计收益。
    返回日度 DataFrame：ret、held（持有的币，逗号分隔）。
    """
    cols = universe or list(sums.columns)
    s, c = sums[cols], cov[cols]
    ok_day = (c >= 0.99) | c.isna()
    trailing = s.where(c >= 0.99).rolling(lookback, min_periods=lookback // 2).mean()
    spot_fee, perp_fee = FEES[venue]
    leg_cost = spot_fee + perp_fee + 2 * slippage
    held: list[str] = []
    rets, holds = [], []
    week = 0
    for i, day in enumerate(s.index):
        cost = 0.0
        due = day.dayofweek == 6 and i >= lookback and (not held or week % every_weeks == 0)
        if day.dayofweek == 6 and i >= lookback:
            week += 1
        if due:  # 周日收盘调仓
            avail = trailing.loc[day].dropna()
            avail = avail[[k for k in avail.index if c.loc[day, k] >= 0.99]]
            if len(avail):  # 数据缺口里没有候选时不调仓，保持原持仓
                new = list(avail.sort_values(ascending=False).index[:top_k])
                changed = len(set(held) ^ set(new)) / max(top_k, 1) / 2 if held else 1.0
                cost = changed * nf * leg_cost * (2 if held else 1)
                held = new
        day_ok = bool(held) and bool((c.loc[day, held] >= 0.99).all())
        r = nf * float(s.loc[day, held].mean()) if held else 0.0
        # 没有持仓（开始前）或数据缺口的日子记为 NaN，不计入收益和年化天数
        rets.append(r - cost if day_ok else (np.nan if cost == 0 else -cost))
        holds.append(",".join(held))
    return pd.DataFrame({"ret": rets, "held": holds}, index=s.index)
