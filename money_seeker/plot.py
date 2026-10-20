"""收益曲线绘图。"""

from __future__ import annotations

from pathlib import Path

import matplotlib

matplotlib.use("Agg")  # 无界面环境也能出图
import matplotlib.pyplot as plt  # noqa: E402
import pandas as pd  # noqa: E402


def plot_equity(
    curves: dict[str, pd.Series],
    path: str | Path,
    title: str = "Equity Curve",
    levels: tuple[float, float] | None = None,
    price: pd.Series | None = None,
) -> Path:
    """上图：各曲线的累计收益；下图（可选）：价格与网格上下沿。"""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    rows = 2 if price is not None else 1
    fig, axes = plt.subplots(
        rows, 1, figsize=(11, 4.5 * rows), sharex=True, squeeze=False
    )
    ax = axes[0, 0]
    for name, s in curves.items():
        ax.plot(s.index, (s / s.iloc[0] - 1) * 100, label=name, linewidth=1.4)
    ax.axhline(0, color="grey", linewidth=0.8, linestyle=":")
    ax.set_ylabel("Cumulative return (%)")
    ax.set_title(title)
    ax.legend()
    ax.grid(alpha=0.3)

    if price is not None:
        ax2 = axes[1, 0]
        ax2.plot(price.index, price, color="black", linewidth=1, label="close")
        if levels:
            for lv, name, color in zip(
                levels, ("grid lower", "grid upper"), ("tab:green", "tab:red")
            ):
                ax2.axhline(lv, color=color, linestyle="--", linewidth=0.9, label=name)
        ax2.set_ylabel("Price")
        ax2.legend()
        ax2.grid(alpha=0.3)

    fig.tight_layout()
    fig.savefig(path, dpi=120)
    plt.close(fig)
    return path
