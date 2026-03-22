# グローポイント支援記録自動化 — 改善実装計画

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** コードレビューで発見した12件の問題（Critical 3件、High 5件、Medium 3件、Low 1件）を段階的に修正する

**Architecture:** GAS完結のパイプラインを維持しつつ、ステージ分割実行・Gemini File API・汎用テンプレートエンジンを導入。エラーハンドリングを統一し、V8ランタイムに移行。

**Tech Stack:** Google Apps Script (V8), Gemini 2.5 Flash API, Google Drive/Docs/Sheets

**設計書:** `docs/plans/2026-03-21-code-review-and-improvement-design.md`

**注意:** GASにはローカルテスト環境がないため、各タスクではGASエディタで実行可能なテスト関数を作成し、手動実行で検証する。テスト関数は `main.gs` の末尾にまとめて配置する。

---

## 依存関係

```
Task 1 (V8移行) ← 全タスクの基盤。最初に実施
Task 2 (エラーハンドリング統一) ← Task 4, 5, 6 が依存
Task 3 (APIレスポンス検証) ← Task 2 と同時実施可
Task 4 (Gemini File API) ← Task 2 完了後
Task 5 (ステージ分割) ← Task 2, 4 完了後
Task 6 (Stage 3-A/B独立) ← Task 2, 5 完了後
Task 7 (冪等性) ← Task 5 完了後
Task 8 (テンプレートエンジン) ← Task 1 完了後（他と独立）
Task 9 (ユーザーマスター修正) ← Task 1 完了後（他と独立）
Task 10 (prompts.gs外部化) ← Task 1 完了後（他と独立）
Task 11 (テンプレート構造設計) ← Task 8 完了後
Task 12 (Low項目) ← 最後に実施
```

---

### Task 1: V8ランタイム移行（全ファイル）

**Files:**
- Modify: `gas/config.gs`
- Modify: `gas/utils.gs`
- Modify: `gas/prompts.gs`
- Modify: `gas/fileManager.gs`
- Modify: `gas/transcribe.gs`
- Modify: `gas/extract.gs`
- Modify: `gas/generateRecord.gs`
- Modify: `gas/generateSheet.gs`
- Modify: `gas/templateManager.gs`
- Modify: `gas/dashboard.gs`
- Modify: `gas/main.gs`

**Step 1: config.gs を V8 構文に変換**

全ての `var` を `const`（再代入なし）または `let`（再代入あり）に置換。関数内の一時変数も対象。

```javascript
// Before
var CONFIG = { ... };

// After
const CONFIG = { ... };
```

**Step 2: utils.gs を V8 構文に変換**

`var` → `const/let`。文字列連結をテンプレートリテラルに変更。

```javascript
// Before
var url = 'https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent?key=' + apiKey;

// After
const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
```

**Step 3: prompts.gs を V8 構文に変換**

