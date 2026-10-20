"""命令行入口：python -m money_seeker {fetch,backtest} ..."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import pandas as pd

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


def _cmd_research(args: argparse.Namespace) -> None:
    from .research import best_equities, run_research

    assets = [a.lower() for a in args.assets]
    daily = {a: data.load_or_fetch_coinmetrics(a, args.data_dir, args.refresh) for a in assets}
    is_period = (args.is_start, args.is_end)
    oos_period = (args.oos_start, args.oos_end)
    table = run_research(daily, assets[0], is_period, oos_period)

    out = Path(args.out_dir)
    out.mkdir(parents=True, exist_ok=True)
    table.to_csv(out / "research_table.csv", index=False)
    for freq in ("D", "W"):
        for a in assets:
            curves = best_equities(daily, table, a, oos_period, freq)
            plot_equity(curves, out / f"research_{freq}_{a}.png",
                        title=f"{a.upper()} out-of-sample {args.oos_start} ~ "
                        f"{args.oos_end or 'latest'} ({'daily' if freq == 'D' else 'weekly'} bars)")
    with pd.option_context("display.width", 250, "display.max_columns", 30,
                           "display.precision", 3):
        print(table.to_string(index=False))
    print(f"输出目录: {out.resolve()}")


def _cmd_universe(args: argparse.Namespace) -> None:
    from .universe import EXTRA_ASSETS, equal_weight_portfolio, evaluate_universe

    assets = [a.lower() for a in (args.assets or ("btc", "eth", *EXTRA_ASSETS))]
    daily = {a: data.load_or_fetch_coinmetrics(a, args.data_dir, args.refresh) for a in assets}
    table = evaluate_universe(daily, main_lookback=args.lookback,
                              periods={"oos": (args.oos_start, None), "full": (None, None)})
    out = Path(args.out_dir)
    out.mkdir(parents=True, exist_ok=True)
    table.to_csv(out / "universe_table.csv", index=False)

    held_out = [a for a in assets if a not in ("btc", "eth")]  # 选参时没用过的币
    sub = table[table["asset"].isin(held_out)]
    g = sub.groupby(["period", "lookback_w"])
    summary = pd.DataFrame({
        "n": g.size(),
        "profitable": g.apply(lambda x: (x.total_ret > 0).sum()),
        "beat_bh_return": g.apply(lambda x: (x.total_ret > x.bh_total_ret).sum()),
        "beat_bh_sharpe": g.apply(lambda x: (x.sharpe > x.bh_sharpe).sum()),
        "smaller_drawdown": g.apply(lambda x: (x.max_dd > x.bh_max_dd).sum()),
        "median_sharpe": g["sharpe"].median(),
        "median_bh_sharpe": g["bh_sharpe"].median(),
        "median_placebo_pctile": g["placebo_pctile"].median(),
    })
    summary.to_csv(out / "universe_summary.csv")

    rows = []
    for name, exclude in (("held_out", ("btc", "eth")), ("held_out_ex_zec", ("btc", "eth", "zec"))):
        for start in (args.oos_start, args.long_start):
            for lb in (4, 8, 13, 26, 52):
                pf = equal_weight_portfolio(daily, lb, start, exclude=exclude)
                m, b = summarize(pf["momentum"]), summarize(pf["buy_hold"])
                rows.append({"universe": name, "start": start, "lookback_w": lb,
                             "n_assets": pf.attrs["n_assets"],
                             "total_ret": m["total_return"], "sharpe": m["sharpe"],
                             "max_dd": m["max_drawdown"], "bh_total_ret": b["total_return"],
                             "bh_sharpe": b["sharpe"], "bh_max_dd": b["max_drawdown"]})
                if lb == args.lookback:
                    plot_equity({"momentum": pf["momentum"], "buy & hold": pf["buy_hold"]},
                                out / f"universe_portfolio_{name}_{start[:4]}.png",
                                title=f"Equal-weight {pf.attrs['n_assets']} coins ({name}), "
                                f"weekly {lb}w momentum, from {start}")
    portfolio = pd.DataFrame(rows)
    portfolio.to_csv(out / "universe_portfolio.csv", index=False)

    with pd.option_context("display.width", 250, "display.max_columns", 30,
                           "display.precision", 2):
        print(summary.to_string())
        print(portfolio.to_string(index=False))
    print(f"输出目录: {out.resolve()}")


def _cmd_rotation(args: argparse.Namespace) -> None:
    from .rotation import (
        ROTATION_EXTRA_ASSETS, equal_weight_targets, placebo_pctile, price_panel, scan,
        simulate, target_weights,
    )
    from .universe import EXTRA_ASSETS

    assets = ["btc", "eth", *EXTRA_ASSETS]
    if args.universe == "42":
        assets += ROTATION_EXTRA_ASSETS
    assets = [a for a in assets if a not in args.exclude]
    daily = {a: data.load_or_fetch_coinmetrics(a, args.data_dir, args.refresh) for a in assets}
    px = price_panel(daily)
    is_period, oos_period = (args.is_start, args.is_end), (args.oos_start, None)
    tag = f"{args.universe}" + (f"_ex_{'_'.join(args.exclude)}" if args.exclude else "")

    res = scan(px, is_period, oos_period)
    out = Path(args.out_dir)
    out.mkdir(parents=True, exist_ok=True)
    res.to_csv(out / f"rotation_scan_{tag}.csv", index=False)

    # 只按样本内夏普选参数
    best = res.sort_values("IS_sharpe", ascending=False).iloc[0]
    params = dict(lookback=int(best["lookback_w"]), top_k=int(best["top_k"]), filt=best["filter"])
    w = target_weights(px, **params)
    pct, rand_median = placebo_pctile(px, w, *oos_period, n=args.placebo)

    curves = {"rotation": simulate(px, w, *oos_period)["equity"],
              "equal weight all": simulate(px, equal_weight_targets(px), *oos_period)["equity"]}
    btc = px["btc"].loc[args.oos_start:]
    curves["BTC buy & hold"] = btc / btc.iloc[0]
    yearly = pd.DataFrame(curves).resample("YE").last()
    yearly = pd.concat([pd.DataFrame(1.0, index=[curves["rotation"].index[0]], columns=yearly.columns),
                        yearly]).pct_change().iloc[1:]
    yearly.index = yearly.index.year

    summary = {
        "universe": tag, "n_assets": px.shape[1], "selected_params": params,
        "IS": {k[3:]: float(best[k]) for k in best.index if k.startswith("IS_")},
        "OOS": {k[4:]: float(best[k]) for k in best.index if k.startswith("OOS_")},
        "OOS_placebo_pctile": pct, "OOS_random_median_sharpe": rand_median,
        "OOS_benchmarks": {k: summarize(v) for k, v in curves.items() if k != "rotation"},
        "OOS_grid_profitable": f"{int((res['OOS_total_ret'] > 0).sum())}/{len(res)}",
        "OOS_yearly_return": {str(y): r.to_dict() for y, r in yearly.iterrows()},
    }
    (out / f"rotation_summary_{tag}.json").write_text(
        json.dumps(summary, indent=2, ensure_ascii=False, default=str))
    plot_equity(curves, out / f"rotation_{tag}.png",
                title=f"Cross-sectional momentum ({px.shape[1]} coins, {tag}), out-of-sample, "
                f"lookback={params['lookback']}w top{params['top_k']} {params['filt']}")
    print(json.dumps(summary, indent=2, ensure_ascii=False, default=str))
    print(f"输出目录: {out.resolve()}")


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

    r = sub.add_parser("research", help="多策略样本内选参 + 样本外检验（Coin Metrics 收盘价数据）")
    r.add_argument("--assets", nargs="+", default=["btc", "eth"],
                   help="币种，第一个用于选参数，其余用于交叉验证；默认 btc eth")
    r.add_argument("--is-start", default="2016-01-01", help="样本内开始")
    r.add_argument("--is-end", default="2021-12-31", help="样本内结束")
    r.add_argument("--oos-start", default="2022-01-01", help="样本外开始")
    r.add_argument("--oos-end", default=None, help="样本外结束，默认到最新")
    r.add_argument("--data-dir", default="data", help="数据缓存目录")
    r.add_argument("--refresh", action="store_true", help="忽略缓存重新拉数据")
    r.add_argument("--out-dir", default="output/research", help="结果输出目录")
    r.set_defaults(func=_cmd_research)

    u = sub.add_parser("universe", help="多币种验证周线时间序列动量（含安慰剂检验、等权组合）")
    u.add_argument("--assets", nargs="+", default=None,
                   help="币种列表，默认 BTC、ETH 加上 universe.EXTRA_ASSETS 中的 23 个币")
    u.add_argument("--lookback", type=int, default=4, help="主检验的回看周数，默认 4")
    u.add_argument("--oos-start", default="2022-01-01", help="样本外开始日期")
    u.add_argument("--long-start", default="2018-08-01", help="长区间组合的开始日期")
    u.add_argument("--data-dir", default="data", help="数据缓存目录")
    u.add_argument("--refresh", action="store_true", help="忽略缓存重新拉数据")
    u.add_argument("--out-dir", default="output/universe", help="结果输出目录")
    u.set_defaults(func=_cmd_universe)

    ro = sub.add_parser("rotation", help="横截面动量轮动：样本内选参、样本外检验、随机选币安慰剂")
    ro.add_argument("--universe", choices=("25", "42"), default="42",
                    help="25 = BTC、ETH 加 23 个币；42 = 再加 17 个币（含崩盘币），默认 42")
    ro.add_argument("--exclude", nargs="*", default=[], help="排除的币，例如 --exclude zec")
    ro.add_argument("--is-start", default="2018-08-01", help="样本内开始")
    ro.add_argument("--is-end", default="2021-12-31", help="样本内结束")
    ro.add_argument("--oos-start", default="2022-01-01", help="样本外开始")
    ro.add_argument("--placebo", type=int, default=300, help="随机选币次数，默认 300")
    ro.add_argument("--data-dir", default="data", help="数据缓存目录")
    ro.add_argument("--refresh", action="store_true", help="忽略缓存重新拉数据")
    ro.add_argument("--out-dir", default="output/rotation", help="结果输出目录")
    ro.set_defaults(func=_cmd_rotation)
    return p


def main(argv: list[str] | None = None) -> None:
    args = build_parser().parse_args(argv)
    args.func(args)


if __name__ == "__main__":
    main()
