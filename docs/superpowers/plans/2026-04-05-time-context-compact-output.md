# 過去事業所情報の区別とモニタリング出力コンパクト化 実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stage2 抽出に時系列タグ (`time_context`) を追加し、Stage3 の記録票・モニタリングシートで過去事業所の情報を区別表記 + 項目ごとの個別エビデンス記載に変更する

**Architecture:** Stage2 の JSON スキーマに `time_context` / `facility_name` を追加 → Stage2 プロンプトで同意日ベースの判定ルールを指示 → Stage3-A/3-B プロンプトでタグに基づく出力制御を指示。GAS コード側は Stage2 バリデーション拡張のみ。

**Tech Stack:** Google Apps Script (V8), Gemini 2.5 Flash API

**設計書:** `docs/superpowers/specs/2026-04-05-time-context-compact-output-design.md`

---

### Task 1: Stage2 JSON スキーマ更新（`getStage2JsonSchema`）

**Files:**
- Modify: `gas/prompts.gs:219-304` (`getStage2JsonSchema` 関数)

- [ ] **Step 1: `getStage2JsonSchema` に `time_context` と `facility_name` を追加**

`gas/prompts.gs` の `getStage2JsonSchema()` 内、各カテゴリの項目スキーマに2フィールドを追加する。`cat1_health` の例示オブジェクトに追加し、他カテゴリも同様であることをコメントで示す。

```javascript
// getStage2JsonSchema() 内 — cat1_health の項目定義を以下に差し替え:
// 既存:
//   "summary": "（1文での要約。事実のみ、解釈不可）",
//   "flags": [...]
// ↓ 差し替え後:
    + '        "summary": "（1文での要約。事実のみ、解釈不可）",\n'
    + '        "time_context": "current | past_facility | general",\n'
    + '        "facility_name": "（past_facility の場合のみ施設名。不明なら \\"不明\\"。それ以外は null）",\n'
    + '        "flags": ["要確認", "低確信度", "前回からの変化", "緊急性あり"],\n'
```

同じく `cat3_wishes` と `cat6_staff` のスキーマ例示にも `time_context` / `facility_name` を追加（`sub_type` の直後に配置）:

```javascript
// cat3_wishes の項目定義:
    + '        "sub_type": "wish | satisfaction | complaint | impression",\n'
    + '        "time_context": "current | past_facility | general",\n'
    + '        "facility_name": null,\n'
    + '        "flags": [],\n'
```

```javascript
// cat6_staff の項目定義:
    + '        "sub_type": "observation | concern | advice | assessment",\n'
    + '        "time_context": "current | past_facility | general",\n'
    + '        "facility_name": null,\n'
    + '        "flags": [],\n'
```

- [ ] **Step 2: 変更を確認**

エディタで `getStage2JsonSchema()` を読み返し、JSON の括弧・カンマの整合を確認する。

- [ ] **Step 3: コミット**

```bash
git add gas/prompts.gs
git commit -m "feat(stage2): add time_context/facility_name to JSON schema"
```

---

### Task 2: Stage2 few-shot 例更新（`getStage2FewShotExample`）

**Files:**
- Modify: `gas/prompts.gs:308-423` (`getStage2FewShotExample` 関数)

- [ ] **Step 1: 既存の few-shot 例に `time_context` / `facility_name` を追加**

全ての抽出項目に `time_context` と `facility_name` を追加する。ほとんどは `"current"` + `null` だが、1つ `"past_facility"` の例と1つ `"general"` の例を入れる。

`cat1_health[0]`（服薬変更 → 睡眠改善）を `"general"` に変更:

```javascript
"cat1_health": [{
  "id": "c1-001",
  "quote": "薬変えてもらってから、だいぶ眠れるようになったっす",
  "speaker": "利用者",
  "summary": "服薬変更後、睡眠が改善",
  "time_context": "general",
  "facility_name": null,
  "flags": [],
  "applicable_sections": ["monitoring_4_status"],
  "dialogue_context": null
}],
```

`cat2_work` に `past_facility` の例を1つ追加:

```javascript
"cat2_work": [{
  "id": "c2-001",
  "quote": "最近は箱折りも早くなってきたんだべ",
  "speaker": "利用者",
  "summary": "箱折り作業の速度向上を実感",
  "time_context": "current",
  "facility_name": null,
  "flags": [],
  "applicable_sections": ["monitoring_4_status", "monitoring_5_impression", "sheet_task"],
  "dialogue_context": null
}, {
  "id": "c2-002",
  "quote": "前の事業所でずっと封入作業やってたから、手先の作業は慣れてる",
  "speaker": "利用者",
  "summary": "以前の事業所で封入作業の経験があり、手先の作業に慣れている",
  "time_context": "past_facility",
  "facility_name": "不明",
  "flags": [],
  "applicable_sections": ["monitoring_4_status", "sheet_task"],
  "dialogue_context": null
}],
```

残りの全項目（`cat3_wishes`, `cat6_staff`, `cat7_agreements`, `cat8_uncategorized`）にも `"time_context": "current"` と `"facility_name": null` を追加する。

