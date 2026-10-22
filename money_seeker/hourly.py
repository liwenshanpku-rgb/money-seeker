"""BTC 小时线：数据下载（Coinbase，失败时用 Bitstamp）。

两个都是公开接口，不需要密钥。索引为 K 线开始时间（UTC），close 是这一小时结束时的价格。
"""

from __future__ import annotations

import time
from datetime import datetime, timedelta, timezone

import pandas as pd
import requests

HEADERS = {"User-Agent": "money-seeker-research"}


def _coinbase_chunk(start: datetime, end: datetime, product: str, timeout: float) -> list:
    resp = requests.get(f"https://api.exchange.coinbase.com/products/{product}/candles",
                        params={"granularity": 3600, "start": start.isoformat(), "end": end.isoformat()},
                        headers=HEADERS, timeout=timeout)
    resp.raise_for_status()
    return resp.json()  # [[time, low, high, open, close, volume], ...]，时间倒序


def fetch_coinbase(start: str, end: str | None = None, product: str = "BTC-USD",
                   pause: float = 0.2, timeout: float = 20.0) -> pd.DataFrame:
    t0 = pd.Timestamp(start, tz="UTC").to_pydatetime()
    t_end = pd.Timestamp(end, tz="UTC").to_pydatetime() if end else datetime.now(timezone.utc)
    rows: list = []
    while t0 < t_end:
        t1 = min(t0 + timedelta(hours=300), t_end)
        for attempt in range(5):
            try:
                rows += _coinbase_chunk(t0, t1, product, timeout)
                break
            except requests.RequestException:
                if attempt == 4:
                    raise
                time.sleep(2 ** attempt)
        t0 = t1
        time.sleep(pause)
    df = pd.DataFrame(rows, columns=["time", "low", "high", "open", "close", "volume"])
    return _finish(df)


def fetch_bitstamp(start: str, end: str | None = None, pair: str = "btcusd",
                   pause: float = 0.2, timeout: float = 20.0) -> pd.DataFrame:
    t0 = int(pd.Timestamp(start, tz="UTC").timestamp())
    t_end = int(pd.Timestamp(end, tz="UTC").timestamp()) if end else int(time.time())
    rows: list = []
    while t0 < t_end:
        resp = requests.get(f"https://www.bitstamp.net/api/v2/ohlc/{pair}/",
                            params={"step": 3600, "limit": 1000, "start": t0}, headers=HEADERS, timeout=timeout)
        resp.raise_for_status()
        chunk = resp.json()["data"]["ohlc"]
        if not chunk:
            break
        rows += [[int(r["timestamp"]), r["low"], r["high"], r["open"], r["close"], r["volume"]] for r in chunk]
        t0 = int(chunk[-1]["timestamp"]) + 3600
        time.sleep(pause)
    df = pd.DataFrame(rows, columns=["time", "low", "high", "open", "close", "volume"])
    return _finish(df[df["time"] < t_end])


def _finish(df: pd.DataFrame) -> pd.DataFrame:
    df = df.astype(float).drop_duplicates("time").sort_values("time")
    df.index = pd.to_datetime(df.pop("time").astype("int64"), unit="s").rename("time")
    now_hour = pd.Timestamp.now(tz="UTC").tz_localize(None).floor("h")
    return df[df.index < now_hour][["open", "high", "low", "close", "volume"]]  # 去掉还没走完的这一小时


def fetch(start: str = "2016-01-01", end: str | None = None) -> pd.DataFrame:
    try:
        return fetch_coinbase(start, end)
    except requests.RequestException as err:
        print(f"Coinbase 失败，改用 Bitstamp：{err}")
        return fetch_bitstamp(start, end)
