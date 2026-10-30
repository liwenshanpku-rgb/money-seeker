import importlib.util
from datetime import datetime, timedelta, timezone
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

import money_seeker.ai_advisor as A

_spec = importlib.util.spec_from_file_location("swing_check", Path(__file__).parents[1] / "scripts" / "swing_check.py")
SC = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(SC)

NOW = datetime(2026, 10, 30, 18, tzinfo=timezone.utc)


def prices(moves):
    """moves: [(hours_ago, price)]，按时间先后。"""
    return [(NOW - timedelta(hours=h), p) for h, p in moves]


def test_check_triggers_on_24h_move_and_respects_cooldown_and_cap():
    px = prices([(80, 80000), (30, 80000), (24, 80000), (1, 80000), (0, 75600)])  # 24h -5.5%
    out = SC.check(px, [], now=NOW)
    assert out["triggered"] and "24 小时" in out["reasons"][0]
    recent = [{"decided_at": (NOW - timedelta(hours=10)).isoformat(), "price_at_decision": 76000.0}]
    out = SC.check(px, recent, now=NOW)
    assert not out["triggered"] and "冷却" in out["blocked"]
    moved = [{"decided_at": (NOW - timedelta(hours=10)).isoformat(), "price_at_decision": 80000.0}]
    assert SC.check(px, moved, now=NOW)["triggered"]  # 冷却期内又变动 5.5%
    cap = [{"decided_at": (NOW - timedelta(days=d)).isoformat(), "price_at_decision": 90000.0} for d in (6, 4, 3)]
    assert "上限" in SC.check(px, cap, now=NOW)["blocked"]


def test_check_quiet_market_and_72h_rule():
    assert not SC.check(prices([(72, 80000), (24, 79000), (0, 80000)]), [], now=NOW)["triggered"]
    out = SC.check(prices([(72, 87500), (24, 82000), (0, 80000)]), [], now=NOW)
    assert out["triggered"] and out["reasons"] == ["72 小时 -8.6%"]


ANSWER = {"target_position_pct": 60, "confidence": "low", "stance": "测试",
          "key_factors": [{"factor": "x", "signal": "bearish", "weight": "high", "evidence": "x"}],
          "main_risks": ["r"], "change_triggers": ["t"], "review_in_days": 7}
SNAP = {"as_of_close_utc": "2026-10-29", "btc_close_usd": 80000.0, "trend_rule_mode": "UP"}
TRIG = {"checked_at": "2026-10-30T18:00+00:00", "price": 77000.0, "reasons": ["24 小时 -5.5%"]}


def test_record_swing_starts_from_weekly_and_blocks_duplicates(tmp_path):
    j = tmp_path / "swing.jsonl"
    weekly = [{"decided_at": "2026-10-26T01:20:00+00:00", "final_pct": 85}]
    rec = A.record_swing(ANSWER, SNAP, j, weekly, TRIG, now=NOW)
    assert rec["previous_pct"] == 85 and rec["final_pct"] == 60 and rec["track"] == "swing"
    assert rec["price_at_decision"] == 77000.0
    with pytest.raises(ValueError, match="重复"):
        A.record_swing(ANSWER, SNAP, j, weekly, TRIG, now=NOW + timedelta(hours=1))
    rec2 = A.record_swing({**ANSWER, "target_position_pct": 100}, SNAP, j, weekly, TRIG, now=NOW + timedelta(hours=7))
    assert rec2["previous_pct"] == 60 and rec2["final_pct"] == 85  # 单次最多 +25


def test_review_swing_uses_intraday_decision_price():
    idx = pd.date_range("2026-10-28", periods=4, freq="D")
    close = pd.Series([80000.0, 80000.0, 76000.0, 76000.0], index=idx)
    journal = [{"decided_at": "2026-10-30T18:00:00+00:00", "previous_pct": 100, "final_pct": 0,
                "price_at_decision": 78000.0}]
    eq = A.review_swing(journal, close, fee=0.0)
    # 10/30：决定前 100% 跟着从 80000 跌到 78000，之后空仓（只有极小的国库券利息）
    assert eq.loc["2026-10-30"] == pytest.approx(78000 / 80000, rel=1e-3)
    assert eq.iloc[-1] == pytest.approx(eq.loc["2026-10-30"], rel=1e-3)


def test_swing_prompt_has_trigger_and_rules():
    text = A.routine_prompt(SNAP, [], 85) + A.swing_note(TRIG)
    assert "波段" in text and "77,000" in text and A.SYSTEM_PROMPT in text
