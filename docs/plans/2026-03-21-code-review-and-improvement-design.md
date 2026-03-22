# グローポイント支援記録自動化システム — コードレビュー・改善設計書

**作成日:** 2026-03-21
**対象:** GAS実装（全11ファイル、約1,940行）+ プロンプト設計 v2.0
**方針:** クリティカル優先・段階修正（アプローチA）
**ランタイム前提:** V8（const/let、アロー関数、テンプレートリテラル使用可）

---

## 1. レビュー指摘一覧

### REVIEW_PROMPT.md 記載の懸念（4-A〜4-H）

| ID | 懸念 | 深刻度 | 評価 | 改善方針 |
|----|------|--------|------|----------|
| 4-A | GAS 6分制限 | **Critical** | 30分超音声で Stage1+2+3A+3B 直列は確実に超過 | ステージ分割実行（経過時間チェック方式） |
| 4-B | base64 インメモリ処理 | **Critical** | 30-60MB音声のbase64化はGASメモリ上限に迫る | Gemini File API（URI参照）に切替 |
| 4-F | Stage 3-A/B 独立性 | **High** | main.gs で3-A失敗時に3-Bが実行されない。設計と実装の乖離 | try/catchで独立実行に修正 |
| 4-E | 冪等性 | **High** | 処理中タイムアウト時のリカバリなし。手動リトライのガードなし | processId重複チェック＋タイムアウトリカバリ |
| 4-H | コード品質 | **Medium** | var多用、エラーハンドリング不統一 | V8前提でconst/let化、エラーパターン統一 |
| 4-C | prompts.gs 保守性 | **Medium** | 516行の文字列連結。プロンプト調整が困難 | Google Drive上のmdファイルから読み込みに変更 |
| 4-D | ダッシュボード行番号 | **Low** | 5分トリガー間隔では実質問題なし | 現状維持 |
| 4-G | セキュリティ | **Low** (Phase P) | Phase Pはフィクション音声のため許容 | コメント注記のみ。Phase 1で対処 |

### 追加発見した問題

| ID | 問題 | 深刻度 | 内容 |
|----|------|--------|------|
| NEW-1 | Gemini APIレスポンス検証不足 | **High** | `candidates[0].content.parts[0]` のnullチェックなし |
| NEW-2 | ユーザーマスター列番号ハードコード | **Medium** | dashboard.gs の loadUserMaster がマジックナンバーで列参照 |
| NEW-3 | ダッシュボード線形検索 | **Low** | findDashboardRowByProcessId が全行スキャン。現時点では許容 |
| NEW-4 | テンプレート置換方式が不十分 | **Critical** | replaceText()は表セル・書式・複数行に非対応 |
| NEW-5 | テンプレート構造設計が未着手 | **High** | 盛岡市様式のプレースホルダ配置設計が必要 |
| NEW-6 | テンプレートエンジンの拡張性 | **High** | 計画書等の他フォーマット追加時に個別実装が必要になる現設計 |

---

## 2. 改善設計

### 2-1. GAS 6分制限対策（ステージ分割実行）— Critical

**方針:** 経過時間チェック＋即時続行方式。各ステージ完了後に経過時間を確認し、余裕があれば同一実行内で次ステージに進む。時間不足時のみ次トリガーに委ねる。

**ステートマシン:**

```
QUEUED → STAGE1_RUNNING → STAGE1_DONE
       → STAGE2_RUNNING → STAGE2_DONE
       → STAGE3_RUNNING → STAGE3_DONE（完了）

どのステージでも失敗 → ERROR（リトライ可能）
Stage 3-A/B 片方失敗 → STAGE3_PARTIAL
```

**実行フロー:**

```
processNewFiles()（5分トリガー）:
  startTime = now()

  1. 新規音声検出 → status=QUEUED → ダッシュボード行作成
  2. QUEUED or STAGE*_DONE の行を検索
  3. 該当ステージ実行
     → 完了後 elapsed < 閾値 なら次ステージ続行
     → 超過なら status 更新して終了、次トリガーで再開
```

**パフォーマンス:**

- 短い音声（10分以内）: 全ステージ1回で完了（〜3分）
- 長い音声（30分超）: Stage1で4分消費 → 次トリガーでStage2+3（計〜10分）

**変更対象:** `main.gs`, `dashboard.gs`, `config.gs`

---

### 2-2. base64 インメモリ処理改善 — Critical

