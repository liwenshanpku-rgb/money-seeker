"""AI 波段模拟盘的触发检查（只用标准库，定时任务里不用装依赖就能跑）。

规则（都按 BTC-USD 小时线的最新价格计算）：
- 触发：最近 24 小时涨跌幅绝对值 ≥ 5%，或最近 72 小时 ≥ 8%；
- 冷却：距离上次波段决定不到 48 小时的，价格还要相对上次决定时再变动 ≥ 5% 才触发；
- 上限：最近 7 天最多 3 次波段决定（控制订阅额度）。

输出一行 JSON：{"triggered": bool, "reasons": [...], "price": ..., ...}
用法：python3 scripts/swing_check.py [--journal 本地 swing_decisions.jsonl 路径或 URL]
"""

from __future__ import annotations

import argparse
import json
import urllib.request
from datetime import datetime, timedelta, timezone

PRICE_URL = "https://query1.finance.yahoo.com/v8/finance/chart/BTC-USD?range=7d&interval=1h"
JOURNAL_URL = ("https://raw.githubusercontent.com/liwenshanpku-rgb/money-seeker/"
               "ai-journal/ai_journal/swing_decisions.jsonl")
MOVE_24H, MOVE_72H, MOVE_SINCE_LAST = 0.05, 0.08, 0.05
COOLDOWN = timedelta(hours=48)
MAX_PER_WEEK = 3


def _get(url: str, timeout: float = 20.0) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0", "Cache-Control": "no-cache"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read()


def hourly_prices(raw: bytes) -> list[tuple[datetime, float]]:
    d = json.loads(raw)["chart"]["result"][0]
    closes = d["indicators"]["quote"][0]["close"]
    return [(datetime.fromtimestamp(t, timezone.utc), float(c)) for t, c in zip(d["timestamp"], closes) if c]


def price_at(prices: list[tuple[datetime, float]], when: datetime) -> float:
    """when 之前（含）最近的一个价格。"""
    earlier = [p for t, p in prices if t <= when]
    return earlier[-1] if earlier else prices[0][1]


def read_journal(text: str) -> list[dict]:
    return [json.loads(line) for line in text.splitlines() if line.strip()]


def check(prices: list[tuple[datetime, float]], journal: list[dict], now: datetime | None = None) -> dict:
    now = now or prices[-1][0]
    price = prices[-1][1]
    r24 = price / price_at(prices, now - timedelta(hours=24)) - 1
    r72 = price / price_at(prices, now - timedelta(hours=72)) - 1
    out = {"checked_at": now.isoformat(timespec="minutes"), "price": round(price, 2),
           "ret_24h": round(r24, 4), "ret_72h": round(r72, 4), "triggered": False, "reasons": []}
    if abs(r24) >= MOVE_24H:
        out["reasons"].append(f"24 小时 {r24:+.1%}")
    if abs(r72) >= MOVE_72H:
        out["reasons"].append(f"72 小时 {r72:+.1%}")
    if not out["reasons"]:
        return out
    recent = [r for r in journal if now - datetime.fromisoformat(r["decided_at"]) < timedelta(days=7)]
    if len(recent) >= MAX_PER_WEEK:
        out["blocked"] = f"最近 7 天已有 {len(recent)} 次波段决定（上限 {MAX_PER_WEEK}）"
        return out
    if journal:
        last = journal[-1]
        last_at = datetime.fromisoformat(last["decided_at"])
        moved = price / last["price_at_decision"] - 1
        out.update(last_decision_at=last["decided_at"], since_last=round(moved, 4))
        if now - last_at < COOLDOWN and abs(moved) < MOVE_SINCE_LAST:
            out["blocked"] = f"上次波段决定在 {last['decided_at']}，之后只变动 {moved:+.1%}，仍在冷却期"
            return out
    out["triggered"] = True
    return out


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--journal", default=JOURNAL_URL, help="swing_decisions.jsonl 的本地路径或 URL")
    args = p.parse_args()
    prices = hourly_prices(_get(PRICE_URL))
    try:
        text = (_get(args.journal).decode() if args.journal.startswith("http")
                else open(args.journal, encoding="utf-8").read())
    except Exception:  # noqa: BLE001 - 日志还不存在时按空处理
        text = ""
    print(json.dumps(check(prices, read_journal(text)), ensure_ascii=False))


if __name__ == "__main__":
    main()
