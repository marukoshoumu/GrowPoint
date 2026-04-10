"""
Cloud Run: 長尺音声を ffmpeg で時間分割し、Drive の未処理フォルダへチャンクを配置する。

- POST /enqueue  … GAS から共有秘密で呼ぶ。Cloud Tasks 経由で /execute を起動（推奨）。
- POST /execute … 実処理。Cloud Tasks（OIDC）または共有秘密で認証。
"""

from __future__ import annotations

import base64
import json
import logging
import math
import os
import re
import secrets
import shutil
import subprocess
import tempfile
import threading
from pathlib import Path
from typing import Any

from flask import Flask, jsonify, request
from google.auth.transport.requests import Request as GoogleAuthRequest
from google.oauth2 import id_token
from googleapiclient.discovery import build
from googleapiclient.http import MediaFileUpload, MediaIoBaseDownload
import io

try:
    from google.cloud import tasks_v2
except ImportError:  # pragma: no cover
    tasks_v2 = None

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = Flask(__name__)


def _env(name: str, default: str | None = None) -> str | None:
    v = os.environ.get(name)
    return v if v is not None and v != "" else default


def _verify_bearer(expected: str) -> bool:
    auth = request.headers.get("Authorization") or ""
    if not auth.startswith("Bearer "):
        return False
    token = auth[7:].strip()
    if not expected:
        return False
    return secrets.compare_digest(token, expected)


def _verify_execute() -> bool:
    """共有秘密、または Cloud Tasks の OIDC（audience + invoker SA の email）。"""
    secret = _env("SPLIT_AUTH_SECRET", "")
    if secret and _verify_bearer(secret):
        return True
    auth = request.headers.get("Authorization") or ""
    if not auth.startswith("Bearer "):
        return False
    token = auth[7:].strip()
    audience = (_env("CLOUD_RUN_SERVICE_URL") or "").rstrip("/")
    invoker = _env("CLOUD_TASKS_INVOKER_SA_EMAIL")
    if not audience or not invoker:
        return False
    try:
        info = id_token.verify_oauth2_token(token, GoogleAuthRequest(), audience=audience)
    except Exception:
        return False
    return info.get("email") == invoker


def _verify_enqueue() -> bool:
    secret = _env("SPLIT_AUTH_SECRET", "")
    return bool(secret) and _verify_bearer(secret)


def _drive_service():
    return build("drive", "v3", cache_discovery=False)


def _download_file(svc, file_id: str, dest: Path) -> None:
    request_media = svc.files().get_media(fileId=file_id, supportsAllDrives=True)
    fh = io.BytesIO()
    downloader = MediaIoBaseDownload(fh, request_media)
    done = False
    while not done:
        _status, done = downloader.next_chunk()
    dest.write_bytes(fh.getvalue())


def _probe_duration_sec(path: Path) -> float:
    out = subprocess.check_output(
        [
            "ffprobe",
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "default=noprint_wrappers=1:nokey=1",
            str(path),
        ],
        stderr=subprocess.STDOUT,
    )
    return float(out.decode().strip())


def _sanitize_segment(s: str) -> str:
    s = s.strip()
    s = re.sub(r'[/\\:*?"<>|]', "_", s)
    return s


def _run_split_job(payload: dict[str, Any]) -> None:
    file_id = payload.get("fileId")
    user_name = _sanitize_segment(str(payload.get("userName") or "user"))
    date_str = str(payload.get("date") or "")[:32]
    chunk_seconds = int(payload.get("chunkSeconds") or 1200)
    unprocessed_id = payload.get("unprocessedFolderId")
    error_id = payload.get("errorFolderId")

    if not file_id or not unprocessed_id or not error_id:
        logger.error("split job: missing required ids")
        return

    tmp_root = Path(tempfile.mkdtemp(prefix="audsplit_"))
    local_in = tmp_root / "input.bin"
    try:
        svc = _drive_service()
        logger.info("split job start fileId=%s", file_id)
        _download_file(svc, file_id, local_in)

        duration = _probe_duration_sec(local_in)
        n_chunks = max(1, math.ceil(duration / float(chunk_seconds)))

        chunk_paths: list[Path] = []
        for i in range(n_chunks):
            start = i * chunk_seconds
            remain = duration - start
            if remain <= 0:
                break
            this_len = min(float(chunk_seconds), remain)
            nn = i + 1
            mm = n_chunks
            out_name = f"{user_name}_{date_str}_{nn:02d}-{mm:02d}.m4a"
            out_path = tmp_root / out_name
            subprocess.run(
                [
                    "ffmpeg",
                    "-y",
                    "-ss",
                    str(start),
                    "-i",
                    str(local_in),
                    "-t",
                    str(this_len),
                    "-c:a",
                    "aac",
                    "-b:a",
                    "128k",
                    str(out_path),
                ],
                check=True,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.PIPE,
            )
            chunk_paths.append(out_path)

        # アップロード（全成功後に元ファイルを処理）
        for p in chunk_paths:
            media = MediaFileUpload(
                str(p), mimetype="audio/mp4", resumable=True
            )
            svc.files().create(
                body={"name": p.name, "parents": [unprocessed_id]},
                media_body=media,
                fields="id",
                supportsAllDrives=True,
            ).execute()

        # 成功: 元ファイルをゴミ箱へ（再処理ループ防止）。共有ドライブでは supportsAllDrives 必須
        svc.files().update(
            fileId=file_id, body={"trashed": True}, supportsAllDrives=True
        ).execute()
        logger.info(
            "split job done fileId=%s chunks=%s",
            file_id,
            len(chunk_paths),
        )
    except Exception as e:
        logger.exception("split job failed fileId=%s err=%s", file_id, e)
        try:
            svc = _drive_service()
            fmeta = svc.files().get(
                fileId=file_id, fields="parents", supportsAllDrives=True
            ).execute()
            prev = ",".join(fmeta.get("parents") or [])
            if prev and error_id:
                svc.files().update(
                    fileId=file_id,
                    addParents=error_id,
                    removeParents=prev,
                    fields="id, parents",
                    supportsAllDrives=True,
                ).execute()
            else:
                svc.files().update(
                    fileId=file_id, body={"trashed": True}, supportsAllDrives=True
                ).execute()
        except Exception as move_err:
            logger.exception("failed to move original to error: %s", move_err)
        raise
    finally:
        shutil.rmtree(tmp_root, ignore_errors=True)


