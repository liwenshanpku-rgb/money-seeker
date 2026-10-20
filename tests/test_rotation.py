import numpy as np
import pandas as pd
import pytest

from money_seeker.rotation import (
    eligibility,
    equal_weight_targets,
    random_weights,
    simulate,
    target_weights,
)

IDX = pd.date_range("2020-01-05", periods=400, freq="D")  # 2020-01-05 是周日


def panel(**growth):
    """每个币按固定日增长率生成价格。"""
    t = np.arange(len(IDX))
    return pd.DataFrame({k: 100 * (1 + g) ** t for k, g in growth.items()}, index=IDX)


def test_picks_top_k_by_momentum():
    px = panel(btc=0.001, a=0.003, b=0.002, c=-0.001)
    w = target_weights(px, lookback=4, top_k=2, min_history=4)
    last = w.iloc[-1]
    assert last["a"] == 0.5 and last["b"] == 0.5 and last["btc"] == 0 and last["c"] == 0


def test_abs_filter_keeps_cash_for_losers():
    px = panel(btc=-0.001, a=0.002, c=-0.002)
    w = target_weights(px, lookback=4, top_k=2, filt="abs", min_history=4)
    assert w.iloc[-1].sum() == pytest.approx(0.5)


def test_btc_trend_filter_goes_to_cash():
    px = panel(btc=-0.002, a=0.003)
    w = target_weights(px, lookback=4, top_k=1, filt="btc_trend", min_history=4)
    assert (w.iloc[-1] == 0).all()


def test_eligibility_requires_history():
    px = panel(btc=0.001, a=0.001)
    px.loc[: "2020-06-30", "a"] = np.nan
    el = eligibility(px, min_history=26)
    assert not el.loc["2020-12-27", "a"]  # 上市未满 26 周
    assert el.loc["2021-01-31", "a"]


def test_simulate_single_asset_matches_buy_and_hold():
    px = panel(btc=0.001, a=0.002)
    w = pd.DataFrame({"btc": 0.0, "a": 1.0}, index=IDX[IDX.dayofweek == 6])
    sim = simulate(px, w, fee_rate=0.0, delay_days=1)
    # 第一个周一收盘买入，之后一直持有
    first_trade = IDX[1]
    expected = px["a"].iloc[-1] / px.loc[first_trade, "a"]
    assert sim["equity"].iloc[-1] == pytest.approx(expected)


def test_simulate_charges_fees_on_turnover():
    px = panel(btc=0.0, a=0.0)
    sun = IDX[IDX.dayofweek == 6]
    w = pd.DataFrame({"btc": np.tile([1.0, 0.0], len(sun))[: len(sun)],
                      "a": np.tile([0.0, 1.0], len(sun))[: len(sun)]}, index=sun)
    sim = simulate(px, w, fee_rate=0.001)
    # 价格不变，亏损全是手续费：首次建仓换手 1，之后每周换手 2
    n_trades = int((sun + pd.Timedelta(days=1) <= IDX[-1]).sum())  # 周一要落在数据范围内
    assert sim["equity"].iloc[-1] < 1
    assert sim["turnover"].sum() == pytest.approx(1 + 2 * (n_trades - 1), rel=0.01)


def test_dead_coin_goes_to_cash():
    px = panel(btc=0.0, a=0.01)
    px.loc["2020-06-01":, "a"] = np.nan
    w = pd.DataFrame({"btc": 0.0, "a": 1.0}, index=IDX[IDX.dayofweek == 6])
    eq = simulate(px, w, fee_rate=0.0)["equity"]
    assert eq.loc["2020-06-01":].nunique() == 1  # 停更后净值不再变化


def test_random_weights_same_count():
    px = panel(btc=0.001, a=0.003, b=0.002, c=-0.001)
    w = target_weights(px, lookback=4, top_k=2, min_history=4)
    rw = random_weights(w, eligibility(px, 4), np.random.default_rng(0))
    assert ((rw > 0).sum(axis=1) == (w > 0).sum(axis=1)).all()
    assert np.allclose(rw.sum(axis=1), w.sum(axis=1))


def test_equal_weight_targets_sum_to_one():
    px = panel(btc=0.001, a=0.002)
    w = equal_weight_targets(px, min_history=4)
    assert np.allclose(w.iloc[10:].sum(axis=1), 1.0)
