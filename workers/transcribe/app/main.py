"""
Cloud Run: 音声ファイルを Gemini で文字起こしし、結果を Drive に保存する。

- POST /enqueue  … GAS から共有秘密で呼ぶ。Cloud Tasks 経由で /execute を起動。
- POST /execute  … 実処理。Cloud Tasks（OIDC）または共有秘密で認証。
"""

from __future__ import annotations

import base64
import json
import logging
import os
import secrets
import shutil
import tempfile
import threading
import time
from pathlib import Path
from typing import Any

import requests
from flask import Flask, jsonify, request
from google.auth.transport.requests import Request as GoogleAuthRequest
from google.oauth2 import id_token
from googleapiclient.discovery import build
from googleapiclient.http import MediaFileUpload, MediaIoBaseDownload

from app.naming import chunk_transcript_filename, transcript_filename

try:
    from google.cloud import tasks_v2
except ImportError:  # pragma: no cover
    tasks_v2 = None

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = Flask(__name__)

# ---------------------------------------------------------------------------
# Config helpers
# ---------------------------------------------------------------------------

GEMINI_API_BASE = "https://generativelanguage.googleapis.com"
GEMINI_MODEL_DEFAULT = "gemini-2.5-flash"
GEMINI_MAX_OUTPUT_TOKENS = 65536
GEMINI_TEMPERATURE = 0.1
GEMINI_TIMEOUT_SEC = 900


def _env(name: str, default: str | None = None) -> str | None:
    v = os.environ.get(name)
    return v if v is not None and v != "" else default


# ---------------------------------------------------------------------------
# Auth (same pattern as audio-split worker)
# ---------------------------------------------------------------------------

def _verify_bearer(expected: str) -> bool:
    auth = request.headers.get("Authorization") or ""
    if not auth.startswith("Bearer "):
        return False
    token = auth[7:].strip()
    if not expected:
        return False
    return secrets.compare_digest(token, expected)


def _verify_execute() -> bool:
    secret = _env("TRANSCRIBE_AUTH_SECRET", "")
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
    secret = _env("TRANSCRIBE_AUTH_SECRET", "")
    return bool(secret) and _verify_bearer(secret)


# ---------------------------------------------------------------------------
# Drive helpers
# ---------------------------------------------------------------------------

def _drive_service():
    return build("drive", "v3", cache_discovery=False)


def _download_file(svc, file_id: str, dest: Path) -> None:
    request_media = svc.files().get_media(fileId=file_id, supportsAllDrives=True)
    with dest.open("wb") as out_f:
        downloader = MediaIoBaseDownload(out_f, request_media)
        done = False
        while not done:
            _status, done = downloader.next_chunk()


def _upload_text_to_drive(svc, folder_id: str, file_name: str, text: str) -> str:
    """テキストを Drive フォルダにアップロードし、file ID を返す。同名は上書き相当（先に削除）。"""
    # 同名ファイルをゴミ箱へ（重複防止）
    q = f"name='{file_name}' and '{folder_id}' in parents and trashed=false"
    existing = svc.files().list(q=q, fields="files(id)", supportsAllDrives=True).execute()
    for f in existing.get("files", []):
        svc.files().update(fileId=f["id"], body={"trashed": True}, supportsAllDrives=True).execute()

    tmp = Path(tempfile.mktemp(suffix=".txt"))
    try:
        tmp.write_text(text, encoding="utf-8")
        media = MediaFileUpload(str(tmp), mimetype="text/plain", resumable=False)
        created = svc.files().create(
            body={"name": file_name, "parents": [folder_id]},
            media_body=media,
            fields="id",
            supportsAllDrives=True,
        ).execute()
        return created["id"]
    finally:
        tmp.unlink(missing_ok=True)


# ---------------------------------------------------------------------------
# Gemini API
# ---------------------------------------------------------------------------

def _upload_to_gemini_file_api(api_key: str, file_path: Path, display_name: str, mime_type: str) -> str:
    """Gemini File API にアップロードし、fileUri を返す。"""
    url = f"{GEMINI_API_BASE}/upload/v1beta/files?key={api_key}"
    with file_path.open("rb") as f:
        resp = requests.post(
            url,
            headers={"X-Goog-Upload-Display-Name": display_name},
            data=f,
            timeout=300,
        )
    if resp.status_code != 200:
        raise RuntimeError(f"Gemini File API upload error ({resp.status_code}): {resp.text[:500]}")
    return resp.json()["file"]["uri"]


