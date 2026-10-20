import numpy as np
import pandas as pd
import pytest

import money_seeker.carry as C


def daily(rate_per_day, days=100, start="2026-01-01", gap=None):
    idx = pd.date_range(start, periods=days, freq="D")
    d = pd.DataFrame({"sum": rate_per_day, "coverage": 1.0}, index=idx)
    if gap:
        d.loc[gap[0]:gap[1], ["sum", "coverage"]] = 0.0
    return d


def test_daily_funding_sum_marks_gaps():
    ts = pd.date_range("2026-01-01", periods=9, freq="8h")
    rate = pd.Series(0.0001, index=ts).drop(ts[4])  # 第二天少一次结算
    dd = C.daily_funding_sum(rate, 8.0)
    assert dd["coverage"].tolist() == pytest.approx([1.0, 2 / 3, 1.0])
    assert dd["sum"].iloc[0] == pytest.approx(0.0003)


def test_notional_fraction():
    assert C.notional_fraction("separate", 1.0) == 0.5
    assert C.notional_fraction("separate", 3.0) == 0.75
    assert C.notional_fraction("unified", buffer=0.1) == pytest.approx(1 / 1.1)


def test_simulate_carry_unified_matches_hand_calc():
    d = daily(0.0003, days=10)
    r = C.simulate_carry(d, venue="binance", mode="unified", slippage=0.0)
    nf = 1 / 1.1
    leg = 0.001 + 0.0005
    expected = (1 - nf * leg) ** 2 * (1 + nf * 0.0003) ** 10 - 1
    assert r["net_return"] == pytest.approx(expected)
    assert r["covered_days"] == 10


def test_gap_days_excluded_from_annualization():
    d = daily(0.0003, days=100, gap=("2026-02-01", "2026-02-20"))
    r = C.simulate_carry(d, mode="unified", slippage=0.0)
    assert r["covered_days"] == 80
    assert len(r["equity"]) == 80


def test_rebalance_and_liquidation_distance():
    d = daily(0.0, days=5)
    price = pd.Series([100, 105, 112, 112, 150], index=d.index, dtype=float)
    r = C.simulate_carry(d, price, mode="separate", leverage=2.0, band=0.1, slippage=0.0)
    assert r["rebalances"] == 2  # 112（+12%）和 150（+34%）各调仓一次
    liq_move = (0.5 - 0.005) / 1.005
    assert r["worst_liq_distance_used"] == pytest.approx((150 / 112 - 1) / liq_move)
    assert r["net_return"] < 0  # 没有资金费，只有成本


def test_safe_leverage_monotonic():
    assert C.safe_leverage(0.1, 0.1) > C.safe_leverage(0.3, 0.1) > C.safe_leverage(1.0, 0.1)


def test_rotation_keeps_holdings_through_gaps():
    idx = pd.date_range("2026-01-01", periods=60, freq="D")
    sums = pd.DataFrame({"A": 0.0003, "B": 0.0001}, index=idx)
    cov = pd.DataFrame(1.0, index=idx, columns=["A", "B"])
    cov.loc["2026-02-01":"2026-02-10"] = 0.0  # 缺口覆盖一个周日
    r = C.rotation_carry(sums, cov, top_k=1, lookback=7, nf=1.0, slippage=0.0)
    held = r["held"][r["held"] != ""]
    assert set(held) == {"A"}  # 缺口期间不清仓、不换币
    assert r.loc["2026-02-03", "ret"] != r.loc["2026-02-03", "ret"]  # 缺口日为 NaN
    assert (r["ret"].dropna() < 0).sum() == 1  # 只有首次建仓那天扣成本


def test_tbill_rate():
    assert C.tbill_rate(pd.Timestamp("2026-03-15")) == 0.0361
    assert C.tbill_rate(pd.Timestamp("2025-05-01")) == 0.0407
