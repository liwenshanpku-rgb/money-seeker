"""money-seeker: 虚拟币日线数据 + 网格策略回测。"""

from .metrics import max_drawdown, sharpe_ratio, summarize
from .strategy import BacktestResult, GridConfig, buy_and_hold, run_grid_backtest

__all__ = [
    "GridConfig",
    "BacktestResult",
    "run_grid_backtest",
    "buy_and_hold",
    "sharpe_ratio",
    "max_drawdown",
    "summarize",
]
__version__ = "0.1.0"
