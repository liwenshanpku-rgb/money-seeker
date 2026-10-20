import numpy as np
import pandas as pd
import pytest

from money_seeker.funding import (
    CARRY_GRID,
    carry_positions,
    contrarian_positions,
    daily_funding,
    overheat_positions,
    run_carry,
    tbill_curve,
)

IDX = pd.date_range("2022-01-01", periods=30, freq="8h")


def test_carry_always_on_collects_funding_minus_entry_fee():
    rate = pd.Series(0.0001, index=IDX)
    eq = run_carry(rate, carry_positions(rate, None, 0, 0), notional=1.0,
                   spot_fee=0.001, perp_fee=0.0005)
    # 第 0 期定仓位、从第 1 期开始收资金费；建仓一次，两条腿共 0.15%
    expected = (1 - 0.0015) * (1 + 0.0001) ** (len(IDX) - 1)
    assert eq.iloc[-1] == pytest.approx(expected)


def test_carry_short_pays_when_funding_negative():
    rate = pd.Series(-0.0002, index=IDX)
    eq = run_carry(rate, pd.Series(1.0, index=IDX), notional=0.5, spot_fee=0, perp_fee=0)
    assert eq.iloc[-1] < 1


def test_conditional_carry_switches_with_hysteresis():
    vals = [0.0003] * 10 + [-0.0003] * 10 + [0.0003] * 10
    rate = pd.Series(vals, index=IDX)
    pos = carry_positions(rate, window=3, enter=0.0001, exit=0.0)
    assert pos.iloc[5] == 1 and pos.iloc[15] == 0 and pos.iloc[-1] == 1
    assert pos.iloc[:2].sum() == 0  # 窗口未满不开仓


def test_carry_grid_exit_not_above_enter():
    assert all(p["exit"] <= p["enter"] for p in CARRY_GRID)


def test_timing_rules():
    days = pd.date_range("2021-01-01", periods=20, freq="D")
    fd = pd.Series([0.0001] * 10 + [0.0008] * 10, index=days)
    ov = overheat_positions(fd, n=1, high=0.0005)
    assert ov.iloc[5] == 1 and ov.iloc[15] == 0
    ct = contrarian_positions(fd, n=1, low=0.0002, exit_high=0.0005)
    assert ct.iloc[5] == 1 and ct.iloc[15] == 0


def test_daily_funding_and_tbill():
    rate = pd.Series(np.arange(6) * 1e-5, index=pd.date_range("2022-01-01", periods=6, freq="8h"))
    assert daily_funding(rate).tolist() == pytest.approx([1e-5, 4e-5])
    tb = tbill_curve(pd.date_range("2023-01-01", "2023-12-31"))
    assert tb.iloc[-1] == pytest.approx((1 + 0.0507 / 365) ** 365)
