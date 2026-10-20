import json
from types import SimpleNamespace as NS

import numpy as np
import pandas as pd
import pytest

import money_seeker.ai_advisor as A

IDX = pd.date_range("2025-01-01", periods=420, freq="D")
CLOSE = pd.Series(np.linspace(60_000, 90_000, len(IDX)), index=IDX)


def decision_json(pct, conf="medium"):
    return json.dumps({
        "target_position_pct": pct, "confidence": conf, "stance": "测试",
        "key_factors": [{"factor": "趋势", "signal": "bullish", "weight": "high", "evidence": "高于均线"}],
        "main_risks": ["宏观"], "change_triggers": ["跌破均线"], "review_in_days": 7,
    })


def response(text=None, stop="end_turn", search=True):
    content = []
    if search:
        content.append(NS(type="server_tool_use"))
        content.append(NS(type="web_search_tool_result",
                          content=[NS(title="ETF flows", url="https://example.com/etf")]))
    if text is not None:
        content.append(NS(type="text", text=text))
    return NS(stop_reason=stop, content=content, model="claude-opus-5-5", stop_details=None,
              usage=NS(input_tokens=1000, output_tokens=200, cache_read_input_tokens=0))


class FakeClient:
    """模拟 client.beta.messages.stream(...)，按顺序返回预设的回答，并记录请求参数。"""

    def __init__(self, responses):
        self.responses = list(responses)
        self.calls = []
        self.beta = NS(messages=NS(stream=self._stream))

    def _stream(self, **kwargs):
        self.calls.append(kwargs)
        resp = self.responses.pop(0)

        class Ctx:
            def __enter__(self_inner):
                return NS(get_final_message=lambda: resp)

            def __exit__(self_inner, *exc):
                return False

        return Ctx()


def test_ask_claude_parses_decision_and_sources():
    client = FakeClient([response(decision_json(120))])
    ans = A.ask_claude(client, "sys", "user")
    assert ans.decision.target_position_pct == 120
    assert ans.sources == [{"title": "ETF flows", "url": "https://example.com/etf"}]
    call = client.calls[0]
    assert [t["type"] for t in call["tools"]] == ["web_search_20260209", "web_fetch_20260209"]
    assert call["tools"][1]["max_content_tokens"] == 6000
    assert all("sec.gov" in t["blocked_domains"] for t in call["tools"])
    assert call["cache_control"] == {"type": "ephemeral"}
    assert call["output_config"]["format"]["type"] == "json_schema"
    assert call["fallbacks"] == "default"


def test_ask_claude_resumes_after_pause_turn():
    client = FakeClient([response(None, stop="pause_turn"), response(decision_json(80))])
    ans = A.ask_claude(client, "sys", "user")
    assert ans.decision.target_position_pct == 80
    second = client.calls[1]["messages"]
    assert second[-1]["role"] == "assistant" and len(second) == 2  # 原样续上，不额外加 user 消息


def test_ask_claude_refusal_and_out_of_range():
    with pytest.raises(RuntimeError):
        A.ask_claude(FakeClient([response(None, stop="refusal", search=False)]), "s", "u")
    with pytest.raises(Exception):
        A.ask_claude(FakeClient([response(decision_json(300))]), "s", "u")  # 超出 0–150


def test_guardrails():
    g = A.Guardrails()
    assert A.apply_guardrails(140, 100, False, g)[0] == 100   # 下跌模式不许加杠杆
    assert A.apply_guardrails(140, 100, True, g)[0] == 125    # 单次最多 25 个百分点
    assert A.apply_guardrails(105, 100, True, g)[0] == 100    # 变化太小不调
    assert A.apply_guardrails(140, 100, False, A.Guardrails(enabled=False))[0] == 140


def test_orders():
    o = A.orders(150, 50_000, btc=2.0)
    assert o["equity"] == 100_000 and o["target_debt"] == pytest.approx(50_000)
    assert o["trade_btc"] == pytest.approx(1.0) and o["ltv_after"] == pytest.approx(1 / 3)
    o = A.orders(50, 50_000, btc=2.0, debt=20_000)
    assert o["target_debt"] == 0 and o["target_cash"] == pytest.approx(40_000)


