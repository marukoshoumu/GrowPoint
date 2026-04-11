# transcribe ワーカー — ビルド・デプロイ手順

Cloud Run に載せる Docker イメージの**ビルド**、Artifact Registry への**プッシュ**、**デプロイ**までの手順です。

## 前提

- Docker Desktop 等で `docker` が使えること
- Google Cloud SDK の `gcloud` が使えること
- 対象プロジェクトへの権限（Artifact Registry push、Cloud Run deploy、Secret Manager admin）
- 作業ディレクトリ: `workers/transcribe`

## 1. 変数設定

```bash
cd /path/to/growpoint/workers/transcribe

export PROJECT_ID=gen-lang-client-0185919690
export REGION=asia-northeast1
export REPO=transcribe-repo
export IMAGE=transcribe
export TAG="$(date +%Y%m%d)-1"
```

## 2. 初回のみ: インフラ準備

### Artifact Registry リポジトリ

```bash
gcloud artifacts repositories create "${REPO}" \
  --repository-format=docker \
  --location="${REGION}" \
  --project="${PROJECT_ID}" \
  --description="transcribe worker"
```

### Cloud Tasks キュー

```bash
gcloud tasks queues create transcribe \
  --location="${REGION}" \
  --project="${PROJECT_ID}" \
  --max-attempts=3 \
  --min-backoff=30s
```

### Secret Manager

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

### SA に Secret Manager アクセス権限付与

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

### Drive API 有効化（未実施の場合）

```bash
gcloud services enable drive.googleapis.com --project="${PROJECT_ID}"
```

## 3. ビルド・プッシュ

```bash
docker build -t "${REGION}-docker.pkg.dev/${PROJECT_ID}/${REPO}/${IMAGE}:${TAG}" .

gcloud auth configure-docker "${REGION}-docker.pkg.dev" --quiet

docker push "${REGION}-docker.pkg.dev/${PROJECT_ID}/${REPO}/${IMAGE}:${TAG}"
```

## 4. Cloud Run デプロイ（初回）

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
  --concurrency=1 \
  --max-instances=5
```

`CLOUD_RUN_SERVICE_URL` は初回デプロイ後に出力される URL で再デプロイして更新する。

## 5. コード更新時（イメージ差し替えのみ）

```bash
gcloud run deploy transcribe \
  --image="${REGION}-docker.pkg.dev/${PROJECT_ID}/${REPO}/${IMAGE}:${TAG}" \
  --region="${REGION}" \
  --project="${PROJECT_ID}"
```

## 6. デプロイ後の確認

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

## 7. GAS 側の切り替え

1. `gas/*.gs` のコードを更新（clasp push）
2. 処理状況シートで `STAGE1_PENDING` ステータスが正しく遷移することを確認
3. 既存の `STAGE1_RUNNING` 行があれば `QUEUED` に手動変更
