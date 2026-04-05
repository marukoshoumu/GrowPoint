function getPromptFromFile_(fileId, variables) {
  const text = DriveApp.getFileById(fileId)
    .getBlob().getDataAsString('UTF-8');
  let prompt = text;
  for (const [key, value] of Object.entries(variables)) {
    prompt = prompt.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), value || '');
  }
  return prompt;
}


function getStage1Prompt(glossaryEntries) {
  const fileIds = getPromptFileIds();
  if (fileIds.stage1) {
    try {
      const glossaryText = buildGlossaryText_(glossaryEntries);
      return getPromptFromFile_(fileIds.stage1, {
        glossary: glossaryText
      });
    } catch (e) {
      logWarn('prompts', `Stage1プロンプトファイル読み込み失敗、ハードコード版を使用: ${e.message}`);
    }
  }
  return buildStage1PromptHardcoded_(glossaryEntries);
}


function buildGlossaryText_(glossaryEntries) {
  let glossaryText = '- 工賃（こうちん）→ 利用者への作業報酬\n'
    + '- サビ管 → サービス管理責任者\n'
    + '- B型 → 就労継続支援B型\n'
    + '- モニタリング → 支援計画の進捗確認面談\n'
    + '- 個別支援計画 → 利用者ごとの支援目標と方法を記載した計画書\n'
    + '- アセスメント → 利用者の状態・ニーズの評価\n'
    + '- 相談支援 → 相談支援事業所が作成するサービス等利用計画\n'
    + '- 就労移行 → 就労移行支援（一般就労を目指す訓練）\n'
    + '- A型 → 就労継続支援A型（雇用契約あり）\n'
    + '- グループホーム / GH → 共同生活援助';
  if (glossaryEntries && glossaryEntries.length > 0) {
    glossaryText += '\n' + glossaryEntries.map((e) => {
      return `- ${e.term}${e.reading ? `（${e.reading}）` : ''} → ${e.formal}`;
    }).join('\n');
  }
  return glossaryText;
}


function buildStage1PromptHardcoded_(glossaryEntries) {
  let glossaryText = '- 工賃（こうちん）→ 利用者への作業報酬\n'
    + '- サビ管 → サービス管理責任者\n'
    + '- B型 → 就労継続支援B型\n'
    + '- モニタリング → 支援計画の進捗確認面談\n'
    + '- 個別支援計画 → 利用者ごとの支援目標と方法を記載した計画書\n'
    + '- アセスメント → 利用者の状態・ニーズの評価\n'
    + '- 相談支援 → 相談支援事業所が作成するサービス等利用計画\n'
    + '- 就労移行 → 就労移行支援（一般就労を目指す訓練）\n'
    + '- A型 → 就労継続支援A型（雇用契約あり）\n'
    + '- グループホーム / GH → 共同生活援助';

  if (glossaryEntries && glossaryEntries.length > 0) {
    glossaryText += '\n' + glossaryEntries.map((e) => {
      return `- ${e.term}${e.reading ? `（${e.reading}）` : ''} → ${e.formal}`;
    }).join('\n');
  }

  return 'あなたは福祉施設の面談音声を文字起こしする専門家です。\n\n'
    + '【タスク】\n'
    + '添付の音声ファイルを全文文字起こししてください。\n\n'
    + '【音声の特徴】\n'
    + '- 就労継続支援B型事業所の個別面談（支援者と利用者の1対1）\n'
    + '- 東北方言（岩手弁）が混じる場合があります\n'
    + '  例：「〜だべ」→「〜でしょう」、「〜んだ」→「〜なんだ」、「〜さ行く」→「〜に行く」\n'
    + '  ※方言はそのまま記録し、標準語に変換しないでください\n'
    + '- 利用者は障害特性により発語が不明瞭な場合があります\n'
    + '- 面談時間は通常15〜30分です\n\n'
    + '【施設用語集】\n'
    + glossaryText + '\n\n'
    + '【出力ルール】\n'
    + '1. 話者を「支援者:」「利用者:」で区分する\n'
    + '2. 非言語情報を角括弧で記録する\n'
    + '   - [笑い] [沈黙:約○秒] [ため息] [声が小さくなる] [声が明るくなる]\n'
    + '   - [電話の音] [ドアの音] などの環境音も記録\n'
    + '3. 聞き取りに自信がない箇所は [低確信度: ○○？] と明記する\n'
    + '4. 発言は一語一句忠実に。要約・省略・補完は絶対にしない\n'
    + '5. 方言はそのまま記録する（標準語に変換しない）\n'
    + '6. 「えー」「あのー」などのフィラーも記録する\n'
    + '7. 言い直し・言い淀みもそのまま記録する\n\n'
    + '【出力フォーマット】\n'
    + 'プレーンテキストで、以下の形式で出力してください：\n\n'
    + '---\n'
    + '録音日時: [ファイル名から推定、不明なら「不明」]\n'
    + '推定録音時間: [○分○秒]\n'
    + '話者: 支援者 / 利用者\n'
    + '音声品質: [良好 / やや不明瞭 / 不明瞭]\n'
    + '低確信度箇所数: [○箇所]\n'
    + '---\n\n'
    + '支援者: （発言内容）\n'
    + '利用者: （発言内容）\n'
    + '...';
}


