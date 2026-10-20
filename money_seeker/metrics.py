"""绩效指标。加密货币 7x24 交易，年化按 365 天计算。"""

from __future__ import annotations

import numpy as np
import pandas as pd

PERIODS_PER_YEAR = 365


def daily_returns(equity: pd.Series) -> pd.Series:
    return equity.pct_change().dropna()


def sharpe_ratio(
    equity: pd.Series, risk_free: float = 0.0, periods: int = PERIODS_PER_YEAR
) -> float:
    """年化夏普 = mean(日超额收益) / std(日超额收益) * sqrt(periods)。"""
    rets = daily_returns(equity) - risk_free / periods
    std = rets.std(ddof=1)
    if len(rets) < 2 or not np.isfinite(std) or std == 0:
        return float("nan")
    return float(rets.mean() / std * np.sqrt(periods))


def max_drawdown(equity: pd.Series) -> float:
    """最大回撤，返回负数（例如 -0.25 表示 25%）。"""
    return float((equity / equity.cummax() - 1).min())


def summarize(
    equity: pd.Series, risk_free: float = 0.0, periods: int = PERIODS_PER_YEAR
) -> dict:
    rets = daily_returns(equity)
    total = equity.iloc[-1] / equity.iloc[0] - 1
    years = max(len(equity) - 1, 1) / periods
    return {
        "start": equity.index[0].date().isoformat(),
        "end": equity.index[-1].date().isoformat(),
        "days": len(equity),
        "final_equity": float(equity.iloc[-1]),
        "total_return": float(total),
        "annual_return": float((1 + total) ** (1 / years) - 1),
        "annual_volatility": float(rets.std(ddof=1) * np.sqrt(periods)),
        "sharpe": sharpe_ratio(equity, risk_free, periods),
        "max_drawdown": max_drawdown(equity),
    }
