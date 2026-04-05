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
function saveTranscript(folderId, userName, date, transcript) {
  const fileName = `${normalizeSheetDateForFilename_(date)}_${userName}_文字起こし.txt`;
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

function estimateDurationMin_(fileSize) {
  return Math.floor(fileSize / CONFIG.BYTES_PER_MINUTE_M4A);
}

function formatMinutesToTime_(minutes) {
  var m = Math.floor(minutes);
  var s = Math.round((minutes - m) * 60);
  if (s === 60) { m++; s = 0; }
  return m + ':' + (s < 10 ? '0' : '') + s;
}

function buildChunkRanges_(durationMin) {
  const chunk = CONFIG.CHUNK_DURATION_MIN;
  const overlap = CONFIG.CHUNK_OVERLAP_MIN;
  const ranges = [];

  for (let start = 0; start < durationMin; start += chunk) {
    const end = Math.min(start + chunk + overlap, durationMin);
    if (durationMin - start <= overlap && ranges.length > 0) {
      break;
    }
    ranges.push({
      startTime: formatMinutesToTime_(start),
      endTime: formatMinutesToTime_(end)
    });
  }

  return ranges;
}

function transcribeChunks_(glossary, fileUri, mimeType, ranges) {
  const chunkTexts = [];

  for (let i = 0; i < ranges.length; i++) {
    const isFirst = (i === 0);
    const prompt = getStage1ChunkPrompt(glossary, ranges[i].startTime, ranges[i].endTime, isFirst);

    logInfo('Stage1', `チャンク${i + 1}/${ranges.length} 文字起こし開始: ${ranges[i].startTime}-${ranges[i].endTime}`);

    const text = callGeminiWithRetry(prompt, {
      model: CONFIG.CHUNK_TRANSCRIPTION_MODEL,
      fileUri: fileUri,
      mimeType: mimeType,
      temperature: 0.1,
      maxTokens: CONFIG.CHUNK_MAX_TOKENS
    });

    logInfo('Stage1', `チャンク${i + 1} 完了: ${text.length}文字`);
    chunkTexts.push(text);
  }

  return chunkTexts;
}

function mergeChunkTranscripts_(chunkTexts, ranges) {
  logInfo('Stage1', `チャンク結合開始: ${chunkTexts.length}チャンク`);

  const prompt = getMergePrompt(chunkTexts, ranges);

  const merged = callGeminiWithRetry(prompt, {
    temperature: 0.1,
    maxTokens: CONFIG.MERGE_MAX_TOKENS
  });

  logInfo('Stage1', `チャンク結合完了: ${merged.length}文字`);
  return merged;
}

function test_estimateDurationMin() {
  var passed = 0;
  var failed = 0;

  var r1 = estimateDurationMin_(34000000);
  if (r1 === 34) { logInfo('Test', 'PASS: 34MB → 34min'); passed++; }
  else { logError('Test', 'FAIL: 34MB → expected 34, got ' + r1); failed++; }

  var r2 = estimateDurationMin_(10000000);
  if (r2 === 10) { logInfo('Test', 'PASS: 10MB → 10min'); passed++; }
  else { logError('Test', 'FAIL: 10MB → expected 10, got ' + r2); failed++; }

  var r3 = estimateDurationMin_(0);
  if (r3 === 0) { logInfo('Test', 'PASS: 0 bytes → 0min'); passed++; }
  else { logError('Test', 'FAIL: 0 bytes → expected 0, got ' + r3); failed++; }

  logInfo('Test', 'estimateDurationMin_ テスト完了: ' + passed + ' passed, ' + failed + ' failed');
}

function test_formatMinutesToTime() {
  var passed = 0;
  var failed = 0;

  function check(input, expected) {
    var result = formatMinutesToTime_(input);
    if (result === expected) { logInfo('Test', 'PASS: ' + input + ' → ' + expected); passed++; }
    else { logError('Test', 'FAIL: ' + input + ' → expected "' + expected + '", got "' + result + '"'); failed++; }
  }

  check(0, '0:00');
  check(10, '10:00');
  check(11, '11:00');
  check(34.383, '34:23');
  check(0.5, '0:30');
  check(90, '90:00');

  logInfo('Test', 'formatMinutesToTime_ テスト完了: ' + passed + ' passed, ' + failed + ' failed');
}

function test_buildChunkRanges() {
  var passed = 0;
  var failed = 0;

  // 34分、10分チャンク、1分オーバーラップ → 4チャンク
  var ranges = buildChunkRanges_(34);
  if (ranges.length === 4) { logInfo('Test', 'PASS: 34min → 4 chunks'); passed++; }
  else { logError('Test', 'FAIL: 34min → expected 4 chunks, got ' + ranges.length); failed++; }

  if (ranges[0].startTime === '0:00' && ranges[0].endTime === '11:00') {
    logInfo('Test', 'PASS: chunk1 = 0:00-11:00'); passed++;
  } else {
    logError('Test', 'FAIL: chunk1 = ' + ranges[0].startTime + '-' + ranges[0].endTime); failed++;
  }

  if (ranges[1].startTime === '10:00' && ranges[1].endTime === '21:00') {
    logInfo('Test', 'PASS: chunk2 = 10:00-21:00'); passed++;
  } else {
    logError('Test', 'FAIL: chunk2 = ' + ranges[1].startTime + '-' + ranges[1].endTime); failed++;
  }

  if (ranges[2].startTime === '20:00' && ranges[2].endTime === '31:00') {
    logInfo('Test', 'PASS: chunk3 = 20:00-31:00'); passed++;
  } else {
    logError('Test', 'FAIL: chunk3 = ' + ranges[2].startTime + '-' + ranges[2].endTime); failed++;
  }

  if (ranges[3].startTime === '30:00' && ranges[3].endTime === '34:00') {
    logInfo('Test', 'PASS: chunk4 = 30:00-34:00'); passed++;
  } else {
    logError('Test', 'FAIL: chunk4 = ' + ranges[3].startTime + '-' + ranges[3].endTime); failed++;
  }

  // 20分 → 2チャンク
  var ranges2 = buildChunkRanges_(20);
  if (ranges2.length === 2) { logInfo('Test', 'PASS: 20min → 2 chunks'); passed++; }
  else { logError('Test', 'FAIL: 20min → expected 2 chunks, got ' + ranges2.length); failed++; }

  if (ranges2[0].startTime === '0:00' && ranges2[0].endTime === '11:00') {
    logInfo('Test', 'PASS: 20min chunk1 = 0:00-11:00'); passed++;
  } else {
    logError('Test', 'FAIL: 20min chunk1 = ' + ranges2[0].startTime + '-' + ranges2[0].endTime); failed++;
  }

  if (ranges2[1].startTime === '10:00' && ranges2[1].endTime === '20:00') {
    logInfo('Test', 'PASS: 20min chunk2 = 10:00-20:00'); passed++;
  } else {
    logError('Test', 'FAIL: 20min chunk2 = ' + ranges2[1].startTime + '-' + ranges2[1].endTime); failed++;
  }

  // 60分 → 6チャンク
  var ranges3 = buildChunkRanges_(60);
  if (ranges3.length === 6) { logInfo('Test', 'PASS: 60min → 6 chunks'); passed++; }
  else { logError('Test', 'FAIL: 60min → expected 6 chunks, got ' + ranges3.length); failed++; }

  logInfo('Test', 'buildChunkRanges_ テスト完了: ' + passed + ' passed, ' + failed + ' failed');
}
