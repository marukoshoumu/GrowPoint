# 設計: Stage1 文字起こしの Cloud Run 非同期化

> **作成日**: 2026-04-11
> **背景**: GAS の6分実行上限により Stage1（Gemini 文字起こし）がタイムアウト → `STAGE1_RUNNING` ゾンビ化 → チャンクマージ詰まり。ファイルサイズに関わらず発生するため、全件を Cloud Run に移行する。
> **参照**: `docs/handover/2026-04-11_GAS-Stage1-時間制限とチャンク詰まり調査.md`

---

## 1. 全体アーキテクチャ

### 変更前（現行）

```
GAS トリガー → QUEUED → executeStage1_()
  → Gemini File API upload + generateContent（同期）
  → STAGE1_DONE / STAGE1_CHUNK_WAIT
```

GAS 内で Gemini API を同期呼び出しするため、6分上限に抵触する。

### 変更後

```
GAS トリガー
  → QUEUED
  → Cloud Run transcribe ワーカーに enqueue
  → STAGE1_PENDING

Cloud Run transcribe ワーカー:
  1. Drive から音声ダウンロード
  2. Gemini File API upload
  3. Gemini generateContent（タイムアウト15分）
  4. 結果 .txt を Drive の 03_文字起こし・抽出/{利用者}/{面談日}/ に保存

GAS 次トリガー
  → STAGE1_PENDING 行をポーリング
  → Drive に .txt があるか確認
  → あれば STAGE1_DONE（or STAGE1_CHUNK_WAIT）に進める
```

### 新ステータス

- `STAGE1_PENDING`: Cloud Run に投入済み、結果待ち
- `STAGE1_RUNNING`: **廃止**（GAS 内で Stage1 を実行しなくなるため）

### チャンク対応

チャンク処理の構造は変更なし。Cloud Run が個別チャンクの `.txt` を保存し、GAS 側の既存マージロジック（`tryMergeChunkGroupAfterStage1_`）がそのまま動作する。ファイル命名規約を守ることが前提。

---

## 2. Cloud Run transcribe ワーカー

### サービス概要

- **配置**: `workers/transcribe/`（新規作成）
- **言語/FW**: Python 3.12 + Flask（音声分割ワーカーと同じスタック）
- **デプロイ先**: 既存と同じ GCP プロジェクト・リージョン（`asia-northeast1`）

### エンドポイント

| メソッド | パス | 認証 | 用途 |
|---------|------|------|------|
| POST | `/enqueue` | 共有秘密 | GAS から呼ぶ。Cloud Tasks 経由で `/execute` を起動 |
| POST | `/execute` | Cloud Tasks OIDC or 共有秘密 | 実処理 |
| GET | `/health` | なし | ヘルスチェック |

### `/execute` 処理フロー

1. Drive から音声ファイルをダウンロード（一時ディレクトリ）
2. Gemini File API にアップロード（`fileUri` を取得）
3. Gemini `generateContent` を呼び出し（payload のプロンプトを使用）
4. 結果テキストを Drive の所定フォルダに `.txt` として保存
5. 一時ファイルを削除

### payload（GAS → Cloud Run）

```json
{
  "audioFileId": "DriveファイルID",
  "userName": "利用者名",
  "date": "2026-04-11",
  "chunkIndex": null,
  "chunkTotal": null,
  "extractedFolderId": "03配下の利用者フォルダID",
  "prompt": "Stage1プロンプト全文",
  "errorFolderId": "06_エラーフォルダID"
}
```

- `chunkIndex` / `chunkTotal`: チャンクの場合は整数、単一ファイルは `null`
- `prompt`: GAS 側で `getStage1Prompt(glossary)` を組み立てて含める（Cloud Run はプロンプトロジックを持たない）

### 出力ファイル命名

GAS 側の既存関数と同じ規約を Cloud Run 側でも守る:

- 単一: `{date}_{userName}_文字起こし.txt`
- チャンク: `{date}_{userName}_文字起こし_{NN}.txt`（NN はゼロ埋め、桁数は `chunkTotal` に合わせる）

### Gemini API 呼び出し

