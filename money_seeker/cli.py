"""命令行入口：python -m money_seeker {fetch,backtest} ..."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from . import data
from .metrics import summarize
from .plot import plot_equity
from .strategy import GridConfig, buy_and_hold, run_grid_backtest


def _cmd_fetch(args: argparse.Namespace) -> None:
    df = data.fetch_binance_daily(args.symbol, args.start, args.end)
    path = data.save_csv(df, Path(args.data_dir) / f"{args.symbol.upper()}_1d.csv")
    print(f"已保存 {len(df)} 根日线 -> {path}  ({df.index[0].date()} ~ {df.index[-1].date()})")


def _load(args: argparse.Namespace):
    if args.demo:
        return data.synthetic_daily(), "DEMO"
    if args.csv:
        df = data.load_csv(args.csv).loc[args.start : args.end]
        return df, Path(args.csv).stem
    df = data.load_or_fetch(args.symbol, args.start, args.end, args.data_dir, args.refresh)
    return df, args.symbol.upper()


def _fmt(stats: dict) -> str:
    pct = {"total_return", "annual_return", "annual_volatility", "max_drawdown"}
    lines = []
    for k, v in stats.items():
        if k in pct:
            v = f"{v:.2%}"
        elif isinstance(v, float):
            v = f"{v:,.4f}" if k == "sharpe" else f"{v:,.2f}"
        lines.append(f"  {k:<18}{v}")
    return "\n".join(lines)


def _cmd_backtest(args: argparse.Namespace) -> None:
    df, name = _load(args)
    if df.empty:
        raise SystemExit("所选区间内没有数据")

    # 未指定区间时，以首日开盘价上下 range_pct 作为网格区间（避免使用未来数据）
    p0 = float(df["open"].iloc[0])
    lower = args.lower or p0 * (1 - args.range_pct)
    upper = args.upper or p0 * (1 + args.range_pct)
    config = GridConfig(
        lower=lower,
        upper=upper,
        n_grids=args.grids,
        capital=args.capital,
        fee_rate=args.fee,
        geometric=args.geometric,
    )
    result = run_grid_backtest(df, config)
    bench = buy_and_hold(df, args.capital, args.fee)

    grid_stats = summarize(result.equity, args.risk_free)
    grid_stats["trades"] = len(result.trades)
    grid_stats["round_trips"] = int((result.trades["side"] == "sell").sum())
    bench_stats = summarize(bench, args.risk_free)

    out = Path(args.out_dir)
    out.mkdir(parents=True, exist_ok=True)
    result.equity.to_frame().join(bench).to_csv(out / f"{name}_equity.csv")
    result.trades.to_csv(out / f"{name}_trades.csv", index=False)
    (out / f"{name}_stats.json").write_text(
        json.dumps({"config": vars(config), "grid": grid_stats, "buy_and_hold": bench_stats},
                   indent=2, ensure_ascii=False)
    )
    png = plot_equity(
        {"grid": result.equity, "buy & hold": bench},
        out / f"{name}_equity.png",
        title=f"{name} grid [{lower:,.2f}, {upper:,.2f}] x {args.grids}  "
        f"Sharpe {grid_stats['sharpe']:.2f}",
        levels=(lower, upper),
        price=df["close"],
    )

    print(f"== {name} 网格区间 [{lower:,.2f}, {upper:,.2f}]，{args.grids} 格，"
          f"{'等比' if args.geometric else '等差'}")
    print("网格策略:\n" + _fmt(grid_stats))
    print("买入持有基准:\n" + _fmt(bench_stats))
    print(f"输出目录: {out.resolve()}  (收益曲线图 {png.name})")


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="money_seeker", description="虚拟币日线网格策略回测")
    sub = p.add_subparsers(dest="command", required=True)

    def common(sp: argparse.ArgumentParser) -> None:
        sp.add_argument("--symbol", default="BTCUSDT", help="Binance 交易对，默认 BTCUSDT")
        sp.add_argument("--start", default="2023-01-01", help="开始日期 YYYY-MM-DD")
        sp.add_argument("--end", default=None, help="结束日期 YYYY-MM-DD，默认至昨天")
        sp.add_argument("--data-dir", default="data", help="数据缓存目录")

    f = sub.add_parser("fetch", help="拉取日线数据并保存为 CSV")
    common(f)
    f.set_defaults(func=_cmd_fetch)

    b = sub.add_parser("backtest", help="运行网格策略回测")
    common(b)
    src = b.add_mutually_exclusive_group()
    src.add_argument("--csv", help="使用本地 CSV（列: date,open,high,low,close[,volume]）")
    src.add_argument("--demo", action="store_true", help="使用离线模拟数据，无需联网")
    b.add_argument("--refresh", action="store_true", help="忽略缓存，重新拉取")
    b.add_argument("--lower", type=float, help="网格下沿价格")
    b.add_argument("--upper", type=float, help="网格上沿价格")
    b.add_argument("--range-pct", type=float, default=0.3,
                   help="未给出上下沿时，按首日开盘价 ±该比例 设定，默认 0.3")
    b.add_argument("--grids", type=int, default=20, help="网格数量，默认 20")
    b.add_argument("--geometric", action="store_true", help="使用等比网格（默认等差）")
    b.add_argument("--capital", type=float, default=10_000, help="初始资金（计价币），默认 10000")
    b.add_argument("--fee", type=float, default=0.001, help="单边手续费率，默认 0.001")
    b.add_argument("--risk-free", type=float, default=0.0, help="年化无风险利率，默认 0")
    b.add_argument("--out-dir", default="output", help="结果输出目录")
    b.set_defaults(func=_cmd_backtest)
    return p


def main(argv: list[str] | None = None) -> None:
    args = build_parser().parse_args(argv)
    args.func(args)


if __name__ == "__main__":
    main()
