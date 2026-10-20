"""每日执行助手：根据最新日线判断“核心 + 200 日均线（+ 上涨趋势借款）”方案今天该做什么。

规则（与 btc_overlay.trend_weight / btc_loan.levered_trend 的回测一致）：
- 上涨模式：收盘价涨破 200 日均线 × (1 + band) 后进入；跌破 200 日均线 × (1 - band) 后转为下跌模式；
- 上涨模式目标：全部资金持有 BTC；方案 C 再借入“核心价值 × borrow_frac”的稳定币买 BTC；
- 下跌模式目标：只保留 core 比例的 BTC，其余卖出，先还清借款，剩余放美债 / 货币基金；
- 模式切换时按总净值重新计算目标仓位；不切换时不操作。

回测假设在信号出现后的下一个日收盘成交；实际操作在信号出现后 24 小时内完成即可。
"""

from __future__ import annotations

from dataclasses import dataclass

import pandas as pd

from .signals import _stateful


@dataclass
class Plan:
    core: float = 0.5           # 永远持有的比例
    sma_days: int = 200
    band: float = 0.03
    borrow_frac: float = 0.0    # 上涨模式借款 = 核心价值 × borrow_frac（方案 C 用 0.5）
    ltv_warn: float = 0.35      # 负债 / BTC 抵押品 超过它时提醒（回测历史最高约 24%）
    ltv_act: float = 0.45       # 超过它时主动还款降到 borrow 时的水平


def regimes(close: pd.Series, plan: Plan) -> pd.DataFrame:
    """逐日计算均线、上下阈值和模式（True = 上涨模式）。"""
    sma = close.rolling(plan.sma_days).mean()
    upper, lower = sma * (1 + plan.band), sma * (1 - plan.band)
    up = _stateful((close > upper).fillna(False), (close < lower).fillna(False)).astype(bool)
    return pd.DataFrame({"close": close, "sma": sma, "upper": upper, "lower": lower, "up": up})


def targets(equity: float, price: float, up: bool, plan: Plan) -> dict:
    """给定总净值（BTC 市值 + 现金 − 负债），返回目标 BTC 数量、借款和现金。"""
    if up:
        debt = equity * plan.core * plan.borrow_frac
        return {"btc": (equity + debt) / price, "debt": debt, "cash": 0.0}
    return {"btc": equity * plan.core / price, "debt": 0.0, "cash": equity * (1 - plan.core)}


def daily_report(
    close: pd.Series, plan: Plan, btc: float | None = None, cash: float = 0.0, debt: float = 0.0,
) -> dict:
    """生成当天的状态与操作建议。close 为已收盘的日线收盘价（最后一行是最近一个完整交易日）。"""
    if len(close.dropna()) < plan.sma_days + 1:
        raise ValueError(f"至少需要 {plan.sma_days + 1} 根日线")
    r = regimes(close, plan)
    last, prev = r.iloc[-1], r.iloc[-2]
    switched = bool(last["up"]) != bool(prev["up"])
    since = r.index[(r["up"] != r["up"].shift()).to_numpy()][-1]
    out = {
        "date": r.index[-1].date().isoformat(), "close": float(last["close"]), "sma": float(last["sma"]),
        "upper": float(last["upper"]), "lower": float(last["lower"]),
        "mode": "UP" if last["up"] else "DOWN", "mode_since": since.date().isoformat(),
        "switched_today": switched,
        # 价格要再变动多少才会切换：上涨模式为负数（需下跌），下跌模式为正数（需上涨）
        "distance_to_switch": float((last["lower"] if last["up"] else last["upper"]) / last["close"] - 1),
        "actions": [], "alerts": [],
    }
    if btc is None:
        out["actions"].append("切换模式时才需要操作。" if not switched else
                              f"模式切换为 {out['mode']}：请带上 --btc/--cash/--debt 重新运行，计算具体下单数量。")
        return out

    price = out["close"]
    equity = btc * price + cash - debt
    out["equity"] = equity
    ltv = debt / (btc * price) if btc > 0 else 0.0
    out["ltv"] = ltv
    goal = targets(equity, price, bool(last["up"]), plan)
    out["target"] = goal
    if switched:
        d_btc = goal["btc"] - btc
        if last["up"]:
            if cash > 0:
                out["actions"].append(f"赎回美债/货币基金 {cash:,.0f} USD，换成 USDT/USDC")
            if goal["debt"] > debt:
                out["actions"].append(f"以 BTC 作抵押借入 {goal['debt'] - debt:,.0f} USD（借款后 LTV ≈ "
                                      f"{goal['debt'] / (goal['btc'] * price):.0%}）")
            out["actions"].append(f"买入 {d_btc:.6f} BTC（约 {d_btc * price:,.0f} USD），之后 BTC 共 {goal['btc']:.6f}")
        else:
            out["actions"].append(f"卖出 {-d_btc:.6f} BTC（约 {-d_btc * price:,.0f} USD），保留 {goal['btc']:.6f} BTC 核心仓位")
            if debt > 0:
                out["actions"].append(f"先用卖出所得还清全部借款 {debt:,.0f} USD")
            out["actions"].append(f"剩余约 {goal['cash']:,.0f} USD 买入美债 / 货币基金")
    else:
        out["actions"].append("无需交易。")
        drift = abs(btc - goal["btc"]) * price / equity if equity > 0 else 0.0
        if drift > 0.05:
            out["alerts"].append(f"当前持仓与 {out['mode']} 模式目标相差 {drift:.0%} 的净值；"
                                 "如果是刚开始执行本方案，请按目标仓位调整一次（见操作手册“开始执行”）")
    if debt > 0:
        if ltv >= plan.ltv_act:
            repay = debt - 0.20 * btc * price  # 用场外资金还款，把 LTV 降回 20%
            out["alerts"].append(f"LTV {ltv:.0%} ≥ {plan.ltv_act:.0%}：立即还款或补充抵押品，"
                                 f"建议先还约 {max(repay, 0):,.0f} USD，把 LTV 降回 20% 左右")
        elif ltv >= plan.ltv_warn:
            out["alerts"].append(f"LTV {ltv:.0%} ≥ {plan.ltv_warn:.0%}：高于历史正常水平，准备好还款资金，明天再检查")
    return out


def format_report(rep: dict) -> str:
    lines = [
        f"日期（UTC 收盘）: {rep['date']}",
        f"BTC 收盘价: {rep['close']:,.0f}   200 日均线: {rep['sma']:,.0f}",
        f"进入上涨线: {rep['upper']:,.0f}   退出线: {rep['lower']:,.0f}",
        f"当前模式: {rep['mode']}（自 {rep['mode_since']} 起）" + ("  ← 今天刚切换！" if rep["switched_today"] else ""),
        (f"离切换为下跌模式: 价格还需下跌 {-rep['distance_to_switch']:.1%}" if rep["mode"] == "UP"
         else f"离切换为上涨模式: 价格还需上涨 {rep['distance_to_switch']:.1%}"),
    ]
    if "equity" in rep:
        lines.append(f"总净值: {rep['equity']:,.0f} USD   LTV: {rep['ltv']:.1%}")
        t = rep["target"]
        lines.append(f"目标仓位: BTC {t['btc']:.6f}  借款 {t['debt']:,.0f} USD  现金 {t['cash']:,.0f} USD")
    lines.append("操作:")
    lines += [f"  - {a}" for a in rep["actions"]]
    if rep["alerts"]:
        lines.append("提醒:")
        lines += [f"  ! {a}" for a in rep["alerts"]]
    return "\n".join(lines)