- REST で直接呼び出し（`google-generativeai` SDK は不使用、音声分割ワーカーと依存を揃える）
- `maxOutputTokens`: GAS の `CONFIG.STAGE1_MAX_OUTPUT_TOKENS`（65536）と同値を payload または環境変数で指定
- `temperature`: 0.1（GAS 側と同値）
- モデル: `gemini-2.5-flash`（GAS の `CONFIG.STAGE1_MODEL` と同値）
- リクエストタイムアウト: 900秒（15分）
- リトライ: Gemini 429/500/503 は最大2回（GAS の `callGeminiWithRetry` と同等ロジック）

### 依存ライブラリ

```
flask
gunicorn
google-api-python-client
google-auth
google-cloud-tasks
requests
```

### Dockerfile

```dockerfile
FROM python:3.12-slim-bookworm
RUN groupadd --system --gid 10001 app \
    && useradd --system --uid 10001 --gid app --home /app --shell /usr/sbin/nologin app
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY app ./app
RUN chown -R app:app /app
ENV PYTHONUNBUFFERED=1 PORT=8080
USER app
CMD exec gunicorn --bind 0.0.0.0:${PORT} --workers 1 --threads 2 --timeout 900 "app.main:app"
```

ffmpeg 不要のため、音声分割ワーカーより軽量。

---

## 3. GAS 側の改修

### 3-A. `executeStage1_()` の書き換え

現行の Gemini 直接呼び出しを削除し、Cloud Run に enqueue するだけに変更。

- `runStage1()` の呼び出しを `requestTranscribeEnqueue_()` に置き換え
- プロンプト組み立て（`getStage1Prompt(glossary)`）と保存先フォルダID取得はここで行い、payload に含める
- ステータスは `STAGE1_PENDING` に設定
- enqueue 失敗時は `ERROR` に落とす

### 3-B. `dispatchNextStage_()` にポーリングステップ追加

`QUEUED → Stage1` ループの前に、`STAGE1_PENDING` 行のポーリングを挿入:

```javascript
// STAGE1_PENDING → 結果ファイル確認 → STAGE1_DONE or STAGE1_CHUNK_WAIT
const pendingJobs = findRowsByStatus(CONFIG.STATUS.STAGE1_PENDING);
for (let i = 0; i < pendingJobs.length; i++) {
  if (elapsed() > CONFIG.STAGE_TIME_LIMIT_MS) return;
  checkTranscribeResult_(pendingJobs[i]);
}
```

`checkTranscribeResult_()`:

1. `extractedFolderId` 配下で該当ファイル名を検索
2. 見つかった → ステータス更新（`STAGE1_DONE` or `STAGE1_CHUNK_WAIT`）+ チャンクマージ判定
3. 見つからない → 何もしない（次トリガーで再確認、5分間隔）

### 3-C. config.gs / ステータス変更

- `CONFIG.STATUS.STAGE1_PENDING` を追加
- `CONFIG.STATUS.STAGE1_RUNNING` を廃止
- Cloud Run 接続設定を Script Properties に追加:
  - `TRANSCRIBE_WORKER_URL`
  - `TRANSCRIBE_AUTH_SECRET`

### 3-D. `recoverTimedOutJobs_()` の変更

```javascript
// 変更前
{ status: STAGE1_RUNNING, recoverTo: QUEUED }    // 30分

// 変更後
{ status: STAGE1_PENDING, recoverTo: QUEUED }     // 60分
```

60分に延長する理由: Cloud Tasks のリトライ（最大3回、バックオフ30秒）分の余裕を確保。

### 3-E. GAS 側で不要になるコード

- `runStage1()` 内の Gemini 呼び出し部分（関数削除。`transcribe.gs` の保存系関数 `saveTranscript`, `saveTranscriptChunk` 等は Cloud Run 側で同等処理するが、ポーリング時のファイル名生成で `getChunkTranscriptBasePrefix_` 等を引き続き使用するため残す）
- `uploadToGeminiFileApi()`: Stage2 では不使用（テキスト入力のみ）だが、一旦残す

---

## 4. デプロイ構成

### Cloud Run サービス設定

| 項目 | 値 | 理由 |
|------|-----|------|
| サービス名 | `transcribe` | 分割ワーカー `audio-split` と並列 |
| リージョン | `asia-northeast1` | 既存と同じ |
| タイムアウト | 900秒 | Gemini 応答待ちの余裕 |
| メモリ | 1Gi | 音声ダウンロードの一時保持。ffmpeg 不要のため分割ワーカー(2Gi)より小さい |
| CPU | 1 | API 呼び出し主体で CPU 負荷低い |
| 認証 | `--no-allow-unauthenticated` | Cloud Tasks OIDC + 共有秘密 |
| 同時実行 | 1 | 1リクエスト=1文字起こしで長時間占有 |