**方針:** Gemini File API を使い、音声ファイルをアップロードしてURIで参照。

```
現状: audioBlob.getBytes() → base64Encode → APIリクエストbodyに埋め込み
改善: DriveファイルをGemini File APIにアップロード → URI参照で送信
```

**実装:**

```javascript
function uploadToGeminiFileApi(driveFileId) {
  const file = DriveApp.getFileById(driveFileId);
  const blob = file.getBlob();
  const response = UrlFetchApp.fetch(
    `https://generativelanguage.googleapis.com/upload/v1beta/files?key=${getApiKey()}`,
    {
      method: 'post',
      contentType: blob.getContentType(),
      payload: blob.getBytes(),
      headers: { 'X-Goog-Upload-Display-Name': file.getName() }
    }
  );
  return JSON.parse(response.getContentText()).file.uri;
}
```

**補足:** Gemini側の一時コピーは48時間で自動削除されるが、原本はGoogle Driveに残るため運用上の影響なし。リトライ時はDriveから再アップロード。

**変更対象:** `utils.gs`, `transcribe.gs`

---

### 2-3. テンプレートエンジン再設計 — Critical

**方針:** テンプレート操作を3層に分離し、様式追加時は設定だけで対応できる汎用エンジンにする。

**3層構造:**

```
Layer 1: テンプレート定義（Google Docs テンプレート）
  └─ プレースホルダ配置: {{xxx}}（本文内 + 表セル内）

Layer 2: マッピング定義（Google Sheets「テンプレート設定」シート）
  └─ テンプレートID、プレースホルダ名→JSONパス の対応表

Layer 3: テンプレートエンジン（templateManager.gs）
  └─ 本文置換 + 表セル置換 + 空欄処理 を統一的に実行
```

**表セル置換の実装:**

```javascript
function fillTemplate(templateId, replacements, outputFolderId, fileName) {
  const copy = DriveApp.getFileById(templateId).makeCopy(fileName, outputFolder);
  const doc = DocumentApp.openById(copy.getId());
  const body = doc.getBody();

  // 1. 本文テキスト置換
  for (const [key, value] of Object.entries(replacements)) {
    body.replaceText(`\\{\\{${escapeRegex_(key)}\\}\\}`, value || '');
  }

  // 2. 表セル内の置換（全テーブルを走査）
  const tables = body.getTables();
  for (const table of tables) {
    for (let r = 0; r < table.getNumRows(); r++) {
      const row = table.getRow(r);
      for (let c = 0; c < row.getNumCells(); c++) {
        const cell = row.getCell(c);
        for (const [key, value] of Object.entries(replacements)) {
          cell.replaceText(
            `\\{\\{${escapeRegex_(key)}\\}\\}`,
            value || '面談中の言及なし'
          );
        }
      }
    }
  }

  doc.saveAndClose();
  return copy;
}
```

**空欄処理ルール:**

| ケース | 処理 |
|--------|------|
| 値がある | そのまま置換 |
| 値が空（面談で言及なし） | `面談中の言及なし` を挿入 |
| プレースホルダがテンプレートに存在しない | スキップ（警告ログ出力） |
| テンプレートに未置換のプレースホルダが残った | 処理後チェックで警告ログ |

**様式拡張時の追加作業:**

```
新様式追加（例: 個別支援計画書）の場合:
  1. Google Docs でテンプレート作成（{{xxx}} 配置）
  2. Sheets の「テンプレート設定」シートにマッピング行追加
  3. Stage 3-C の生成プロンプト追加（mdファイル）
  → templateManager.gs の修正は不要
```

**変更対象:** `templateManager.gs`

---

### 2-4. Stage 3-A/B 独立実行 — High

**改善:**

```javascript
let result3A, result3B;

try {
  result3A = runStage3A(extractionData, userMaster);
} catch (e) {
  result3A = { success: false, error: e.message };
  logError('Stage3A', e.message);
}

