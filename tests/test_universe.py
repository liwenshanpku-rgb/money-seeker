import numpy as np
import pandas as pd
import pytest

from money_seeker.data import close_only, synthetic_daily
from money_seeker.universe import (
    _shifted_positions,
    equal_weight_portfolio,
    evaluate_asset,
    evaluate_universe,
    weekly_positions,
)


@pytest.fixture
def coins():
    return {
        "a": close_only(synthetic_daily(days=900, seed=1, start="2021-01-01")["close"]),
        "b": close_only(synthetic_daily(days=900, seed=2, start="2021-01-01")["close"]),
        "late": close_only(synthetic_daily(days=300, seed=3, start="2022-06-01")["close"]),
    }


def test_weekly_positions_constant_within_week(coins):
    pos = weekly_positions(coins["a"], 4)
    # 周日收盘出新信号，周一到下个周日保持不变
    weeks = pos.index.to_period("W-SAT")
    assert (pos.groupby(weeks).nunique() == 1).all()


def test_shift_keeps_exposure_and_turnover(coins):
    pos = weekly_positions(coins["a"], 4)
    shifted = _shifted_positions(pos, 10)
    week = pos.index.to_period("W-SAT")
    w0, w1 = pos.groupby(week).first(), shifted.groupby(week).first()
    assert w0.sum() == w1.sum()
    # 循环平移后换手次数最多因首尾相接差 1
    assert abs(w0.diff().abs().sum() - w1.diff().abs().sum()) <= 1


def test_evaluate_asset_with_placebo(coins):
    row = evaluate_asset(coins["a"], 4, "2022-01-01", None, placebo=True)
    assert 0 <= row["placebo_pctile"] <= 1
    assert 0 < row["exposure"] < 1


def test_universe_skips_assets_listed_after_start(coins):
    res = evaluate_universe(coins, lookbacks=(4,), periods={"oos": ("2022-01-01", None)})
    assert set(res["asset"]) == {"a", "b"}


def test_equal_weight_portfolio(coins):
    pf = equal_weight_portfolio(coins, 4, "2022-01-01", exclude=("b",))
    assert pf.attrs["n_assets"] == 1
    assert pf["buy_hold"].iloc[0] == pytest.approx(1.0)
    a = coins["a"].loc["2022-01-01":, "close"]
    assert pf["buy_hold"].iloc[-1] == pytest.approx(a.iloc[-1] / a.iloc[0])
