from types import SimpleNamespace as NS

import pytest

from money_seeker import kraken
from money_seeker.cli import main


def test_sign_matches_kraken_documentation_example():
    # Kraken 官方文档的示例
    secret = "kQH5HW/8p1uGOVjbgWA7FunAmGO8lsSUXNsu3eow76sz84Q18fWxnyRzBHCd3pd5nE9qa99HAZtuZuj6F1huXg=="
    post = "nonce=1616492376594&ordertype=limit&pair=XBTUSD&price=37500&type=buy&volume=1.25"
    sig = kraken.sign("/0/private/AddOrder", "1616492376594", post, secret)
    assert sig == "4/dpxb3iT4tp/ZCVEwSnEsLxx0bqyhLpdfOpc6fn7OR8+UClSV5n9E6aSS8MPtnRfp32bAb0nmbRn6H8ndwLUQ=="


def test_classify_groups_suffixed_codes():
    btc, cash, other = kraken.classify({
        "XXBT": "0.5", "XBT.F": "0.1", "ZUSD": "1000.5", "USDT": "200", "USD.HOLD": "10",
        "XETH": "2", "ZEUR": "50", "DOT": "0.0000",
    })
    assert btc == pytest.approx(0.6) and cash == pytest.approx(1210.5)
    assert other == {"XETH": 2.0, "ZEUR": 50.0}


def fake_http(monkeypatch, balance_body, calls):
    def fake_post(url, data, headers, timeout):
        calls.append({"url": url, "data": data, "headers": headers})
        return NS(raise_for_status=lambda: None, json=lambda: balance_body)

    def fake_get(url, params, timeout):
        return NS(raise_for_status=lambda: None,
                  json=lambda: {"error": [], "result": {"XXBTZUSD": {"c": ["80000.0", "0.01"]}}})

    monkeypatch.setattr(kraken.requests, "post", fake_post)
    monkeypatch.setattr(kraken.requests, "get", fake_get)


def test_holdings_end_to_end(monkeypatch):
    monkeypatch.setenv("KRAKEN_API_KEY", "k")
    monkeypatch.setenv("KRAKEN_API_SECRET", "c2VjcmV0")  # base64("secret")
    calls = []
    fake_http(monkeypatch, {"error": [], "result": {"XXBT": "1.0", "ZUSD": "20000"}}, calls)
    h = kraken.holdings()
    assert h.btc == 1.0 and h.cash_usd == 20000 and h.price == 80000
    assert h.pct() == pytest.approx(80.0) and h.pct(debt=20000) == pytest.approx(100.0)
    req = calls[0]
    assert req["url"].endswith("/0/private/Balance") and req["data"].startswith("nonce=")
    assert req["headers"]["API-Key"] == "k" and req["headers"]["API-Sign"]


def test_errors(monkeypatch):
    monkeypatch.delenv("KRAKEN_API_KEY", raising=False)
    with pytest.raises(kraken.KrakenError):
        kraken.credentials()
    monkeypatch.setenv("KRAKEN_API_KEY", "k")
    monkeypatch.setenv("KRAKEN_API_SECRET", "c2VjcmV0")
    fake_http(monkeypatch, {"error": ["EAPI:Invalid key"]}, [])
    with pytest.raises(kraken.KrakenError, match="Invalid key"):
        kraken.holdings()


def test_cli_kraken_and_today(monkeypatch, tmp_path, capsys):
    import numpy as np
    import pandas as pd

    monkeypatch.setenv("KRAKEN_API_KEY", "k")
    monkeypatch.setenv("KRAKEN_API_SECRET", "c2VjcmV0")
    fake_http(monkeypatch, {"error": [], "result": {"XXBT": "1.0", "ZUSD": "20000", "XETH": "1"}}, [])
    main(["kraken"])
    out = capsys.readouterr().out
    assert "当前 BTC 仓位: 80.0%" in out and "XETH" in out

    idx = pd.date_range("2025-01-01", periods=300, freq="D")
    p = np.linspace(50_000, 80_000, len(idx))
    csv = tmp_path / "btc.csv"
    pd.DataFrame({"open": p, "high": p, "low": p, "close": p}, index=idx).to_csv(csv, index_label="date")
    main(["today", "--csv", str(csv), "--from-kraken"])
    out = capsys.readouterr().out
    assert "已从 Kraken 读取" in out and "总净值" in out


def test_cli_missing_credentials_message(monkeypatch):
    monkeypatch.delenv("KRAKEN_API_KEY", raising=False)
    monkeypatch.delenv("KRAKEN_API_SECRET", raising=False)
    with pytest.raises(SystemExit, match="KRAKEN_API_KEY"):
        main(["kraken"])