def _create_cloud_task(payload: dict[str, Any]) -> None:
    if tasks_v2 is None:
        raise RuntimeError("google-cloud-tasks not available")
    project = _env("GCP_PROJECT")
    location = _env("CLOUD_TASKS_LOCATION")
    queue_name = _env("CLOUD_TASKS_QUEUE")
    service_url = (_env("CLOUD_RUN_SERVICE_URL") or "").rstrip("/")
    invoker_sa = _env("CLOUD_TASKS_INVOKER_SA_EMAIL")
    if not all([project, location, queue_name, service_url, invoker_sa]):
        raise RuntimeError("missing GCP_PROJECT / CLOUD_TASKS_* / CLOUD_RUN_SERVICE_URL / INVOKER_SA")

    client = tasks_v2.CloudTasksClient()
    parent = client.queue_path(project, location, queue_name)
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    task: dict[str, Any] = {
        "http_request": {
            "http_method": tasks_v2.HttpMethod.POST,
            "url": f"{service_url}/execute",
            "headers": {"Content-Type": "application/json; charset=utf-8"},
            "body": base64.b64encode(body).decode("ascii"),
            "oidc_token": {
                "service_account_email": invoker_sa,
                "audience": service_url,
            },
        }
    }
    client.create_task(request={"parent": parent, "task": task})


@app.get("/health")
def health():
    return jsonify({"ok": True}), 200


@app.post("/enqueue")
def enqueue():
    if not _verify_enqueue():
        return jsonify({"error": "unauthorized"}), 401
    payload = request.get_json(silent=True) or {}
    if not payload.get("fileId"):
        return jsonify({"error": "fileId required"}), 400

    allow_inline = _env("ALLOW_INLINE_EXECUTE", "0") == "1"
    has_tasks = bool(
        _env("GCP_PROJECT")
        and _env("CLOUD_TASKS_LOCATION")
        and _env("CLOUD_TASKS_QUEUE")
        and _env("CLOUD_TASKS_INVOKER_SA_EMAIL")
    )

    try:
        if has_tasks:
            _create_cloud_task(payload)
            return "", 202
        if allow_inline:

            def _bg():
                try:
                    _run_split_job(payload)
                except Exception:
                    pass

            threading.Thread(target=_bg, daemon=True).start()
            return jsonify({"queued": "inline", "warning": "dev only"}), 202
    except Exception as e:
        logger.exception("enqueue failed: %s", e)
        return jsonify({"error": str(e)}), 503

    return (
        jsonify(
            {
                "error": "Configure Cloud Tasks env vars or set ALLOW_INLINE_EXECUTE=1 for dev only"
            }
        ),
        503,
    )


@app.post("/execute")
def execute():
    if not _verify_execute():
        return jsonify({"error": "unauthorized"}), 401
    payload = request.get_json(silent=True) or {}
    if not payload.get("fileId"):
        return jsonify({"error": "fileId required"}), 400
    try:
        _run_split_job(payload)
        return jsonify({"ok": True}), 200
    except Exception as e:
        logger.exception("execute failed: %s", e)
        return jsonify({"error": "split_failed", "detail": str(e)}), 500


if __name__ == "__main__":
    port = int(_env("PORT", "8080") or "8080")
    app.run(host="0.0.0.0", port=port, debug=_env("FLASK_DEBUG", "0") == "1")
