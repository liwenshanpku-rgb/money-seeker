import numpy as np
import pandas as pd
import pytest

from money_seeker.data import close_only, resample, synthetic_daily
from money_seeker.research import grid_equity, weekly_signal_daily_exec
from money_seeker.signals import PARAM_GRIDS, run_positions, tsmom
from money_seeker.strategy import GridConfig, run_grid_backtest


@pytest.fixture
def daily():
    return close_only(synthetic_daily(days=600, seed=3)["close"])


@pytest.mark.parametrize("freq", ["D", "W"])
def test_signals_have_no_lookahead(daily, freq):
    close = daily["close"]
    cut = 400
    tampered = close.copy()
    tampered.iloc[cut:] *= np.linspace(0.3, 3.0, len(close) - cut)
    for name, (fn, grid) in PARAM_GRIDS[freq].items():
        for params in grid:
            a = fn(close, **params).iloc[:cut]
            b = fn(tampered, **params).iloc[:cut]
            pd.testing.assert_series_equal(a, b, check_names=False, obj=f"{name} {params}")


def test_run_positions_always_long_matches_buy_hold(daily):
    close = daily["close"]
    eq = run_positions(close, pd.Series(1.0, index=close.index), capital=100, fee_rate=0.001)
    # 第一根空仓起步，第二根开始持有：只吃到 close[0] -> close[-1] 的涨跌，扣一次手续费
    assert eq.iloc[-1] == pytest.approx(100 * close.iloc[-1] / close.iloc[0] * (1 - 0.001))


def test_run_positions_flat_and_lag(daily):
    close = daily["close"]
    flat = run_positions(close, pd.Series(0.0, index=close.index))
    assert np.allclose(flat, 10_000)
    pos = tsmom(close, 20)
    assert not run_positions(close, pos, lag=1).equals(run_positions(close, pos))


def test_grid_trades_on_gap_between_bars():
    # 只有收盘价：100 -> 80 -> 100，跳空穿过格子也要成交
    idx = pd.date_range("2024-01-01", periods=3, freq="D")
    df = close_only(pd.Series([100.0, 80.0, 100.0], index=idx))
    res = run_grid_backtest(df, GridConfig(50, 150, 10, capital=1000, fee_rate=0))
    assert set(res.trades["side"]) == {"buy", "sell"}
    assert res.equity.iloc[-1] > 1000


def test_resample_weekly(daily):
    w = resample(daily)
    assert (w.index.dayofweek == 6).all()
    assert w["close"].iloc[0] == daily.loc[: w.index[0], "close"].iloc[-1]


def test_grid_equity_with_reset_keeps_index(daily):
    eq = grid_equity(daily, range_pct=0.2, n_grids=10, reset=30)
    assert eq.index.equals(daily.index)
    assert eq.iloc[0] == pytest.approx(10_000, rel=1e-3)  # 首日只扣建仓手续费


def test_weekly_signal_daily_exec(daily):
    eq = weekly_signal_daily_exec(daily, tsmom, dict(lookback=4), "2023-06-01", None)
    assert eq.index[0] == pd.Timestamp("2023-06-01")
    assert eq.iloc[0] == 10_000