### 環境変数 / Secret

| 変数 | 種別 | 用途 |
|------|------|------|
| `GEMINI_API_KEY` | Secret Manager | Gemini API 認証 |
| `TRANSCRIBE_AUTH_SECRET` | Secret Manager | GAS との共有秘密 |
| `GCP_PROJECT` | 環境変数 | Cloud Tasks 用 |
| `CLOUD_TASKS_LOCATION` | 環境変数 | `asia-northeast1` |
| `CLOUD_TASKS_QUEUE` | 環境変数 | `transcribe` |
| `CLOUD_TASKS_INVOKER_SA_EMAIL` | 環境変数 | OIDC 検証用 |
| `CLOUD_RUN_SERVICE_URL` | 環境変数 | OIDC audience |

### Cloud Tasks キュー

`transcribe` を新規作成（音声分割の `audio-split` キューとは分離）。

- 最大リトライ: 3回
- バックオフ: 30秒
- タスクタイムアウト: 900秒

### サービスアカウント

分割ワーカーと同じ SA を共用可（Drive アクセス権限が同一）。

---

## 5. エラーハンドリング・リカバリ

| シナリオ | 検知 | リカバリ |
|---------|------|---------|
| Cloud Run enqueue 失敗 | GAS で HTTP エラー検知 | 即座に `ERROR` に落とす |
| Gemini API 失敗 | `/execute` が 500 | Cloud Tasks 自動リトライ（最大3回） |
| Cloud Tasks リトライ上限超過 | `STAGE1_PENDING` が60分滞留 | `recoverTimedOutJobs_` で `QUEUED` に戻す → 再enqueue |
| Cloud Run ダウン | 同上 | 同上 |
| Drive 保存失敗 | `/execute` が 500 | Cloud Tasks リトライ → 上限超過なら上記 |
| Gemini `MAX_TOKENS` | ワーカー側でログ警告 | テキストは保存する（品質問題は別途チャンク短縮で対処） |

### 重複実行の防止

- `STAGE1_PENDING` 行は `dispatchNextStage_` の `QUEUED` ループでスキップされる
- Cloud Tasks の重複配信で `/execute` が2回走った場合: 同名ファイルの上書きで実害なし

---

## 6. デプロイ手順

### 6.0 前提

- Docker Desktop 等で `docker` が使えること
- Google Cloud SDK の `gcloud` が使えること
- 対象プロジェクトへの権限（Artifact Registry push、Cloud Run deploy、Secret Manager admin）
- 作業ディレクトリ: `workers/transcribe`

### 6.1 変数設定

```bash
cd /path/to/growpoint/workers/transcribe

export PROJECT_ID=gen-lang-client-0185919690
export REGION=asia-northeast1
export REPO=transcribe-repo
export IMAGE=transcribe
export TAG="$(date +%Y%m%d)-1"
```

### 6.2 初回のみ: インフラ準備

#### Artifact Registry リポジトリ

```bash
gcloud artifacts repositories create "${REPO}" \
  --repository-format=docker \
  --location="${REGION}" \
  --project="${PROJECT_ID}" \
  --description="transcribe worker"
```

#### Cloud Tasks キュー

```bash
gcloud tasks queues create transcribe \
  --location="${REGION}" \
  --project="${PROJECT_ID}" \
  --max-attempts=3 \
  --min-backoff=30s
```

#### Secret Manager

```bash
echo -n "YOUR_GEMINI_API_KEY" | \
  gcloud secrets create gemini-api-key \
    --data-file=- \
    --project="${PROJECT_ID}"

echo -n "$(openssl rand -base64 32)" | \
  gcloud secrets create transcribe-auth-secret \
    --data-file=- \
    --project="${PROJECT_ID}"
```

既に `gemini-api-key` が存在する場合（分割ワーカー等で作成済み）はスキップ。

#### SA に Secret Manager アクセス権限付与

