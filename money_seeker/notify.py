"""Bark 推送（和 pm-maker / schwab-bot 共用自建的 Bark 服务）。

BARK_URL 和 BARK_DEVICE_KEY 从环境变量或本项目的 .env 读取。没配置就只打印、不报错；
推送失败绝不能让主流程中断。
"""

from __future__ import annotations

import os

import requests

GROUP = "money-seeker"


def send(text: str, title: str = "money-seeker", level: str | None = None) -> bool:
    url = (os.getenv("BARK_URL") or "").rstrip("/")
    key = os.getenv("BARK_DEVICE_KEY")
    if not url or not key:
        print(f"（未配置 Bark，仅打印）{title}: {text}")
        return False
    body = {"device_key": key, "title": title, "body": text, "group": GROUP}
    if level:
        body["level"] = level  # timeSensitive 能穿透专注模式
    try:
        r = requests.post(f"{url}/push", json=body, timeout=10)
        if r.status_code != 200:
            print(f"Bark 推送失败: {r.status_code} {r.text[:200]}")
            return False
        return True
    except Exception as e:  # noqa: BLE001 - 推送失败不影响主流程
        print(f"Bark 推送出错（不影响主流程）: {e}")
        return False
