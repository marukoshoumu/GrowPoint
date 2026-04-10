# 長尺音声分割ワーカー（Cloud Run + ffmpeg）

**ビルド・Artifact Registry・Cloud Run デプロイ**は [DEPLOY.md](./DEPLOY.md) を参照してください（変数の例・イメージ差し替えのみ・トラブルシュート含む）。

GAS が `POST /enqueue` を呼ぶと、**Cloud Tasks** 経由で `POST /execute` が実行されます。Drive 上の元ファイルをダウンロード → ffmpeg で時間分割 → `01_未処理` に `利用者名_YYYY-MM-DD_NN-MM.m4a` をアップロードし、**成功時は元ファイルをゴミ箱**（`trashed`）にします。失敗時は元ファイルを **`06_エラー` フォルダへ移動**します。Drive API 呼び出しは **共有ドライブ（Team Drive）でも動くよう `supportsAllDrives=True`** で実行しています。

## GCP 事前準備（必須）

- **Google Drive API** をプロジェクトで有効にする: `gcloud services enable drive.googleapis.com --project=YOUR_PROJECT`  
  無効のままだと Drive 呼び出しが `accessNotConfigured`（403）になります。
- **Artifact Registry API**（初回 `docker push` 用）: [DEPLOY.md §2](./DEPLOY.md) を参照。リポジトリ未作成のまま push すると認証トークン取得が **404** になることがあります。
- ランタイム用サービスアカウントに、対象の **Drive フォルダを共有**（編集権限）。
- **共有ドライブ（旧 Team Drive）推奨**: マイドライブ上のフォルダだけ共有していると、サービスアカウントが **新規ファイルをアップロード**するときに `Service Accounts do not have storage quota`（`storageQuotaExceeded`）になることがあります。**Google Workspace の共有ドライブ**に `01_未処理` などの運用フォルダ一式を置き、その共有ドライブにワーカー用 SA を **コンテンツ管理者** 相当で追加すると解消しやすいです。
- GAS の `FOLDER_ID_*` は、SA がアクセスできる **実在フォルダ ID** と一致させる。誤りや未共有だと失敗時の移動で `File not found`（404）になります。

## 環境変数

| 変数 | 必須 | 説明 |
|------|------|------|
| `SPLIT_AUTH_SECRET` | はい | GAS の `AUDIO_SPLIT_SECRET`（`Authorization: Bearer`）と一致させる共有秘密 |
| `CLOUD_RUN_SERVICE_URL` | はい※ | デプロイ後のサービス URL（`https://....run.app`、**末尾スラッシュなし**。OIDC の audience に使用） |
| `GCP_PROJECT` | Tasks 利用時 | GCP プロジェクト ID |
| `CLOUD_TASKS_LOCATION` | Tasks 利用時 | 例: `asia-northeast1` |
| `CLOUD_TASKS_QUEUE` | Tasks 利用時 | キュー名（例: `audio-split`） |
| `CLOUD_TASKS_INVOKER_SA_EMAIL` | Tasks 利用時 | Cloud Tasks が OIDC で付与するサービスアカウント（Cloud Run Invoker に付与） |
| `ALLOW_INLINE_EXECUTE` | 開発用 | `1` のときのみ、Tasks が未設定でも `/enqueue` 内スレッドが `/execute` 相当を実行（**本番非推奨**） |
| `FFMPEG_TIMEOUT_SEC` | いいえ | 各チャンクの ffmpeg タイムアウト（秒）。既定 **300**。不正値は 300 にフォールバック |
| `PORT` | いいえ | リッスンポート。Cloud Run では通常 **8080** |

※ OIDC 検証に必須。**実際に発行された Cloud Run の URL** と一字一句合わせる（GAS の `AUDIO_SPLIT_WORKER_URL` のホスト部分とも一致させる）。ローカルでは秘密のみで `/execute` に Bearer を付けて直接 POST して試せます。

### セキュリティのベストプラクティス

- **`SPLIT_AUTH_SECRET`**: 推奨は **暗号学的にランダムな 32 バイト以上**（Base64 や hex で 256 bit 相当）を `openssl rand -base64 32` などで生成する。平文の短い語句は避ける。運用では **3〜12 か月ごとのローテーション**を目安にし、新しい値を Cloud Run / Secret Manager に反映したうえで旧値を失効させる（GAS 側の `AUDIO_SPLIT_SECRET` も同時更新）。
- **秘密の保管**: `--set-env-vars` に平文で埋め込まず、**Secret Manager**（または `--set-secrets` / `--env-vars-file` で参照）に置き、シェル履歴・CI ログに残さない。例: `echo -n "$SPLIT_AUTH_SECRET" | gcloud secrets versions add split-auth-secret --data-file=-` のようにパイプで登録し、ランタイムでは `--set-secrets=SPLIT_AUTH_SECRET=split-auth-secret:latest` で注入。
- **`ALLOW_INLINE_EXECUTE`**: **開発専用**。本番で `1` にしたまま共有秘密を有効にすると、インライン実行経路のリスクが増えるため **必ず `0`（未設定）** にする。