function getStage2Prompt(userMaster, glossaryEntries, previousIssues) {
  const fileIds = getPromptFileIds();
  if (fileIds.stage2) {
    try {
      let glossaryInjection = '';
      if (glossaryEntries && glossaryEntries.length > 0) {
        glossaryInjection = glossaryEntries.map((e) => {
          return `- ${e.term} → ${e.formal}`;
        }).join('\n');
      }
      return getPromptFromFile_(fileIds.stage2, {
        userName: userMaster.name,
        staffName: userMaster.staff,
        shortTermGoals: [userMaster.shortTermGoal1, userMaster.shortTermGoal2].filter(Boolean).join('、'),
        previousIssues: previousIssues || '初回モニタリングのため、前回の課題なし',
        glossary: glossaryInjection,
        jsonSchema: getStage2JsonSchema(),
        fewShotExample: getStage2FewShotExample()
      });
    } catch (e) {
      logWarn('prompts', `Stage2プロンプトファイル読み込み失敗、ハードコード版を使用: ${e.message}`);
    }
  }
  return buildStage2PromptHardcoded_(userMaster, glossaryEntries, previousIssues);
}


function buildStage2PromptHardcoded_(userMaster, glossaryEntries, previousIssues) {
  let glossaryInjection = '';
  if (glossaryEntries && glossaryEntries.length > 0) {
    glossaryInjection = glossaryEntries.map((e) => {
      return `- ${e.term} → ${e.formal}`;
    }).join('\n');
  }

  return 'あなたは就労継続支援B型事業所の支援記録を構造化するAIアシスタントです。\n\n'
    + '【タスク】\n'
    + '以下の面談文字起こし全文を読み、すべての重要情報を構造化JSONとして抽出してください。\n\n'
    + '【重要な原則】\n'
    + '- 要約ではなく「抽出」です。発言の原文をできるだけ保持してください\n'
    + '- 1つの発言が複数カテゴリに該当する場合は、すべてのカテゴリに登録してください\n'
    + '- 「対話パターン」（やり取り全体で意味が生まれるもの）も見落とさず抽出してください\n'
    + '- 発言がないカテゴリは空配列 [] としてください\n'
    + '- AIの推測・解釈は入れないでください。発言にないことは書かないでください\n\n'
    + '【利用者マスター情報】\n'
    + `- 利用者名: ${userMaster.name}\n`
    + `- 担当者名: ${userMaster.staff}\n`
    + `- 現在の短期目標: ${[userMaster.shortTermGoal1, userMaster.shortTermGoal2].filter(Boolean).join('、')}\n`
    + `- 前回モニタリングの主な課題: ${previousIssues || '初回モニタリングのため、前回の課題なし'}\n\n`
    + '【初回モニタリングの場合】\n'
    + '- previous_issues が空の場合は「初回モニタリング」として処理してください\n'
    + '- cross_reference_alerts の "goal_progress" は「初回のため比較基準なし」と記載してください\n'
    + '- 前回との比較は行わず、現在の状況のみを記録してください\n\n'
    + '【抽出カテゴリ（8カテゴリ）】\n\n'
    + 'カテゴリ1: 身体・健康状態\n'
    + '  → 体調、服薬、通院、睡眠、食事、体重変化、痛み、障害特性に関する変化\n\n'
    + 'カテゴリ2: 就労・作業状況\n'
    + '  → 作業内容、出席状況、工賃、スキルの変化、集中力、作業速度、作業態度\n\n'
    + 'カテゴリ3: 本人の希望・要望・感想\n'
    + '  → 自ら表明した希望、目標、不満、満足、達成感、改善要望\n'
    + '  ★サブ分類を付与してください：\n'
    + '    - "wish"（希望・目標）\n'
    + '    - "satisfaction"（満足・達成感）\n'
    + '    - "complaint"（不満・改善要望）\n'
    + '    - "impression"（感想・実感）\n\n'
    + 'カテゴリ4: 生活環境\n'
    + '  → 住居、経済状況、余暇活動、日常生活動作、買い物、金銭管理、移動手段\n\n'
    + 'カテゴリ5: 家族の意向・関係\n'
    + '  → 家族からの要望、家族関係の変化、家族との交流、家族の健康状態\n\n'
    + 'カテゴリ6: 支援者の観察・懸念\n'
    + '  → 支援者が述べた気づき、懸念、評価、助言、指導内容\n'
    + '  ★サブ分類を付与してください：\n'
    + '    - "observation"（観察・気づき）\n'
    + '    - "concern"（懸念・心配）\n'
    + '    - "advice"（助言・指導）\n'
    + '    - "assessment"（評価・判断）\n\n'
    + 'カテゴリ7: 合意・約束事\n'
    + '  → 次回までの取り決め、予定、宿題、確認事項、次回面談日\n\n'
    + 'カテゴリ8: 未分類の重要発言\n'
    + '  → 上記1〜7に当てはまらないが支援上重要と思われる発言\n'
    + '  → 迷った場合はここに入れてください（見落とすよりここに入れる方が安全）\n\n'
    + '【applicable_sections（様式マッピング）】\n'
    + '各抽出項目に、以下の様式セクションのうち該当するものをすべて付与してください。\n\n'
    + 'モニタリング記録票:\n'
    + '  - "monitoring_1_intention" = 1. 本人・家族の意向\n'
    + '  - "monitoring_4_status" = 4. 支援の実施状況\n'
    + '  - "monitoring_5_impression" = 5. 支援を受けた感想\n'
    + '  - "monitoring_6_future" = 6. 今後の支援方針\n'
    + '  - "monitoring_7_notes" = 7. 特記事項\n\n'
    + 'モニタリングシート（就労関係）:\n'
    + '  - "sheet_work_life" = 1. 職業生活\n'
    + '  - "sheet_relationship" = 2. 対人関係\n'
    + '  - "sheet_task" = 3. 作業\n'
    + '  - "sheet_overall" = 4. 総合所見\n\n'
    + '【出力JSONスキーマ】\n\n'
    + getStage2JsonSchema() + '\n\n'
    + '【出力例（参考）— 架空の面談からの抽出例】\n\n'
    + getStage2FewShotExample() + '\n\n'
    + '【最終チェック】\n'
    + '出力前に以下を自己確認してください：\n'
    + '1. 文字起こし全文を最初から最後まで読み返し、抽出漏れがないか？\n'
    + '2. [低確信度] マーカーがある箇所にはflagsに "低確信度" を付与したか？\n'
    + '3. 対話パターン（やり取り全体で意味が生まれるもの）を見落としていないか？\n'
    + '4. applicable_sections は適切に付与したか？\n'
    + '5. 推測・解釈を入れていないか？（発言にないことを書いていないか？）\n'
    + '6. cat8（未分類）に入れるべき発言を無理に他カテゴリに押し込んでいないか？\n'
    + '7. monitoring_sheet_evidence で、面談中に言及がなかった項目のevidenceは空文字列になっているか？\n\n'
    + '【JSON出力の厳密なルール】\n'
    + '- 出力はパース可能なJSONオブジェクト1個のみ。説明文・markdown・コードフェンスは付けない。\n'
    + '- 文字列値内のダブルクォートは \\" にエスケープする。改行は \\n。\n'
    + '- quote フィールドの発言原文は、可能なら「」『』で表記し、生の " を含めない（含む場合は必ず \\"）。\n'
    + '- 【重要・サイズ】各 quote は150文字以内（長い場合は要約）。各 summary は220文字以内。各カテゴリ配列は重要度順に最大15件まで（それ以上は省略）。出力が長すぎるとAPI上限で切れ不正JSONになります。\n\n'
    + '【面談文字起こし全文】\n\n';
}


