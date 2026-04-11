# audio-split ワーカー — ビルド・デプロイ手順

Cloud Run に載せる Docker イメージの**ビルド**、Artifact Registry への**プッシュ**、**デプロイ**までの手順です。初回と、コード更新後の**差し替えのみ**の両方を書きます。

## 前提

- [Docker Desktop](https://docs.docker.com/desktop/) などで `docker` が使えること
- [Google Cloud SDK](https://cloud.google.com/sdk) の `gcloud` が使えること
- 対象プロジェクトへの権限（Artifact Registry への push、Cloud Run への deploy）
- 作業ディレクトリ: リポジトリ内の **`workers/audio-split`**（ここに `Dockerfile` がある）

以下、例としてプロジェクト ID を **`gen-lang-client-0185919690`**、リージョンを **`asia-northeast1`** にしています。別プロジェクトのときは読み替えてください。

---

## 1. 変数の設定

ターミナルでビルド〜プッシュまで同じセッションで行う場合、先に変数を揃えます。

```bash
cd /path/to/growpoint/workers/audio-split

export PROJECT_ID=gen-lang-client-0185919690
export REGION=asia-northeast1
export REPO=audio-split-repo
export IMAGE=audio-split
export TAG="$(date +%Y%m%d)-1"
```

**注意（シェル）**: `export TAG=...` と **同一行に** `# コメント …` を付けると、環境によっては `#` がコメントとして扱われず、`export` が失敗することがあります。コメントは**別行**にするか、コメントなしの 1 行だけにしてください。

Git コミット短ハッシュをタグに含める例:

```bash
export TAG="$(date +%Y%m%d)-$(git -C /path/to/growpoint rev-parse --short HEAD)"
```

---

## 2. 初回のみ: API 有効化と Artifact Registry リポジトリ

### 2.1 Artifact Registry API

```bash
gcloud services enable artifactregistry.googleapis.com --project="${PROJECT_ID}"
```

### 2.2 Docker 用リポジトリの作成（未作成のときだけ）

リポジトリが無いまま `docker push` すると、認証トークン取得が **404 Not Found** になることがあります。

```bash
gcloud artifacts repositories create "${REPO}" \
  --repository-format=docker \
  --location="${REGION}" \
  --project="${PROJECT_ID}" \
  --description="audio-split worker"
```

確認:

```bash
gcloud artifacts repositories list --location="${REGION}" --project="${PROJECT_ID}"
```

### 2.3 （別途）Drive API

ワーカーが Google Drive を呼ぶプロジェクトでは、次も有効にします。

```bash
gcloud services enable drive.googleapis.com --project="${PROJECT_ID}"
```

### 2.4 Secret Manager（`split-auth-secret`）とランタイム SA

Cloud Run で `--set-secrets="SPLIT_AUTH_SECRET=split-auth-secret:latest"` を使う前に、次を実施します。

#### 2.4.1 Secret Manager API の有効化

```bash
gcloud services enable secretmanager.googleapis.com --project="${PROJECT_ID}"
```

API が無効だと、シークレット参照時に `secretmanager.googleapis.com` 関連のエラーになります。

#### 2.4.2 シークレット作成と `roles/secretmanager.secretAccessor`

1. シークレット **`split-auth-secret`** を作成します（値はランダム文字列。例は README の運用に合わせてください）。

   ```bash
   echo -n "$(openssl rand -base64 32)" | gcloud secrets create split-auth-secret \
     --data-file=- --project="${PROJECT_ID}"
   ```

2. **ランタイム用サービスアカウント**（`gcloud run deploy` の `--service-account` で指定する SA）に、少なくとも **`roles/secretmanager.secretAccessor`** を付与します。

   ```bash
   gcloud secrets add-iam-policy-binding split-auth-secret \
     --project="${PROJECT_ID}" \
     --member="serviceAccount:YOUR_DRIVE_WORKER_SA@...iam.gserviceaccount.com" \
     --role="roles/secretmanager.secretAccessor"
   ```

秘密の作成と上記 IAM 設定が済んでから `--set-secrets` でデプロイしてください（平文を `--set-env-vars` に埋め込まない）。

---

## 3. ビルドとプッシュ

```bash
docker build -t "${REGION}-docker.pkg.dev/${PROJECT_ID}/${REPO}/${IMAGE}:${TAG}" .

gcloud auth configure-docker "${REGION}-docker.pkg.dev" --quiet

docker push "${REGION}-docker.pkg.dev/${PROJECT_ID}/${REPO}/${IMAGE}:${TAG}"
```

プッシュ先イメージ例:

`asia-northeast1-docker.pkg.dev/gen-lang-client-0185919690/audio-split-repo/audio-split:20260410-1`

---

## 4. Cloud Run デプロイ

### 4.1 初回、または環境変数・SA をまとめて指定するとき

サービス名を **`audio-split`** とした例です。**`SPLIT_AUTH_SECRET` は `--set-env-vars` に平文で埋め込まず**、Secret Manager と `--set-secrets`（または `--env-vars-file`）を推奨します（シェル履歴・CI ログ漏えい防止）。**秘密作成と SA への権限付与は §2.4 参照。** ランタイム SA に **`roles/secretmanager.secretAccessor`** を付与したうえでデプロイしてください。

```bash
gcloud run deploy audio-split \
  --image="${REGION}-docker.pkg.dev/${PROJECT_ID}/${REPO}/${IMAGE}:${TAG}" \
  --region="${REGION}" \
  --project="${PROJECT_ID}" \
  --no-allow-unauthenticated \
  --set-secrets="SPLIT_AUTH_SECRET=split-auth-secret:latest" \
  --set-env-vars="GCP_PROJECT=${PROJECT_ID},CLOUD_TASKS_LOCATION=${REGION},CLOUD_TASKS_QUEUE=audio-split,CLOUD_TASKS_INVOKER_SA_EMAIL=YOUR_TASKS_INVOKER_SA@...iam.gserviceaccount.com,CLOUD_RUN_SERVICE_URL=https://YOUR-SERVICE-URL.run.app" \
  --service-account="YOUR_DRIVE_WORKER_SA@...iam.gserviceaccount.com" \
  --timeout=900 \
  --memory=2Gi
```

- **`CLOUD_RUN_SERVICE_URL`**: デプロイ**後**に表示されるサービス URL（`https://....run.app`、末尾スラッシュなし）と一致させる。先に仮 URLでデプロイし、出力された URL に合わせて **再デプロイで env だけ更新**してもよい。
- **ランタイム SA**（`--service-account`）: Drive 上の対象フォルダ／共有ドライブに、この SA がアクセスできるよう共有しておく。

### 4.2 コード更新後: イメージの差し替えだけ（よく使う）

既に Cloud Run の env・SA・認証設定が正しい場合、**イメージだけ**更新します。既存の環境変数はそのまま継承されます。

```bash
gcloud run deploy audio-split \
  --image="${REGION}-docker.pkg.dev/${PROJECT_ID}/${REPO}/${IMAGE}:${TAG}" \
  --region="${REGION}" \
  --project="${PROJECT_ID}"
```

---

## 5. デプロイ後の確認

1. **サービス URL**  
   `gcloud run services describe audio-split --region="${REGION}" --project="${PROJECT_ID}" --format='value(status.url)'`  
   またはデプロイ出力に表示された URL。

2. **ヘルス**  
   `curl -sS "https://（上記URL）/health"`

3. **GAS**  
   スクリプトプロパティのワーカー向けベース URLが、上記サービス URL と一致しているか。

4. **Cloud Run の `CLOUD_RUN_SERVICE_URL`**  
   Cloud Tasks からの OIDC 検証で使うため、**現在の** `https://....run.app`（末尾スラッシュなし）と一致しているか。

```bash
gcloud run services describe audio-split \
  --region="${REGION}" \
  --project="${PROJECT_ID}" \
  --format='yaml(spec.template.spec.containers[0].env)'
```

---

## 6. トラブルシューティング（要点）

| 現象 | 想定原因 |
|------|----------|
| `docker push` の token が **404** | `audio-split-repo` が **`${REGION}` に未作成**、または API 未使用。§2 を実施。 |
| **403**（push / gcloud） | プロジェクト違い、権限不足、`artifactregistry.googleapis.com` 未使用。 |
| `cd: ... workers/audio-split` | リポジトリの**実パス**で `cd`（例: `~/Downloads/temp/growpoint/workers/audio-split`）。 |
| Tasks 実行後に 401/403 | `CLOUD_RUN_SERVICE_URL` と実 URL の不一致、Invoker SA・OIDC 設定の不整合。詳細は README の環境変数表を参照。 |
| Cloud Run **起動時**に secret 関連エラー | シークレット名 **`split-auth-secret`** が未作成、またはランタイム SA に **`roles/secretmanager.secretAccessor`** が無い。§2.4 でシークレット作成と `gcloud secrets add-iam-policy-binding` を確認。 |
| **Secret Manager API** エラー（参照・取得で失敗） | プロジェクトで **`secretmanager.googleapis.com`** が無効。§2.4.1 のとおり API を有効化。 |

---

## 7. 関連ドキュメント

- 同ディレクトリの [README.md](./README.md)（概要・環境変数・API）
- 設計メモ（リポジトリ内）: `docs/superpowers/specs/2026-04-10-audio-split-cloud-run-design.md`
