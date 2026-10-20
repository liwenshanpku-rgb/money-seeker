import pandas as pd

from money_seeker import data


def fake_kline(day: pd.Timestamp, price: float) -> list:
    ms = int(day.tz_localize("UTC").timestamp() * 1000)
    return [ms, str(price), str(price + 1), str(price - 1), str(price), "10", ms + 1, "0", 0, "0", "0", "0"]


def test_fetch_paginates(monkeypatch):
    days = pd.date_range("2020-01-01", periods=1500, freq="D")
    calls = []

    def fake_get(params, **_):
        calls.append(params)
        start = pd.Timestamp(params["startTime"], unit="ms")
        sel = [d for d in days if d >= start][: params["limit"]]
        return [fake_kline(d, 100 + i) for i, d in enumerate(sel)]

    monkeypatch.setattr(data, "_get", fake_get)
    df = data.fetch_binance_daily("btcusdt", "2020-01-01", "2024-12-31")
    assert len(calls) == 2
    assert len(df) == 1500 and df.index.is_monotonic_increasing
    assert list(df.columns) == data.COLUMNS


def test_csv_roundtrip(tmp_path):
    df = data.synthetic_daily(days=10)
    path = data.save_csv(df, tmp_path / "x.csv")
    back = data.load_csv(path)
    pd.testing.assert_frame_equal(back, df, check_freq=False)
