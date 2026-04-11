# transcribe ワーカー

音声ファイルを Gemini API で文字起こしし、結果テキストを Google Drive に保存する Cloud Run サービス。

## エンドポイント

| メソッド | パス | 認証 | 用途 |
|---------|------|------|------|
| GET | `/health` | なし | ヘルスチェック |
| POST | `/enqueue` | 共有秘密（Bearer） | GAS から呼ぶ。Cloud Tasks 経由で `/execute` を起動 |
| POST | `/execute` | OIDC or 共有秘密 | 文字起こし実処理 |

## 環境変数

| 変数 | 必須 | 説明 |
|------|------|------|
| `GEMINI_API_KEY` | Yes | Gemini API キー（Secret Manager 推奨） |
| `TRANSCRIBE_AUTH_SECRET` | Yes | GAS との共有秘密 |
| `GCP_PROJECT` | Yes* | Cloud Tasks 用 |
| `CLOUD_TASKS_LOCATION` | Yes* | リージョン |
| `CLOUD_TASKS_QUEUE` | Yes* | キュー名 |
| `CLOUD_TASKS_INVOKER_SA_EMAIL` | Yes* | OIDC 検証用 |
| `CLOUD_RUN_SERVICE_URL` | Yes* | OIDC audience |
| `GEMINI_MODEL` | No | デフォルト: `gemini-2.5-flash` |
| `ALLOW_INLINE_EXECUTE` | No | `1` で Cloud Tasks なしのインライン実行（開発用） |

*Cloud Tasks 経由で実行する場合に必須。

## payload

```json
{
  "audioFileId": "DriveファイルID",
  "userName": "利用者名",
  "date": "2026-04-11",
  "chunkIndex": null,
  "chunkTotal": null,
  "extractedFolderId": "03配下フォルダID",
  "prompt": "Stage1プロンプト全文",
  "errorFolderId": "06_エラーフォルダID"
}
```

## 関連ドキュメント

- 設計: `docs/handover/2026-04-11-transcribe-cloud-run-design.md`
- デプロイ: `DEPLOY.md`（同ディレクトリ）
