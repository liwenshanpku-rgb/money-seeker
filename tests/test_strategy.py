import numpy as np
import pandas as pd
import pytest

from money_seeker.data import synthetic_daily
from money_seeker.metrics import max_drawdown, sharpe_ratio, summarize
from money_seeker.strategy import GridConfig, buy_and_hold, run_grid_backtest


def bars(rows):
    idx = pd.date_range("2024-01-01", periods=len(rows), freq="D", name="date")
    return pd.DataFrame(rows, columns=["open", "high", "low", "close"], index=idx)


def test_levels_arithmetic_and_geometric():
    assert np.allclose(GridConfig(100, 200, 4).levels(), [100, 125, 150, 175, 200])
    geo = GridConfig(100, 400, 2, geometric=True).levels()
    assert np.allclose(geo, [100, 200, 400])


@pytest.mark.parametrize("kwargs", [
    dict(lower=200, upper=100), dict(lower=0, upper=100),
    dict(lower=1, upper=2, n_grids=0), dict(lower=1, upper=2, capital=0),
])
def test_invalid_config(kwargs):
    with pytest.raises(ValueError):
        GridConfig(**kwargs)


def test_flat_price_no_trades_beyond_initial():
    df = bars([[150, 150, 150, 150]] * 5)
    res = run_grid_backtest(df, GridConfig(100, 200, 4, capital=1000, fee_rate=0))
    # 下沿高于 150 的格子（175 那一格）开盘即买入，之后价格不动不再成交
    assert (res.trades["side"] == "buy").all()
    assert np.allclose(res.equity, 1000)


def test_round_trip_profit_without_fees():
    # 价格 150 -> 跌到 125 买入 -> 涨回 150 卖出，赚一格
    df = bars([[150, 150, 125, 125], [125, 150, 125, 150]])
    cfg = GridConfig(100, 200, 4, capital=1000, fee_rate=0)
    res = run_grid_backtest(df, cfg)
    sells = res.trades[res.trades["side"] == "sell"]
    assert len(sells) == 1 and sells["price"].iloc[0] == 150
    per_grid = 1000 / 4
    expected_profit = per_grid / 125 * 25
    assert res.equity.iloc[-1] == pytest.approx(1000 + expected_profit)


def test_cash_never_negative_with_fees():
    df = synthetic_daily(days=400, seed=7)
    p0 = df["open"].iloc[0]
    cfg = GridConfig(p0 * 0.5, p0 * 1.5, 30, capital=10_000, fee_rate=0.001)
    res = run_grid_backtest(df, cfg)
    t = res.trades
    flow = np.where(t["side"] == "buy", -1, 1) * t["price"] * t["qty"] - t["fee"]
    assert (cfg.capital + np.cumsum(flow)).min() >= -1e-6
    pos = np.cumsum(np.where(t["side"] == "buy", 1, -1) * t["qty"])
    assert pos.min() >= -1e-9


def test_buy_and_hold():
    df = bars([[100, 100, 100, 100], [100, 200, 100, 200]])
    bh = buy_and_hold(df, 1000, fee_rate=0)
    assert bh.iloc[-1] == pytest.approx(2000)


def test_metrics():
    eq = pd.Series([100, 110, 99, 120], index=pd.date_range("2024-01-01", periods=4))
    assert max_drawdown(eq) == pytest.approx(-0.1)
    rets = eq.pct_change().dropna()
    assert sharpe_ratio(eq) == pytest.approx(rets.mean() / rets.std() * np.sqrt(365))
    assert np.isnan(sharpe_ratio(pd.Series([1.0, 1.0, 1.0])))
    s = summarize(eq)
    assert s["total_return"] == pytest.approx(0.2)
