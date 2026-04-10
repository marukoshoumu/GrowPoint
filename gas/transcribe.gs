function runStage1(audioFileId) {
  logInfo('Stage1', `文字起こし開始: ${audioFileId}`);

  try {
    const glossary = loadGlossary();
    const audioFile = DriveApp.getFileById(audioFileId);
    const mimeType = audioFile.getMimeType() || 'audio/mp4';
    const fileUri = uploadToGeminiFileApi(audioFileId);

    const prompt = getStage1Prompt(glossary);
    const transcript = callGeminiWithRetry(prompt, {
      model: CONFIG.STAGE1_MODEL,
      fileUri: fileUri,
      mimeType: mimeType,
      temperature: 0.1,
      maxTokens: CONFIG.STAGE1_MAX_OUTPUT_TOKENS
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

// TODO(Phase 1): 文字起こしファイルの暗号化 or アクセス制限
function getChunkTranscriptBasePrefix_(userName, date) {
  return normalizeSheetDateForFilename_(date) + '_' + userName + '_文字起こし';
}

function saveTranscript(folderId, userName, date, transcript) {
  const fileName = getChunkTranscriptBasePrefix_(userName, date) + '.txt';
  trashFilesInFolderByName_(folderId, fileName);
  const file = saveTextToFile(folderId, fileName, transcript);
  logInfo('Stage1', `文字起こしファイル保存: ${fileName}`);
  return file.getId();
}

/** 分割音声: チャンク番号付き（例: …_文字起こし_01.txt） */
function saveTranscriptChunk(folderId, userName, date, transcript, chunkIndex) {
  const pad = chunkIndex < 10 ? '0' + chunkIndex : String(chunkIndex);
  const fileName = getChunkTranscriptBasePrefix_(userName, date) + '_' + pad + '.txt';
  trashFilesInFolderByName_(folderId, fileName);
  const file = saveTextToFile(folderId, fileName, transcript);
  logInfo('Stage1', `チャンク文字起こし保存: ${fileName}`);
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

