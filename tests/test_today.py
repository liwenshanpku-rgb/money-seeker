import numpy as np
import pandas as pd
import pytest

from money_seeker.btc_loan import levered_trend
from money_seeker.btc_overlay import trend_weight
from money_seeker.today import Plan, daily_report, format_report, regimes, targets

IDX = pd.date_range("2024-01-01", periods=600, freq="D")


def series():
    up = np.linspace(100, 200, 300)
    down = np.linspace(200, 80, 300)
    return pd.Series(np.r_[up, down], index=IDX)


def test_regimes_match_backtest_signal():
    close = series()
    r = regimes(close, Plan())
    w = trend_weight(close, 200, 0.5, 0.03)
    # 回测里的仓位 = 两天前的模式（当天收盘出信号、次日收盘成交、再下一天生效）
    expected = (0.5 + 0.5 * r["up"].astype(float)).shift(2).fillna(1.0)
    pd.testing.assert_series_equal(w, expected, check_names=False)


def test_targets():
    t = targets(100_000, 50_000, True, Plan(borrow_frac=0.5))
    assert t["debt"] == pytest.approx(25_000) and t["btc"] == pytest.approx(2.5)
    t = targets(100_000, 50_000, False, Plan(borrow_frac=0.5))
    assert t == {"btc": pytest.approx(1.0), "debt": 0.0, "cash": pytest.approx(50_000)}


def test_report_on_switch_down_sells_and_repays():
    close = series()
    r = regimes(close, Plan())
    flips = (r["up"] != r["up"].shift()) & ~r["up"] & r["sma"].notna()
    switch_day = r.index[flips][0]
    rep = daily_report(close.loc[:switch_day], Plan(borrow_frac=0.5), btc=1.25, cash=0, debt=40)
    assert rep["switched_today"] and rep["mode"] == "DOWN"
    text = format_report(rep)
    assert "卖出" in text and "还清全部借款" in text
    assert rep["distance_to_switch"] > 0  # 下跌模式：需要上涨才会切回


def test_report_no_action_and_ltv_alert():
    close = series().iloc[:290]
    rep = daily_report(close, Plan(borrow_frac=0.5), btc=1.0, cash=0, debt=close.iloc[-1] * 0.5)
    assert rep["mode"] == "UP" and not rep["switched_today"]
    assert any("LTV" in a for a in rep["alerts"])


def test_requires_enough_history():
    with pytest.raises(ValueError):
        daily_report(series().iloc[:100], Plan())