## ジョブのペイロード（JSON）

`/enqueue` と `/execute` は同じ JSON ボディを想定します（GAS は `gas/audioSplit.gs` の `requestAudioSplitEnqueue_` から送信）。

| キー | 必須 | 説明 |
|------|------|------|
| `fileId` | はい | 分割対象ファイルの Drive ID |
| `unprocessedFolderId` | はい | チャンクを置く `01_未処理` フォルダ ID |
| `errorFolderId` | はい | 失敗時に元ファイルを移す `06_エラー` フォルダ ID |
| `userName` | いいえ | 出力ファイル名用（未指定時は `user`）。`/` や `:` などファイル名に使えない文字は `_` に置換 |
| `date` | いいえ | 出力ファイル名用（先頭 32 文字まで） |
| `chunkSeconds` | いいえ | 1 チャンクの秒数。**既定 1200**（20 分）。**30〜 14400**（4 時間）にクランプ。`bool` や 0 以下は既定値 |

GAS は `processingFolderId` も送りますが、ワーカー側の分割処理では未使用です。

## ローカル試験（Docker）

コンテナは **非 root ユーザー**（Dockerfile で uid 固定）で動きます。ADC をマウントするパスは読み取り可能にしてください。

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

## Cloud Tasks（キュー作成の例）

```bash
gcloud tasks queues create audio-split \
  --project=YOUR_PROJECT \
  --location=asia-northeast1
```

タスク実行用 SA に `roles/run.invoker` を Cloud Run サービスに付与します。キューが **`pause` のまま**だとタスクが実行されずワーカーが止まったように見えます。再開: `gcloud tasks queues resume audio-split --location=asia-northeast1 --project=YOUR_PROJECT`。未実行タスクだけ破棄する場合は **`gcloud tasks queues purge audio-split --location=… --project=…`**（`purge queue --queue=` 形式は誤り）。パージは Drive 上のファイルを削除しません。詳細は運用メモ（ナレッジ `sessions/2026-04-10-audio-split-shared-drive-deploy-ops.md`）や [DEPLOY.md](./DEPLOY.md) を参照。

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

Drive 用サービスアカウントには、運用フォルダ（未処理・エラー）が共有されている必要があります。コード更新後は **イメージだけ差し替え**する運用が可能です（[DEPLOY.md §4.2](./DEPLOY.md)）。

## API

| メソッド | パス | 認証 | 説明 |
|----------|------|------|------|
| `GET` | `/health` | なし | `{"ok": true}` |
| `POST` | `/enqueue` | Bearer（`SPLIT_AUTH_SECRET`） | Cloud Tasks にジョブを積む。成功 **202**。Tasks 利用時はレスポンスボディ空。インライン実行時は `{"queued":"inline","warning":"dev only"}`。**400**（`fileId` なし）、**401**、Tasks 未設定かつ `ALLOW_INLINE_EXECUTE` でもない場合 **503** |
| `POST` | `/execute` | Bearer（秘密または Cloud Tasks の OIDC） | 分割を同期的に実行。成功 **200** `{"ok": true}`。**400** / **401** / 失敗 **500**（`split_failed` と `detail`） |

無リクエスト時は Cloud Run が **スケールゼロ**になり、次の `/enqueue` で処理が再開します。

## GAS 側プロパティ（対応表）

| Script Property | ワーカー側の対応 |
|-----------------|------------------|
| `AUDIO_SPLIT_WORKER_URL` | サービス URL（`/enqueue` は `URL + '/enqueue'`） |
| `AUDIO_SPLIT_SECRET` | `SPLIT_AUTH_SECRET` |
| `AUDIO_SPLIT_CHUNK_SECONDS` | ペイロードの `chunkSeconds`（既定 1200） |

ファイル名が既に `_NN-MM` 形式のチャンクとみなされる場合、長尺自動分割の対象外です（`gas/audioSplit.gs` の `shouldRouteToAudioSplitWorker_`）。
