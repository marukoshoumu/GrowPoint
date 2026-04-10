// =====================================================
// Stage 3: 統合ドキュメント生成
// keikakumonita 形式（個別支援計画 + 記録票 + シート就労）を
// 1つの Google Docs テンプレートに差し込む
// =====================================================


// --- Stage 3-A: モニタリング記録票テキスト生成 ---

function runStage3A(extractionData, userMaster) {
  logInfo('Stage3A', 'モニタリング記録票生成開始');

  try {
    const extractionJson = JSON.stringify(extractionData, null, 2);
    const prompt = getStage3APrompt(userMaster, extractionJson);

    const recordText = callGeminiWithRetry(prompt, {
      temperature: 0.2,
      maxTokens: 8192
    });

    logInfo('Stage3A', `記録票テキスト生成完了: ${recordText.length}文字`);
    return {
      success: true,
      data: {
        text: recordText
      }
    };
  } catch (e) {
    logError('Stage3A', `記録票生成失敗: ${e.message}`);
    return {
      success: false,
      error: e.message
    };
  }
}


function parseRecordSections_(text) {
  const sections = {
    intention: '',
    status_1: '',
    status_2: '',
    impression: '',
    future: '',
    notes: ''
  };

  // セクション2（長期目標）と3（短期目標）はマスターデータから直接差し込むため、
  // AI出力からパースするのは 1, 4.1/4.2, 5, 6, 7 のみ。
  // 4 は短期目標①②ごとに分割（Stage 3-A が ## 4.1 / ## 4.2 見出しで出力）。
  const sectionPatterns = [
    { key: 'intention',   pattern: /##\s*1[.．]\s*本人・家族の意向([\s\S]*?)(?=##\s*2[.．]|$)/  },
    { key: 'status_1',    pattern: /##\s*4\.1[^\n]*\n([\s\S]*?)(?=##\s*4\.2|##\s*5[.．]|$)/       },
    { key: 'status_2',    pattern: /##\s*4\.2[^\n]*\n([\s\S]*?)(?=##\s*5[.．]|$)/                 },
    { key: 'impression',  pattern: /##\s*5[.．]\s*支援を受けた感想([\s\S]*?)(?=##\s*6[.．]|$)/   },
    { key: 'future',      pattern: /##\s*6[.．]\s*今後の支援方針([\s\S]*?)(?=##\s*7[.．]|$)/     },
    { key: 'notes',       pattern: /##\s*7[.．]\s*特記事項([\s\S]*?)(?=---|$)/                   }
  ];

  for (let i = 0; i < sectionPatterns.length; i++) {
    const match = text.match(sectionPatterns[i].pattern);
    if (match) {
      let content = match[1].trim();
      content = content.replace(/^データソース:.*$/gm, '');
      content = content.replace(/^applicable_sections:.*$/gm, '');
      sections[sectionPatterns[i].key] = cleanRecordSectionText_(content);
    }
  }

  // 後方互換: 旧プロンプトが ## 4. 支援の実施状況（単一ブロック）のみの場合 → 4.1 に丸ごと入れる
  if (!sections.status_1 && !sections.status_2) {
    const legacy = text.match(/##\s*4[.．]\s*支援の実施状況([\s\S]*?)(?=##\s*5[.．]|$)/);
    if (legacy) {
      let content = legacy[1].trim();
      content = content.replace(/^データソース:.*$/gm, '');
      content = content.replace(/^applicable_sections:.*$/gm, '');
      sections.status_1 = cleanRecordSectionText_(content);
    }
  }

  return sections;
}

/** Stage3A がマークダウン風に出力した --- 行を除去 */
function cleanRecordSectionText_(text) {
  if (!text) return '';
  let s = text.trim();
  s = s.replace(/^\s*---\s*$/gm, '');
  s = stripNoMentionPlaceholderLines_(s);
  s = s.replace(/\n{3,}/g, '\n\n');
  return s.trim();
}

/** 旧プロンプト由来の「面談中の言及なし」単独行を除去（下書きのノイズ防止） */
function stripNoMentionPlaceholderLines_(text) {
  if (!text) return '';
  const lines = text.split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === '面談中の言及なし') continue;
    out.push(lines[i]);
  }
  return out.join('\n');
}


// --- Stage 3-B: モニタリングシート生成 ---
// per-item notes は Stage2 の monitoring_sheet_evidence から GAS で直接組立。
// LLM は overall_assessment（総合所見）のみ生成する。

function runStage3B(extractionData, userMaster) {
  logInfo('Stage3B', 'モニタリングシート生成開始');

  try {
    // 1. per-item notes を evidence から直接構築（LLM不使用）
    const sheetData = buildSheetNotesFromEvidence_(extractionData);
    logInfo('Stage3B', 'エビデンスから特記事項を構築完了');

    // 2. overall_assessment のみ LLM で生成
    const extractionJson = JSON.stringify(extractionData, null, 2);
    const prompt = getStage3BOverallAssessmentPrompt(userMaster, extractionJson);

    let lastError = null;
    let lastOutput = null;

    for (let attempt = 0; attempt <= CONFIG.MAX_RETRIES; attempt++) {
      try {
        const currentPrompt = attempt === 0
          ? prompt
          : getRetryPrompt(prompt, lastError, lastOutput);

        const response = callGeminiWithRetry(currentPrompt, {
          temperature: 0.2,
          maxTokens: 2048
        }, 0);

        lastOutput = response;
        const assessment = response.trim();

        if (assessment.length > 10) {
          sheetData.overall_assessment = assessment;
          logInfo('Stage3B', `総合所見生成完了（試行 ${attempt + 1}回目）`);
          return {
            success: true,
            data: {
              parsed: sheetData,
              attempts: attempt + 1
            }
          };
        }

        lastError = '総合所見が短すぎます';
        logWarn('Stage3B', `総合所見が短すぎ（試行 ${attempt + 1}）: ${assessment.length}文字`);

      } catch (e) {
        lastError = e.message;
        lastOutput = null;
        logWarn('Stage3B', `総合所見生成エラー（試行 ${attempt + 1}）: ${e.message}`);
      }

      if (attempt < CONFIG.MAX_RETRIES) {
        Utilities.sleep(3000);
      }
    }

    // overall_assessment の生成に失敗しても、per-item notes は返す
    logWarn('Stage3B', '総合所見生成失敗（リトライ上限）。特記事項のみで続行', { lastError: lastError });
    sheetData.overall_assessment = '（総合所見の自動生成に失敗しました。担当者が記入してください。）';
    return {
      success: true,
      data: {
        parsed: sheetData,
        attempts: CONFIG.MAX_RETRIES + 1
      }
    };
  } catch (e) {
    logError('Stage3B', `モニタリングシート生成で予期しないエラー: ${e.message}`);
    return {
      success: false,
      error: e.message
    };
  }
}


/**
 * Stage2 の monitoring_sheet_evidence から、テンプレート差し込み用の sheetData を直接構築。
 * LLM を経由しないため、項目間のコピペが原理的に発生しない。
 */
function buildSheetNotesFromEvidence_(extractionData) {
  const mse = extractionData.monitoring_sheet_evidence || {};

  const workLifeMap = [
    ['attendance', '遅刻，早退，欠勤しない'],
    ['punctuality', '作業開始（終了）時間を守る'],
    ['health_management', '健康に気を付けた生活をしている'],
    ['appearance', '職場に適した身だしなみ'],
    ['rule_compliance', '職場の規則を守る'],
    ['reporting', '相談・報告・連絡ができる'],
    ['workspace_tidiness', '職場を散らかさない'],
    ['work_attitude', '作業に積極的に取り組む'],
    ['concentration', '作業に集中して取り組む'],
    ['persistence', '作業に最後まで取り組む']
  ];
  const relMap = [
    ['greeting', '挨拶ができる'],
    ['conversation', '同僚と会話ができる'],
    ['understanding_hierarchy', '上司を理解している'],
    ['emotional_control', '感情的になる'],
    ['stress_management', 'ストレスをためている']
  ];
  const taskMap = [
    ['physical_stamina', '作業時間内の体力がある'],
    ['instruction_compliance', '指示を理解し守れる'],
    ['quality', '適正な作業の完成度'],
    ['speed', '適正な作業スピード'],
    ['safety_awareness', '道具を安全に使える']
  ];

  function buildItems(sectionData, mapping) {
    const items = [];
    for (let i = 0; i < mapping.length; i++) {
      const key = mapping[i][0];
      const label = mapping[i][1];
      const entry = sectionData && sectionData[key] ? sectionData[key] : {};
      const evidence = (entry.evidence || '').trim();
      items.push({
        item: label,
        note: evidence
      });
    }
    return items;
  }

  return {
    work_life: buildItems(mse.work_life, workLifeMap),
    relationships: buildItems(mse.relationships, relMap),
    tasks: buildItems(mse.tasks, taskMap),
    overall_assessment: ''
  };
}


// --- 統合ドキュメント差し込み ---

/**
 * @param {string} [chunkLabel] 例: 01/02（同一利用者・面談日で複数パートのときファイル名衝突を防ぐ）
 */
function fillMonitoringDocument(userMaster, recordText, sheetData, chunkLabel) {
  const templateIds = getTemplateIds();
  const folderIds = getFolderIds();

  if (!templateIds.monitoringDocument) {
    logWarn('Stage3', 'テンプレートID未設定。プレーンテキストで保存します');
    return saveDocumentAsPlainText_(userMaster, recordText, sheetData, chunkLabel);
  }

  const replacements = buildAllReplacements_(userMaster, recordText, sheetData);

  const fileName = buildMonitoringDraftBaseFileName_(userMaster, chunkLabel);

  try {
    const docId = fillTemplate(
      templateIds.monitoringDocument,
      replacements,
      folderIds.draft,
      fileName
    );
    logInfo('Stage3', `テンプレート差し込み完了: ${docId}`);
    return { docId: docId, url: getDocUrl(docId) };
  } catch (e) {
    logError('Stage3', `テンプレート差し込み失敗: ${e.message}`);
    return saveDocumentAsPlainText_(userMaster, recordText, sheetData, chunkLabel);
  }
}

/** ドラフトのベースファイル名（拡張子なし）。チャンクがあると `…（下書き）_01-02` のようにサフィックスを付与 */
function buildMonitoringDraftBaseFileName_(userMaster, chunkLabel) {
  let base = `${formatJapaneseDate(userMaster.date)}_${userMaster.name}_計画モニタ（下書き）`;
  const chunk = normalizeChunkLabel_(chunkLabel);
  if (chunk) {
    base += '_' + chunk.replace(/\//g, '-');
  }
  return base;
}


function buildAllReplacements_(userMaster, recordText, sheetData) {
  const r = {};

  // --- 共通ヘッダー（3帳票で共有）---
  r['user_name'] = userMaster.name;
  r['staff_name'] = userMaster.staff;
  r['date'] = formatJapaneseDate(userMaster.date);
  r['previous_monitoring_date'] = userMaster.previousMonitoringDate
    ? formatJapaneseDate(userMaster.previousMonitoringDate) : '初回';
  r['next_monitoring_month'] = formatNextMonitoringMonthForTemplate(userMaster.nextMonitoringMonth);
  r['attendees'] = userMaster.attendees || '';

  // --- 個別支援計画セクション（全てマスターデータ）---
  r['service_type'] = userMaster.serviceType || '就労継続支援B型';
  r['creation_date'] = userMaster.creationDate
    ? formatJapaneseDate(userMaster.creationDate) : '';
  r['consent_date'] = userMaster.consentDate
    ? formatJapaneseDate(userMaster.consentDate) : '';
  r['plan_section_1_needs'] = userMaster.planNeeds || '';
  r['long_term_goal'] = userMaster.longTermGoal;
  r['short_term_goal_1'] = userMaster.shortTermGoal1;
  r['support_content_1'] = userMaster.supportContent1;
  r['goal_1_period'] = formatGoalPeriodForTemplate(userMaster.goal1Period);
  r['short_term_goal_2'] = userMaster.shortTermGoal2 || '';
  r['support_content_2'] = userMaster.supportContent2 || '';
  r['goal_2_period'] = formatGoalPeriodForTemplate(userMaster.goal2Period || '');
  r['plan_section_4_notes'] = userMaster.planNotes || '';

  // --- モニタリング記録票セクション（AI生成 Stage 3-A）---
  if (recordText) {
    const sections = parseRecordSections_(recordText);
    r['section_1_intention'] = sections.intention || '';
    r['section_4_status_1'] = sections.status_1 || '';
    r['section_4_status_2'] = sections.status_2 || '';
    r['section_5_impression'] = sections.impression || '';
    r['section_6_future'] = sections.future || '';
    r['section_7_notes'] = sections.notes || '';
  } else {
    r['section_1_intention'] = '';
    r['section_4_status_1'] = '';
    r['section_4_status_2'] = '';
    r['section_5_impression'] = '';
    r['section_6_future'] = '';
    r['section_7_notes'] = '';
  }

  // --- モニタリングシート（AI生成 Stage 3-B）---
  // 特記事項: 空欄のまま（長文で表項目とずれるのを防ぐ）。1セルにまとめたい場合は {{sheet_notes_combined}}。
  // 評価（1/2/3）: GAS では置換しない。テンプレ側で「1　2　3」を固定記載する。
  if (sheetData) {
    for (let i = 0; i < sheetData.work_life.length; i++) {
      r[`wl_note_${i + 1}`] = trimNoteOrEmpty_(sheetData.work_life[i].note);
    }
    for (let j = 0; j < sheetData.relationships.length; j++) {
      r[`rel_note_${j + 1}`] = trimNoteOrEmpty_(sheetData.relationships[j].note);
    }
    for (let k = 0; k < sheetData.tasks.length; k++) {
      r[`task_note_${k + 1}`] = trimNoteOrEmpty_(sheetData.tasks[k].note);
    }
    r['overall_assessment'] = stripNoMentionPlaceholderLines_(String(sheetData.overall_assessment || '').trim());
    r['sheet_notes_combined'] = buildCombinedSheetNotes_(sheetData);
  } else {
    for (let i = 1; i <= 10; i++) r[`wl_note_${i}`] = '';
    for (let j = 1; j <= 5; j++) r[`rel_note_${j}`] = '';
    for (let k = 1; k <= 5; k++) r[`task_note_${k}`] = '';
    r['overall_assessment'] = '';
    r['sheet_notes_combined'] = '';
  }

  // --- フッター ---
  r['ai_disclaimer'] = '本書類はAI支援による下書きです。担当者による確認・修正を経て確定してください。';

  return r;
}

function trimNoteOrEmpty_(note) {
  if (note === undefined || note === null) return '';
  const s = String(note).trim();
  if (s === '面談中の言及なし') return '';
  return s;
}

/**
 * モニタリングシートの特記事項のみを、空欄項目を除き改行で連結（1セル用 {{sheet_notes_combined}}）。
 */
function buildCombinedSheetNotes_(sheetData) {
  if (!sheetData) return '';
  const parts = [];

  function appendSection(title, items) {
    if (!items || !items.length) return;
    const blocks = [];
    for (let i = 0; i < items.length; i++) {
      const note = trimNoteOrEmpty_(items[i].note);
      if (!note) continue;
      const itemLabel = items[i].item ? String(items[i].item) : '';
      blocks.push((itemLabel ? itemLabel + '\n' : '') + note);
    }
    if (blocks.length) {
      parts.push('【' + title + '】\n\n' + blocks.join('\n\n'));
    }
  }

  appendSection('職業生活', sheetData.work_life);
  appendSection('対人関係', sheetData.relationships);
  appendSection('作業', sheetData.tasks);

  return parts.join('\n\n');
}


// --- フォールバック: プレーンテキスト保存 ---

function saveDocumentAsPlainText_(userMaster, recordText, sheetData, chunkLabel) {
  const folderIds = getFolderIds();
  const text = buildDocumentPlainText_(userMaster, recordText, sheetData);
  const fileName = buildMonitoringDraftBaseFileName_(userMaster, chunkLabel) + '.txt';
  const file = saveTextToFile(folderIds.draft, fileName, text);
  logInfo('Stage3', `プレーンテキストで保存: ${fileName}`);
  return { docId: file.getId(), url: getFileUrl(file.getId()) };
}


function buildDocumentPlainText_(userMaster, recordText, sheetData) {
  const lines = [];

  lines.push('======================================');
  lines.push('個別支援計画');
  lines.push('======================================');
  lines.push(`利用者名: ${userMaster.name}`);
  lines.push(`担当者: ${userMaster.staff}`);
  lines.push(`長期目標: ${userMaster.longTermGoal}`);
  lines.push(`短期目標①: ${userMaster.shortTermGoal1}`);
  lines.push('');

  lines.push('======================================');
  lines.push('モニタリング記録票');
  lines.push('======================================');
  lines.push(`実施年月日: ${formatJapaneseDate(userMaster.date)}`);
  if (recordText) {
    lines.push(recordText);
  } else {
    lines.push('（Stage 3-A 失敗のため未生成）');
  }
  lines.push('');

  lines.push('======================================');
  lines.push('モニタリングシート（就労関係）');
  lines.push('======================================');
  if (sheetData) {
    lines.push('=== 1. 職業生活 ===');
    for (let i = 0; i < sheetData.work_life.length; i++) {
      lines.push(`${i + 1}. ${sheetData.work_life[i].item}: [評価: 担当者記入] ${trimNoteOrEmpty_(sheetData.work_life[i].note)}`);
    }
    lines.push('');
    lines.push('=== 2. 対人関係 ===');
    for (let j = 0; j < sheetData.relationships.length; j++) {
      lines.push(`${j + 1}. ${sheetData.relationships[j].item}: [評価: 担当者記入] ${trimNoteOrEmpty_(sheetData.relationships[j].note)}`);
    }
    lines.push('');
    lines.push('=== 3. 作業 ===');
    for (let k = 0; k < sheetData.tasks.length; k++) {
      lines.push(`${k + 1}. ${sheetData.tasks[k].item}: [評価: 担当者記入] ${trimNoteOrEmpty_(sheetData.tasks[k].note)}`);
    }
    lines.push('');
    lines.push('=== 4. 総合所見 ===');
    lines.push(stripNoMentionPlaceholderLines_(String(sheetData.overall_assessment || '').trim()));
  } else {
    lines.push('（Stage 3-B 失敗のため未生成）');
  }

  lines.push('');
  lines.push('※ 本書類はAI支援による下書きです。担当者による確認・修正を経て確定してください。');

  return lines.join('\n');
}