def test_decide_median_journal_and_prompt(tmp_path):
    journal = tmp_path / "j.jsonl"
    client = FakeClient([response(decision_json(p)) for p in (60, 90, 150)])
    rec = A.decide(client, CLOSE, journal, current_pct=100, samples=3)
    assert rec["samples"] == [60, 90, 150] and rec["model_pct"] == 90
    assert rec["final_pct"] == 90  # 相差正好 10 个百分点，不小于 min_change，照常调整
    assert A.read_journal(journal)[0]["final_pct"] == rec["final_pct"]
    prompt = client.calls[0]["messages"][0]["content"]
    assert "当前实际仓位：100%" in prompt and "btc_close_usd" in prompt


@pytest.mark.parametrize("freq,rate", [("8h", 0.0001), ("1h", 0.0001 / 8)])
def test_snapshot_funding_annualized_for_any_interval(freq, rate):
    funding = pd.Series(rate, index=pd.date_range("2026-01-01", periods=int(60 * 24 / int(freq[0])), freq=freq))
    s = A.market_snapshot(CLOSE, funding, 0.036, open_interest={"open_interest_btc": 30000.0})
    f = s["perp_funding"]
    for k in ("avg_1d_annualized", "avg_7d_annualized", "avg_30d_annualized"):
        assert f[k] == pytest.approx(0.1095, rel=1e-3)  # 每 8 小时 0.01% ≈ 年化 10.95%
    assert f["source"] == "hyperliquid" and s["perp_open_interest"]["open_interest_btc"] == 30000.0
    assert s["trend_rule_mode"] == "UP" and s["us_3m_tbill"] == 0.036


def test_fetch_hyperliquid_paginates_and_parses(monkeypatch):
    t0 = int(pd.Timestamp("2026-10-01").timestamp() * 1000)
    hour = 3_600_000
    pages = [[{"coin": "BTC", "fundingRate": "0.0000125", "premium": "0", "time": t0 + i * hour} for i in range(500)],
             [{"coin": "BTC", "fundingRate": "0.00002", "premium": "0", "time": t0 + (500 + i) * hour} for i in range(20)]]
    calls = []

    def fake_post(url, json, timeout):
        calls.append(json)
        if json["type"] == "fundingHistory":
            body = pages.pop(0) if pages else []
        else:
            body = [{"universe": [{"name": "ETH"}, {"name": "BTC"}]},
                    [{"openInterest": "1", "markPx": "1"}, {"openInterest": "25000.5", "markPx": "80000", "dayNtlVlm": "2e9"}]]
        return NS(raise_for_status=lambda: None, json=lambda: body)

    monkeypatch.setattr(A.requests, "post", fake_post)
    f = A.fetch_hyperliquid_funding(days=30)
    assert len(f) == 520 and f.iloc[-1] == pytest.approx(0.00002)
    assert calls[1]["startTime"] == t0 + 499 * hour + 1  # 第二页从上一页最后一条之后开始
    oi = A.fetch_hyperliquid_open_interest()
    assert oi["open_interest_btc"] == 25000.5 and oi["open_interest_usd"] == 25000.5 * 80000


def test_prompt_contains_research_checklist_and_missing_info_rule():
    assert "缺少信息本身不是看空或看多的理由" in A.SYSTEM_PROMPT
    for k in ("ETF", "衍生品", "链上", "宏观", "监管", "情绪"):
        assert k in A.SYSTEM_PROMPT


def test_review_matches_buy_hold_at_100pct():
    journal = [{"as_of_close_utc": str(IDX[250].date()), "final_pct": 100, "previous_pct": 100}]
    curves = A.review(journal, CLOSE, fee=0.0)
    np.testing.assert_allclose(curves["ai"].to_numpy(), curves["buy_hold"].to_numpy())


def test_usage_summary_cost_estimate():
    usage = NS(input_tokens=10_000, output_tokens=5_000, cache_read_input_tokens=200_000,
               cache_creation_input_tokens=40_000,
               server_tool_use=NS(web_search_requests=10, web_fetch_requests=4))
    u = A.usage_summary(usage)
    # 0.04 + 0.10 + 0.04 + 0.20 + 搜索 0.10
    assert u["estimated_cost_usd"] == pytest.approx(0.48)
    assert u["web_fetch_requests"] == 4
    assert A.usage_summary(None) == {}
