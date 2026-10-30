import base64
import importlib.util
import json
from pathlib import Path

import pytest

_spec = importlib.util.spec_from_file_location("coach_task", Path(__file__).parent.parent / "swing_coach" / "coach_task.py")
task = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(task)

JPEG_BYTES = b"\xff\xd8\xff fake jpeg"
JPEG = "data:image/jpeg;base64," + base64.b64encode(JPEG_BYTES).decode()
RID = "20261030120000-abc123"


def payload(**kw):
    p = {
        "settings": {"handed": "right", "club": "iron", "view": "fo", "skeletonOnly": True},
        "score": 72,
        "metrics": [{"pos": "P7", "name": "击球时骨盆前移", "value": "0.01", "status": "bad"}],
        "images": [{"pos": "P1", "data": JPEG}, {"pos": "P7", "data": JPEG}],
        "note": "经常打右曲",
    }
    p.update(kw)
    return p


def write_request(data: Path, rid=RID, **kw):
    (data / "requests").mkdir(parents=True, exist_ok=True)
    (data / "requests" / f"{rid}.json").write_text(json.dumps(payload(**kw), ensure_ascii=False), encoding="utf-8")


def test_prepare_writes_images_and_task(tmp_path):
    data, work = tmp_path / "data", tmp_path / "work"
    write_request(data)
    task.prepare(data, RID, work)
    assert (work / "01_P1.jpg").read_bytes() == JPEG_BYTES
    assert (work / "02_P7.jpg").exists()
    text = (work / "task.md").read_text(encoding="utf-8")
    assert str((work / "01_P1.jpg").resolve()) in text
    assert str((work / "review.md").resolve()) in text
    assert "击球时骨盆前移" in text and "经常打右曲" in text
    assert "只有骨架" in text


@pytest.mark.parametrize("images", [
    [],
    [{"pos": "P1", "data": "http://example.com/x.jpg"}],
    [{"pos": "P1", "data": "data:image/gif;base64,AAAA"}],
    [{"pos": "P99", "data": JPEG}],
])
def test_prepare_rejects_bad_requests(tmp_path, images):
    write_request(tmp_path / "data", images=images)
    with pytest.raises(ValueError):
        task.prepare(tmp_path / "data", RID, tmp_path / "work")


@pytest.mark.parametrize("rid", ["../../etc", "a b", "x"])
def test_bad_ids_rejected(tmp_path, rid):
    with pytest.raises(ValueError):
        task.prepare(tmp_path, rid, tmp_path / "w")


def test_finish_and_prune(tmp_path):
    data, work, out = tmp_path / "data", tmp_path / "work", tmp_path / "out"
    write_request(data)
    write_request(data, rid="20261030120500-pend01")
    work.mkdir()
    assert task.finish(out, RID, work) is False
    assert (out / "errors" / f"{RID}.txt").exists()

    (work / "review.md").write_text("## 总体评价\n不错\n", encoding="utf-8")
    assert task.finish(out, RID, work) is True
    assert (out / "reviews" / f"{RID}.md").read_text(encoding="utf-8").startswith("## 总体评价")

    (data / "reviews").mkdir()
    (data / "reviews" / f"{RID}.md").write_text("ok", encoding="utf-8")
    assert task.prune(data) == [RID]
    assert not (data / "requests" / f"{RID}.json").exists()
    assert (data / "requests" / "20261030120500-pend01.json").exists()
