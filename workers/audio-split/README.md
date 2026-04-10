# 長尺音声分割ワーカー（Cloud Run + ffmpeg）

**ビルド・Artifact Registry・Cloud Run デプロイの手順**は [DEPLOY.md](./DEPLOY.md) を参照してください。

GAS が `POST /enqueue` を呼び出すと、**Cloud Tasks** 経由で `POST /execute` が実行され、Drive 上のファイルをダウンロード → 時間分割 → `01_未処理` に `利用者名_YYYY-MM-DD_NN-MM.m4a` をアップロードし、元ファイルはゴミ箱へ移動します。失敗時は元ファイルを `06_エラー` へ移動します。

## GCP 事前準備（必須）

- **Google Drive API** をプロジェクトで有効にする: `gcloud services enable drive.googleapis.com --project=YOUR_PROJECT`  
  無効のままだと Drive 呼び出しが `accessNotConfigured`（403）になる。
- ランタイム用サービスアカウントに、対象の **Drive フォルダを共有**（編集権限）。
- **共有ドライブ（旧 Team Drive）推奨**: マイドライブ上のフォルダだけ共有していると、サービスアカウントが **新規ファイルをアップロード**するときに `Service Accounts do not have storage quota`（`storageQuotaExceeded`）になることがあります。**Google Workspace の共有ドライブ**に `01_未処理` などの運用フォルダ一式を置き、その共有ドライブにワーカー用 SA を **コンテンツ管理者** 相当で追加すると解消しやすいです。
- GAS の `FOLDER_ID_*` は、SA がアクセスできる **実在フォルダ ID** と一致させる。誤りや未共有だと失敗時の移動で `File not found`（404）になる。

## 環境変数

| 変数 | 必須 | 説明 |
|------|------|------|
| `SPLIT_AUTH_SECRET` | はい | GAS の `Authorization: Bearer` と一致させる共有秘密 |
| `CLOUD_RUN_SERVICE_URL` | はい※ | デプロイ後のサービス URL（`https://....run.app`、OIDC audience に使用） |
| `GCP_PROJECT` | Tasks 利用時 | GCP プロジェクト ID |
| `CLOUD_TASKS_LOCATION` | Tasks 利用時 | 例: `asia-northeast1` |
| `CLOUD_TASKS_QUEUE` | Tasks 利用時 | キュー名 |
| `CLOUD_TASKS_INVOKER_SA_EMAIL` | Tasks 利用時 | Cloud Tasks が OIDC で付与するサービスアカウント（Cloud Run Invoker に付与） |
| `ALLOW_INLINE_EXECUTE` | 開発用 | `1` のときのみ、Tasks なしで `/enqueue` 内スレッドが `/execute` 相当を実行（本番非推奨） |

※ OIDC 検証に必須。ローカルで秘密のみ試す場合は `/execute` に Bearer を付けて直接 POST 可能。

### セキュリティのベストプラクティス

- **`SPLIT_AUTH_SECRET`**: 推奨は **暗号学的にランダムな 32 バイト以上**（Base64 や hex で 256 bit 相当）を `openssl rand -base64 32` などで生成する。平文の短い語句は避ける。運用では **3〜12 か月ごとのローテーション**を目安にし、新しい値を Cloud Run / Secret Manager に反映したうえで旧値を失効させる（GAS 側の `AUDIO_SPLIT_SECRET` も同時更新）。
- **秘密の保管**: `--set-env-vars` に平文で埋め込まず、**Secret Manager**（または `--set-secrets` / `--env-vars-file` で参照）に置き、シェル履歴・CI ログに残さない。例: `echo -n "$SPLIT_AUTH_SECRET" | gcloud secrets versions add split-auth-secret --data-file=-` のようにパイプで登録し、ランタイムでは `--set-secrets=SPLIT_AUTH_SECRET=split-auth-secret:latest` で注入。
- **`ALLOW_INLINE_EXECUTE`**: **開発専用**。本番で `1` にしたまま共有秘密を有効にすると、インライン実行経路のリスクが増えるため **必ず `0`（未設定）** にする。

## ローカル試験（Docker）

```bash
cd workers/audio-split
docker build -t audio-split:local .
docker run --rm -p 8080:8080 \
  -e SPLIT_AUTH_SECRET=devsecret \
  -e CLOUD_RUN_SERVICE_URL=http://localhost:8080 \
  -e ALLOW_INLINE_EXECUTE=1 \
  -e GOOGLE_APPLICATION_CREDENTIALS=/key.json \
  -v $HOME/.config/gcloud/application_default_credentials.json:/key.json:ro \
  audio-split:local
```

`GOOGLE_APPLICATION_CREDENTIALS` には、対象 Drive フォルダに共有したサービスアカウント鍵、または ADC をマウントしてください。

## Cloud Tasks キュー作成（例）

```bash
gcloud tasks queues create audio-split \
  --project=YOUR_PROJECT \
  --location=asia-northeast1
```

タスク実行用 SA に `roles/run.invoker` を Cloud Run サービスに付与します。

## Cloud Run デプロイ（概略）

```bash
# Artifact Registry にプッシュ後
gcloud run deploy audio-split \
  --image=REGION-docker.pkg.dev/PROJECT/REPO/audio-split:TAG \
  --region=asia-northeast1 \
  --no-allow-unauthenticated \
  --set-secrets=SPLIT_AUTH_SECRET=split-auth-secret:latest \
  --set-env-vars=GCP_PROJECT=...,CLOUD_TASKS_LOCATION=asia-northeast1,CLOUD_TASKS_QUEUE=audio-split,CLOUD_TASKS_INVOKER_SA_EMAIL=tasks-invoker@....iam.gserviceaccount.com,CLOUD_RUN_SERVICE_URL=https://audio-split-xxxxx.run.app \
  --service-account=DRIVE_WORKER_SA@....iam.gserviceaccount.com \
  --timeout=900 \
  --memory=2Gi
```

Drive 用サービスアカウントには、運用フォルダ（未処理・処理中・エラー）が共有されている必要があります。

## API

- `GET /health` … 認証なし
- `POST /enqueue` … `Authorization: Bearer <SPLIT_AUTH_SECRET>`、JSON ボディは GAS の `requestAudioSplitEnqueue_` と同一キー
- `POST /execute` … Cloud Tasks（OIDC）または同一 Bearer 秘密
