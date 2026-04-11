/**
 * Cloud Run transcribe ワーカーに文字起こしジョブを投入する。
 * @returns {{ success: boolean, error?: string }}
 */
function requestTranscribeEnqueue_(audioFileId, userName, interviewDate, chunkIndex, chunkTotal, extractedFolderId) {
  var props = PropertiesService.getScriptProperties();
  var workerUrl = props.getProperty('TRANSCRIBE_WORKER_URL');
  var secret = props.getProperty('TRANSCRIBE_AUTH_SECRET');
  if (!workerUrl || !secret) {
    return { success: false, error: 'TRANSCRIBE_WORKER_URL または TRANSCRIBE_AUTH_SECRET が未設定' };
  }

  var glossary = loadGlossary();
  var prompt = getStage1Prompt(glossary);

  var folderIds = getFolderIds();
  var payload = {
    audioFileId: audioFileId,
    userName: userName,
    date: normalizeSheetDateForFilename_(interviewDate),
    chunkIndex: chunkIndex || null,
    chunkTotal: chunkTotal || null,
    extractedFolderId: extractedFolderId,
    prompt: prompt,
    errorFolderId: folderIds.error
  };

  var url = workerUrl.replace(/\/$/, '') + '/enqueue';
  var options = {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    headers: { Authorization: 'Bearer ' + secret },
    muteHttpExceptions: true
  };

  try {
    var res = UrlFetchApp.fetch(url, options);
    var code = res.getResponseCode();
    if (code >= 200 && code < 300) {
      return { success: true };
    }
    return { success: false, error: 'transcribe enqueue HTTP ' + code + ': ' + String(res.getContentText()).substring(0, 300) };
  } catch (e) {
    return { success: false, error: 'transcribe enqueue fetch error: ' + e.message };
  }
}

/**
 * STAGE1_PENDING 行に対し、Drive に文字起こし結果ファイルが存在するかチェック。
 * 存在すれば STAGE1_DONE（or STAGE1_CHUNK_WAIT）に進める。
 */
function checkTranscribeResult_(job) {
  var folderIds = getFolderIds();
  var userName = job.userName;
  var interviewDate = job.interviewDate;
  var processingFolder = createUserProcessingFolder(folderIds.extracted, userName, interviewDate);
  var folderId = processingFolder.getId();

  var chunk = parseChunkLabel_(job.chunkLabel || '');
  var expectedFileName;
  if (chunk) {
    var pad = formatChunkTranscriptIndexPad_(chunk.chunkIndex, chunk.chunkTotal);
    expectedFileName = getChunkTranscriptBasePrefix_(userName, interviewDate) + '_' + pad + '.txt';
  } else {
    expectedFileName = getChunkTranscriptBasePrefix_(userName, interviewDate) + '.txt';
  }

  var folder = DriveApp.getFolderById(folderId);
  var it = folder.getFilesByName(expectedFileName);
  if (!it.hasNext()) {
    return; // まだ結果なし。次トリガーで再確認。
  }

  var transcriptFile = it.next();
  var transcriptUrl = getFileUrl(transcriptFile.getId());

  if (chunk) {
    updateDashboardStatus(job.rowNumber, {
      'ステータス': CONFIG.STATUS.STAGE1_CHUNK_WAIT,
      '文字起こし': transcriptUrl
    });
    tryMergeChunkGroupAfterStage1_(userName, interviewDate, chunk.chunkTotal, folderId);
  } else {
    updateDashboardStatus(job.rowNumber, {
      'ステータス': CONFIG.STATUS.STAGE1_DONE,
      '文字起こし': transcriptUrl
    });
  }

  logInfo('Main', 'Stage1結果検出: ' + job.processId + ' → ' + expectedFileName);
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

/**
 * チャンク連番のゼロ埋め幅（chunkTotal に合わせる。1〜9 チャンクでも従来どおり最低2桁）
 * @param {number} chunkIndex
 * @param {number} chunkTotal
 */
function formatChunkTranscriptIndexPad_(chunkIndex, chunkTotal) {
  const w = Math.max(String(chunkTotal).length, 2);
  return String(chunkIndex).padStart(w, '0');
}

/** 分割音声: チャンク番号付き（例: …_文字起こし_01.txt、100 チャンク超は桁が増える） */
function saveTranscriptChunk(folderId, userName, date, transcript, chunkIndex, chunkTotal) {
  const pad = formatChunkTranscriptIndexPad_(chunkIndex, chunkTotal);
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

