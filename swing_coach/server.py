"""挥杆教练本地服务：提供网页静态文件，并把关键帧 + 测量数据转给 Claude 生成教练点评。

用法：
    export ANTHROPIC_API_KEY=sk-ant-...
    python swing_coach/server.py            # 打开 http://localhost:8000
    python swing_coach/server.py --port 9000 --host 0.0.0.0

网页里的姿态识别和 P1–P10 分析完全在浏览器端完成；只有点击「生成 AI 点评」时，
10 张关键帧截图和测量数据才会发送到 Claude API。
"""

from __future__ import annotations

import argparse
import base64
import binascii
import json
import os
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

WEB_DIR = Path(__file__).resolve().parent / "web"
MODEL = os.environ.get("SWING_COACH_MODEL", "claude-opus-5-5")
MAX_BODY = 12 * 1024 * 1024
MAX_IMAGES = 12

POSITION_NAMES = {
    "P1": "准备站位", "P2": "起杆（杆身与地面平行）", "P3": "上杆中段（前臂与地面平行）",
    "P4": "上杆顶点", "P5": "下杆早段（前臂与地面平行）", "P6": "下杆释放前（杆身与地面平行）",
    "P7": "击球", "P8": "送杆（杆身与地面平行）", "P9": "收杆前段（后臂与地面平行）", "P10": "收杆",
}

SYSTEM_PROMPT = """你是一位经验丰富的 PGA 认证高尔夫教练，精通 P1–P10 挥杆分析体系，擅长用通俗的中文给业余球员讲解。

你会收到同一次挥杆的 P1–P10 关键帧截图（橙色骨架是学员，绿色虚线骨架和虚线球杆是按学员身材对齐的职业模板），
以及程序根据 2D 关键点测得的数据和职业区间。测量来自单机位 2D 视频，有透视和识别误差：
以截图中能看到的情况为准，数据和画面矛盾时要指出来，不要过度解读细小差异。截图里看不到球杆的细节时，不要编造杆面角度等信息。

请按以下结构输出 Markdown：
## 总体评价
两三句话概括这次挥杆的优点和最核心的问题（指出问题之间的因果关系，例如上杆反向重心导致下杆重心留在后脚）。
## 关键位置点评
只挑有明显问题或值得肯定的位置（如 P1、P4、P7），每条写清楚「看到了什么 → 与职业模板的差别 → 可能导致的球路」。
## 优先改进
按优先级列出 2–3 个改进点，每个包含：要改什么、动作要领（身体感觉）、一个具体练习（步骤、次数）。
## 两周练习计划
简短的每周安排（每次 30–45 分钟），从慢动作分解到实打。

语气鼓励、具体、可执行，避免空泛的术语堆砌。"""


def _decode_image(data_url: str) -> tuple[str, str]:
    """把 data:image/jpeg;base64,... 拆成 (media_type, base64 数据)，并校验格式。"""
    if not isinstance(data_url, str) or not data_url.startswith("data:image/"):
        raise ValueError("图片格式不正确")
    header, _, b64 = data_url.partition(",")
    media_type = header[5:].split(";")[0]
    if media_type not in {"image/jpeg", "image/png", "image/webp"}:
        raise ValueError(f"不支持的图片类型：{media_type}")
    try:
        base64.b64decode(b64, validate=True)
    except (binascii.Error, ValueError) as err:
        raise ValueError("图片数据损坏") from err
    return media_type, b64


