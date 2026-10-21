import json
from datetime import datetime, timezone
from types import SimpleNamespace as NS

import numpy as np
import pandas as pd
import pytest

from money_seeker import brief, kraken, notify
from money_seeker.cli import main
from money_seeker.today import Plan

IDX = pd.date_range("2025-06-01", periods=400, freq="D")
UP = pd.Series(np.linspace(50_000, 90_000, len(IDX)), index=IDX)
TUESDAY = datetime(2026, 7, 7, 1, 0, tzinfo=timezone.utc)
MONDAY = datetime(2026, 7, 6, 1, 0, tzinfo=timezone.utc)
AI = {"as_of_close_utc": "2026-07-05", "decided_at": "2026-07-06T00:35:00+00:00", "final_pct": 85,
      "confidence": "medium", "stance": "测试"}


def test_kraken_daily_closes_drops_open_candle(monkeypatch):
    t0 = int(pd.Timestamp("2026-01-01").timestamp())
    rows = [[t0 + i * 86400, "1", "1", "1", str(100 + i), "1", "1", 1] for i in range(5)]

    def fake_get(url, params, timeout):
        assert params == {"pair": "XBTUSD", "interval": 1440}
        return NS(raise_for_status=lambda: None, json=lambda: {"error": [], "result": {"XXBTZUSD": rows, "last": 1}})

    monkeypatch.setattr(kraken.requests, "get", fake_get)
    c = kraken.daily_closes()
    assert len(c) == 4 and c.iloc[-1] == 103.0 and c.index[0] == pd.Timestamp("2026-01-01")


def test_build_signal_contents():
    sig = brief.build(UP, btc=1.0, cash=10_000, debt=0, plan=Plan(), ai=AI, now=TUESDAY)
    assert sig["plan_b"]["mode"] == "UP" and sig["plan_b"]["target_pct"] == pytest.approx(100)
    assert sig["holdings"]["btc_pct"] == pytest.approx(90_000 / 100_000 * 100)
    assert sig["ai"]["target_pct"] == 85 and sig["ai"]["age_days"] == 2 and not sig["ai"]["stale"]
    assert sig["ai"]["orders"]["trade_btc"] < 0  # 当前 90%，AI 建议 85% → 卖一点


def test_push_rules():
    sig = brief.build(UP, 1.0, 10_000, 0, Plan(), AI, TUESDAY)
    assert brief.push_reasons(sig, {"last_ai_as_of": "2026-07-05"}, TUESDAY) == ([], False)
    reasons, urgent = brief.push_reasons(sig, {}, TUESDAY)
    assert reasons == ["AI 顾问有新决定"] and not urgent
    reasons, _ = brief.push_reasons(sig, {"last_ai_as_of": "2026-07-05"}, MONDAY)
    assert reasons == ["每周汇总"]
    assert brief.push_reasons(sig, {"last_ai_as_of": "2026-07-05"}, TUESDAY, always=True)[0] == ["手动推送"]
    old_ai = dict(AI, as_of_close_utc="2026-06-20")
    sig2 = brief.build(UP, 1.0, 10_000, 0, Plan(), old_ai, TUESDAY)
    assert "AI 决定超过 9 天没有更新" in brief.push_reasons(sig2, {"last_ai_as_of": "2026-06-20"}, TUESDAY)[0]


def test_switch_is_urgent():
    down = pd.Series(np.r_[np.linspace(50_000, 90_000, 300), np.linspace(90_000, 40_000, 100)], index=IDX)
    from money_seeker.today import regimes
    r = regimes(down, Plan())
    flip = r.index[(r["up"] != r["up"].shift()) & ~r["up"] & r["sma"].notna()][0]
    sig = brief.build(down.loc[:flip], 1.0, 0, 0, Plan(), None, TUESDAY)
    reasons, urgent = brief.push_reasons(sig, {}, TUESDAY)
    assert urgent and reasons[0].startswith("方案 B 切换为下跌")
    title, body = brief.format_message(sig, reasons)
    assert "调仓信号" in title and "卖出" in body


def test_run_pushes_once_and_writes_signal(monkeypatch, tmp_path):
    sent = []
    monkeypatch.setattr(brief, "fetch_ai_decision", lambda url: AI)
    monkeypatch.setattr(notify, "send", lambda body, title, level=None: sent.append((title, level)) or True)
    s1 = brief.run(UP, 1.0, 10_000, 0, Plan(), state_dir=tmp_path, now=TUESDAY)
    assert s1["pushed"] and len(sent) == 1
    saved = json.loads((tmp_path / "latest_signal.json").read_text())
    assert saved["ai"]["target_pct"] == 85 and saved["plan_b"]["mode"] == "UP"
    s2 = brief.run(UP, 1.0, 10_000, 0, Plan(), state_dir=tmp_path, now=TUESDAY)
    assert not s2["reasons"] and len(sent) == 1  # 同一个 AI 决定不重复推送


def test_failed_push_retries_next_time(monkeypatch, tmp_path):
    monkeypatch.setattr(brief, "fetch_ai_decision", lambda url: AI)
    monkeypatch.setattr(notify, "send", lambda body, title, level=None: False)
    brief.run(UP, 1.0, 10_000, 0, Plan(), state_dir=tmp_path, now=TUESDAY)
    assert not (tmp_path / "brief_state.json").exists()  # 没推出去就不记账


def test_bark_send(monkeypatch):
    monkeypatch.delenv("BARK_URL", raising=False)
    assert notify.send("x") is False  # 没配置只打印
    monkeypatch.setenv("BARK_URL", "https://bark.example.com/")
    monkeypatch.setenv("BARK_DEVICE_KEY", "dk")
    calls = []
    monkeypatch.setattr(notify.requests, "post",
                        lambda url, json, timeout: calls.append((url, json)) or NS(status_code=200, text="ok"))
    assert notify.send("hello", title="t", level="timeSensitive")
    url, body = calls[0]
    assert url == "https://bark.example.com/push" and body["group"] == "money-seeker" and body["level"] == "timeSensitive"


def test_cli_brief_end_to_end(monkeypatch, tmp_path, capsys):
    monkeypatch.setenv("KRAKEN_API_KEY", "k")
    monkeypatch.setenv("KRAKEN_API_SECRET", "c2VjcmV0")
    monkeypatch.delenv("BARK_URL", raising=False)
    monkeypatch.setattr(kraken, "daily_closes", lambda: UP)
    monkeypatch.setattr(kraken, "holdings", lambda: kraken.Holdings(btc=1.0, cash_usd=10_000, price=90_000))
    monkeypatch.setattr(brief, "fetch_ai_decision", lambda url: AI)
    main(["brief", "--state-dir", str(tmp_path), "--always-push"])
    out = capsys.readouterr().out
    assert "方案 B" in out and "AI 建议 85%" in out and "未推送" in out
    assert (tmp_path / "latest_signal.json").exists()