function getStage2JsonSchema() {
  return '{\n'
    + '  "extraction_metadata": {\n'
    + '    "transcript_length": "（文字起こしの文字数）",\n'
    + '    "extraction_date": "YYYY-MM-DD",\n'
    + '    "low_confidence_count": "（低確信度マーカーの数）",\n'
    + '    "total_items_extracted": "（抽出項目の総数）"\n'
    + '  },\n'
    + '  "categories": {\n'
    + '    "cat1_health": [\n'
    + '      {\n'
    + '        "id": "c1-001",\n'
    + '        "quote": "（発言の原文または対話の引用）",\n'
    + '        "speaker": "利用者 or 支援者 or 対話",\n'
    + '        "summary": "（1文での要約。事実のみ、解釈不可）",\n'
    + '        "time_context": "current | past_facility | general",\n'
    + '        "facility_name": "（past_facility の場合のみ施設名。不明なら \\"不明\\"。それ以外は null）",\n'
    + '        "flags": ["要確認", "低確信度", "前回からの変化", "緊急性あり"],\n'
    + '        "applicable_sections": ["monitoring_4_status"],\n'
    + '        "dialogue_context": "（対話パターンの場合、やり取りの文脈を記載。単独発言の場合はnull）"\n'
    + '      }\n'
    + '    ],\n'
    + '    "cat2_work": [ "..." ],\n'
    + '    "cat3_wishes": [\n'
    + '      {\n'
    + '        "id": "c3-001",\n'
    + '        "quote": "...",\n'
    + '        "speaker": "...",\n'
    + '        "summary": "...",\n'
    + '        "sub_type": "wish | satisfaction | complaint | impression",\n'
    + '        "time_context": "current | past_facility | general",\n'
    + '        "facility_name": null,\n'
    + '        "flags": [],\n'
    + '        "applicable_sections": ["monitoring_1_intention", "monitoring_5_impression"],\n'
    + '        "dialogue_context": "..."\n'
    + '      }\n'
    + '    ],\n'
    + '    "cat4_living": [ "..." ],\n'
    + '    "cat5_family": [ "..." ],\n'
    + '    "cat6_staff": [\n'
    + '      {\n'
    + '        "id": "c6-001",\n'
    + '        "quote": "...",\n'
    + '        "speaker": "支援者",\n'
    + '        "summary": "...",\n'
    + '        "sub_type": "observation | concern | advice | assessment",\n'
    + '        "time_context": "current | past_facility | general",\n'
    + '        "facility_name": null,\n'
    + '        "flags": [],\n'
    + '        "applicable_sections": ["monitoring_4_status", "monitoring_6_future"],\n'
    + '        "dialogue_context": "..."\n'
    + '      }\n'
    + '    ],\n'
    + '    "cat7_agreements": [ "..." ],\n'
    + '    "cat8_uncategorized": [ "..." ]\n'
    + '  },\n'
    + '  "monitoring_sheet_evidence": {\n'
    + '    "work_life": {\n'
    + '      "attendance": { "evidence": "", "suggested_rating": null, "note": "" },\n'
    + '      "punctuality": { "evidence": "", "suggested_rating": null, "note": "" },\n'
    + '      "health_management": { "evidence": "", "suggested_rating": null, "note": "" },\n'
    + '      "appearance": { "evidence": "", "suggested_rating": null, "note": "" },\n'
    + '      "rule_compliance": { "evidence": "", "suggested_rating": null, "note": "" },\n'
    + '      "reporting": { "evidence": "", "suggested_rating": null, "note": "" },\n'
    + '      "workspace_tidiness": { "evidence": "", "suggested_rating": null, "note": "" },\n'
    + '      "work_attitude": { "evidence": "", "suggested_rating": null, "note": "" },\n'
    + '      "concentration": { "evidence": "", "suggested_rating": null, "note": "" },\n'
    + '      "persistence": { "evidence": "", "suggested_rating": null, "note": "" }\n'
    + '    },\n'
    + '    "relationships": {\n'
    + '      "greeting": { "evidence": "", "suggested_rating": null, "note": "" },\n'
    + '      "conversation": { "evidence": "", "suggested_rating": null, "note": "" },\n'
    + '      "understanding_hierarchy": { "evidence": "", "suggested_rating": null, "note": "" },\n'
    + '      "emotional_control": { "evidence": "", "suggested_rating": null, "note": "" },\n'
    + '      "stress_management": { "evidence": "", "suggested_rating": null, "note": "" }\n'
    + '    },\n'
    + '    "tasks": {\n'
    + '      "physical_stamina": { "evidence": "", "suggested_rating": null, "note": "" },\n'
    + '      "instruction_compliance": { "evidence": "", "suggested_rating": null, "note": "" },\n'
    + '      "quality": { "evidence": "", "suggested_rating": null, "note": "" },\n'
    + '      "speed": { "evidence": "", "suggested_rating": null, "note": "" },\n'
    + '      "safety_awareness": { "evidence": "", "suggested_rating": null, "note": "" }\n'
    + '    }\n'
    + '  },\n'
    + '  "cross_reference_alerts": [\n'
    + '    {\n'
    + '      "alert_type": "goal_progress | new_issue | contradiction | needs_follow_up",\n'
    + '      "description": "（短期目標との照合で気づいた点）",\n'
    + '      "related_items": ["c1-001", "c2-003"]\n'
    + '    }\n'
    + '  ]\n'
    + '}';
}