def build_messages(payload: dict) -> list[dict]:
    """把网页提交的数据组装成发给 Claude 的消息。"""
    images = payload.get("images") or []
    if not images:
        raise ValueError("没有关键帧图片")
    if len(images) > MAX_IMAGES:
        raise ValueError("图片太多")

    content: list[dict] = []
    for img in images:
        pos = str(img.get("pos", ""))
        media_type, b64 = _decode_image(img.get("data", ""))
        content.append({"type": "text", "text": f"{pos} {POSITION_NAMES.get(pos, '')}"})
        content.append({"type": "image", "source": {"type": "base64", "media_type": media_type, "data": b64}})

    s = payload.get("settings") or {}
    info = {
        "惯用手": "左手" if s.get("handed") == "left" else "右手",
        "球杆": "一号木" if s.get("club") == "driver" else "铁杆",
        "拍摄角度": "正面（face-on）" if s.get("view") == "fo" else "侧面（down-the-line）",
        "综合评分": payload.get("score"),
        "各位置时间(秒)": payload.get("timing"),
    }
    lines = [
        "以上是 P1–P10 关键帧。基本信息：",
        json.dumps(info, ensure_ascii=False),
        "",
        "程序测量结果（status：good=在职业区间内，warn=接近，bad=明显偏离，na=无法判断；pro_value 为学员上传的职业视频的同项数值，可能为空）：",
        json.dumps(payload.get("metrics") or [], ensure_ascii=False),
    ]
    if s.get("demo"):
        lines.append("\n注意：这是程序合成的示例挥杆（只有骨架，没有真实画面），请基于骨架和数据点评。")
    note = str(payload.get("note") or "").strip()[:500]
    if note:
        lines.append(f"\n学员补充：{note}")
    lines.append("\n请给出教练点评。")
    content.append({"type": "text", "text": "\n".join(lines)})
    return [{"role": "user", "content": content}]


def coach(payload: dict, client=None) -> str:
    import anthropic

    client = client or anthropic.Anthropic()
    with client.beta.messages.stream(
        model=MODEL,
        max_tokens=16000,
        system=SYSTEM_PROMPT,
        thinking={"type": "adaptive"},
        output_config={"effort": "medium"},
        betas=["server-side-fallback-2026-07-01"],
        fallbacks="default",
        messages=build_messages(payload),
    ) as stream:
        message = stream.get_final_message()
    if message.stop_reason == "refusal":
        raise RuntimeError("模型拒绝了这次请求，请换一段视频或修改补充说明后重试")
    text = "".join(b.text for b in message.content if b.type == "text").strip()
    if not text:
        raise RuntimeError("模型没有返回内容")
    return text


class Handler(SimpleHTTPRequestHandler):
    def do_POST(self):
        if self.path.rstrip("/") not in ("/api/coach", "/api/coach.json"):
            self._json(404, {"error": "not found"})
            return
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0 or length > MAX_BODY:
            self._json(413, {"error": "请求过大或为空"})
            return
        try:
            payload = json.loads(self.rfile.read(length))
            text = coach(payload)
        except (ValueError, json.JSONDecodeError) as err:
            self._json(400, {"error": str(err)})
            return
        except Exception as err:  # noqa: BLE001 - 把 API 错误原样告诉前端
            self._json(502, {"error": _friendly_error(err)})
            return
        self._json(200, {"text": text})

    def _json(self, code: int, body: dict):
        data = json.dumps(body, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


def _friendly_error(err: Exception) -> str:
    try:
        import anthropic
    except ImportError:
        return "服务器未安装 anthropic：pip install -r swing_coach/requirements.txt"
    if isinstance(err, anthropic.AuthenticationError):
        return "Claude API 认证失败，请检查 ANTHROPIC_API_KEY"
    if isinstance(err, anthropic.RateLimitError):
        return "请求太频繁，请稍后再试"
    if isinstance(err, anthropic.APIConnectionError):
        return "无法连接 Claude API，请检查网络"
    if isinstance(err, anthropic.APIStatusError):
        return f"Claude API 错误（{err.status_code}）：{err.message}"
    return str(err)


def main():
    ap = argparse.ArgumentParser(description="挥杆教练本地服务")
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8000)
    args = ap.parse_args()
    server = ThreadingHTTPServer((args.host, args.port), partial(Handler, directory=str(WEB_DIR)))
    print(f"挥杆教练已启动：http://{args.host}:{args.port}  （Ctrl+C 退出）")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