```bash
export SA_EMAIL="YOUR_DRIVE_WORKER_SA@...iam.gserviceaccount.com"

gcloud secrets add-iam-policy-binding gemini-api-key \
  --member="serviceAccount:${SA_EMAIL}" \
  --role="roles/secretmanager.secretAccessor" \
  --project="${PROJECT_ID}"

gcloud secrets add-iam-policy-binding transcribe-auth-secret \
  --member="serviceAccount:${SA_EMAIL}" \
  --role="roles/secretmanager.secretAccessor" \
  --project="${PROJECT_ID}"
```

#### Drive API 有効化（未実施の場合）

```bash
gcloud services enable drive.googleapis.com --project="${PROJECT_ID}"
```

### 6.3 ビルド・プッシュ

```bash
docker build -t "${REGION}-docker.pkg.dev/${PROJECT_ID}/${REPO}/${IMAGE}:${TAG}" .

gcloud auth configure-docker "${REGION}-docker.pkg.dev" --quiet

docker push "${REGION}-docker.pkg.dev/${PROJECT_ID}/${REPO}/${IMAGE}:${TAG}"
```

### 6.4 Cloud Run デプロイ（初回）

```bash
gcloud run deploy transcribe \
  --image="${REGION}-docker.pkg.dev/${PROJECT_ID}/${REPO}/${IMAGE}:${TAG}" \
  --region="${REGION}" \
  --project="${PROJECT_ID}" \
  --no-allow-unauthenticated \
  --set-secrets="GEMINI_API_KEY=gemini-api-key:latest,TRANSCRIBE_AUTH_SECRET=transcribe-auth-secret:latest" \
  --set-env-vars="GCP_PROJECT=${PROJECT_ID},CLOUD_TASKS_LOCATION=${REGION},CLOUD_TASKS_QUEUE=transcribe,CLOUD_TASKS_INVOKER_SA_EMAIL=<INVOKER_SA>@...iam.gserviceaccount.com,CLOUD_RUN_SERVICE_URL=https://<初回デプロイ後に確定>" \
  --service-account="${SA_EMAIL}" \
  --timeout=900 \
  --memory=1Gi \
  --concurrency=1
```

`CLOUD_RUN_SERVICE_URL` は初回デプロイ後に出力される URL で再デプロイして更新する。

### 6.5 コード更新時（イメージ差し替えのみ）

```bash
gcloud run deploy transcribe \
  --image="${REGION}-docker.pkg.dev/${PROJECT_ID}/${REPO}/${IMAGE}:${TAG}" \
  --region="${REGION}" \
  --project="${PROJECT_ID}"
```

### 6.6 デプロイ後の確認

1. サービス URL 取得:
   ```bash
   gcloud run services describe transcribe \
     --region="${REGION}" --project="${PROJECT_ID}" \
     --format='value(status.url)'
   ```

2. ヘルスチェック:
   ```bash
   curl -sS "https://<SERVICE_URL>/health"
   ```

3. GAS Script Properties 設定:
   - `TRANSCRIBE_WORKER_URL` = サービス URL
   - `TRANSCRIBE_AUTH_SECRET` = Secret Manager に登録した値と同じ

4. 環境変数確認:
   ```bash
   gcloud run services describe transcribe \
     --region="${REGION}" --project="${PROJECT_ID}" \
     --format='yaml(spec.template.spec.containers[0].env)'
   ```

### 6.7 GAS 側の切り替え

1. `gas/*.gs` のコードを更新（clasp push）
2. 処理状況シートで `STAGE1_PENDING` ステータスが正しく遷移することを確認
3. 既存の `STAGE1_RUNNING` 行があれば `QUEUED` に手動変更

### 6.8 トラブルシューティング

| 現象 | 想定原因 |
|------|----------|
| `docker push` の token が 404 | `transcribe-repo` が未作成。6.2 を実施 |
| 403（push / gcloud） | プロジェクト違い、権限不足 |
| `/enqueue` が 401 | `TRANSCRIBE_AUTH_SECRET` の不一致（GAS Script Properties と Secret Manager） |
| `/execute` が 401 | `CLOUD_RUN_SERVICE_URL` と実 URL の不一致、Invoker SA の OIDC 設定不備 |
| `STAGE1_PENDING` が60分以上滞留 | Cloud Run ログを確認。Gemini API キー無効、Drive 権限不足等 |
| 文字起こし結果が Drive に出ない | ワーカーの SA が対象フォルダにアクセスできるか確認 |