function getStage2FewShotExample() {
  return JSON.stringify({
    "extraction_metadata": {
      "transcript_length": "4523",
      "extraction_date": "2026-03-20",
      "low_confidence_count": "1",
      "total_items_extracted": "9"
    },
    "categories": {
      "cat1_health": [{
        "id": "c1-001",
        "quote": "薬変えてもらってから、だいぶ眠れるようになったっす",
        "speaker": "利用者",
        "summary": "服薬変更後、睡眠が改善",
        "flags": [],
        "applicable_sections": ["monitoring_4_status"],
        "dialogue_context": null
      }],
      "cat2_work": [{
        "id": "c2-001",
        "quote": "最近は箱折りも早くなってきたんだべ",
        "speaker": "利用者",
        "summary": "箱折り作業の速度向上を実感",
        "flags": [],
        "applicable_sections": ["monitoring_4_status", "monitoring_5_impression", "sheet_task"],
        "dialogue_context": null
      }],
      "cat3_wishes": [{
        "id": "c3-001",
        "quote": "週3日じゃなくて、週4日来たいなと思ってる",
        "speaker": "利用者",
        "summary": "通所日数を増やしたい希望",
        "sub_type": "wish",
        "flags": [],
        "applicable_sections": ["monitoring_1_intention", "monitoring_6_future"],
        "dialogue_context": null
      }, {
        "id": "c3-002",
        "quote": "最近は作業も楽しくなってきた",
        "speaker": "利用者",
        "summary": "作業への前向きな感想",
        "sub_type": "satisfaction",
        "flags": [],
        "applicable_sections": ["monitoring_5_impression"],
        "dialogue_context": null
      }],
      "cat4_living": [],
      "cat5_family": [],
      "cat6_staff": [{
        "id": "c6-001",
        "quote": "支援者:「お薬は飲めていますか？」→ 利用者:「うーん...まあ...」[沈黙:約3秒]",
        "speaker": "対話",
        "summary": "服薬状況について曖昧な回答。確認が必要",
        "sub_type": "concern",
        "flags": ["要確認"],
        "applicable_sections": ["monitoring_4_status", "monitoring_7_notes"],
        "dialogue_context": "体調確認中、服薬について問われた際の反応。明確な回答を避けている印象"
      }],
      "cat7_agreements": [{
        "id": "c7-001",
        "quote": "じゃあ来月から週4日で試してみましょうか",
        "speaker": "支援者",
        "summary": "来月から通所日数を週4日に試行することで合意",
        "flags": [],
        "applicable_sections": ["monitoring_6_future"],
        "dialogue_context": null
      }],
      "cat8_uncategorized": [{
        "id": "c8-001",
        "quote": "子どもの体育祭には絶対行きたい",
        "speaker": "利用者",
        "summary": "子どもの行事への参加希望。通所スケジュールへの配慮が必要",
        "flags": [],
        "applicable_sections": ["monitoring_7_notes"],
        "dialogue_context": "面談終了間際、来月の予定確認中にポロッと発言"
      }]
    },
    "monitoring_sheet_evidence": {
      "work_life": {
        "attendance": { "evidence": "「最近は休まず来れてる」との発言あり", "suggested_rating": null, "note": "" },
        "punctuality": { "evidence": "", "suggested_rating": null, "note": "" },
        "health_management": { "evidence": "服薬変更後の睡眠改善を報告。ただし服薬状況に曖昧な回答あり", "suggested_rating": null, "note": "要確認" },
        "appearance": { "evidence": "", "suggested_rating": null, "note": "" },
        "rule_compliance": { "evidence": "", "suggested_rating": null, "note": "" },
        "reporting": { "evidence": "", "suggested_rating": null, "note": "" },
        "workspace_tidiness": { "evidence": "", "suggested_rating": null, "note": "" },
        "work_attitude": { "evidence": "「作業も楽しくなってきた」との発言あり", "suggested_rating": null, "note": "" },
        "concentration": { "evidence": "「薬変えてから集中できるようになった」との発言あり", "suggested_rating": null, "note": "" },
        "persistence": { "evidence": "", "suggested_rating": null, "note": "" }
      },
      "relationships": {
        "greeting": { "evidence": "", "suggested_rating": null, "note": "" },
        "conversation": { "evidence": "", "suggested_rating": null, "note": "" },
        "understanding_hierarchy": { "evidence": "", "suggested_rating": null, "note": "" },
        "emotional_control": { "evidence": "", "suggested_rating": null, "note": "" },
        "stress_management": { "evidence": "", "suggested_rating": null, "note": "" }
      },
      "tasks": {
        "physical_stamina": { "evidence": "週4日への増加希望は体力面の自信を示唆", "suggested_rating": null, "note": "" },
        "instruction_compliance": { "evidence": "", "suggested_rating": null, "note": "" },
        "quality": { "evidence": "", "suggested_rating": null, "note": "" },
        "speed": { "evidence": "「箱折りも早くなってきた」との発言あり", "suggested_rating": null, "note": "" },
        "safety_awareness": { "evidence": "", "suggested_rating": null, "note": "" }
      }
    },
    "cross_reference_alerts": [{
      "alert_type": "goal_progress",
      "description": "短期目標「通所日数の安定」に対し、週4日への増加希望が出ている。目標達成の兆候",
      "related_items": ["c3-001", "c7-001"]
    }, {
      "alert_type": "needs_follow_up",
      "description": "服薬状況について曖昧な回答あり。次回面談で具体的に確認が必要",
      "related_items": ["c6-001"]
    }]
  }, null, 2);
}


