"""Kraken 只读同步：读取账户余额和 BTC 价格，算出当前 BTC 仓位。

只用两个接口：
- 公开行情 /0/public/Ticker（不需要密钥）；
- 私有余额 /0/private/Balance（API 密钥只需要“Query Funds”权限，不要开交易和提币权限）。

密钥从环境变量 KRAKEN_API_KEY / KRAKEN_API_SECRET 读取，不作为命令行参数，避免留在命令历史里。
本模块只在你自己的电脑上使用：仓库公开，GitHub Actions 的日志也公开，余额不能出现在那里。
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import os
import time
import urllib.parse
from dataclasses import dataclass, field

import requests

API_URL = "https://api.kraken.com"

# Kraken 的余额代码可能带后缀：.F（灵活理财）、.B / .S（质押）、.HOLD（冻结）等，按前缀归类
BTC_CODES = {"XXBT", "XBT"}
CASH_CODES = {"ZUSD", "USD", "USDT", "USDC", "USDG", "PYUSD", "DAI"}


class KrakenError(RuntimeError):
    pass


def sign(uri_path: str, nonce: str, post_data: str, secret_b64: str) -> str:
    """API-Sign = base64(HMAC-SHA512(base64decode(secret), uri_path + SHA256(nonce + post_data)))。"""
    message = uri_path.encode() + hashlib.sha256((nonce + post_data).encode()).digest()
    mac = hmac.new(base64.b64decode(secret_b64), message, hashlib.sha512)
    return base64.b64encode(mac.digest()).decode()


def credentials() -> tuple[str, str]:
    key, secret = os.environ.get("KRAKEN_API_KEY"), os.environ.get("KRAKEN_API_SECRET")
    if not key or not secret:
        raise KrakenError("缺少 Kraken 密钥：请设置环境变量 KRAKEN_API_KEY 和 KRAKEN_API_SECRET（只读权限）")
    return key, secret


def private(method: str, key: str, secret: str, params: dict | None = None, timeout: float = 15.0) -> dict:
    uri_path = f"/0/private/{method}"
    nonce = str(int(time.time() * 1000))
    data = {"nonce": nonce, **(params or {})}
    post_data = urllib.parse.urlencode(data)
    headers = {"API-Key": key, "API-Sign": sign(uri_path, nonce, post_data, secret),
               "Content-Type": "application/x-www-form-urlencoded; charset=utf-8"}
    resp = requests.post(API_URL + uri_path, data=post_data, headers=headers, timeout=timeout)
    resp.raise_for_status()
    body = resp.json()
    if body.get("error"):
        raise KrakenError(f"Kraken 返回错误：{', '.join(body['error'])}")
    return body["result"]


def btc_price(pair: str = "XBTUSD", timeout: float = 15.0) -> float:
    resp = requests.get(f"{API_URL}/0/public/Ticker", params={"pair": pair}, timeout=timeout)
    resp.raise_for_status()
    body = resp.json()
    if body.get("error"):
        raise KrakenError(f"Kraken 返回错误：{', '.join(body['error'])}")
    ticker = next(iter(body["result"].values()))
    return float(ticker["c"][0])  # 最新成交价


def daily_closes(pair: str = "XBTUSD", timeout: float = 15.0):
    """Kraken 公开日线收盘价（最多约 720 天），去掉还没收盘的当天 K 线。

    索引按本项目的约定：D 日的收盘价 = D+1 日 00:00 UTC 的价格，标签为 D。
    """
    import pandas as pd

    resp = requests.get(f"{API_URL}/0/public/OHLC", params={"pair": pair, "interval": 1440}, timeout=timeout)
    resp.raise_for_status()
    body = resp.json()
    if body.get("error"):
        raise KrakenError(f"Kraken 返回错误：{', '.join(body['error'])}")
    rows = next(v for k, v in body["result"].items() if k != "last")
    rows = rows[:-1]  # 最后一根是还在进行中的当天 K 线
    idx = pd.to_datetime([int(r[0]) for r in rows], unit="s")
    return pd.Series([float(r[4]) for r in rows], index=idx.rename("date"), name="close")


@dataclass
class Holdings:
    btc: float
    cash_usd: float
    price: float
    other: dict = field(default_factory=dict)  # 没计入的其他资产（代码 → 数量）

    @property
    def btc_value(self) -> float:
        return self.btc * self.price

    def pct(self, debt: float = 0.0) -> float | None:
        equity = self.btc_value + self.cash_usd - debt
        return self.btc_value / equity * 100 if equity > 0 else None


def classify(balances: dict) -> tuple[float, float, dict]:
    """把 Balance 接口返回的 {代码: 数量} 归成 BTC、美元现金和其他。"""
    btc = cash = 0.0
    other: dict = {}
    for code, amount in balances.items():
        qty = float(amount)
        if qty == 0:
            continue
        base = code.split(".")[0]
        if base in BTC_CODES:
            btc += qty
        elif base in CASH_CODES:
            cash += qty
        else:
            other[code] = qty
    return btc, cash, other


def holdings() -> Holdings:
    key, secret = credentials()
    btc, cash, other = classify(private("Balance", key, secret))
    return Holdings(btc=btc, cash_usd=cash, price=btc_price(), other=other)


def format_holdings(h: Holdings, debt: float = 0.0) -> str:
    lines = [
        f"BTC: {h.btc:.8f}（约 {h.btc_value:,.0f} USD，价格 {h.price:,.0f}）",
        f"美元及稳定币: {h.cash_usd:,.2f}",
    ]
    if debt:
        lines.append(f"外部借款（手动输入）: {debt:,.2f}")
    pct = h.pct(debt)
    lines.append(f"当前 BTC 仓位: {pct:.1f}%" if pct is not None else "当前 BTC 仓位: 无法计算（净值 ≤ 0）")
    if h.other:
        lines.append("未计入的其他资产: " + ", ".join(f"{k} {v:g}" for k, v in sorted(h.other.items())))
    return "\n".join(lines)
