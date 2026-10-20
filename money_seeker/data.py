"""日线 K 线数据：从 Binance 公共行情接口拉取、本地 CSV 缓存、离线模拟数据。"""

from __future__ import annotations

import time
from pathlib import Path

import numpy as np
import pandas as pd
import requests

# data-api.binance.vision 是 Binance 官方的纯行情镜像，无需 API Key；
# 主站作为备用。
BINANCE_ENDPOINTS = (
    "https://data-api.binance.vision/api/v3/klines",
    "https://api.binance.com/api/v3/klines",
)
KLINE_LIMIT = 1000
DAY_MS = 24 * 60 * 60 * 1000
COLUMNS = ["open", "high", "low", "close", "volume"]


def _to_ms(date: str | pd.Timestamp) -> int:
    ts = pd.Timestamp(date)
    if ts.tzinfo is None:
        ts = ts.tz_localize("UTC")
    return int(ts.timestamp() * 1000)


def _get(params: dict, timeout: float = 15.0, retries: int = 3) -> list:
    last_err: Exception | None = None
    for url in BINANCE_ENDPOINTS:
        for attempt in range(retries):
            try:
                resp = requests.get(url, params=params, timeout=timeout)
                resp.raise_for_status()
                return resp.json()
            except requests.RequestException as err:
                last_err = err
                time.sleep(2**attempt)
    raise RuntimeError(f"拉取 Binance K 线失败: {last_err}")


def fetch_binance_daily(
    symbol: str = "BTCUSDT",
    start: str = "2021-01-01",
    end: str | None = None,
) -> pd.DataFrame:
    """拉取 [start, end] 区间的日线，自动分页。返回以 UTC 日期为索引的 OHLCV。"""
    start_ms = _to_ms(start)
    end_ms = _to_ms(end) if end else int(time.time() * 1000)
    rows: list = []
    cursor = start_ms
    while cursor <= end_ms:
        batch = _get(
            {
                "symbol": symbol.upper(),
                "interval": "1d",
                "startTime": cursor,
                "endTime": end_ms,
                "limit": KLINE_LIMIT,
            }
        )
        if not batch:
            break
        rows.extend(batch)
        cursor = batch[-1][0] + DAY_MS
        if len(batch) < KLINE_LIMIT:
            break
    if not rows:
        raise RuntimeError(f"{symbol} 在 {start} ~ {end} 没有数据")

    df = pd.DataFrame([r[:6] for r in rows], columns=["open_time", *COLUMNS])
    df["date"] = pd.to_datetime(df["open_time"], unit="ms").dt.normalize()
    df = df.drop(columns="open_time").set_index("date").astype(float)
    df = df[~df.index.duplicated(keep="last")].sort_index()
    # 去掉尚未收盘的当日 K 线
    today = pd.Timestamp.now(tz="UTC").normalize().tz_localize(None)
    return df[df.index < today] if end is None else df


def save_csv(df: pd.DataFrame, path: str | Path) -> Path:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    df.to_csv(path, index_label="date")
    return path


def load_csv(path: str | Path) -> pd.DataFrame:
    df = pd.read_csv(path, parse_dates=["date"], index_col="date")
    missing = set(COLUMNS[:4]) - set(df.columns)
    if missing:
        raise ValueError(f"{path} 缺少列: {sorted(missing)}")
    return df.sort_index()


def load_or_fetch(
    symbol: str,
    start: str,
    end: str | None = None,
    data_dir: str | Path = "data",
    refresh: bool = False,
) -> pd.DataFrame:
    """优先读本地缓存 data/<SYMBOL>_1d.csv，覆盖不了所需区间时重新拉取。"""
    path = Path(data_dir) / f"{symbol.upper()}_1d.csv"
    want_start = pd.Timestamp(start)
    if path.exists() and not refresh:
        cached = load_csv(path)
        covers_end = end is None or cached.index[-1] >= pd.Timestamp(end)
        if cached.index[0] <= want_start and covers_end:
            return cached.loc[start:end]
    df = fetch_binance_daily(symbol, start, end)
    save_csv(df, path)
    return df


def synthetic_daily(
    days: int = 730,
    start_price: float = 30000.0,
    annual_vol: float = 0.6,
    annual_drift: float = 0.0,
    start: str = "2023-01-01",
    seed: int = 42,
) -> pd.DataFrame:
    """几何布朗运动生成的模拟日线，用于离线演示和测试。"""
    rng = np.random.default_rng(seed)
    dt = 1 / 365
    sigma = annual_vol * np.sqrt(dt)
    rets = rng.normal((annual_drift - 0.5 * annual_vol**2) * dt, sigma, days)
    close = start_price * np.exp(np.cumsum(rets))
    open_ = np.concatenate([[start_price], close[:-1]])
    wick = np.abs(rng.normal(0, sigma / 2, (2, days)))
    high = np.maximum(open_, close) * (1 + wick[0])
    low = np.minimum(open_, close) * (1 - wick[1])
    volume = rng.uniform(1_000, 5_000, days)
    index = pd.date_range(start, periods=days, freq="D", name="date")
    return pd.DataFrame(
        {"open": open_, "high": high, "low": low, "close": close, "volume": volume},
        index=index,
    )
