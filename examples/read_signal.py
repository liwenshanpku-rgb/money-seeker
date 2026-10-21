"""本地下单程序读取 money-seeker 公开信号的示例（只依赖 requests，可以直接复制到 schwab 项目）。

原则：任何一项校验不过就返回 None —— 调用方看到 None 就“今天不动”，绝不按猜测下单。

用法：
    sig = fetch_signal()
    pct = target_pct(sig, source="plan_b")          # 或 "plan_c" / "ai"
    if pct is not None:
        pct = limit_step(current_pct, pct, max_step=25)
        ...用 Kraken 余额算出要买卖多少 BTC，再下单...

字段说明见 reports/signal.md。
"""

from __future__ import annotations

import time
from datetime import datetime, timedelta, timezone

import requests

SIGNAL_URL = ("https://raw.githubusercontent.com/liwenshanpku-rgb/money-seeker/"
              "ai-journal/signal/latest.json")
SCHEMA_VERSION = 1
MAX_SIGNAL_AGE = timedelta(hours=36)     # 每天 00:45 UTC 发布；超过 36 小时说明当天的任务失败了
MAX_CLOSE_AGE_DAYS = 2
MAX_PCT = 150.0


def fetch_signal(url: str = SIGNAL_URL, retries: int = 3, timeout: float = 15.0) -> dict | None:
    for attempt in range(retries):
        try:
            resp = requests.get(url, timeout=timeout, headers={"Cache-Control": "no-cache"})
            resp.raise_for_status()
            sig = resp.json()
            return sig if validate(sig) else None
        except (requests.RequestException, ValueError) as err:
            print(f"读取信号失败（第 {attempt + 1} 次）：{err}")
            time.sleep(2 ** attempt)
    return None


def validate(sig: dict, now: datetime | None = None) -> bool:
    now = now or datetime.now(timezone.utc)
    try:
        if sig["schema_version"] != SCHEMA_VERSION:
            print(f"信号版本 {sig['schema_version']} 与读取程序 {SCHEMA_VERSION} 不一致，请先更新读取程序")
            return False
        generated = datetime.fromisoformat(sig["generated_at"])
        if not timedelta(minutes=-5) <= now - generated <= MAX_SIGNAL_AGE:
            print(f"信号生成于 {sig['generated_at']}，太旧或时间异常")
            return False
        close_day = datetime.fromisoformat(sig["as_of_close_utc"]).date()
        if (now.date() - close_day).days > MAX_CLOSE_AGE_DAYS:
            print(f"信号基于 {sig['as_of_close_utc']} 的收盘，太旧")
            return False
        b = sig["plan_b"]
        if b["mode"] not in ("UP", "DOWN") or not 0 <= b["target_pct"] <= 100:
            print("方案 B 字段异常")
            return False
        if not 0 <= sig["plan_c"]["target_pct"] <= MAX_PCT:
            print("方案 C 字段异常")
            return False
        if sig["price"] <= 0:
            return False
    except (KeyError, TypeError, ValueError) as err:
        print(f"信号格式错误：{err}")
        return False
    return True


def target_pct(sig: dict | None, source: str = "plan_b") -> float | None:
    """目标 BTC 仓位（BTC 市值 / 净值 × 100）；拿不到可信数值时返回 None。"""
    if sig is None:
        return None
    if source in ("plan_b", "plan_c"):
        return float(sig[source]["target_pct"])
    if source == "ai":
        ai = sig.get("ai")
        if not ai or ai.get("stale") or not isinstance(ai.get("target_pct"), (int, float)):
            print("AI 决定缺失或已过期")
            return None
        pct = float(ai["target_pct"])
        return pct if 0 <= pct <= MAX_PCT else None
    raise ValueError(f"未知信号来源：{source}")


def limit_step(current_pct: float, target: float, max_step: float = 25.0) -> float:
    """单次调仓最多变动 max_step 个百分点（方案 B 切换时一次是 50 点，用 B 时请调大或不调用）。"""
    return max(current_pct - max_step, min(current_pct + max_step, target))


if __name__ == "__main__":
    s = fetch_signal()
    if s is None:
        print("信号不可用：今天不操作")
    else:
        print(f"{s['as_of_close_utc']} 收盘 {s['price']:,.0f}，方案 B {s['plan_b']['mode']} → {target_pct(s, 'plan_b'):.0f}%，"
              f"方案 C → {target_pct(s, 'plan_c'):.0f}%，AI → {target_pct(s, 'ai')}")
