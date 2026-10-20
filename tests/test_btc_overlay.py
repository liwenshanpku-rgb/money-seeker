import numpy as np
import pandas as pd
import pytest

import money_seeker.btc_overlay as B

IDX = pd.date_range("2024-01-01", periods=400, freq="D")


def test_bs_call_sanity():
    assert B.bs_call(100, 100, 30 / 365, 0.0) == 0.0
    atm = B.bs_call(100, 100, 30 / 365, 0.6)
    assert atm == pytest.approx(100 * 0.4 * 0.6 * np.sqrt(30 / 365), rel=0.02)  # ATM 近似公式
    assert B.bs_call(100, 110, 30 / 365, 0.6) < atm


def test_covered_call_flat_market_accumulates_premium():
    rng = np.random.default_rng(0)
    price = pd.Series(100 * np.exp(rng.normal(0, 0.01, len(IDX)).cumsum() * 0), index=IDX) + rng.normal(0, 0.5, len(IDX))
    cc = B.covered_call(price, otm=0.2, iv_ratio=1.2)
    assert cc["btc"].iloc[-1] > 1.0  # 价格不怎么动，权利金都留下


def test_covered_call_caps_upside():
    price = pd.Series(np.linspace(100, 400, len(IDX)), index=IDX)
    price.iloc[:40] = 100 + np.sin(np.arange(40)) * 3  # 先有一点波动，才算得出实际波动率
    cc = B.covered_call(price, otm=0.05, iv_ratio=1.0)
    assert cc["value"].iloc[-1] < price.iloc[-1]
    assert cc["btc"].iloc[-1] < 1.0  # 被行权，BTC 变少


def test_trend_weight_lag_band_and_core():
    price = pd.Series(np.r_[np.linspace(90, 110, 250), np.full(150, 80.0)], index=IDX)  # 先涨后跌破均线
    w = B.trend_weight(price, sma_days=200, core=0.5)
    drop_day = IDX[250]
    assert w.loc[drop_day] == 1.0 and w.loc[drop_day + pd.Timedelta(days=1)] == 1.0
    assert w.loc[drop_day + pd.Timedelta(days=2)] == 0.5  # 次日收盘成交后才生效
    wb = B.trend_weight(price, sma_days=200, core=0.5, band=0.5)
    assert wb.loc[drop_day + pd.Timedelta(days=5)] == 0.5  # 从没涨破 1.5 倍均线，一直是核心仓位


def test_trend_overlay_full_exposure_matches_buy_and_hold():
    price = pd.Series(np.linspace(100, 200, len(IDX)), index=IDX)
    v = B.trend_overlay(price, sma_days=20, core=1.0, fee=0.0)
    assert v.iloc[-1] == pytest.approx(2.0)


def test_synthetic_excess_rules():
    idx = pd.date_range("2026-01-01", periods=120, freq="D")
    f = pd.DataFrame({"sum": 0.0001 / 3 * 3, "coverage": 1.0}, index=idx)  # 年化约 3.65%
    a = B.synthetic_excess(f, "always", collateral_haircut=0.0, switch_cost=0.0)
    expected = B.tbill_daily(idx) - 0.0001
    assert np.allclose(a["excess"], expected)
    sw = B.synthetic_excess(f, "switch", lookback=7, hurdle=0.05, collateral_haircut=0.0)
    assert sw["use_synthetic"].sum() == 0  # 利差不够 5% 门槛，从不切换