try {
  result3B = runStage3B(extractionData, userMaster);
} catch (e) {
  result3B = { success: false, error: e.message };
  logError('Stage3B', e.message);
}
```

**ダッシュボードステータス:**

| 3-A | 3-B | status |
|-----|-----|--------|
| 成功 | 成功 | STAGE3_DONE |
| 成功 | 失敗 | STAGE3_PARTIAL |
| 失敗 | 成功 | STAGE3_PARTIAL |
| 失敗 | 失敗 | ERROR |

**変更対象:** `main.gs`

---

### 2-5. 冪等性（重複処理防止）— High

**3重ガード:**

1. **ファイル移動ガード（既存）**: 音声ファイルを 01_未処理 → 02_処理中 に移動。次トリガーでは検出されない
2. **processId 重複チェック（新規）**: processId = ファイルID。addDashboardRow() 時に既存チェック
3. **タイムアウトリカバリ（新規）**: STAGE*_RUNNING 状態で30分以上経過 → 自動で ERROR に変更。手動リトライ可能

**変更対象:** `main.gs`, `dashboard.gs`

---

### 2-6. 盛岡市様式テンプレート構造設計 — High

**モニタリング記録票 (B):**

```
ヘッダー部（本文）:
  {{user_name}}, {{staff_name}}, {{service_manager}}
  {{date}}, {{previous_monitoring_date}}, {{next_monitoring_month}}, {{attendees}}

目標部（表）:
  {{long_term_goal}}
  {{short_term_goal_1}}, {{support_content_1}}, {{goal_1_period}}
  {{short_term_goal_2}}, {{support_content_2}}, {{goal_2_period}}

本文7セクション:
  {{section_1_intention}}, {{section_2_goal}}, {{section_3_plan}}
  {{section_4_status}}, {{section_5_impression}}, {{section_6_future}}, {{section_7_notes}}

フッター:
  {{ai_disclaimer}}
```

**モニタリングシート 就労 (C):**

```
ヘッダー部: {{user_name}}, {{staff_name}}, {{service_manager}}, {{date}} 等

表形式:
  職業生活（10行）: {{wl_note_1}} 〜 {{wl_note_10}}  ※評価列は空欄（担当者記入）
  対人関係（5行）:  {{rel_note_1}} 〜 {{rel_note_5}}
  作業関係（5行）:  {{task_note_1}} 〜 {{task_note_5}}

総合所見: {{overall_assessment}}
フッター: {{ai_disclaimer}}
```

**テンプレート設定シート（マッピング管理）:**

| 様式名 | テンプレートDocID | 生成ステージ | プロンプトFileID |
|--------|------------------|-------------|-----------------|
| 記録票(B) | (DocID) | Stage3A | (DriveFileID) |
| シート(C) | (DocID) | Stage3B | (DriveFileID) |
| 計画書(A) | (Phase 3で設定) | Stage3C | (Phase 3で設定) |

**対応予定:**

| 様式 | Phase | 状態 |
|------|-------|------|
| モニタリング記録票 (B) | Phase P | 今回設計 |
| モニタリングシート 就労 (C) | Phase P | 今回設計 |
| 個別支援計画書 (A) | Phase 3 | 今後設計 |

---

### 2-7. Gemini APIレスポンス検証 — High

**安全アクセス関数:**

```javascript
function extractTextFromResponse_(result) {
  if (!result.candidates || result.candidates.length === 0) {
    throw new Error('Gemini: candidatesが空です');
  }
  const candidate = result.candidates[0];
  if (candidate.finishReason === 'SAFETY') {
    throw new Error('Gemini: 安全フィルタでブロックされました');
  }
  if (!candidate.content || !candidate.content.parts || candidate.content.parts.length === 0) {
    throw new Error('Gemini: レスポンス構造が不正です');
  }
  return candidate.content.parts[0].text;
}
```

**変更対象:** `utils.gs`

---

### 2-8. エラーハンドリング統一 — High

**統一パターン:**

- 全 `runStage*()` は `{ success: true, data: ... }` or `{ success: false, error: '...' }` を返す
- throw はしない（呼び出し元でtry/catch不要）
- 内部例外は catch して `{ success: false }` に変換
- ログ出力は各関数内で完結

**ログレベル:**

| レベル | 用途 |
|--------|------|
| ERROR | 処理継続不能（API失敗、バリデーション失敗） |
| WARN | 処理は継続するが注意（空欄フォールバック、リトライ発生） |
| INFO | 正常動作の記録（ステージ完了、ファイル移動） |

**変更対象:** 全ステージファイル

---

### 2-9. V8ランタイム移行 — Medium

全ファイルで以下を適用。機能変更なし、構文のみ。

| 変更 | 例 |
|------|-----|
| `var` → `const/let` | スコープ安全性向上 |
| テンプレートリテラル | `` `Hello ${name}` `` |
| アロー関数 | コールバック簡略化 |
| 分割代入 | `const { success, data } = runStage1()` |
| `Object.entries()` | テンプレート置換ループ等 |

**変更対象:** 全11ファイル

---

### 2-10. prompts.gs 保守性改善 — Medium

**方針:** Google Drive 上の md ファイルからプロンプトを読み込む。

```
Drive「プロンプトテンプレート」フォルダ:
  ├─ stage1_transcribe.md     ← {{glossary}} 等の変数あり
  ├─ stage2_extract.md
  ├─ stage3a_record.md
  └─ stage3b_sheet.md
