function runStage2(transcript, userMaster) {
  logInfo('Stage2', '構造化抽出開始');

  const glossary = loadGlossary();
  const previousIssues = userMaster.previousIssues || '';
  const prompt = getStage2Prompt(userMaster, glossary, previousIssues);
  const fullPrompt = prompt + transcript;

  let lastError = null;
  let lastOutput = null;

  for (let attempt = 0; attempt <= CONFIG.MAX_RETRIES; attempt++) {
    try {
      const currentPrompt = attempt === 0
        ? fullPrompt
        : getRetryPrompt(fullPrompt, lastError, lastOutput);

      const response = callGeminiWithRetry(currentPrompt, {
        temperature: 0.1,
        maxTokens: 16384
      }, 0);

      lastOutput = response;
      const parsed = parseJsonResponse(response);
      const validation = validateStage2Output(parsed);

      if (validation.valid) {
        logInfo('Stage2', `構造化抽出完了（試行 ${attempt + 1}回目）`, {
          totalItems: parsed.extraction_metadata.total_items_extracted
        });
        return {
          success: true,
          data: parsed,
          rawJson: JSON.stringify(parsed, null, 2),
          attempts: attempt + 1
        };
      }

      lastError = validation.error;
      logWarn('Stage2', `バリデーション失敗（試行 ${attempt + 1}）: ${validation.error}`);

    } catch (e) {
      lastError = e.message;
      lastOutput = null;
      logWarn('Stage2', `抽出エラー（試行 ${attempt + 1}）: ${e.message}`);
    }

    if (attempt < CONFIG.MAX_RETRIES) {
      Utilities.sleep(3000);
    }
  }

  logError('Stage2', '構造化抽出失敗（リトライ上限）', { lastError: lastError });
  return {
    success: false,
    error: lastError
  };
}


function validateStage2Output(parsed) {
  if (typeof parsed !== 'object' || parsed === null) {
    return { valid: false, error: 'トップレベルがオブジェクトではありません' };
  }

  const requiredFields = ['extraction_metadata', 'categories', 'monitoring_sheet_evidence'];
  for (let i = 0; i < requiredFields.length; i++) {
    if (!(requiredFields[i] in parsed)) {
      return { valid: false, error: `必須フィールド不足: ${requiredFields[i]}` };
    }
  }

  const requiredCategories = [
    'cat1_health', 'cat2_work', 'cat3_wishes', 'cat4_living',
    'cat5_family', 'cat6_staff', 'cat7_agreements', 'cat8_uncategorized'
  ];
  for (let j = 0; j < requiredCategories.length; j++) {
    if (!(requiredCategories[j] in parsed.categories)) {
      return { valid: false, error: `カテゴリ不足: ${requiredCategories[j]}` };
    }
    if (!Array.isArray(parsed.categories[requiredCategories[j]])) {
      return { valid: false, error: `カテゴリが配列ではありません: ${requiredCategories[j]}` };
    }
  }

  const evidence = parsed.monitoring_sheet_evidence;
  if (!evidence.work_life || !evidence.relationships || !evidence.tasks) {
    return { valid: false, error: 'monitoring_sheet_evidence の構造が不完全です' };
  }

  const workLifeKeys = [
    'attendance', 'punctuality', 'health_management', 'appearance',
    'rule_compliance', 'reporting', 'workspace_tidiness',
    'work_attitude', 'concentration', 'persistence'
  ];
  for (let k = 0; k < workLifeKeys.length; k++) {
    if (!(workLifeKeys[k] in evidence.work_life)) {
      return { valid: false, error: `work_life の項目不足: ${workLifeKeys[k]}` };
    }
  }

  if (!parsed.cross_reference_alerts || !Array.isArray(parsed.cross_reference_alerts)) {
    return { valid: false, error: 'cross_reference_alerts が配列ではありません' };
  }

  const allCategories = requiredCategories;
  for (let c = 0; c < allCategories.length; c++) {
    const items = parsed.categories[allCategories[c]];
    for (let m = 0; m < items.length; m++) {
      const item = items[m];
      if (!item.id || !item.quote || !item.speaker || !item.summary) {
        return { valid: false, error: `${allCategories[c]}[${m}] に必須プロパティ不足 (id/quote/speaker/summary)` };
      }
      if (!item.applicable_sections || !Array.isArray(item.applicable_sections)) {
        return { valid: false, error: `${allCategories[c]}[${m}] の applicable_sections が配列ではありません` };
      }
    }
  }

  const cat3Items = parsed.categories.cat3_wishes;
  for (let n = 0; n < cat3Items.length; n++) {
    if (!cat3Items[n].sub_type) {
      return { valid: false, error: `cat3_wishes[${n}] に sub_type がありません` };
    }
  }

  const cat6Items = parsed.categories.cat6_staff;
  for (let p = 0; p < cat6Items.length; p++) {
    if (!cat6Items[p].sub_type) {
      return { valid: false, error: `cat6_staff[${p}] に sub_type がありません` };
    }
  }

  return { valid: true };
}


function saveExtraction(folderId, userName, date, extractionJson) {
  const fileName = `${date}_${userName}_抽出.json`;
  const file = saveTextToFile(folderId, fileName, extractionJson);
  logInfo('Stage2', `構造化抽出ファイル保存: ${fileName}`);
  return file.getId();
}