def _call_gemini_with_retry(
    api_key: str,
    model: str,
    prompt: str,
    file_uri: str,
    mime_type: str,
    max_retries: int = 2,
    retry_base_delay: float = 2.0,
) -> str:
    """Gemini generateContent を呼び出す。429/500/502/503 はリトライ。"""
    url = f"{GEMINI_API_BASE}/v1beta/models/{model}:generateContent?key={api_key}"
    payload = {
        "contents": [
            {
                "parts": [
                    {"fileData": {"mimeType": mime_type, "fileUri": file_uri}},
                    {"text": prompt},
                ]
            }
        ],
        "generationConfig": {
            "temperature": GEMINI_TEMPERATURE,
            "maxOutputTokens": GEMINI_MAX_OUTPUT_TOKENS,
        },
    }
    last_error: Exception | None = None
    for attempt in range(max_retries + 1):
        try:
            resp = requests.post(url, json=payload, timeout=GEMINI_TIMEOUT_SEC)
        except requests.exceptions.RequestException as e:
            last_error = RuntimeError(f"Gemini API request error: {e}")
            if attempt < max_retries:
                time.sleep(retry_base_delay * (attempt + 1))
                continue
            raise last_error

        if resp.status_code == 200:
            result = resp.json()
            # usage logging
            usage = result.get("usageMetadata")
            if usage:
                logger.info("Gemini token usage: prompt=%s candidates=%s total=%s",
                            usage.get("promptTokenCount"), usage.get("candidatesTokenCount"),
                            usage.get("totalTokenCount"))
            candidates = result.get("candidates", [])
            if not candidates:
                raise RuntimeError("Gemini API returned no candidates")
            candidate = candidates[0]
            finish = candidate.get("finishReason", "")
            if finish == "SAFETY":
                raise RuntimeError("Gemini API response blocked by safety filter")
            if finish == "MAX_TOKENS":
                logger.warning("finishReason=MAX_TOKENS: output may be truncated")
            parts = (candidate.get("content") or {}).get("parts") or []
            if not parts:
                raise RuntimeError("Gemini API response has no content parts")
            return parts[0]["text"]

        if resp.status_code in (429, 500, 502, 503) and attempt < max_retries:
            delay = retry_base_delay * (attempt + 1)
            logger.warning("Gemini API %s, retry %s/%s after %.1fs",
                           resp.status_code, attempt + 1, max_retries, delay)
            time.sleep(delay)
            last_error = RuntimeError(f"Gemini API failed ({resp.status_code}): {resp.text[:500]}")
            continue

        raise RuntimeError(f"Gemini API failed ({resp.status_code}): {resp.text[:500]}")

    raise last_error or RuntimeError("Gemini API failed: retries exhausted")


# ---------------------------------------------------------------------------
# Output filename (delegates to naming module)
# ---------------------------------------------------------------------------

def _output_filename(date: str, user_name: str, chunk_index: int | None, chunk_total: int | None) -> str:
    if chunk_index is not None and chunk_total is not None:
        return chunk_transcript_filename(date, user_name, chunk_index, chunk_total)
    return transcript_filename(date, user_name)


# ---------------------------------------------------------------------------
# Transcription job
# ---------------------------------------------------------------------------

