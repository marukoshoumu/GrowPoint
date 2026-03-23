function runStage3B(extractionData, userMaster) {
  logInfo('Stage3B', 'モニタリングシート生成開始');

  try {
    const extractionJson = JSON.stringify(extractionData, null, 2);
    const prompt = getStage3BPrompt(userMaster, extractionJson);

    let lastError = null;
    let lastOutput = null;

    for (let attempt = 0; attempt <= CONFIG.MAX_RETRIES; attempt++) {
      try {
        const currentPrompt = attempt === 0
          ? prompt
          : getRetryPrompt(prompt, lastError, lastOutput);

        const response = callGeminiWithRetry(currentPrompt, {
          temperature: 0.2,
          maxTokens: 8192
        }, 0);

        lastOutput = response;
        const parsed = parseJsonResponse(response);
        const validation = validateStage3BOutput(parsed);

        if (validation.valid) {
          logInfo('Stage3B', `シートデータ生成完了（試行 ${attempt + 1}回目）`);
          return {
            success: true,
            data: {
              parsed: parsed,
              attempts: attempt + 1
            }
          };
        }

        lastError = validation.error;
        logWarn('Stage3B', `バリデーション失敗（試行 ${attempt + 1}）: ${validation.error}`);

      } catch (e) {
        lastError = e.message;
        lastOutput = null;
        logWarn('Stage3B', `シート生成エラー（試行 ${attempt + 1}）: ${e.message}`);
      }

      if (attempt < CONFIG.MAX_RETRIES) {
        Utilities.sleep(3000);
      }
    }

    logError('Stage3B', 'モニタリングシート生成失敗（リトライ上限）', { lastError: lastError });
    return {
      success: false,
      error: lastError || 'モニタリングシート生成に失敗しました'
    };
  } catch (e) {
    logError('Stage3B', `モニタリングシート生成で予期しないエラー: ${e.message}`);
    return {
      success: false,
      error: e.message
    };
  }
}


function validateStage3BOutput(parsed) {
  if (typeof parsed !== 'object' || parsed === null) {
    return { valid: false, error: 'トップレベルがオブジェクトではありません' };
  }

  if (!Array.isArray(parsed.work_life) || parsed.work_life.length < 10) {
    return { valid: false, error: 'work_life が不足（10項目必要）' };
  }
  if (!Array.isArray(parsed.relationships) || parsed.relationships.length < 5) {
    return { valid: false, error: 'relationships が不足（5項目必要）' };
  }
  if (!Array.isArray(parsed.tasks) || parsed.tasks.length < 5) {
    return { valid: false, error: 'tasks が不足（5項目必要）' };
  }
  if (!parsed.overall_assessment || typeof parsed.overall_assessment !== 'string') {
    return { valid: false, error: 'overall_assessment が文字列ではありません' };
  }

  const allItems = parsed.work_life.concat(parsed.relationships).concat(parsed.tasks);
  for (let i = 0; i < allItems.length; i++) {
    if (!allItems[i].item || typeof allItems[i].note === 'undefined') {
      return { valid: false, error: `項目[${i}]に item または note がありません` };
    }
  }

  return { valid: true };
}


function fillMonitoringSheet(userMaster, sheetData) {
  const templateIds = getTemplateIds();
  const folderIds = getFolderIds();

  if (!templateIds.monitoringSheet) {
    logWarn('Stage3B', 'テンプレートID未設定。プレーンテキストで保存します');
    return saveSheetAsPlainText_(userMaster, sheetData);
  }

  const replacements = {
    'user_name': userMaster.name,
    'staff_name': userMaster.staff,
    'service_manager': userMaster.manager,
    'date': userMaster.date,
    'previous_monitoring_date': userMaster.previousMonitoringDate || '初回',
    'next_monitoring_month': userMaster.nextMonitoringMonth || ''
  };

  for (let i = 0; i < sheetData.work_life.length; i++) {
    replacements[`wl_note_${i + 1}`] = sheetData.work_life[i].note || '面談中の言及なし';
  }
  for (let j = 0; j < sheetData.relationships.length; j++) {
    replacements[`rel_note_${j + 1}`] = sheetData.relationships[j].note || '面談中の言及なし';
  }
  for (let k = 0; k < sheetData.tasks.length; k++) {
    replacements[`task_note_${k + 1}`] = sheetData.tasks[k].note || '面談中の言及なし';
  }

  replacements['overall_assessment'] = sheetData.overall_assessment;
  replacements['ai_disclaimer'] = '本シートの特記事項はAI支援による下書きです。評価（1/2/3）は担当者が判断・記入してください。';

  const fileName = `${userMaster.date}_${userMaster.name}_モニタリングシート（下書き）`;

  try {
    const docId = fillTemplate(
      templateIds.monitoringSheet,
      replacements,
      folderIds.draft,
      fileName
    );
    logInfo('Stage3B', `テンプレート差し込み完了: ${docId}`);
    return { docId: docId, url: getDocUrl(docId) };
  } catch (e) {
    logError('Stage3B', `テンプレート差し込み失敗: ${e.message}`);
    return saveSheetAsPlainText_(userMaster, sheetData);
  }
}


function saveSheetAsPlainText_(userMaster, sheetData) {
  const folderIds = getFolderIds();
  const text = buildSheetPlainText_(userMaster, sheetData);
  const fileName = `${userMaster.date}_${userMaster.name}_モニタリングシート（下書き）.txt`;
  const file = saveTextToFile(folderIds.draft, fileName, text);
  logInfo('Stage3B', `プレーンテキストで保存: ${fileName}`);
  return { docId: file.getId(), url: getFileUrl(file.getId()) };
}


function buildSheetPlainText_(userMaster, sheetData) {
  const lines = [];
  lines.push('モニタリングシート（就労関係）下書き');
  lines.push(`利用者名: ${userMaster.name}`);
  lines.push(`実施年月日: ${userMaster.date}`);
  lines.push(`作成者: ${userMaster.staff}`);
  lines.push('');
  lines.push('=== 1. 職業生活 ===');
  for (let i = 0; i < sheetData.work_life.length; i++) {
    lines.push(`${i + 1}. ${sheetData.work_life[i].item}: [評価: 担当者記入] ${sheetData.work_life[i].note}`);
  }
  lines.push('');
  lines.push('=== 2. 対人関係 ===');
  for (let j = 0; j < sheetData.relationships.length; j++) {
    lines.push(`${j + 1}. ${sheetData.relationships[j].item}: [評価: 担当者記入] ${sheetData.relationships[j].note}`);
  }
  lines.push('');
  lines.push('=== 3. 作業 ===');
  for (let k = 0; k < sheetData.tasks.length; k++) {
    lines.push(`${k + 1}. ${sheetData.tasks[k].item}: [評価: 担当者記入] ${sheetData.tasks[k].note}`);
  }
  lines.push('');
  lines.push('=== 4. 総合所見 ===');
  lines.push(sheetData.overall_assessment);
  lines.push('');
  lines.push('※ 本シートの特記事項はAI支援による下書きです。評価（1/2/3）は担当者が判断・記入してください。');

  return lines.join('\n');
}
