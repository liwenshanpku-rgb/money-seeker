import numpy as np
import pandas as pd
import pytest

from money_seeker import intraday as I

IDX = pd.date_range("2024-01-01", periods=24 * 60, freq="h")
RNG = np.random.default_rng(1)
CLOSE = pd.Series(100 * np.exp(np.cumsum(RNG.normal(0, 0.01, len(IDX)))), index=IDX)


@pytest.mark.parametrize("spec", [s for s in I.grid() if s.params.get("n", 0) <= 168])
def test_signals_do_not_look_ahead(spec):
    base = spec.signal(CLOSE)
    changed = CLOSE.copy()
    changed.iloc[1000:] *= 1.5
    assert base.iloc[:1000].equals(spec.signal(changed).iloc[:1000])


def test_backtest_costs_and_timing():
    close = pd.Series([100.0, 110.0, 121.0, 121.0], index=IDX[:4])
    pos = pd.Series([1.0, 1.0, 0.0, 0.0], index=close.index)
    bt = I.backtest(close, pos, cost=0.01)
    # 第 0 小时收盘买入 → 赚第 1、2 小时的涨幅；进出各收 1%
    assert bt["held"].tolist() == [0, 1, 1, 0]
    assert bt["equity"].iloc[-1] == pytest.approx((1.1 - 0.01) * 1.1 * (1 - 0.01))  # 成本从当小时收益中扣除


def test_day_momentum_flat_at_day_end_and_only_after_hour():
    sig = I.day_momentum(CLOSE, hour=20, short=True)
    h = sig.index.hour
    assert (sig[h < 19] == 0).all() and (sig[h == 23] == 0).all()
    assert set(sig[h == 19].unique()) <= {-1.0, 0.0, 1.0}


def test_after_tax_carries_losses_forward():
    idx = pd.date_range("2024-01-01", "2025-12-31 23:00", freq="h")
    net = pd.Series(0.0, index=idx)
    net[idx[0]] = -0.5                      # 2024 亏一半
    net[pd.Timestamp("2025-01-01")] = 1.0   # 2025 翻倍，正好回本 → 不交税
    assert I.after_tax_annual(pd.DataFrame({"net": net})) == pytest.approx(0.0, abs=1e-9)