```

**実装:**

```javascript
function getPromptFromFile_(fileId, variables) {
  const text = DriveApp.getFileById(fileId)
    .getBlob().getDataAsString('UTF-8');
  let prompt = text;
  for (const [key, value] of Object.entries(variables)) {
    prompt = prompt.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), value);
  }
  return prompt;
}
```

**フォールバック:** FileID未設定 or 読み込み失敗時 → prompts.gs 内のハードコード版を使用。

**変更対象:** `prompts.gs`

---

### 2-11. ユーザーマスター列番号修正 — Medium

**方針:** ヘッダー行から列名→インデックスのマップを動的生成。

```javascript
function loadUserMaster(userName) {
  const ss = SpreadsheetApp.openById(getSpreadsheetId());
  const sheet = ss.getSheetByName(CONFIG.SHEET_NAMES.USER_MASTER);
  const data = sheet.getDataRange().getValues();
  const headers = data[0];

  const col = {};
  headers.forEach((h, i) => col[h] = i);

  for (let i = 1; i < data.length; i++) {
    if (data[i][col['利用者名']] === userName) {
      return {
        name:         data[i][col['利用者名']],
        staff:        data[i][col['担当職員']],
        manager:      data[i][col['サービス管理責任者']],
        longTermGoal: data[i][col['長期目標']],
        // ... 以下同様
      };
    }
  }
  return null;
}
```

**変更対象:** `dashboard.gs`

---

### 2-12. Low 項目

- **ダッシュボード行番号追跡・線形検索:** 現状維持。Phase 2以降で再検討
- **セキュリティ:** Phase P ではコメント注記のみ（`// TODO(Phase 1): ...`）

---

## 3. 変更しないもの

- ダッシュボードの `appendRow` + `getLastRow` 方式
- 5分ポーリング間隔
- Script Properties でのAPIキー管理
- Stage 2 のバリデーションロジック（スキーマ検証）
- フォルダ構造（00〜06）

---

## 4. ステータス定数

```javascript
const STATUS = {
  QUEUED:         'QUEUED',
  STAGE1_RUNNING: 'STAGE1_RUNNING',
  STAGE1_DONE:    'STAGE1_DONE',
  STAGE2_RUNNING: 'STAGE2_RUNNING',
  STAGE2_DONE:    'STAGE2_DONE',
  STAGE3_RUNNING: 'STAGE3_RUNNING',
  STAGE3_DONE:    'STAGE3_DONE',
  STAGE3_PARTIAL: 'STAGE3_PARTIAL',
  ERROR:          'ERROR',
  APPROVED:       'APPROVED'
};
```

---

## 5. 修正優先順位

| # | 修正内容 | 深刻度 | 変更ファイル |
|---|---------|--------|------------|
| 1 | ステージ分割実行（経過時間チェック方式） | Critical | `main.gs`, `dashboard.gs`, `config.gs` |
| 2 | Gemini File API 切替 | Critical | `utils.gs`, `transcribe.gs` |
| 3 | テンプレートエンジン再設計 | Critical | `templateManager.gs` |
| 4 | Stage 3-A/B 独立実行 | High | `main.gs` |
| 5 | 冪等性（重複チェック・タイムアウトリカバリ） | High | `main.gs`, `dashboard.gs` |
| 6 | 盛岡市様式テンプレート構造設計 | High | 新規Docsテンプレート2件 + Sheets設定 |
| 7 | Gemini APIレスポンス検証 | High | `utils.gs` |
| 8 | エラーハンドリング統一 | High | 全ステージファイル |
| 9 | V8ランタイム移行（const/let） | Medium | 全11ファイル |
| 10 | prompts.gs → md外部化 | Medium | `prompts.gs`, 新規mdファイル4件 |
| 11 | ユーザーマスター列番号修正 | Medium | `dashboard.gs` |
| 12 | ダッシュボード / セキュリティ | Low | コメント注記のみ |
