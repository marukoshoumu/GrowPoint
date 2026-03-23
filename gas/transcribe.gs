function runStage1(audioFileId) {
  logInfo('Stage1', `文字起こし開始: ${audioFileId}`);

  try {
    const glossary = loadGlossary();
    const prompt = getStage1Prompt(glossary);

    const transcript = callGeminiWithRetry(prompt, {
      audioFileId: audioFileId,
      temperature: 0.1,
      maxTokens: 16384
    });

    logInfo('Stage1', `文字起こし完了: ${transcript.length}文字`);
    return {
      success: true,
      data: {
        transcript: transcript,
        charCount: transcript.length
      }
    };
  } catch (e) {
    logError('Stage1', `文字起こし失敗: ${e.message}`);
    return {
      success: false,
      error: e.message
    };
  }
}

function saveTranscript(folderId, userName, date, transcript) {
  const fileName = `${date}_${userName}_文字起こし.txt`;
  const file = saveTextToFile(folderId, fileName, transcript);
  logInfo('Stage1', `文字起こしファイル保存: ${fileName}`);
  return file.getId();
}

function loadGlossary() {
  try {
    const ssId = getSpreadsheetId();
    if (!ssId) return [];

    const ss = SpreadsheetApp.openById(ssId);
    const sheet = ss.getSheetByName(CONFIG.SHEET_NAMES.GLOSSARY);
    if (!sheet) return [];

    const data = sheet.getDataRange().getValues();
    if (data.length <= 1) return [];

    const glossary = [];
    for (let i = 1; i < data.length; i++) {
      if (data[i][0]) {
        glossary.push({
          term: data[i][0],
          reading: data[i][1] || '',
          formal: data[i][2] || data[i][0],
          note: data[i][3] || ''
        });
      }
    }
    return glossary;
  } catch (e) {
    logWarn('Stage1', `用語集読み込みスキップ: ${e.message}`);
    return [];
  }
}