function getStage3APrompt(userMaster, extractionJson) {
  const fileIds = getPromptFileIds();
  if (fileIds.stage3a) {
    try {
      return getPromptFromFile_(fileIds.stage3a, {
        userName: userMaster.name,
        staffName: userMaster.staff,
        serviceManager: userMaster.manager,
        date: formatJapaneseDate(userMaster.date) || '',
        previousMonitoringDate: userMaster.previousMonitoringDate
          ? formatJapaneseDate(userMaster.previousMonitoringDate) : '初回',
        nextMonitoringMonth: formatNextMonitoringMonthForTemplate(userMaster.nextMonitoringMonth) || '',
        longTermGoal: userMaster.longTermGoal,
        shortTermGoal1: userMaster.shortTermGoal1,
        supportContent1: userMaster.supportContent1,
        goal1Period: formatGoalPeriodForTemplate(userMaster.goal1Period),
        shortTermGoal2: userMaster.shortTermGoal2 || 'なし',
        supportContent2: userMaster.supportContent2 || 'なし',
        goal2Period: formatGoalPeriodForTemplate(userMaster.goal2Period || ''),
        attendees: userMaster.attendees || '',
        extractionJson: extractionJson
      });
    } catch (e) {
      logWarn('prompts', `Stage3Aプロンプトファイル読み込み失敗、ハードコード版を使用: ${e.message}`);
    }
  }
  return buildStage3APromptHardcoded_(userMaster, extractionJson);
}


