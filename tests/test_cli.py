import json

from money_seeker.cli import main


def test_demo_backtest_writes_outputs(tmp_path, capsys):
    main(["backtest", "--demo", "--out-dir", str(tmp_path)])
    for name in ["DEMO_equity.png", "DEMO_equity.csv", "DEMO_trades.csv", "DEMO_stats.json"]:
        assert (tmp_path / name).exists()
    stats = json.loads((tmp_path / "DEMO_stats.json").read_text())
    assert "sharpe" in stats["grid"]
    assert "sharpe" in capsys.readouterr().out
