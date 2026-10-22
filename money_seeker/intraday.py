"""小时线动量（日内 / 超短线）回测：样本内选参、样本外检验、手续费敏感性、安慰剂检验、交易边际。

约定：
- 第 t 小时收盘时算信号，第 t+1+lag 小时开始持仓（lag=0 表示收盘后立刻按收盘价成交，偏乐观）；
- 成本按单边费率 × 仓位变动量收取（0→1 或 1→0 收一次，−1→1 收两次）；
- 只做多 / 空仓用现货；多空双向需要永续合约，资金费率没有计入（对多空大致抵消，但不是 0）；
- 绩效按日末净值计算（与本项目其他研究可比）。
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import pandas as pd

from .metrics import summarize

COSTS = [0.0, 0.0005, 0.001, 0.0025, 0.004]   # 单边：无成本、永续 / 高等级挂单、挂单、Kraken 入门挂单、入门吃单
IS_END, OOS_START = "2021-12-31 23:00", "2022-01-01"


# ---------- 信号：返回目标仓位（1 / 0 / −1），在该小时收盘时决定 ----------

def tsmom(close: pd.Series, n: int, short: bool = False) -> pd.Series:
    r = close / close.shift(n) - 1
    return np.sign(r).clip(lower=-1 if short else 0).fillna(0)


def ema_cross(close: pd.Series, fast: int, slow: int, short: bool = False) -> pd.Series:
    d = close.ewm(span=fast, adjust=False).mean() - close.ewm(span=slow, adjust=False).mean()
    return np.sign(d).clip(lower=-1 if short else 0).fillna(0)


def breakout(close: pd.Series, n: int, short: bool = False) -> pd.Series:
    """突破过去 n 小时最高价做多，跌破过去 n/2 小时最低价离场（做空对称）。"""
    hi, lo = close.shift(1).rolling(n).max(), close.shift(1).rolling(n).min()
    hi2, lo2 = close.shift(1).rolling(max(n // 2, 1)).max(), close.shift(1).rolling(max(n // 2, 1)).min()
    pos, cur = np.zeros(len(close)), 0.0
    c, a, b, x, y = close.to_numpy(), hi.to_numpy(), lo.to_numpy(), hi2.to_numpy(), lo2.to_numpy()
    for i in range(len(c)):
        if cur == 1 and c[i] < y[i]:
            cur = 0.0
        elif cur == -1 and c[i] > x[i]:
            cur = 0.0
        if cur == 0:
            if c[i] > a[i]:
                cur = 1.0
            elif short and c[i] < b[i]:
                cur = -1.0
        pos[i] = cur
    return pd.Series(pos, index=close.index)


def day_momentum(close: pd.Series, hour: int, short: bool = False) -> pd.Series:
    """日内动量：UTC 当天 00:00 到 hour:00 的涨跌决定当天剩余几小时的方向，日末平仓。"""
    day = close.index.normalize()
    day_open = close.groupby(day).transform("first")  # 当天第一根收盘（00:00–01:00）近似开盘
    first_part = close / day_open - 1
    h = close.index.hour
    sig = pd.Series(np.nan, index=close.index)
    sig[h == hour - 1] = np.sign(first_part[h == hour - 1])  # hour:00 的价格 = (hour−1) 那根 K 线的收盘
    sig[h == 23] = 0.0  # 23:00 那根收盘 = 24:00，平仓
    sig = sig.groupby(day).ffill().fillna(0)
    return sig.clip(lower=-1 if short else 0)


@dataclass
class Spec:
    family: str
    params: dict
    short: bool

    def signal(self, close: pd.Series) -> pd.Series:
        fn = {"tsmom": tsmom, "ema": ema_cross, "breakout": breakout, "daymom": day_momentum}[self.family]
        return fn(close, **self.params, short=self.short)

    @property
    def name(self) -> str:
        p = ",".join(f"{k}={v}" for k, v in self.params.items())
        return f"{self.family}({p}){' 多空' if self.short else ''}"


def grid() -> list[Spec]:
    specs = []
    for short in (False, True):
        specs += [Spec("tsmom", {"n": n}, short) for n in (1, 2, 3, 6, 12, 24, 48, 72, 168)]
        specs += [Spec("ema", {"fast": f, "slow": s}, short) for f in (3, 6, 12, 24) for s in (24, 48, 96, 168) if f < s]
        specs += [Spec("breakout", {"n": n}, short) for n in (6, 12, 24, 48, 96, 168)]
        specs += [Spec("daymom", {"hour": h}, short) for h in (6, 12, 16, 18, 20, 22)]
    return specs


# ---------- 回测 ----------

def backtest(close: pd.Series, pos: pd.Series, cost: float, lag: int = 0) -> pd.DataFrame:
    held = pos.shift(1 + lag).fillna(0)
    ret = close.pct_change().fillna(0)
    turnover = held.diff().abs().fillna(held.abs())
    net = held * ret - turnover * cost
    equity = (1 + net).cumprod()
    return pd.DataFrame({"held": held, "gross": held * ret, "net": net, "turnover": turnover, "equity": equity})


def daily(equity: pd.Series) -> pd.Series:
    return equity.resample("D").last().dropna()


def stats(bt: pd.DataFrame) -> dict:
    s = summarize(daily(bt["equity"]))
    years = len(bt) / 8760
    trades = bt["turnover"].sum() / 2  # 一进一出算一次
    gross_total = bt["gross"].sum()
    return {
        "annual_return": s["annual_return"], "sharpe": s["sharpe"], "max_drawdown": s["max_drawdown"],
        "trades_per_year": trades / years, "exposure": float(bt["held"].abs().mean()),
        # 每一次来回（一进一出）平均赚多少（未扣成本，单位：基点）；低于 2 × 单边成本就必亏
        "gross_bp_per_trade": gross_total / trades * 1e4 if trades else float("nan"),
    }


def evaluate(close: pd.Series, specs: list[Spec], cost: float, lag: int = 0) -> pd.DataFrame:
    rows = []
    for sp in specs:
        pos = sp.signal(close)
        bt = backtest(close, pos, cost, lag)
        ins, oos = bt.loc[:IS_END], bt.loc[OOS_START:]
        oos = oos.assign(equity=(1 + oos["net"]).cumprod())
        ins = ins.assign(equity=(1 + ins["net"]).cumprod())
        a, b = stats(ins), stats(oos)
        rows.append({"strategy": sp.name, "family": sp.family, "short": sp.short,
                     **{f"is_{k}": v for k, v in a.items()}, **{f"oos_{k}": v for k, v in b.items()}})
    return pd.DataFrame(rows)


def buy_hold(close: pd.Series) -> dict:
    out = {}
    for label, part in (("is", close.loc[:IS_END]), ("oos", close.loc[OOS_START:])):
        s = summarize(daily(part / part.iloc[0]))
        out[label] = {"annual_return": s["annual_return"], "sharpe": s["sharpe"], "max_drawdown": s["max_drawdown"]}
    return out


def placebo(close: pd.Series, spec: Spec, cost: float, n: int = 200, seed: int = 0) -> dict:
    """把信号整体平移随机时长（≥ 30 天），保留交易频率和持仓比例，打乱它和价格的对应关系。"""
    rng = np.random.default_rng(seed)
    part = close.loc[OOS_START:]
    pos = spec.signal(close).loc[OOS_START:]
    real = stats(backtest(part, pos, cost))["sharpe"]
    sims = []
    for _ in range(n):
        k = int(rng.integers(24 * 30, len(pos) - 24 * 30))
        fake = pd.Series(np.roll(pos.to_numpy(), k), index=pos.index)
        sims.append(stats(backtest(part, fake, cost))["sharpe"])
    sims = np.array(sims)
    return {"real_sharpe": real, "placebo_median": float(np.median(sims)),
            "placebo_p95": float(np.percentile(sims, 95)), "p_value": float((sims >= real).mean())}


def after_tax_annual(bt: pd.DataFrame, rate: float = 0.45) -> float:
    """粗略税后年化：每个自然年的净盈利按短期利得税率缴税（亏损向后结转），税款从净值中扣除。"""
    eq, carry = 1.0, 0.0
    for _, g in bt["net"].groupby(bt.index.year):
        start = eq
        eq *= float((1 + g).prod())
        pnl = eq - start + carry
        if pnl > 0:
            eq -= pnl * rate
            carry = 0.0
        else:
            carry = pnl
    years = len(bt) / 8760
    return eq ** (1 / years) - 1
