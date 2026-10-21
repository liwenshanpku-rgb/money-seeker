import json
from datetime import datetime, timedelta, timezone
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

from money_seeker import publish
from money_seeker.cli import main
from money_seeker.today import Plan

import importlib.util

_spec = importlib.util.spec_from_file_location("read_signal", Path(__file__).parents[1] / "examples" / "read_signal.py")
reader = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(reader)

IDX = pd.date_range("2025-06-01", periods=400, freq="D")
UP = pd.Series(np.linspace(50_000, 90_000, len(IDX)), index=IDX)
DOWN = pd.Series(np.linspace(90_000, 50_000, len(IDX)), index=IDX)
NOW = datetime.combine((IDX[-1] + timedelta(days=1)).date(), datetime.min.time(), timezone.utc) + timedelta(minutes=45)
AI = {"as_of_close_utc": IDX[-3].date().isoformat(), "decided_at": "x", "final_pct": 85,
      "confidence": "low", "stance": "测试", "snapshot": {"secret": 1}}


def test_targets_up_and_down():
    up = publish.build(UP, AI, now=NOW)
    assert up["plan_b"]["mode"] == "UP" and up["plan_b"]["target_pct"] == 100
    assert up["plan_c"]["target_pct"] == 125
    down = publish.build(DOWN, None, now=NOW)
    assert down["plan_b"]["mode"] == "DOWN" and down["plan_b"]["target_pct"] == 50
    assert down["plan_c"]["target_pct"] == 50 and down["ai"] is None


def test_no_holdings_and_only_whitelisted_ai_fields():
    sig = publish.build(UP, AI, now=NOW)
    text = json.dumps(sig)
    for word in ("holdings", "equity", "btc_pct", "orders", "secret", "cash"):
        assert word not in text
    assert sig["ai"]["target_pct"] == 85 and sig["ai"]["age_days"] == 3 and not sig["ai"]["stale"]


def test_refuses_stale_close():
    with pytest.raises(publish.StaleData):
        publish.build(UP, AI, now=NOW + timedelta(days=2))


def test_reader_accepts_fresh_signal_and_rejects_bad_ones():
    sig = json.loads(json.dumps(publish.build(UP, AI, now=NOW)))
    assert reader.validate(sig, now=NOW + timedelta(hours=1))
    assert reader.target_pct(sig, "plan_c") == 125 and reader.target_pct(sig, "ai") == 85
    assert not reader.validate(sig, now=NOW + timedelta(hours=40))           # 当天任务失败 → 旧信号
    assert not reader.validate({**sig, "schema_version": 2}, now=NOW)
    assert not reader.validate({**sig, "plan_c": {"target_pct": 300}}, now=NOW)
    assert not reader.validate({"schema_version": 1}, now=NOW)
    assert reader.target_pct(None) is None
    assert reader.target_pct({**sig, "ai": {**sig["ai"], "stale": True}}, "ai") is None
    assert reader.limit_step(100, 50, 25) == 75 and reader.limit_step(50, 60, 25) == 60


def test_cli_writes_latest_and_history(tmp_path, monkeypatch):
    csv = tmp_path / "btc.csv"
    pd.DataFrame({c: UP for c in ("open", "high", "low", "close")}).rename_axis("date").to_csv(csv)
    journal = tmp_path / "decisions.jsonl"
    journal.write_text(json.dumps(AI) + "\n")
    out, hist = tmp_path / "signal" / "latest.json", tmp_path / "signal" / "history.jsonl"
    args = ["signal", "--csv", str(csv), "--ai-journal", str(journal), "--out", str(out), "--history", str(hist),
            "--max-close-age", "100000"]
    main(args)
    main(args)
    sig = json.loads(out.read_text())
    assert sig["schema_version"] == 1 and sig["ai"]["target_pct"] == 85
    assert len(hist.read_text().splitlines()) == 2
