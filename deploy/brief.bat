@echo off
REM money-seeker 每日简报（Windows 任务计划程序调用）。只读 Kraken、通过 Bark 推送，不下单。
REM 密钥和 Bark 配置放在项目根目录的 .env（已在 .gitignore 里，不会提交）。
cd /d "%~dp0.."
if not exist state mkdir state
venv\Scripts\python.exe -m money_seeker brief >> state\brief.log 2>&1
