import numpy as np
import pandas as pd
import pytest

from money_seeker.onchain import (
    FAMILIES,
    applicable,
    band_positions,
    evaluate,
    mvrv_z,
    n_trades,
    positions,
    puell,
    quantile_band_positions,
    trade_log,
)


@pytest.fixture
def metrics():
    rng = np.random.default_rng(0)
    idx = pd.date_range("2015-01-01", periods=2200, freq="D")
    price = 100 * np.exp(np.cumsum(rng.normal(0, 0.03, len(idx))))
    supply = 1e6
    return pd.DataFrame({
        "PriceUSD": price,
        "CapMrktCurUSD": price * supply,
        "CapMVRVCur": 1 + np.sin(np.arange(len(idx)) / 200) * 1.5 + 1.0,
        "IssTotUSD": price * 900,
        "HashRate": np.linspace(1, 100, len(idx)) * (1 + rng.normal(0, 0.05, len(idx))),
        "SplyExNtv": 1e5 + np.cumsum(rng.normal(0, 100, len(idx))),
        "SplyCur": supply,
        "AdrActCnt": 1e5 * (1 + rng.normal(0, 0.1, len(idx))),
    }, index=idx.rename("date"))


def test_band_positions_hysteresis():
    x = pd.Series([2.0, 0.5, 1.5, 3.0, 4.5, 3.0, 0.8])
    assert band_positions(x, low=1.0, high=4.0).tolist() == [0, 1, 1, 1, 0, 0, 1]


@pytest.mark.parametrize("family", list(FAMILIES))
def test_signals_have_no_lookahead(metrics, family):
    cut = 1500
    tampered = metrics.copy()
    tampered.iloc[cut:] *= 3.0
    for params in FAMILIES[family][1]:
        a = positions(metrics, family, params).iloc[:cut]
        b = positions(tampered, family, params).iloc[:cut]
        pd.testing.assert_series_equal(a, b, check_names=False, obj=f"{family} {params}")


def test_indicators(metrics):
    z = mvrv_z(metrics)
    assert z.iloc[:364].isna().all() and z.iloc[400:].notna().all()
    p = puell(metrics)
    assert p.iloc[-1] == pytest.approx(metrics["IssTotUSD"].iloc[-1] / metrics["IssTotUSD"].iloc[-365:].mean())


def test_quantile_band_positions_trade_on_extremes():
    x = pd.Series(np.sin(np.arange(3000) / 100))
    pos = quantile_band_positions(x, 600, 0.05, 0.95)
    assert n_trades(pos) > 4


def test_evaluate_and_trade_log(metrics):
    pos = positions(metrics, "mvrv", dict(low=1.0, high=3.0))
    r = evaluate(metrics["PriceUSD"], pos, "2017-01-01", None)
    assert 0 <= r["exposure"] <= 1 and r["trades"] >= 0
    log = trade_log(metrics, "mvrv", dict(low=1.0, high=3.0))
    assert set(log["action"]) <= {"BUY", "SELL"}
    assert (log["action"].iloc[::2] == "BUY").all()  # 买卖交替，从买开始


def test_applicable(metrics):
    m = metrics.copy()
    m.loc["2018-01-01":, "HashRate"] = np.nan  # 模拟 ETH 合并后没有算力
    assert not applicable(m, "hash_ribbon", "2019-01-01", None)
    assert applicable(m, "mvrv", "2019-01-01", None)
