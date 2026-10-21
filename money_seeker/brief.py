"""本地每日简报：结合 Kraken 真实持仓、方案 B（200 日均线）和 AI 顾问的最新决定，通过 Bark 推送。

在你自己的电脑上每天运行一次（日线收盘后，例如北京时间 08:45）。只读，不下单：
1. Kraken 公开日线 → 200 日均线模式（方案 B）；
2. Kraken 余额（只读密钥）→ 当前 BTC 仓位；
3. AI 顾问最新决定：GitHub 上公开的 ai-journal/decisions.jsonl（不含任何持仓信息）；
4. 算出两种方案各需要买卖多少，写入本地 state/latest_signal.json（供其他本地程序读取）；
5. 只在值得看的时候推送：方案 B 切换、LTV 告警、AI 出了新决定、每周一汇总，或手动要求。
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

import pandas as pd
import requests

from . import notify
from .ai_advisor import orders
from .today import Plan, daily_report

AI_JOURNAL_URL = ("https://raw.githubusercontent.com/liwenshanpku-rgb/money-seeker/"
                  "ai-journal/ai_journal/decisions.jsonl")


def fetch_ai_decision(url: str = AI_JOURNAL_URL, timeout: float = 15.0) -> dict | None:
    """AI 顾问最近一次决定；拿不到时返回 None（不影响方案 B 的提醒）。"""
    try:
        resp = requests.get(url, timeout=timeout)
        resp.raise_for_status()
        lines = [line for line in resp.text.splitlines() if line.strip()]
        return json.loads(lines[-1]) if lines else None
    except Exception as err:  # noqa: BLE001
        print(f"（AI 决定获取失败，跳过：{err}）")
        return None


def build(close: pd.Series, btc: float, cash: float, debt: float, plan: Plan,
          ai: dict | None, now: datetime | None = None) -> dict:
    """计算简报内容（纯函数，便于测试）。"""
    now = now or datetime.now(timezone.utc)
    rep = daily_report(close, plan, btc, cash, debt)
    price = rep["close"]
    signal = {
        "generated_at": now.isoformat(timespec="seconds"),
        "price": price, "as_of_close_utc": rep["date"],
        "holdings": {"btc": btc, "cash_usd": cash, "debt_usd": debt,
                     "equity_usd": rep["equity"], "btc_pct": btc * price / rep["equity"] * 100 if rep["equity"] > 0 else None,
                     "ltv": rep["ltv"]},
        "plan_b": {
            "mode": rep["mode"], "mode_since": rep["mode_since"], "switched_today": rep["switched_today"],
            "sma": rep["sma"], "upper": rep["upper"], "lower": rep["lower"],
            "distance_to_switch": rep["distance_to_switch"],
            "target_pct": rep["target"]["btc"] * price / rep["equity"] * 100 if rep["equity"] > 0 else None,
            "target": rep["target"], "actions": rep["actions"], "alerts": rep["alerts"],
        },
        "ai": None,
    }
    if ai:
        age = (now.date() - pd.Timestamp(ai["as_of_close_utc"]).date()).days
        o = orders(ai["final_pct"], price, btc, cash, debt)
        signal["ai"] = {"as_of_close_utc": ai["as_of_close_utc"], "decided_at": ai.get("decided_at"),
                        "target_pct": ai["final_pct"], "confidence": ai.get("confidence"),
                        "stance": ai.get("stance"), "age_days": age, "orders": o,
                        "stale": age > 9}
    return signal


def push_reasons(signal: dict, state: dict, now: datetime, always: bool = False) -> tuple[list[str], bool]:
    """要不要推送、为什么推送；第二个返回值表示是否紧急（穿透专注模式）。"""
    reasons, urgent = [], False
    pb = signal["plan_b"]
    if pb["switched_today"]:
        reasons.append(f"方案 B 切换为{'上涨' if pb['mode'] == 'UP' else '下跌'}模式")
        urgent = True
    if any("LTV" in a for a in pb["alerts"]):
        reasons.append("借款 LTV 告警")
        urgent = True
    ai = signal.get("ai")
    if ai and ai["as_of_close_utc"] != state.get("last_ai_as_of"):
        reasons.append("AI 顾问有新决定")
    if ai and ai["stale"] and state.get("last_stale_warned") != ai["as_of_close_utc"]:
        reasons.append("AI 决定超过 9 天没有更新")
    today = now.date().isoformat()
    if now.weekday() == 0 and state.get("last_weekly") != today:
        reasons.append("每周汇总")
    if always and not reasons:
        reasons.append("手动推送")
    return reasons, urgent


def format_message(signal: dict, reasons: list[str]) -> tuple[str, str]:
    pb, h, ai = signal["plan_b"], signal["holdings"], signal.get("ai")
    title = ("⚠️ BTC 调仓信号" if pb["switched_today"] else "BTC 每日简报") + "：" + "、".join(reasons)
    dist = pb["distance_to_switch"]
    lines = [
        f"价格 {signal['price']:,.0f}（{signal['as_of_close_utc']} 收盘），200 日均线 {pb['sma']:,.0f}",
        f"方案 B：{'上涨' if pb['mode'] == 'UP' else '下跌'}模式"
        + (f"（再跌 {-dist:.1%} 转下跌）" if pb["mode"] == "UP" else f"（再涨 {dist:.1%} 转上涨）"),
        f"当前：BTC {h['btc']:.4f}，现金 {h['cash_usd']:,.0f}" + (f"，借款 {h['debt_usd']:,.0f}" if h["debt_usd"] else "")
        + (f"，仓位 {h['btc_pct']:.0f}%" if h["btc_pct"] is not None else ""),
        f"方案 B 目标 {pb['target_pct']:.0f}%：" + "；".join(pb["actions"]),
    ]
    if ai:
        o = ai["orders"]
        trade = f"BTC {o['trade_btc']:+.4f}" if abs(o["trade_btc"]) * signal["price"] >= 1 else "无需交易"
        lines.append(f"AI 建议 {ai['target_pct']}%（{ai['confidence']}，{ai['as_of_close_utc']}）：{trade}"
                     + ("，数据已过期" if ai["stale"] else ""))
    lines += [f"! {a}" for a in pb["alerts"]]
    return title, "\n".join(lines)


def run(close: pd.Series, btc: float, cash: float, debt: float, plan: Plan, state_dir: str | Path = "state",
        ai_url: str = AI_JOURNAL_URL, push: bool = True, always_push: bool = False,
        now: datetime | None = None) -> dict:
    """完整流程：计算 → 写信号文件 → 按规则推送 → 更新状态。返回信号字典（含 pushed / reasons）。"""
    now = now or datetime.now(timezone.utc)
    state_dir = Path(state_dir)
    state_dir.mkdir(parents=True, exist_ok=True)
    state_path = state_dir / "brief_state.json"
    state = json.loads(state_path.read_text()) if state_path.exists() else {}

    signal = build(close, btc, cash, debt, plan, fetch_ai_decision(ai_url), now)
    reasons, urgent = push_reasons(signal, state, now, always_push)
    title, body = format_message(signal, reasons or ["无需推送"])
    signal["reasons"], signal["message"] = reasons, {"title": title, "body": body}
    (state_dir / "latest_signal.json").write_text(json.dumps(signal, ensure_ascii=False, indent=2))

    pushed = False
    if reasons and push:
        pushed = notify.send(body, title=title, level="timeSensitive" if urgent else None)
    signal["pushed"] = pushed
    if reasons and pushed:  # 只有推送成功才记账；没推送或推送失败时下次再试
        if signal.get("ai"):
            state["last_ai_as_of"] = signal["ai"]["as_of_close_utc"]
            if signal["ai"]["stale"]:
                state["last_stale_warned"] = signal["ai"]["as_of_close_utc"]
        if now.weekday() == 0:
            state["last_weekly"] = now.date().isoformat()
        state["last_push_at"] = now.isoformat(timespec="seconds")
        state_path.write_text(json.dumps(state, ensure_ascii=False, indent=2))
    return signal