- [ ] **Step 2: few-shot 全体の JSON 整合を確認**

`JSON.stringify` に渡すオブジェクトリテラルなので、カンマ・括弧の整合を読み返す。

- [ ] **Step 3: コミット**

```bash
git add gas/prompts.gs
git commit -m "feat(stage2): add time_context examples to few-shot"
```

---

### Task 3: Stage2 プロンプト本文に判定ルール追加

**Files:**
- Modify: `gas/prompts.gs:103-127` (`getStage2Prompt` 関数)
- Modify: `gas/prompts.gs:130-216` (`buildStage2PromptHardcoded_` 関数)

- [ ] **Step 1: `getStage2Prompt` に `consentDate` テンプレート変数を追加**

`gas/prompts.gs` の `getStage2Prompt()` 内、`getPromptFromFile_` 呼び出しのテンプレート変数に追加:

```javascript
// 既存の return getPromptFromFile_(fileIds.stage2, { ... }) 内に追加:
        consentDate: userMaster.consentDate
          ? formatJapaneseDate(userMaster.consentDate) : '',
```

- [ ] **Step 2: `buildStage2PromptHardcoded_` に同意日と判定ルールを追加**

利用者マスター情報セクションに同意日を追加:

```javascript
// 既存の「前回モニタリングの主な課題」の後に追加:
    + `- 同意日（≒利用開始時期の目安）: ${userMaster.consentDate ? formatJapaneseDate(userMaster.consentDate) : '不明'}\n\n`
```

「【重要な原則】」セクションの末尾（「AIの推測・解釈は入れないでください」の後）に時系列判定ルールを追加:

```javascript
    + '\n【時系列の判定ルール（time_context）】\n'
    + '各抽出項目に time_context フィールドを付与してください。\n'
    + '- "past_facility": 「前の事業所」「以前は」「○○（施設名）では」等、過去の施設での出来事であることを示す手がかりが1つでもある場合。施設名が特定できれば facility_name に記載、不明なら "不明"\n'
    + '- "current": 同意日以降の出来事、またはグローポイント（当事業所）での出来事と明確にわかるもの\n'
    + '- "general": 障害特性、服薬状況、家族状況など、特定の時期や施設に依存しない継続的事実\n'
    + '- 判断に迷い、過去施設を示す手がかりが一切ない場合は "current" とする\n'
    + '- past_facility 以外の場合、facility_name は null\n\n'
```

- [ ] **Step 3: コミット**

```bash
git add gas/prompts.gs
git commit -m "feat(stage2): add consent date and time_context rules to prompt"
```

---

### Task 4: Stage2 バリデーション拡張（`validateStage2Output`）

**Files:**
- Modify: `gas/extract.gs:76-150` (`validateStage2Output` 関数)

- [ ] **Step 1: 各カテゴリ項目の `time_context` 存在チェックを追加**

`gas/extract.gs` の `validateStage2Output` 内、既存の必須プロパティチェック（L126-128: `id/quote/speaker/summary`）の直後に追加:

```javascript
      // 既存: if (!item.id || !item.quote || !item.speaker || !item.summary) { ... }
      // の後に追加:

      const validTimeContexts = ['current', 'past_facility', 'general'];
      if (!item.time_context || validTimeContexts.indexOf(item.time_context) === -1) {
        return { valid: false, error: `${allCategories[c]}[${m}] の time_context が不正です（値: ${item.time_context}）` };
      }
      if (item.time_context === 'past_facility' && !item.facility_name) {
        return { valid: false, error: `${allCategories[c]}[${m}] が past_facility ですが facility_name がありません` };
      }
```

**注意**: `validTimeContexts` の定義はループの外（`allCategories` の後、ループ開始前）に移動してもよいが、GAS の V8 エンジンでは問題ないためループ内でも可。

- [ ] **Step 2: コミット**

```bash
git add gas/extract.gs
git commit -m "feat(stage2): validate time_context/facility_name in extraction output"
```

---

### Task 5: Stage3-A プロンプトに過去事業所の区別表記ルール追加

**Files:**
- Modify: `gas/prompts.gs:456-556` (`buildStage3APromptHardcoded_` 関数)
- Modify: `gas/prompts.gs:426-453` (`getStage3APrompt` 関数)

- [ ] **Step 1: `getStage3APrompt` に `consentDate` テンプレート変数を追加**

`getStage3APrompt()` の `getPromptFromFile_` 呼び出しに追加:

```javascript
        consentDate: userMaster.consentDate
          ? formatJapaneseDate(userMaster.consentDate) : '',
```

- [ ] **Step 2: `buildStage3APromptHardcoded_` の「重要な原則」に過去事業所ルールを追加**

既存の「情報がない項目は〜」ルールの後（L471 付近）に追加:

```javascript
    + '- 【過去の事業所の情報の扱い】抽出JSONの time_context フィールドを確認し、以下のルールで記載してください：\n'
    + '  - time_context="current" → そのまま記載（グローポイントでの出来事）\n'
    + '  - time_context="past_facility" → 「（過去：○○事業所での経験）」と明記。facility_name が "不明" の場合は「（過去：以前の事業所での経験）」\n'
    + '  - time_context="general" → そのまま記載（継続的な事実）\n\n'
```

