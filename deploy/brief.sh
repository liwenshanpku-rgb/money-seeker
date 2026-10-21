#!/usr/bin/env bash
# money-seeker 每日简报（macOS / Linux 的 cron 调用）。只读 Kraken、通过 Bark 推送，不下单。
# 密钥和 Bark 配置放在项目根目录的 .env（已在 .gitignore 里，不会提交）。
cd "$(dirname "$0")/.." || exit 1
mkdir -p state
./venv/bin/python -m money_seeker brief >> state/brief.log 2>&1
