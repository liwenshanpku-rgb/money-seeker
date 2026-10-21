"""公开信号文件：方案 B / 方案 C 的目标仓位 + AI 顾问的最新决定，不含任何持仓。

由 GitHub Actions 每天日线收盘后生成，提交到 ai-journal 分支的 signal/latest.json，
本地下单程序（例如 schwab 项目）只读这一个地址，再结合自己读到的 Kraken 余额算出下单数量。

字段说明见 reports/signal.md；本地读取和校验示例见 examples/read_signal.py。
仓库是公开的：这里只放行情推导出来的信号，余额、净值、下单数量都不能出现。
"""

from __future__ import annotations

from datetime import datetime, timezone

import pandas as pd

from .today import Plan, daily_report, targets

SCHEMA_VERSION = 1
AI_STALE_DAYS = 9   # 周更的 AI 决定超过 9 天没更新视为过期（与 brief 一致）


class StaleData(RuntimeError):
    pass


def target_pct(up: bool, plan: Plan) -> float:
    """目标 BTC 市值 / 净值 × 100（与净值大小无关）。"""
    t = targets(1.0, 1.0, up, plan)
    return round(t["btc"] * 100, 4)


def build(close: pd.Series, ai: dict | None, plan_b: Plan | None = None, plan_c: Plan | None = None,
          now: datetime | None = None, max_close_age_days: int = 1) -> dict:
    """生成公开信号（纯函数）。最近一根收盘 K 线太旧时抛 StaleData，宁可不发也不发旧信号。"""
    now = now or datetime.now(timezone.utc)
    plan_b = plan_b or Plan()
    plan_c = plan_c or Plan(borrow_frac=0.5)
    rep = daily_report(close, plan_b)
    close_age = (now.date() - pd.Timestamp(rep["date"]).date()).days
    if close_age > max_close_age_days:
        raise StaleData(f"最新日线收盘是 {rep['date']}，已过去 {close_age} 天")
    up = rep["mode"] == "UP"
    sig = {
        "schema_version": SCHEMA_VERSION,
        "generated_at": now.isoformat(timespec="seconds"),
        "as_of_close_utc": rep["date"],
        "price": rep["close"],
        "price_source": "kraken XBTUSD 1d",
        "plan_b": {
            "mode": rep["mode"], "mode_since": rep["mode_since"], "switched_today": rep["switched_today"],
            "target_pct": target_pct(up, plan_b),
            "sma": round(rep["sma"], 2), "upper": round(rep["upper"], 2), "lower": round(rep["lower"], 2),
            "distance_to_switch": round(rep["distance_to_switch"], 6),
            "params": {"core": plan_b.core, "sma_days": plan_b.sma_days, "band": plan_b.band},
        },
        # 方案 C 与方案 B 模式相同（同一条均线），只是上涨模式多借“核心价值 × borrow_frac”
        "plan_c": {"target_pct": target_pct(up, plan_c), "borrow_frac": plan_c.borrow_frac},
        "ai": None,
    }
    if ai:
        age = (now.date() - pd.Timestamp(ai["as_of_close_utc"]).date()).days
        sig["ai"] = {"target_pct": ai["final_pct"], "as_of_close_utc": ai["as_of_close_utc"],
                     "decided_at": ai.get("decided_at"), "confidence": ai.get("confidence"),
                     "stance": ai.get("stance"), "age_days": age, "stale": age > AI_STALE_DAYS}
    return sig