- [ ] **Step 3: コミット**

```bash
git add gas/prompts.gs
git commit -m "feat(stage3a): add past-facility labeling rules to record prompt"
```

---

### Task 6: Stage3-B プロンプトの「1対1原則」改定と過去表記ルール追加

**Files:**
- Modify: `gas/prompts.gs:581-648` (`buildStage3BPromptHardcoded_` 関数)
- Modify: `gas/prompts.gs:559-578` (`getStage3BPrompt` 関数)

- [ ] **Step 1: `getStage3BPrompt` に `consentDate` テンプレート変数を追加**

`getStage3BPrompt()` の `getPromptFromFile_` 呼び出しに追加:

```javascript
        consentDate: userMaster.consentDate
          ? formatJapaneseDate(userMaster.consentDate) : '',
```

- [ ] **Step 2: `buildStage3BPromptHardcoded_` の「重要な原則」を改定**

既存 L592:
```javascript
    + '- 各項目の「特記事項」欄には、当該観点に関連する面談内容を**簡潔に要約**して記載します（項目に1対1で機械的に紐づけるより、職業生活全体の話題を要約してよい）\n'
```

↓ 差し替え:

```javascript
    + '- 各項目の「特記事項」欄には、monitoring_sheet_evidence の該当項目キーの evidence / note を第一根拠として、その項目に該当するエビデンスのみを簡潔に記載してください\n'
    + '- 複数項目に同じ文章をコピペしないでください。各項目は独立した内容にしてください\n'
    + '- evidence が空文字列の項目は note も空文字列 "" にしてください\n'
```

- [ ] **Step 3: 過去事業所の区別ルールを追加**

「面談中に言及がなかった項目の note は空文字列 "" にしてください」の後に追加:

```javascript
    + '- 【過去の事業所の情報の扱い】抽出JSONの time_context フィールドを確認し、以下のルールで記載してください：\n'
    + '  - time_context="current" → そのまま記載\n'
    + '  - time_context="past_facility" → 「（過去：○○事業所）」と明記\n'
    + '  - time_context="general" → そのまま記載\n\n'
```

- [ ] **Step 4: コミット**

```bash
git add gas/prompts.gs
git commit -m "feat(stage3b): replace copy-paste principle with per-item evidence rule, add past-facility labeling"
```

---

### Task 7: Drive プロンプトファイルの同期（設定済みの場合）

**Files:**
- 外部: Google Drive 上の Stage2 / Stage3-A / Stage3-B プロンプトファイル

- [ ] **Step 1: Drive プロンプトファイルの有無を確認**

GAS エディタまたはスクリプトプロパティで `PROMPT_FILE_ID_STAGE2`, `PROMPT_FILE_ID_STAGE3A`, `PROMPT_FILE_ID_STAGE3B` が設定されているか確認する。

- 設定されていない場合 → このタスクはスキップ（ハードコード版のみが使われる）
- 設定されている場合 → 各ファイルを開き、ハードコード版と同等の変更を手動で適用する:
  - Stage2: `{{consentDate}}` プレースホルダ追加、時系列判定ルール追加、スキーマの `time_context` / `facility_name` 追加
  - Stage3-A: 過去事業所の区別表記ルール追加、`{{consentDate}}` プレースホルダ追加
  - Stage3-B: 「1対1原則」改定、過去事業所ルール追加、`{{consentDate}}` プレースホルダ追加

- [ ] **Step 2: コミット（該当する場合）**

Drive ファイルの変更はコードリポジトリ外のため、変更内容をコミットメッセージに記録:

```bash
git commit --allow-empty -m "docs: note Drive prompt files updated to match hardcoded changes (time_context)"
```

---

### Task 8: E2E 動作確認

**Files:**
- 既存のテスト音声ファイル（メンバーAモニ.m4a）を使用

- [ ] **Step 1: `processSpecificFile` でパイプラインを実行**

GAS エディタから `processSpecificFile` を実行し、メンバーAモニの音声で全パイプラインを通す。

- [ ] **Step 2: Stage2 出力の確認**

生成された抽出 JSON ファイルを開き、以下を目視確認:
- 各項目に `time_context` フィールドが存在するか
- デジルミ・フロックスの話題が `"past_facility"` に分類されているか
- 偏頭痛・解離性障害など障害特性が `"general"` に分類されているか
- グローポイントでの活動（イラスト作業の感想等）が `"current"` に分類されているか

- [ ] **Step 3: Stage3 出力の確認**

生成された下書き docx を開き、以下を目視確認:
- 記録票: 過去事業所の情報に「（過去：○○事業所での経験）」が付いているか
- モニタリングシート: 各項目の特記事項が個別の内容になっているか（全行コピペでないか）
- モニタリングシート: 言及なしの項目が空欄になっているか

- [ ] **Step 4: 問題があれば修正し、再テスト**

- [ ] **Step 5: コミット（修正があった場合）**

```bash
git add -A
git commit -m "fix: adjust prompts based on E2E test results"
```