function buildStage3APromptHardcoded_(userMaster, extractionJson) {
  const dateStr = formatJapaneseDate(userMaster.date) || '';
  const prevStr = userMaster.previousMonitoringDate
    ? formatJapaneseDate(userMaster.previousMonitoringDate) : '初回';
  const nextStr = formatNextMonitoringMonthForTemplate(userMaster.nextMonitoringMonth) || '';
  const goal1P = formatGoalPeriodForTemplate(userMaster.goal1Period);
  const goal2P = formatGoalPeriodForTemplate(userMaster.goal2Period || '');
  return 'あなたは就労継続支援B型事業所の支援記録を作成するAIアシスタントです。\n\n'
    + '【タスク】\n'
    + '構造化抽出JSONと利用者マスター情報をもとに、盛岡市様式の「モニタリング記録票」を作成してください。\n\n'
    + '【重要な原則】\n'
    + '- あなたは「下書きマシン」です。最終判断は担当者が行います\n'
    + '- 発言の原文を活かしつつ、記録として適切な文体に整えてください\n'
    + '- AIの推測・解釈は入れないでください\n'
    + '- 「計画見直しの要否」は記載しないでください（担当者判断事項）\n'
    + '- 情報がない項目は、該当する段落を省略するか、必要最小限の「該当なし」に留めてください。「面談中の言及なし」という定型文を繰り返さないでください\n\n'
    + '【利用者マスター情報】\n'
    + `- 利用者名: ${userMaster.name}\n`
    + `- 担当者名: ${userMaster.staff}\n`
    + `- サービス管理責任者: ${userMaster.manager}\n`
    + `- 実施年月日: ${dateStr}\n`
    + `- 前回モニタリング実施日: ${prevStr}\n`
    + `- 次回モニタリング予定月: ${nextStr}\n`
    + `- 長期目標: ${userMaster.longTermGoal}\n`
    + `- 短期目標①: ${userMaster.shortTermGoal1}\n`
    + `- 短期目標①の具体的支援内容: ${userMaster.supportContent1}\n`
    + `- 短期目標①の期間: ${goal1P}\n`
    + `- 短期目標②: ${userMaster.shortTermGoal2 || 'なし'}\n`
    + `- 短期目標②の具体的支援内容: ${userMaster.supportContent2 || 'なし'}\n`
    + `- 短期目標②の期間: ${goal2P}\n`
    + `- 出席者: ${userMaster.attendees || ''}\n\n`
    + '【構造化抽出JSON】\n'
    + extractionJson + '\n\n'
    + '【出力フォーマット — モニタリング記録票】\n\n'
    + '以下のセクションごとに記載してください。\n'
    + 'JSONの applicable_sections を参照し、該当する抽出項目を適切なセクションに配置してください。\n'
    + '（セクションの区切りは ## 見出しのみ。行が `---` だけの区切り線は出力しない。指示文にあった `---` は書式例であり、最終出力に含めない。）\n\n'
    + '---\n\n'
    + '## 1. 本人・家族の意向\n\n'
    + 'データソース: cat3_wishes (sub_type: "wish") + cat5_family\n'
    + 'applicable_sections: "monitoring_1_intention"\n\n'
    + '【本人の意向】\n'
    + '（cat3_wishesのうち sub_type="wish" の項目を、利用者の言葉を活かして記載）\n\n'
    + '【家族の意向】\n'
    + '（cat5_family の項目を記載。言及がなければ本項の本文は省略してよい）\n\n'
    + '---\n\n'
    + '## 2. 長期目標\n\n'
    + userMaster.longTermGoal + '\n\n'
    + '---\n\n'
    + '## 3. 短期目標及び具体的支援内容\n\n'
    + `①短期目標: ${userMaster.shortTermGoal1}\n`
    + `　具体的支援内容: ${userMaster.supportContent1}\n`
    + `　期間: ${goal1P}\n\n`
    + `②短期目標: ${userMaster.shortTermGoal2 || 'なし'}\n`
    + `　具体的支援内容: ${userMaster.supportContent2 || 'なし'}\n`
    + `　期間: ${goal2P}\n\n`
    + '---\n\n'
    + '## 4.1 短期目標①に対する支援の実施状況\n\n'
    + 'データソース: cat1_health + cat2_work + cat4_living + cat6_staff (sub_type: "observation")\n'
    + 'applicable_sections: "monitoring_4_status"（短期目標①に紐づく抽出のみ）\n\n'
    + `対象の短期目標①: ${userMaster.shortTermGoal1}\n`
    + '（この目標・支援内容に対して、面談で示された支援の実施状況を記載。具体的な発言を引用しつつ描写）\n\n'
    + '---\n\n'
    + '## 4.2 短期目標②に対する支援の実施状況\n\n'
    + 'データソース: 同上（短期目標②に紐づく抽出）\n'
    + 'applicable_sections: "monitoring_4_status"（短期目標②に紐づく抽出のみ）\n\n'
    + `対象の短期目標②: ${userMaster.shortTermGoal2 || '（未設定）'}\n`
    + '（短期目標②が未設定・空の場合は「該当なし」と明記し、本文は空欄相当の一文に留める）\n'
    + '（設定がある場合は、①と同様に記載）\n\n'
    + '【その他の状況（身体面・生活面）】\n'
    + '（いずれの短期目標にも直接紐づかないが記録すべき情報があれば、4.1 または 4.2 の末尾に追記してよい）\n\n'
    + '---\n\n'
    + '## 5. 支援を受けた感想（本人の満足度，達成度，今後の希望等）\n\n'
    + 'データソース: cat3_wishes (sub_type: "satisfaction" | "impression" | "complaint")\n'
    + 'applicable_sections: "monitoring_5_impression"\n\n'
    + '（利用者自身の言葉を活かして、満足度・達成感・今後の希望を記載）\n'
    + '（不満や改善要望があればそれも正確に記載する）\n\n'
    + '---\n\n'
    + '## 6. 今後の支援方針（短期目標の「終了」「継続」「内容変更」等）\n\n'
    + 'データソース: cat7_agreements + cat6_staff (sub_type: "advice" | "concern")\n'
    + 'applicable_sections: "monitoring_6_future"\n\n'
    + '【合意事項・次回までの取り決め】\n'
    + '（cat7_agreements の内容を具体的に記載）\n\n'
    + '【支援者の所見】\n'
    + '（cat6_staff の観察・懸念を記載）\n\n'
    + '【短期目標の方向性】→ [担当者判断] ※AIは記載しない\n\n'
    + '---\n\n'
    + '## 7. 特記事項\n\n'
    + 'データソース: cat8_uncategorized + flags に "要確認" がある項目 + flags に "緊急性あり" がある項目\n'
    + 'applicable_sections: "monitoring_7_notes"\n\n'
    + '（未分類の重要発言、フラグ付き項目、低確信度の情報をここに集約）\n\n'
    + '---\n\n'
    + '文書末尾に以下の注記を必ず付与：\n'
    + '「本記録はAI支援による下書きです。担当者による確認・修正を経て確定してください。」\n\n'
    + '【文体ルール】\n'
    + '- 「です・ます」調ではなく「である」調で記載\n'
    + '- 利用者の発言を引用する場合は「〜と話された」「〜との発言あり」の形式\n'
    + '- 支援者の観察は「〜が観察された」「〜と思われる」の形式\n'
    + '- 具体的なエピソード・数値があれば積極的に記載\n'
    + '- 曖昧な表現（「概ね良好」等）は避け、具体的な事実を記載';
}


