"""Flask エンドポイント + ジョブロジックのテスト。外部 API はモックする。"""

import json
import os
from unittest.mock import MagicMock, patch

import pytest

os.environ.setdefault("TRANSCRIBE_AUTH_SECRET", "test-secret")
os.environ.setdefault("GEMINI_API_KEY", "fake-key")

from app.main import app


@pytest.fixture()
def client():
    app.config["TESTING"] = True
    with app.test_client() as c:
        yield c


class TestHealth:
    def test_returns_ok(self, client):
        resp = client.get("/health")
        assert resp.status_code == 200
        assert resp.get_json()["ok"] is True


class TestEnqueueAuth:
    def test_no_auth_returns_401(self, client):
        resp = client.post("/enqueue", json={"audioFileId": "abc"})
        assert resp.status_code == 401

    def test_wrong_token_returns_401(self, client):
        resp = client.post(
            "/enqueue",
            json={"audioFileId": "abc"},
            headers={"Authorization": "Bearer wrong"},
        )
        assert resp.status_code == 401

    def test_missing_file_id_returns_400(self, client):
        resp = client.post(
            "/enqueue",
            json={},
            headers={"Authorization": "Bearer test-secret"},
        )
        assert resp.status_code == 400


class TestExecuteAuth:
    def test_no_auth_returns_401(self, client):
        resp = client.post("/execute", json={"audioFileId": "abc"})
        assert resp.status_code == 401


class TestGeminiRetry:
    """Gemini API の 429/500/503 リトライロジック"""

    def test_retry_on_429(self):
        from app.main import _call_gemini_with_retry

        responses = [
            MagicMock(status_code=429, text="rate limited", json=lambda: {}),
            MagicMock(
                status_code=200,
                json=lambda: {
                    "candidates": [
                        {
                            "content": {"parts": [{"text": "transcript"}]},
                            "finishReason": "STOP",
                        }
                    ]
                },
            ),
        ]
        with patch("app.main.requests.post", side_effect=responses):
            result = _call_gemini_with_retry(
                "fake-key", "gemini-2.5-flash", "prompt", "uri", "audio/mp4",
                max_retries=2, retry_base_delay=0.0,
            )
        assert result == "transcript"

    def test_all_retries_exhausted_raises(self):
        from app.main import _call_gemini_with_retry

        fail_resp = MagicMock(status_code=500, text="server error", json=lambda: {})
        with patch("app.main.requests.post", return_value=fail_resp):
            with pytest.raises(RuntimeError, match="Gemini API failed"):
                _call_gemini_with_retry(
                    "fake-key", "gemini-2.5-flash", "prompt", "uri", "audio/mp4",
                    max_retries=2, retry_base_delay=0.0,
                )


class TestTranscriptFilenameSelection:
    """ジョブが単一/チャンクで正しいファイル名を選ぶか"""

    def test_single_file(self):
        from app.main import _output_filename

        assert _output_filename("2026-04-11", "田中", None, None) == "2026-04-11_田中_文字起こし.txt"

    def test_chunk_file(self):
        from app.main import _output_filename

        assert _output_filename("2026-04-11", "田中", 1, 2) == "2026-04-11_田中_文字起こし_01.txt"


class TestCloudTasksTaskResourceName:
    """Cloud Tasks task.name の長さ・文字制約"""

    def test_safe_id_unchanged_suffix(self):
        from app.main import _cloud_tasks_task_resource_name

        parent = "projects/p/locations/l/queues/q"
        pid = "1Ab_-xYz09"
        name = _cloud_tasks_task_resource_name(parent, pid)
        assert name == f"{parent}/tasks/transcribe-{pid}"
        assert len(name) <= 500

    def test_special_chars_replaced(self):
        from app.main import _cloud_tasks_task_resource_name

        parent = "projects/p/locations/l/queues/q"
        name = _cloud_tasks_task_resource_name(parent, "a/b:c@d")
        assert "/" not in name.split("/tasks/", 1)[-1]
        assert len(name) <= 500

    def test_very_long_id_gets_hash_suffix(self):
        from app.main import _cloud_tasks_task_resource_name

        parent = "projects/" + "x" * 200 + "/locations/l/queues/q"
        pid = "Z" * 400
        name = _cloud_tasks_task_resource_name(parent, pid)
        assert len(name) <= 500
        assert "transcribe-" in name