文字列連結 (`+`) をテンプレートリテラル (`` ` ``) に変換。`var` → `const`。

**Step 4: 残り8ファイルを V8 構文に変換**

`fileManager.gs`, `transcribe.gs`, `extract.gs`, `generateRecord.gs`, `generateSheet.gs`, `templateManager.gs`, `dashboard.gs`, `main.gs` の全てで `var` → `const/let`。

**Step 5: コミット**

```bash
git add gas/
git commit -m "refactor: migrate all GAS files to V8 runtime syntax (const/let, template literals)"
```

---

### Task 2: エラーハンドリング統一

**Files:**
- Modify: `gas/transcribe.gs`
- Modify: `gas/extract.gs`
- Modify: `gas/generateRecord.gs`
- Modify: `gas/generateSheet.gs`

**Step 1: transcribe.gs の戻り値パターンを統一**

`runStage1()` が `{ success: true, data: { transcript, fileUrl } }` または `{ success: false, error: '...' }` を返すように修正。内部例外は catch して変換。ログ出力は関数内で完結。

```javascript
function runStage1(audioFileId, processingFolderId, userMaster) {
  try {
    logInfo('Stage1', `文字起こし開始: ${userMaster.name}`);
    // ... 処理 ...
    logInfo('Stage1', '文字起こし完了');
    return { success: true, data: { transcript, fileUrl } };
  } catch (e) {
    logError('Stage1', `文字起こし失敗: ${e.message}`);
    return { success: false, error: e.message };
  }
}
```

**Step 2: extract.gs の戻り値パターンを統一**

`runStage2()` を同じパターンに修正。バリデーション失敗時も `{ success: false, error }` を返す（throwしない）。

**Step 3: generateRecord.gs の戻り値パターンを統一**

`runStage3A()` を同じパターンに修正。

**Step 4: generateSheet.gs の戻り値パターンを統一**

`runStage3B()` を同じパターンに修正。

**Step 5: コミット**

```bash
git add gas/transcribe.gs gas/extract.gs gas/generateRecord.gs gas/generateSheet.gs
git commit -m "refactor: unify error handling pattern across all pipeline stages"
```

---

### Task 3: Gemini APIレスポンス検証

**Files:**
- Modify: `gas/utils.gs`

**Step 1: extractTextFromResponse_ 関数を追加**

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

**Step 2: callGeminiApi() 内のレスポンス取得部分を extractTextFromResponse_ に置換**

既存の `result.candidates[0].content.parts[0].text` 直接参照を全て置換。

**Step 3: テスト関数を作成**

```javascript
function test_extractTextFromResponse() {
  // 正常系
  const valid = { candidates: [{ content: { parts: [{ text: 'hello' }] } }] };
  console.log('正常系:', extractTextFromResponse_(valid) === 'hello' ? 'PASS' : 'FAIL');

  // 異常系: candidates空
  try {
    extractTextFromResponse_({ candidates: [] });
    console.log('candidates空: FAIL (例外なし)');
  } catch (e) {
    console.log('candidates空:', e.message.includes('candidatesが空') ? 'PASS' : 'FAIL');
  }

  // 異常系: SAFETYブロック
  try {
    extractTextFromResponse_({ candidates: [{ finishReason: 'SAFETY' }] });
    console.log('SAFETY: FAIL (例外なし)');
  } catch (e) {
    console.log('SAFETY:', e.message.includes('安全フィルタ') ? 'PASS' : 'FAIL');
  }
}
```

**Step 4: GASエディタで test_extractTextFromResponse を実行し、全てPASSを確認**

**Step 5: コミット**

```bash
git add gas/utils.gs
git commit -m "fix: add Gemini API response validation to prevent null reference errors"
```

---

### Task 4: Gemini File API 切替

**Files:**
- Modify: `gas/utils.gs`
- Modify: `gas/transcribe.gs`

**Step 1: utils.gs に uploadToGeminiFileApi() を追加**

```javascript
function uploadToGeminiFileApi(driveFileId) {
  const apiKey = getApiKey();
  const file = DriveApp.getFileById(driveFileId);
  const blob = file.getBlob();
  logInfo('FileAPI', `アップロード開始: ${file.getName()} (${blob.getBytes().length} bytes)`);

  const response = UrlFetchApp.fetch(
    `https://generativelanguage.googleapis.com/upload/v1beta/files?key=${apiKey}`,
    {
      method: 'post',
      contentType: blob.getContentType(),
      payload: blob.getBytes(),
      headers: { 'X-Goog-Upload-Display-Name': file.getName() },
      muteHttpExceptions: true
    }
  );

  const status = response.getResponseCode();
  if (status !== 200) {
    throw new Error(`Gemini File API アップロード失敗: HTTP ${status} - ${response.getContentText()}`);
  }

  const result = JSON.parse(response.getContentText());
  logInfo('FileAPI', `アップロード完了: ${result.file.uri}`);
  return result.file.uri;
}
```

**Step 2: callGeminiApi() に fileUri オプションを追加**

音声ファイルをbase64ではなくURI参照で送信するモードを追加。

```javascript
function callGeminiApi(prompt, options = {}) {
  const apiKey = getApiKey();
  const model = options.model || CONFIG.GEMINI_MODEL;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

  const parts = [{ text: prompt }];

  // File API URI参照モード（新規）
  if (options.fileUri) {
    parts.unshift({
      fileData: {
        mimeType: options.mimeType || 'audio/mp4',
        fileUri: options.fileUri
      }
    });
  }
  // 従来のbase64モード（テキスト系ステージで引き続き使用）
  else if (options.audioBlob) {
    parts.unshift({
      inlineData: {
        mimeType: options.audioBlob.getContentType() || 'audio/mp4',
        data: Utilities.base64Encode(options.audioBlob.getBytes())
      }
    });
  }

  const payload = {
    contents: [{ parts }],
    generationConfig: options.generationConfig || {}
  };

  const fetchOptions = {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };

  const response = UrlFetchApp.fetch(url, fetchOptions);
  const status = response.getResponseCode();
  if (status !== 200) {
    throw new Error(`Gemini API エラー: HTTP ${status} - ${response.getContentText()}`);
  }

  const result = JSON.parse(response.getContentText());
  return extractTextFromResponse_(result);
}
```

**Step 3: transcribe.gs の runStage1() を File API 使用に変更**

```javascript
function runStage1(audioFileId, processingFolderId, userMaster) {
  try {
    logInfo('Stage1', `文字起こし開始: ${userMaster.name}`);

    // Gemini File API にアップロード → URI取得
    const fileUri = uploadToGeminiFileApi(audioFileId);
    const file = DriveApp.getFileById(audioFileId);

    // URI参照で文字起こし実行
    const glossary = loadGlossary();
    const prompt = getStage1Prompt(glossary);
    const transcript = callGeminiWithRetry(prompt, {
      fileUri: fileUri,
      mimeType: file.getBlob().getContentType() || 'audio/mp4'
    });

    // 文字起こし結果を保存
    const fileUrl = saveTranscript(processingFolderId, userMaster.name, formatDate(new Date()), transcript);
    logInfo('Stage1', '文字起こし完了');
    return { success: true, data: { transcript, fileUrl } };
  } catch (e) {
    logError('Stage1', `文字起こし失敗: ${e.message}`);
    return { success: false, error: e.message };
  }
}
```

**Step 4: 旧 base64 コードを削除**

utils.gs の `callGeminiApi()` から旧来の `audioBlob` 分岐を削除（File API に完全移行）。

**Step 5: コミット**

```bash
git add gas/utils.gs gas/transcribe.gs
git commit -m "feat: switch to Gemini File API for audio upload, eliminate base64 memory issue"
```

---

### Task 5: ステージ分割実行（経過時間チェック方式）

**Files:**
- Modify: `gas/config.gs`
- Modify: `gas/dashboard.gs`
- Modify: `gas/main.gs`

**Step 1: config.gs にステータス定数を追加**

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

// CONFIG に追加
const CONFIG = {
  // ... 既存設定 ...
  STAGE_TIME_LIMIT_MS: 4 * 60 * 1000,   // 4分（6分制限に対して2分マージン）
  TIMEOUT_THRESHOLD_MS: 30 * 60 * 1000,  // 30分でタイムアウト判定
};
```

**Step 2: dashboard.gs にステージ別検索関数を追加**

```javascript
function findRowsByStatus(targetStatus) {
  const ss = SpreadsheetApp.openById(getSpreadsheetId());
  const sheet = ss.getSheetByName(CONFIG.SHEET_NAMES.DASHBOARD);
  if (!sheet) return [];

  const data = sheet.getDataRange().getValues();
  const headers = data[0];
  const col = {};
  headers.forEach((h, i) => col[h] = i);

  const results = [];
  for (let i = 1; i < data.length; i++) {
    if (data[i][col['ステータス']] === targetStatus) {
      results.push({
        rowNumber: i + 1,
        processId: data[i][col['処理ID']],
        userName: data[i][col['利用者名']],
        audioFileId: data[i][col['音声ファイルID']],
        transcript: data[i][col['文字起こしURL']],
        extractionUrl: data[i][col['抽出JSONURL']],
        updatedAt: data[i][col['更新日時']]
      });
    }
  }
  return results;
}
```

**Step 3: main.gs を書き換え — processNewFiles() をステージディスパッチャに変更**

```javascript
function processNewFiles() {
  const startTime = Date.now();

  try {
    // 1. タイムアウトしたジョブのリカバリ
    recoverTimedOutJobs_();

    // 2. 新規ファイル検出 → QUEUED
    const newFiles = detectNewAudioFiles();
    for (const file of newFiles) {
      enqueueFile_(file);
    }

    // 3. ステージ別ディスパッチ（1ファイルずつ、時間の許す限り）
    dispatchNextStage_(startTime);

  } catch (e) {
    logError('processNewFiles', e.message);
  }
}

function dispatchNextStage_(startTime) {
  const elapsed = () => Date.now() - startTime;

  // QUEUED → Stage 1
  const queued = findRowsByStatus(STATUS.QUEUED);
  if (queued.length > 0 && elapsed() < CONFIG.STAGE_TIME_LIMIT_MS) {
    executeStage1_(queued[0]);
  }

  // STAGE1_DONE → Stage 2
  const stage1Done = findRowsByStatus(STATUS.STAGE1_DONE);
  if (stage1Done.length > 0 && elapsed() < CONFIG.STAGE_TIME_LIMIT_MS) {
    executeStage2_(stage1Done[0]);
  }

  // STAGE2_DONE → Stage 3
  const stage2Done = findRowsByStatus(STATUS.STAGE2_DONE);
  if (stage2Done.length > 0 && elapsed() < CONFIG.STAGE_TIME_LIMIT_MS) {
    executeStage3_(stage2Done[0]);
  }
}
```

**Step 4: main.gs に各ステージ実行関数を実装**

`executeStage1_()`, `executeStage2_()`, `executeStage3_()` を実装。各関数はダッシュボードのステータスを `*_RUNNING` → `*_DONE` or `ERROR` に更新。

```javascript
function executeStage1_(job) {
  updateDashboardStatus(job.rowNumber, {
    'ステータス': STATUS.STAGE1_RUNNING,
    '更新日時': formatDateTime(new Date())
  });

  const userMaster = loadUserMaster(job.userName);
  if (!userMaster) {
    updateDashboardStatus(job.rowNumber, {
      'ステータス': STATUS.ERROR,
      'エラー内容': `利用者「${job.userName}」がマスターに見つかりません`
    });
    return;
  }

  const result = runStage1(job.audioFileId, getFolderIds().processing, userMaster);
  if (result.success) {
    updateDashboardStatus(job.rowNumber, {
      'ステータス': STATUS.STAGE1_DONE,
      '文字起こしURL': result.data.fileUrl,
      '更新日時': formatDateTime(new Date())
    });
  } else {
    updateDashboardStatus(job.rowNumber, {
      'ステータス': STATUS.ERROR,
      'エラー内容': result.error
    });
  }
}

// executeStage2_, executeStage3_ も同様のパターンで実装
```

**Step 5: 旧 processSingleFile() を削除**

新しいディスパッチャに置き換わったため削除。

**Step 6: テスト関数を作成**

```javascript
function test_dispatchNextStage() {
  // ダッシュボードにテスト行を追加して各ステータスの遷移を確認
  console.log('STATUS定数:', JSON.stringify(STATUS));
  const queued = findRowsByStatus(STATUS.QUEUED);
  console.log('QUEUED行数:', queued.length);
  const s1done = findRowsByStatus(STATUS.STAGE1_DONE);
  console.log('STAGE1_DONE行数:', s1done.length);
}
```

**Step 7: コミット**

```bash
git add gas/config.gs gas/dashboard.gs gas/main.gs
git commit -m "feat: implement stage-based pipeline dispatch with elapsed time checking"
```

---

### Task 6: Stage 3-A/B 独立実行

**Files:**
- Modify: `gas/main.gs`

**Step 1: executeStage3_() で 3-A と 3-B を独立実行に修正**

```javascript
function executeStage3_(job) {
  updateDashboardStatus(job.rowNumber, {
    'ステータス': STATUS.STAGE3_RUNNING,
    '更新日時': formatDateTime(new Date())
  });

  const userMaster = loadUserMaster(job.userName);
  const extractionData = loadExtractionData_(job);

  let result3A, result3B;

  // 3-A: モニタリング記録票（失敗しても3-Bに進む）
  try {
    result3A = runStage3A(extractionData, userMaster);
  } catch (e) {
    result3A = { success: false, error: e.message };
    logError('Stage3A', e.message);
  }

  // 3-B: モニタリングシート（3-Aの結果に依存しない）
  try {
    result3B = runStage3B(extractionData, userMaster);
  } catch (e) {
    result3B = { success: false, error: e.message };
    logError('Stage3B', e.message);
  }

  // ステータス判定
  const bothSuccess = result3A.success && result3B.success;
  const bothFailed = !result3A.success && !result3B.success;

  if (bothSuccess) {
    updateDashboardStatus(job.rowNumber, {
      'ステータス': STATUS.STAGE3_DONE,
      '記録票URL': result3A.data?.docUrl || '',
      'シートURL': result3B.data?.docUrl || '',
      '更新日時': formatDateTime(new Date())
    });
  } else if (bothFailed) {
    updateDashboardStatus(job.rowNumber, {
      'ステータス': STATUS.ERROR,
      'エラー内容': `3A: ${result3A.error} / 3B: ${result3B.error}`
    });
  } else {
    updateDashboardStatus(job.rowNumber, {
      'ステータス': STATUS.STAGE3_PARTIAL,
      '記録票URL': result3A.success ? (result3A.data?.docUrl || '') : `エラー: ${result3A.error}`,
      'シートURL': result3B.success ? (result3B.data?.docUrl || '') : `エラー: ${result3B.error}`,
      '更新日時': formatDateTime(new Date())
    });
  }
}
```

**Step 2: コミット**

```bash
git add gas/main.gs
git commit -m "fix: execute Stage 3-A and 3-B independently (design-implementation alignment)"
```

---

### Task 7: 冪等性（重複処理防止 + タイムアウトリカバリ）

**Files:**
- Modify: `gas/dashboard.gs`
- Modify: `gas/main.gs`

**Step 1: dashboard.gs に重複チェック関数を追加**

```javascript
function isDuplicateProcess(processId) {
  const existing = findDashboardRowByProcessId(processId);
  return existing !== null;
}
```

**Step 2: main.gs の enqueueFile_() に重複ガードを追加**

```javascript
function enqueueFile_(audioFile) {
  const processId = audioFile.getId();

  // 重複チェック
  if (isDuplicateProcess(processId)) {
    logWarn('enqueue', `重複スキップ: ${audioFile.getName()} (${processId})`);
    return;
  }

  const parsed = parseFileNameForUser(audioFile.getName());
  moveToProcessing(audioFile.getId());

  addDashboardRow(processId, parsed.userName, parsed.date, audioFile.getName(), STATUS.QUEUED);
  logInfo('enqueue', `キュー追加: ${audioFile.getName()}`);
}
```

**Step 3: main.gs にタイムアウトリカバリ関数を追加**

```javascript
function recoverTimedOutJobs_() {
  const runningStatuses = [STATUS.STAGE1_RUNNING, STATUS.STAGE2_RUNNING, STATUS.STAGE3_RUNNING];

  for (const status of runningStatuses) {
    const rows = findRowsByStatus(status);
    for (const row of rows) {
      const updatedAt = new Date(row.updatedAt);
      const elapsed = Date.now() - updatedAt.getTime();

      if (elapsed > CONFIG.TIMEOUT_THRESHOLD_MS) {
        logWarn('recovery', `タイムアウト検出: ${row.processId} (${status}, ${Math.round(elapsed / 60000)}分経過)`);
        updateDashboardStatus(row.rowNumber, {
          'ステータス': STATUS.ERROR,
          'エラー内容': `タイムアウト (${status} で ${Math.round(elapsed / 60000)}分停止)`,
          '更新日時': formatDateTime(new Date())
        });
      }
    }
  }
}
```

**Step 4: コミット**

```bash
git add gas/dashboard.gs gas/main.gs
git commit -m "feat: add idempotency guard and timeout recovery for pipeline resilience"
```

---

### Task 8: テンプレートエンジン再設計

**Files:**
- Modify: `gas/templateManager.gs`

**Step 1: fillTemplate() を本文+表セル対応に書き換え**

```javascript
function fillTemplate(templateId, replacements, outputFolderId, fileName) {
  const templateFile = DriveApp.getFileById(templateId);
  const outputFolder = DriveApp.getFolderById(outputFolderId);
  const copy = templateFile.makeCopy(fileName, outputFolder);
  const doc = DocumentApp.openById(copy.getId());
  const body = doc.getBody();

  // 1. 本文テキスト置換
  for (const [key, value] of Object.entries(replacements)) {
    const pattern = `\\{\\{${escapeRegex_(key)}\\}\\}`;
    const replacement = value || '';
    body.replaceText(pattern, replacement);
  }

  // 2. 表セル内の置換
  const numTables = body.getNumChildren();
  for (let t = 0; t < numTables; t++) {
    const child = body.getChild(t);
    if (child.getType() !== DocumentApp.ElementType.TABLE) continue;

    const table = child.asTable();
    for (let r = 0; r < table.getNumRows(); r++) {
      const row = table.getRow(r);
      for (let c = 0; c < row.getNumCells(); c++) {
        const cell = row.getCell(c);
        const cellText = cell.getText();

        // セル内にプレースホルダがある場合のみ処理
        if (!cellText.includes('{{')) continue;

        for (const [key, value] of Object.entries(replacements)) {
          const pattern = `\\{\\{${escapeRegex_(key)}\\}\\}`;
          const replacement = value || '面談中の言及なし';
          cell.replaceText(pattern, replacement);
        }
      }
    }
  }

  // 3. 未置換プレースホルダのチェック
  const remainingText = body.getText();
  const unfilledMatches = remainingText.match(/\{\{[^}]+\}\}/g);
  if (unfilledMatches) {
    logWarn('template', `未置換プレースホルダ: ${unfilledMatches.join(', ')}`);
  }

  doc.saveAndClose();
  logInfo('template', `テンプレート生成完了: ${fileName}`);
  return copy;
}
```

**Step 2: verifyTemplate() を更新（テーブル内プレースホルダも検出）**

```javascript
function verifyTemplate(templateId) {
  try {
    const doc = DocumentApp.openById(templateId);
    const body = doc.getBody();
    const fullText = body.getText();
    const placeholders = fullText.match(/\{\{[^}]+\}\}/g) || [];

    return {
      success: true,
      name: doc.getName(),
      placeholders: [...new Set(placeholders)],
      placeholderCount: [...new Set(placeholders)].length,
      charCount: fullText.length
    };
  } catch (e) {
    return { success: false, error: e.message };
  }
}
```

**Step 3: テスト関数を作成**

```javascript
function test_fillTemplate() {
  // テスト用テンプレートが設定されている場合のみ実行
  const templateIds = getTemplateIds();
  if (!templateIds.monitoringRecord) {
    console.log('SKIP: テンプレート未設定');
    return;
  }

  const result = verifyTemplate(templateIds.monitoringRecord);
  console.log('テンプレート検証:', JSON.stringify(result, null, 2));
}
```

**Step 4: コミット**

```bash
git add gas/templateManager.gs
git commit -m "feat: redesign template engine with table cell support and unfilled placeholder detection"
```

---

### Task 9: ユーザーマスター列番号修正

**Files:**
- Modify: `gas/dashboard.gs`

**Step 1: loadUserMaster() をヘッダーベースの動的マッピングに変更**

```javascript
function loadUserMaster(userName) {
  const ss = SpreadsheetApp.openById(getSpreadsheetId());
  const sheet = ss.getSheetByName(CONFIG.SHEET_NAMES.USER_MASTER);
  if (!sheet) {
    logError('UserMaster', '利用者マスターシートが見つかりません');
    return null;
  }

  const data = sheet.getDataRange().getValues();
  if (data.length < 2) {
    logWarn('UserMaster', '利用者マスターにデータがありません');
    return null;
  }

  const headers = data[0];
  const col = {};
  headers.forEach((h, i) => col[h] = i);

  for (let i = 1; i < data.length; i++) {
    if (data[i][col['利用者名']] === userName) {
      return {
        name:               data[i][col['利用者名']],
        staff:              data[i][col['担当職員']],
        manager:            data[i][col['サービス管理責任者']],
        longTermGoal:       data[i][col['長期目標']],
        shortTermGoal1:     data[i][col['短期目標①']],
        supportContent1:    data[i][col['支援内容①']],
        goal1Period:        data[i][col['期間①']],
        shortTermGoal2:     data[i][col['短期目標②']],
        supportContent2:    data[i][col['支援内容②']],
        goal2Period:        data[i][col['期間②']],
        previousMonitoringDate: data[i][col['前回モニタリング日']] ? new Date(data[i][col['前回モニタリング日']]) : null,
        nextMonitoringMonth: data[i][col['次回モニタリング予定月']],
        previousIssues:     data[i][col['前回の課題']] || '',
        attendees:          data[i][col['出席者']] || ''
      };
    }
  }

  logWarn('UserMaster', `利用者「${userName}」が見つかりません`);
  return null;
}
```

**Step 2: テスト関数を作成**

```javascript
function test_loadUserMaster() {
  const ss = SpreadsheetApp.openById(getSpreadsheetId());
  const sheet = ss.getSheetByName(CONFIG.SHEET_NAMES.USER_MASTER);
  if (!sheet || sheet.getLastRow() < 2) {
    console.log('SKIP: マスターデータなし');
    return;
  }

  const firstUserName = sheet.getRange(2, 1).getValue();
  const result = loadUserMaster(firstUserName);
  console.log('取得結果:', JSON.stringify(result, null, 2));
  console.log('name一致:', result && result.name === firstUserName ? 'PASS' : 'FAIL');
}
```

**Step 3: コミット**

```bash
git add gas/dashboard.gs
git commit -m "fix: replace hardcoded column indices with dynamic header-based mapping in loadUserMaster"
```

---

### Task 10: prompts.gs 外部化（mdファイル読み込み）

**Files:**
- Modify: `gas/prompts.gs`
- Modify: `gas/config.gs`

**Step 1: config.gs にプロンプトファイルIDのプロパティ名を追加**

```javascript
// getTemplateIds() と同様のパターンで追加
function getPromptFileIds() {
  const props = PropertiesService.getScriptProperties();
  return {
    stage1: props.getProperty('PROMPT_FILE_ID_STAGE1'),
    stage2: props.getProperty('PROMPT_FILE_ID_STAGE2'),
    stage3a: props.getProperty('PROMPT_FILE_ID_STAGE3A'),
    stage3b: props.getProperty('PROMPT_FILE_ID_STAGE3B')
  };
}
```

**Step 2: prompts.gs にファイル読み込み関数を追加**

```javascript
function getPromptFromFile_(fileId, variables) {
  const text = DriveApp.getFileById(fileId)
    .getBlob().getDataAsString('UTF-8');
  let prompt = text;
  for (const [key, value] of Object.entries(variables)) {
    prompt = prompt.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), value || '');
  }
  return prompt;
}
```

**Step 3: 各 getStage*Prompt() にフォールバック付き外部読み込みを追加**

```javascript
function getStage1Prompt(glossaryEntries) {
  const fileIds = getPromptFileIds();

  // 外部ファイルが設定されていればそちらを使用
  if (fileIds.stage1) {
    try {
      return getPromptFromFile_(fileIds.stage1, {
        glossary: (glossaryEntries || []).join('\n')
      });
    } catch (e) {
      logWarn('prompts', `Stage1プロンプトファイル読み込み失敗、ハードコード版を使用: ${e.message}`);
    }
  }

  // フォールバック: 既存のハードコード版
  return buildStage1PromptHardcoded_(glossaryEntries);
}
```

**Step 4: 既存のプロンプト構築ロジックを _Hardcoded_ サフィックス付きプライベート関数にリネーム**

`getStage1Prompt()` の既存ロジック → `buildStage1PromptHardcoded_()`
（Stage2, 3A, 3B も同様）

**Step 5: コミット**

```bash
git add gas/prompts.gs gas/config.gs
git commit -m "feat: externalize prompts to Drive markdown files with hardcoded fallback"
```

---

### Task 11: テンプレート構造設計（ドキュメント作成）

**Files:**
- Create: `docs/templates/monitoring-record-template-spec.md`
- Create: `docs/templates/monitoring-sheet-template-spec.md`

**Step 1: モニタリング記録票テンプレート仕様書を作成**

Google Docsテンプレート作成時の手順書。プレースホルダの配置場所、書式、テーブル構造を明記。

**Step 2: モニタリングシートテンプレート仕様書を作成**

表セル内のプレースホルダ配置、評価列の空欄維持、備考列への `{{wl_note_*}}` 配置を明記。

**Step 3: コミット**

```bash
git add docs/templates/
git commit -m "docs: add template structure specifications for Morioka municipal forms"
```

---

### Task 12: Low 項目（セキュリティ注記）

**Files:**
- Modify: `gas/main.gs`
- Modify: `gas/utils.gs`
- Modify: `gas/transcribe.gs`

**Step 1: Phase 1 対応が必要な箇所にTODOコメントを追加**

```javascript
// main.gs のファイル先頭
// TODO(Phase 1): 個人情報マスキング対応（文字起こし・抽出結果の平文保存）
// TODO(Phase 1): Drive共有範囲の制限確認
// TODO(Phase 1): ログシートの個人情報保持期間設定

// utils.gs の callGeminiApi 付近
// TODO(Phase 1): APIキーのローテーション検討

// transcribe.gs の saveTranscript 付近
// TODO(Phase 1): 文字起こしファイルの暗号化 or アクセス制限
```

**Step 2: コミット**

```bash
git add gas/main.gs gas/utils.gs gas/transcribe.gs
git commit -m "chore: add Phase 1 security TODO comments for personal data handling"
```

---

## 完了後チェックリスト

- [ ] 全ファイルが `const/let` を使用していること
- [ ] 全 `runStage*()` が `{ success, data/error }` パターンを返すこと
- [ ] `callGeminiApi()` が `extractTextFromResponse_()` を使用していること
- [ ] `processSingleFile()` が削除されていること
- [ ] `executeStage3_()` で 3-A/3-B が独立実行されること
- [ ] `enqueueFile_()` に重複チェックがあること
- [ ] `fillTemplate()` がテーブルセル内を走査すること
- [ ] `loadUserMaster()` がヘッダーベースのマッピングを使用すること
- [ ] テスト関数が全てPASSすること