function getStage3BPrompt(userMaster, extractionJson) {
  const fileIds = getPromptFileIds();
  if (fileIds.stage3b) {
    try {
      return getPromptFromFile_(fileIds.stage3b, {
        userName: userMaster.name,
        date: formatJapaneseDate(userMaster.date) || '',
        staffName: userMaster.staff,
        serviceManager: userMaster.manager,
        previousMonitoringDate: userMaster.previousMonitoringDate
          ? formatJapaneseDate(userMaster.previousMonitoringDate) : '初回',
        nextMonitoringMonth: formatNextMonitoringMonthForTemplate(userMaster.nextMonitoringMonth) || '',
        extractionJson: extractionJson
      });
    } catch (e) {
      logWarn('prompts', `Stage3Bプロンプトファイル読み込み失敗、ハードコード版を使用: ${e.message}`);
    }
  }
  return buildStage3BPromptHardcoded_(userMaster, extractionJson);
}


function buildStage3BPromptHardcoded_(userMaster, extractionJson) {
  const dateStr = formatJapaneseDate(userMaster.date) || '';
  const prevStr = userMaster.previousMonitoringDate
    ? formatJapaneseDate(userMaster.previousMonitoringDate) : '初回';
  const nextStr = formatNextMonitoringMonthForTemplate(userMaster.nextMonitoringMonth) || '';
  return 'あなたは就労継続支援B型事業所のモニタリングシート（就労関係）の下書きを作成するAIアシスタントです。\n\n'
    + '【タスク】\n'
    + '構造化抽出JSONの monitoring_sheet_evidence セクションをもとに、\n'
    + '盛岡市様式のモニタリングシート（就労関係）の「特記事項」と「総合所見」を作成してください。\n\n'
    + '【重要な原則】\n'
    + '- 3段階評価（1=もう少し / 2=合格 / 3=すぐれている）はAIは付与しません\n'
    + '- 各項目の「特記事項」欄には、当該観点に関連する面談内容を**簡潔に要約**して記載します（項目に1対1で機械的に紐づけるより、職業生活全体の話題を要約してよい）\n'
    + '- 根拠となる事実・発言は残しつつ、担当者が評価を付けられる程度の長さにまとめる\n'
    + '- 面談中に言及がなかった項目の note は空文字列 "" にしてください。「面談中の言及なし」という文字列は入れないでください\n\n'
    + '【整合性ルール】\n'
    + '本シートは、同日に生成されるモニタリング記録票と同じ面談データに基づいています。\n'
    + '記録票の「4.1」「4.2」（支援の実施状況）に記載した事実と矛盾する特記事項を書かないでください。\n'
    + '同じ発言を参照する場合は、表現の整合性を保ってください。\n\n'
    + '【利用者マスター情報】\n'
    + `- 利用者名: ${userMaster.name}\n`
    + `- 実施年月日: ${dateStr}\n`
    + `- 作成者: ${userMaster.staff}\n`
    + `- サービス管理責任者: ${userMaster.manager}\n`
    + `- 前回モニタリング実施日: ${prevStr}\n`
    + `- 次回モニタリング予定月: ${nextStr}\n\n`
    + '【構造化抽出JSON】\n'
    + extractionJson + '\n\n'
    + '【出力フォーマット】\n\n'
    + '以下のJSON形式で出力してください。テンプレートへの差し込みに使用します。\n\n'
    + '```json\n'
    + '{\n'
    + '  "work_life": [\n'
    + '    { "item": "遅刻，早退，欠勤しない", "note": "（特記事項）" },\n'
    + '    { "item": "作業開始（終了）時間を守る", "note": "..." },\n'
    + '    { "item": "健康に気を付けた生活をしている", "note": "..." },\n'
    + '    { "item": "職場に適した身だしなみ", "note": "..." },\n'
    + '    { "item": "職場の規則を守る", "note": "..." },\n'
    + '    { "item": "相談・報告・連絡ができる", "note": "..." },\n'
    + '    { "item": "職場を散らかさない", "note": "..." },\n'
    + '    { "item": "作業に積極的に取り組む", "note": "..." },\n'
    + '    { "item": "作業に集中して取り組む", "note": "..." },\n'
    + '    { "item": "作業に最後まで取り組む", "note": "..." }\n'
    + '  ],\n'
    + '  "relationships": [\n'
    + '    { "item": "挨拶ができる", "note": "..." },\n'
    + '    { "item": "同僚と会話ができる", "note": "..." },\n'
    + '    { "item": "上司を理解している", "note": "..." },\n'
    + '    { "item": "感情的になる", "note": "..." },\n'
    + '    { "item": "ストレスをためている", "note": "..." }\n'
    + '  ],\n'
    + '  "tasks": [\n'
    + '    { "item": "作業時間内の体力がある", "note": "..." },\n'
    + '    { "item": "指示を理解し守れる", "note": "..." },\n'
    + '    { "item": "適正な作業の完成度", "note": "..." },\n'
    + '    { "item": "適正な作業スピード", "note": "..." },\n'
    + '    { "item": "道具を安全に使える", "note": "..." }\n'
    + '  ],\n'
    + '  "overall_assessment": "（総合所見テキスト）"\n'
    + '}\n'
    + '```\n\n'
    + '【総合所見の書き方】\n'
    + 'データソース: cat6_staff (sub_type: "assessment" | "observation") + cross_reference_alerts\n\n'
    + '支援者の総合的な見解を、抽出データをもとに記載。\n'
    + '前回モニタリングからの変化があれば明記。\n'
    + '短期目標に対する進捗の概況を含める。\n\n'
    + '文書末尾に以下の注記を必ず付与：\n'
    + '「本シートの特記事項はAI支援による下書きです。評価（1/2/3）は担当者が判断・記入してください。」';
}


function getRetryPrompt(originalPrompt, errorMessage, previousOutput) {
  let sample = '（出力なし）';
  if (previousOutput) {
    if (previousOutput.length <= 4000) {
      sample = previousOutput;
    } else {
      sample = previousOutput.substring(0, 2000)
        + '\n\n... (中略) ...\n\n'
        + previousOutput.substring(previousOutput.length - 2000);
    }
  }

  return '前回の出力でエラーが発生しました。以下の点を修正して再度出力してください。\n\n'
    + '【エラー内容】\n'
    + errorMessage + '\n\n'
    + '【前回の出力（先頭・末尾。JSONパース失敗時は短く再出力すること）】\n'
    + sample + '\n\n'
    + '【リトライ時の追加ルール】\n'
    + '- 必ず有効なJSON1個のみ（application/json 想定）。\n'
    + '- Unterminated string / パース失敗が続く場合: quote を各100文字以内に短縮、各カテゴリは最大10件、monitoring_sheet_evidence の長文は要約。\n'
    + '- マークダウンのコードフェンスは付けないでください。\n\n'
    + '--- 以下、元のタスク ---\n\n'
    + originalPrompt;
}


