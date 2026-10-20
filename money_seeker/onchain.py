"""链上数据择时（现货只做多）。数据来自 Coin Metrics 社区版每日指标。

信号（都只用当天及以前的数据，并在次日收盘成交）：
- mvrv：MVRV = 市值 / 实现市值。低于 low 买入（价格接近持币人平均成本），高于 high 卖出；
- mvrv_z：MVRV Z 分数 = (市值 - 实现市值) / 市值的历史标准差（扩展窗口）；
- puell：Puell 倍数 = 当日矿工发行收入（USD）/ 365 日均值；低买高卖。仅 BTC；
- hash_ribbon：算力 fast 日均线在 slow 日均线上方时持有，可选价格动量确认。仅 PoW 链；
- exchange_supply：交易所持币量 n 日变化为负（币在流出交易所）时持有；
- active_addr：活跃地址 fast 日均线高于 slow 日均线（网络使用在增长）时持有。

注意：交易所持币量依赖交易所地址标签，标签往往是事后才识别出来的，
历史数据可能被回溯修订，存在未来函数风险。
"""

from __future__ import annotations

from io import StringIO
from itertools import product
from pathlib import Path

import numpy as np
import pandas as pd
import requests

from .data import COINMETRICS_URL
from .signals import _stateful

METRIC_COLUMNS = [
    "PriceUSD", "CapMrktCurUSD", "CapMVRVCur", "IssTotUSD", "HashRate",
    "SplyExNtv", "SplyCur", "AdrActCnt",
]


def load_metrics(asset: str, data_dir: str | Path = "data", refresh: bool = False) -> pd.DataFrame:
    """Coin Metrics 每日指标（只保留用得到的列），本地缓存为 data/coinmetrics_metrics_<asset>.csv。"""
    path = Path(data_dir) / f"coinmetrics_metrics_{asset.lower()}.csv"
    if not path.exists() or refresh:
        resp = requests.get(COINMETRICS_URL.format(asset=asset.lower()), timeout=120)
        resp.raise_for_status()
        raw = pd.read_csv(StringIO(resp.text), low_memory=False)
        cols = ["time", *[c for c in METRIC_COLUMNS if c in raw.columns]]
        path.parent.mkdir(parents=True, exist_ok=True)
        raw[cols].to_csv(path, index=False)
    df = pd.read_csv(path, parse_dates=["time"]).set_index("time").rename_axis("date")
    return df.dropna(subset=["PriceUSD"]).sort_index()


# ---------------------------------------------------------------- 指标

def mvrv(m: pd.DataFrame) -> pd.Series:
    return m["CapMVRVCur"]


def mvrv_z(m: pd.DataFrame, min_periods: int = 365) -> pd.Series:
    realized = m["CapMrktCurUSD"] / m["CapMVRVCur"]
    std = m["CapMrktCurUSD"].expanding(min_periods).std()
    return (m["CapMrktCurUSD"] - realized) / std


def puell(m: pd.DataFrame) -> pd.Series:
    iss = m["IssTotUSD"]
    return iss / iss.rolling(365).mean()


# ---------------------------------------------------------------- 仓位

def band_positions(x: pd.Series, low: float, high: float) -> pd.Series:
    """指标低于 low 买入、高于 high 卖出；指标缺失时保持原状态。"""
    return _stateful((x < low).fillna(False), (x > high).fillna(False))


def hash_ribbon_positions(m: pd.DataFrame, fast: int, slow: int, confirm: bool) -> pd.Series:
    hr = m["HashRate"]
    ok = hr.rolling(fast).mean() > hr.rolling(slow).mean()
    if confirm:  # 经典版本：再要求价格 10 日均线在 20 日均线上方
        p = m["PriceUSD"]
        ok &= p.rolling(10).mean() > p.rolling(20).mean()
    return ok.astype(float)


def exchange_supply_positions(m: pd.DataFrame, n: int) -> pd.Series:
    return (m["SplyExNtv"].diff(n) < 0).astype(float)


def active_addr_positions(m: pd.DataFrame, fast: int, slow: int) -> pd.Series:
    a = m["AdrActCnt"]
    return (a.rolling(fast).mean() > a.rolling(slow).mean()).astype(float)