def _run_transcribe_job(payload: dict[str, Any]) -> None:
    audio_file_id = payload.get("audioFileId")
    user_name = str(payload.get("userName") or "user")
    date_str = str(payload.get("date") or "")[:32]
    chunk_index = payload.get("chunkIndex")
    chunk_total = payload.get("chunkTotal")
    extracted_folder_id = payload.get("extractedFolderId")
    prompt = payload.get("prompt", "")
    error_folder_id = payload.get("errorFolderId")

    if not audio_file_id or not extracted_folder_id:
        logger.error("transcribe job: missing required ids")
        return

    api_key = _env("GEMINI_API_KEY", "")
    if not api_key:
        raise RuntimeError("GEMINI_API_KEY not set")

    model = _env("GEMINI_MODEL", GEMINI_MODEL_DEFAULT)
    tmp_root = Path(tempfile.mkdtemp(prefix="transcribe_"))
    local_audio = tmp_root / "audio.bin"

    try:
        svc = _drive_service()
        logger.info("transcribe job start audioFileId=%s", audio_file_id)

        # 1. Drive から音声ダウンロード
        _download_file(svc, audio_file_id, local_audio)

        # ファイル名・MIME 取得
        file_meta = svc.files().get(
            fileId=audio_file_id, fields="name,mimeType", supportsAllDrives=True
        ).execute()
        display_name = file_meta.get("name", "audio")
        mime_type = file_meta.get("mimeType", "audio/mp4")

        # 2. Gemini File API にアップロード
        file_uri = _upload_to_gemini_file_api(api_key, local_audio, display_name, mime_type)
        logger.info("Gemini File API upload done: %s", file_uri)

        # 3. Gemini generateContent
        transcript = _call_gemini_with_retry(api_key, model, prompt, file_uri, mime_type)
        logger.info("transcription done: %d chars", len(transcript))

        # 4. Drive に結果保存
        out_name = _output_filename(date_str, user_name, chunk_index, chunk_total)
        file_id = _upload_text_to_drive(svc, extracted_folder_id, out_name, transcript)
        logger.info("saved to Drive: %s (id=%s)", out_name, file_id)

    except Exception as e:
        logger.exception("transcribe job failed audioFileId=%s err=%s", audio_file_id, e)
        raise
    finally:
        shutil.rmtree(tmp_root, ignore_errors=True)


# ---------------------------------------------------------------------------
# Cloud Tasks
# ---------------------------------------------------------------------------

def _create_cloud_task(payload: dict[str, Any], process_id: str) -> None:
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
    # task name で冪等化（同一 processId の重複投入を排除）
    task_name = f"{parent}/tasks/transcribe-{process_id}"
    task: dict[str, Any] = {
        "name": task_name,
        "http_request": {
            "http_method": tasks_v2.HttpMethod.POST,
            "url": f"{service_url}/execute",
            "headers": {"Content-Type": "application/json; charset=utf-8"},
            "body": base64.b64encode(body).decode("ascii"),
            "oidc_token": {
                "service_account_email": invoker_sa,
                "audience": service_url,
            },
        },
    }
    client.create_task(request={"parent": parent, "task": task})


# ---------------------------------------------------------------------------
# Flask routes
# ---------------------------------------------------------------------------

@app.get("/health")
def health():
    return jsonify({"ok": True}), 200


@app.post("/enqueue")
def enqueue():
    if not _verify_enqueue():
        return jsonify({"error": "unauthorized"}), 401
    payload = request.get_json(silent=True) or {}
    if not payload.get("audioFileId"):
        return jsonify({"error": "audioFileId required"}), 400

    process_id = str(payload.get("audioFileId", ""))

    allow_inline = _env("ALLOW_INLINE_EXECUTE", "0") == "1"
    has_tasks = bool(
        _env("GCP_PROJECT")
        and _env("CLOUD_TASKS_LOCATION")
        and _env("CLOUD_TASKS_QUEUE")
        and _env("CLOUD_TASKS_INVOKER_SA_EMAIL")
    )

    try:
        if has_tasks:
            _create_cloud_task(payload, process_id)
            return "", 202
        if allow_inline:

            def _bg():
                try:
                    _run_transcribe_job(payload)
                except Exception:
                    logger.exception(
                        "inline transcribe job failed audioFileId=%s",
                        payload.get("audioFileId"),
                    )

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
    if not payload.get("audioFileId"):
        return jsonify({"error": "audioFileId required"}), 400
    try:
        _run_transcribe_job(payload)
        return jsonify({"ok": True}), 200
    except Exception as e:
        logger.exception("execute failed: %s", e)
        return jsonify({"error": "transcribe_failed", "detail": str(e)}), 500


if __name__ == "__main__":
    port = int(_env("PORT", "8080") or "8080")
    app.run(host="0.0.0.0", port=port, debug=_env("FLASK_DEBUG", "0") == "1")
