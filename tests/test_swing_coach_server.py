import base64
import importlib.util
from pathlib import Path
from types import SimpleNamespace

import pytest

_spec = importlib.util.spec_from_file_location("swing_server", Path(__file__).parent.parent / "swing_coach" / "server.py")
server = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(server)

JPEG = "data:image/jpeg;base64," + base64.b64encode(b"\xff\xd8\xff fake").decode()


def payload(**kw):
    p = {
        "settings": {"handed": "right", "club": "iron", "view": "fo"},
        "score": 72,
        "timing": {"P1": 0.5, "P4": 1.3, "P7": 1.6},
        "metrics": [{"pos": "P7", "name": "击球时骨盆前移", "value": "0.01", "status": "bad"}],
        "images": [{"pos": "P1", "data": JPEG}, {"pos": "P7", "data": JPEG}],
        "note": "经常打右曲",
    }
    p.update(kw)
    return p


def test_build_messages_interleaves_labels_and_images():
    content = server.build_messages(payload())[0]["content"]
    assert [b["type"] for b in content] == ["text", "image", "text", "image", "text"]
    assert content[0]["text"].startswith("P1")
    assert content[1]["source"]["media_type"] == "image/jpeg"
    assert "经常打右曲" in content[-1]["text"]
    assert "击球时骨盆前移" in content[-1]["text"]


@pytest.mark.parametrize("images", [[], [{"pos": "P1", "data": "http://x"}], [{"pos": "P1", "data": "data:image/gif;base64,AAAA"}]])
def test_build_messages_rejects_bad_images(images):
    with pytest.raises(ValueError):
        server.build_messages(payload(images=images))


class FakeStream:
    def __init__(self, message):
        self.message = message

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def get_final_message(self):
        return self.message


def fake_client(message, seen):
    def stream(**kwargs):
        seen.update(kwargs)
        return FakeStream(message)
    return SimpleNamespace(beta=SimpleNamespace(messages=SimpleNamespace(stream=stream)))


def test_coach_returns_text_and_uses_fallbacks():
    seen = {}
    msg = SimpleNamespace(stop_reason="end_turn", content=[SimpleNamespace(type="thinking"), SimpleNamespace(type="text", text="## 总体评价\n不错")])
    assert server.coach(payload(), client=fake_client(msg, seen)).startswith("## 总体评价")
    assert seen["fallbacks"] == "default"
    assert seen["thinking"] == {"type": "adaptive"}


def test_coach_raises_on_refusal():
    msg = SimpleNamespace(stop_reason="refusal", content=[])
    with pytest.raises(RuntimeError):
        server.coach(payload(), client=fake_client(msg, {}))