# family -> (仓位函数, 参数网格, 需要的列)
FAMILIES = {
    "mvrv": (lambda m, low, high: band_positions(mvrv(m), low, high),
             [dict(low=lo, high=hi) for lo, hi in product((1.0, 1.5, 2.0), (2.5, 3.0, 3.5, 4.0))],
             ["CapMVRVCur"]),
    "mvrv_z": (lambda m, low, high: band_positions(mvrv_z(m), low, high),
               [dict(low=lo, high=hi) for lo, hi in product((0.0, 0.5, 1.0, 2.0), (3.0, 5.0, 7.0))],
               ["CapMVRVCur", "CapMrktCurUSD"]),
    "puell": (lambda m, low, high: band_positions(puell(m), low, high),
              [dict(low=lo, high=hi) for lo, hi in product((0.5, 0.7, 1.0), (2.0, 3.0, 4.0))],
              ["IssTotUSD"]),
    "hash_ribbon": (hash_ribbon_positions,
                    [dict(fast=f, slow=s, confirm=c) for (f, s), c in
                     product(((30, 60), (14, 60), (30, 90)), (False, True))],
                    ["HashRate"]),
    "exchange_supply": (exchange_supply_positions,
                        [dict(n=n) for n in (7, 14, 30, 60, 90)], ["SplyExNtv"]),
    "active_addr": (active_addr_positions,
                    [dict(fast=f, slow=s) for f, s in ((7, 90), (30, 180), (30, 365), (90, 365))],
                    ["AdrActCnt"]),
}


def positions(m: pd.DataFrame, family: str, params: dict) -> pd.Series:
    fn = FAMILIES[family][0]
    return fn(m, **params)


def applicable(m: pd.DataFrame, family: str, start: str, end: str | None) -> bool:
    """该币在区间内是否有这个指标（例如 ETH 合并后没有算力，Puell 只对 BTC 有意义）。"""
    sl = m.loc[start:end]
    return all(c in m.columns and sl[c].notna().mean() > 0.95 for c in FAMILIES[family][2])


def n_trades(pos: pd.Series) -> int:
    return int(pos.diff().abs().fillna(0).sum())


def quantile_band_positions(x: pd.Series, window: int, q_low: float, q_high: float) -> pd.Series:
    """自适应阈值：指标低于自身过去 window 天的 q_low 分位买入，高于 q_high 分位卖出。"""
    lo = x.rolling(window, min_periods=window // 2).quantile(q_low)
    hi = x.rolling(window, min_periods=window // 2).quantile(q_high)
    return _stateful((x < lo).fillna(False), (x > hi).fillna(False))


# 自适应 MVRV Z：是在看到固定阈值样本外失效（周期顶部逐轮降低）之后才提出的，
# 属于“看过样本外再改进”，证据力度低于其他信号。
FAMILIES["mvrv_z_adaptive"] = (
    lambda m, q_low, q_high: quantile_band_positions(mvrv_z(m), 1460, q_low, q_high),
    [dict(q_low=lo, q_high=hi) for lo, hi in product((0.05, 0.10, 0.20), (0.90, 0.95, 0.98))],
    ["CapMVRVCur", "CapMrktCurUSD"],
)


def evaluate(price: pd.Series, pos: pd.Series, start: str | None, end: str | None, lag: int = 1) -> dict:
    """择时在区间内的指标、成交次数和持仓时间占比，以及同期买入持有的指标。"""
    from .metrics import summarize
    from .signals import run_positions

    sl = price.loc[start:end]
    p = pos.reindex(sl.index).ffill().fillna(0.0)
    st, bh = summarize(run_positions(sl, p, lag=lag)), summarize(sl)
    return {"total_ret": st["total_return"], "sharpe": st["sharpe"], "max_dd": st["max_drawdown"],
            "trades": n_trades(p), "exposure": float(p.mean()),
            "bh_total_ret": bh["total_return"], "bh_sharpe": bh["sharpe"], "bh_max_dd": bh["max_drawdown"]}


def trade_log(m: pd.DataFrame, family: str, params: dict, indicator: pd.Series | None = None) -> pd.DataFrame:
    pos = positions(m, family, params)
    ch = pos.diff().fillna(pos.iloc[0])
    ch = ch[ch != 0]
    return pd.DataFrame({
        "signal_date": ch.index.date, "action": np.where(ch > 0, "BUY", "SELL"),
        "price": m.loc[ch.index, "PriceUSD"].round(2).to_numpy(),
        **({"indicator": indicator.loc[ch.index].round(3).to_numpy()} if indicator is not None else {}),
    })
