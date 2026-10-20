import numpy as np
import pandas as pd
import pytest

import money_seeker.btc_loan as L

IDX = pd.date_range("2020-01-01", periods=800, freq="D")


def test_liquidation_drop():
    assert L.liquidation_drop(0.4, 0.8) == pytest.approx(0.5)


def test_liquidation_frequency_crash_vs_flat():
    flat = pd.Series(100.0, index=IDX)
    assert L.liquidation_frequency(flat, 0.3, 365, borrow_rate=0.0)["liquidated_share"] == 0
    crash = pd.Series(np.r_[np.full(400, 100.0), np.full(400, 30.0)], index=IDX)
    r = L.liquidation_frequency(crash, 0.3, 365, borrow_rate=0.0)
    assert r["liquidated_share"] > 0.5  # 起点在暴跌前 365 天内的都会被强平


def test_leveraged_hold_math_and_liquidation():
    up = pd.Series(np.linspace(100, 200, 100), index=IDX[:100])
    eq, liq = L.leveraged_hold(up, 0.5, borrow_rate=0.0)
    assert not liq and eq.iloc[-1] == pytest.approx(1.5 * 2 - 0.5)  # 1.5 BTC × 200 − 50 负债
    crash = pd.Series([100.0, 100.0, 20.0, 20.0], index=IDX[:4])
    eq, liq = L.leveraged_hold(crash, 0.5, borrow_rate=0.0)
    assert len(liq) == 1 and eq.iloc[-1] >= 0  # 资不抵债时最多亏光，不会为负


def test_levered_trend_no_borrow_has_no_debt_effect():
    rng = np.random.default_rng(1)
    price = pd.Series(100 * np.exp(rng.normal(0.001, 0.03, len(IDX)).cumsum()), index=IDX)
    a, _ = L.levered_trend(price, 0.5, 0.0, borrow_rate=0.10)
    b, _ = L.levered_trend(price, 0.5, 0.0, borrow_rate=0.0)
    pd.testing.assert_series_equal(a, b)


def test_levered_trend_repays_in_downtrend():
    price = pd.Series(np.r_[np.linspace(50, 150, 400), np.linspace(150, 40, 400)], index=IDX)
    worst, _ = L.worst_ltv_levered_trend(price, 0.5, 1.0)
    eq, liq = L.levered_trend(price, 0.5, 1.0, borrow_rate=0.05)
    assert not liq and worst < 0.8
    assert eq.iloc[-1] > 0
