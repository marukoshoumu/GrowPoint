function log_(level, context, message, data) {
  const timestamp = new Date().toISOString();
  const logLine = `[${timestamp}] [${level}] [${context}] ${message}`;
  console.log(logLine);

  if (data) console.log(JSON.stringify(data, null, 2));

  try {
    appendToLogSheet_(timestamp, level, context, message, data);
  } catch (e) {
    console.warn(`ログシート書き込み失敗: ${e.message}`);
  }
}

function logInfo(context, message, data) {
  log_('INFO', context, message, data);
}

function logError(context, message, data) {
  log_('ERROR', context, message, data);
}

function logWarn(context, message, data) {
  log_('WARN', context, message, data);
}

function appendToLogSheet_(timestamp, level, context, message, data) {
  const ssId = getSpreadsheetId();
  if (!ssId) return;

  const ss = SpreadsheetApp.openById(ssId);
  const sheet = ss.getSheetByName(CONFIG.SHEET_NAMES.LOG);
  if (!sheet) return;

  sheet.appendRow([
    timestamp,
    level,
    context,
    message,
    data ? JSON.stringify(data).substring(0, 1000) : ''
  ]);
}

function uploadToGeminiFileApi(driveFileId) {
  const apiKey = getApiKey();
  const file = DriveApp.getFileById(driveFileId);
  const blob = file.getBlob();
  const fileName = file.getName();
  const fileSize = file.getSize();

  logInfo('FileAPI', `アップロード開始: ${fileName} (${fileSize} bytes)`);

  const uploadUrl = `https://generativelanguage.googleapis.com/upload/v1beta/files?key=${apiKey}`;

  const response = UrlFetchApp.fetch(uploadUrl, {
    method: 'post',
    contentType: blob.getContentType(),
    payload: blob,
    headers: {
      'X-Goog-Upload-Display-Name': fileName
    },
    muteHttpExceptions: true
  });

  const responseCode = response.getResponseCode();
  if (responseCode !== 200) {
    throw new Error(`Gemini File API upload error (${responseCode}): ${response.getContentText()}`);
  }

  const result = JSON.parse(response.getContentText());
  const fileUri = result.file.uri;

  logInfo('FileAPI', `アップロード完了: ${fileUri}`);
  return fileUri;
}

// TODO(Phase 1): APIキーのローテーション検討
function callGeminiApi(prompt, options) {
  options = options || {};
  const apiKey = getApiKey();
  const model = options.model || CONFIG.GEMINI_MODEL;

  let url = CONFIG.GEMINI_API_BASE + model;
  url += `:generateContent?key=${apiKey}`;

  const parts = [];
  if (options.fileUri) {
    parts.push({
      fileData: {
        mimeType: options.mimeType || 'audio/mp4',
        fileUri: options.fileUri
      }
    });
  }
  parts.push({ text: prompt });

  const contents = [{
    parts: parts
  }];

  const generationConfig = {
    temperature: options.temperature || 0.1,
    maxOutputTokens: options.maxTokens || 8192
  };
  if (options.responseMimeType) {
    generationConfig.responseMimeType = options.responseMimeType;
  }

  const payload = {
    contents: contents,
    generationConfig: generationConfig
  };

  const fetchOptions = {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };

  const response = UrlFetchApp.fetch(url, fetchOptions);
  const responseCode = response.getResponseCode();

  if (responseCode !== 200) {
    throw new Error(`Gemini API error (${responseCode}): ${response.getContentText()}`);
  }

  const result = JSON.parse(response.getContentText());
  if (result.usageMetadata) {
    logInfo('GeminiAPI', 'token usage', {
      prompt: result.usageMetadata.promptTokenCount,
      candidates: result.usageMetadata.candidatesTokenCount,
      total: result.usageMetadata.totalTokenCount
    });
  }
  return extractTextFromResponse_(result);
}

function callGeminiWithRetry(prompt, options, maxRetries) {
  maxRetries = maxRetries || CONFIG.MAX_RETRIES;
  let lastError;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return callGeminiApi(prompt, options);
    } catch (e) {
      lastError = e;
      logWarn('GeminiAPI', `リトライ ${attempt + 1}/${maxRetries + 1}`, { error: e.message });
      if (attempt < maxRetries) {
        Utilities.sleep(geminiRetryDelayMs_(e.message, attempt));
      }
    }
  }
  throw lastError;
}

/**
 * 429 時はレスポンスの "Please retry in Ns" を優先（短時間レート制限向け）。
 * 無料枠の **1日あたりリクエスト上限** に達した場合は待っても解消しない（翌日まで／課金プランへ）。
 */
function geminiRetryDelayMs_(errorMessage, attemptZeroBased) {
  const base = 2000 * (attemptZeroBased + 1);
  const m = errorMessage && errorMessage.match(/Please retry in ([\d.]+)\s*s/i);
  if (m) {
    return Math.max(base, Math.ceil(parseFloat(m[1], 10) * 1000) + 500);
  }
  if (errorMessage && errorMessage.indexOf('429') !== -1) {
    return Math.max(base, 25000);
  }
  return base;
}

/**
 * Gemini が ```json ... ``` で囲む／閉じタグが欠ける／前後に説明文がある場合の前処理
 */
function stripJsonFromGeminiText_(text) {
  let s = text.trim();
  if (!s) return s;

  // 先頭のフェンス（``` json のように空白が入る場合も）
  s = s.replace(/^```\s*(?:json)?\s*\r?\n?/i, '');
  s = s.replace(/\r?\n```\s*$/i, '');
  s = s.trim();

  // まだバッククォートで始まる場合（変種のフェンス）
  if (s.charAt(0) === '`') {
    s = s.replace(/^`{3}(?:json)?\s*\r?\n?/i, '');
    s = s.replace(/\r?\n`{3}\s*$/i, '');
    s = s.trim();
  }

  // 非貪欲マッチで囲み全体を取れるとき
  const m = s.match(/```\s*(?:json)?\s*([\s\S]*?)```/);
  if (m) {
    s = m[1].trim();
  }

  // トップレベルが { でないときは、最初の { から最後の } までを採用
  if (s.length > 0 && s.charAt(0) !== '[' && s.charAt(0) !== '{') {
    const i0 = s.indexOf('{');
    const i1 = s.lastIndexOf('}');
    if (i0 !== -1 && i1 > i0) {
      s = s.substring(i0, i1 + 1);
    }
  }

  return s.trim();
}

function parseJsonResponse(text) {
  const cleaned = stripJsonFromGeminiText_(text);
  return JSON.parse(cleaned);
}

/**
 * 処理状況シートの「面談日」が Date オブジェクトのとき、ファイル名に直結すると
 * 「Wed Mar 25 2026 ...」になる。フォルダ名・保存ファイル名は yyyy-MM-dd に統一する。
 */
function normalizeSheetDateForFilename_(value) {
  if (value === '' || value === null || value === undefined) return formatDate();
  if (value instanceof Date) return formatDate(value);
  if (typeof value === 'string') {
    const t = value.trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;
    const d = new Date(t);
    if (!isNaN(d.getTime())) return formatDate(d);
  }
  return formatDate();
}

function formatDate(date) {
  date = date || new Date();
  return Utilities.formatDate(date, 'Asia/Tokyo', 'yyyy-MM-dd');
}

function formatJapaneseDate(date) {
  if (!date) return '';
  if (typeof date === 'string') {
    const parsed = new Date(date);
    if (isNaN(parsed.getTime())) return date;
    date = parsed;
  }
  return Utilities.formatDate(date, 'Asia/Tokyo', 'yyyy年M月d日');
}

/**
 * 利用者マスター「次回モニタリング予定月」をテンプレート {{next_monitoring_month}} 用に整形する。
 * シートが Date のとき raw の toString が入るのを防ぎ、yyyy年M月 に統一する。
 */
function formatNextMonitoringMonthForTemplate(value) {
  if (value === '' || value === null || value === undefined) return '';
  if (value instanceof Date) {
    return Utilities.formatDate(value, 'Asia/Tokyo', 'yyyy年M月');
  }
  if (typeof value === 'string') {
    const t = value.trim();
    if (!t) return '';
    const d = new Date(t);
    if (!isNaN(d.getTime())) return Utilities.formatDate(d, 'Asia/Tokyo', 'yyyy年M月');
    return t;
  }
  return String(value);
}

function formatDateTime(date) {
  date = date || new Date();
  return Utilities.formatDate(date, 'Asia/Tokyo', 'yyyy-MM-dd HH:mm:ss');
}

/**
 * Drive 上にフォルダが存在するか（削除済みのIDは false）
 */
function folderExists_(folderId) {
  if (!folderId) return false;
  try {
    DriveApp.getFolderById(folderId);
    return true;
  } catch (e) {
    return false;
  }
}

function createSubfolder(parentFolderId, name) {
  const parent = DriveApp.getFolderById(parentFolderId);
  const existing = parent.getFoldersByName(name);
  if (existing.hasNext()) return existing.next();
  return parent.createFolder(name);
}

function saveTextToFile(folderId, fileName, content) {
  const folder = DriveApp.getFolderById(folderId);
  const blob = Utilities.newBlob(content, 'text/plain', fileName);
  return folder.createFile(blob);
}

function extractTextFromResponse_(result) {
  if (!result.candidates || result.candidates.length === 0) {
    throw new Error('Gemini API returned no candidates');
  }

  const candidate = result.candidates[0];

  if (candidate.finishReason === 'SAFETY') {
    throw new Error('Gemini API response blocked by safety filter (finishReason: SAFETY)');
  }

  if (candidate.finishReason === 'MAX_TOKENS') {
    logWarn('GeminiAPI', 'finishReason=MAX_TOKENS（出力がトークン上限で切れた可能性）。続くJSONパースに失敗する場合はプロンプトで抽出を短くしてください。');
  }

  if (!candidate.content || !candidate.content.parts || candidate.content.parts.length === 0) {
    throw new Error('Gemini API response has no content parts');
  }

  return candidate.content.parts[0].text;
}

function test_extractTextFromResponse() {
  let passed = 0;
  let failed = 0;

  // Test 1: Normal case - valid response returns text
  try {
    const validResponse = {
      candidates: [{
        finishReason: 'STOP',
        content: { parts: [{ text: 'Hello, world!' }] }
      }]
    };
    const text = extractTextFromResponse_(validResponse);
    if (text === 'Hello, world!') {
      logInfo('Test', 'PASS: Normal case - valid response returns text');
      passed++;
    } else {
      logError('Test', `FAIL: Normal case - expected "Hello, world!" but got "${text}"`);
      failed++;
    }
  } catch (e) {
    logError('Test', `FAIL: Normal case - unexpected error: ${e.message}`);
    failed++;
  }

  // Test 2: Empty candidates → throws
  try {
    extractTextFromResponse_({ candidates: [] });
    logError('Test', 'FAIL: Empty candidates - did not throw');
    failed++;
  } catch (e) {
    if (e.message.indexOf('no candidates') !== -1) {
      logInfo('Test', 'PASS: Empty candidates → throws correct error');
      passed++;
    } else {
      logError('Test', `FAIL: Empty candidates - wrong error: ${e.message}`);
      failed++;
    }
  }

  // Test 3: Missing candidates → throws
  try {
    extractTextFromResponse_({});
    logError('Test', 'FAIL: Missing candidates - did not throw');
    failed++;
  } catch (e) {
    if (e.message.indexOf('no candidates') !== -1) {
      logInfo('Test', 'PASS: Missing candidates → throws correct error');
      passed++;
    } else {
      logError('Test', `FAIL: Missing candidates - wrong error: ${e.message}`);
      failed++;
    }
  }

  // Test 4: SAFETY block → throws
  try {
    extractTextFromResponse_({
      candidates: [{
        finishReason: 'SAFETY',
        content: { parts: [{ text: '' }] }
      }]
    });
    logError('Test', 'FAIL: SAFETY block - did not throw');
    failed++;
  } catch (e) {
    if (e.message.indexOf('safety filter') !== -1 || e.message.indexOf('SAFETY') !== -1) {
      logInfo('Test', 'PASS: SAFETY block → throws correct error');
      passed++;
    } else {
      logError('Test', `FAIL: SAFETY block - wrong error: ${e.message}`);
      failed++;
    }
  }

  // Test 5: Missing content structure → throws
  try {
    extractTextFromResponse_({
      candidates: [{
        finishReason: 'STOP',
        content: {}
      }]
    });
    logError('Test', 'FAIL: Missing content.parts - did not throw');
    failed++;
  } catch (e) {
    if (e.message.indexOf('no content parts') !== -1) {
      logInfo('Test', 'PASS: Missing content.parts → throws correct error');
      passed++;
    } else {
      logError('Test', `FAIL: Missing content.parts - wrong error: ${e.message}`);
      failed++;
    }
  }

  // Test 6: Missing content entirely → throws
  try {
    extractTextFromResponse_({
      candidates: [{
        finishReason: 'STOP'
      }]
    });
    logError('Test', 'FAIL: Missing content - did not throw');
    failed++;
  } catch (e) {
    if (e.message.indexOf('no content parts') !== -1) {
      logInfo('Test', 'PASS: Missing content → throws correct error');
      passed++;
    } else {
      logError('Test', `FAIL: Missing content - wrong error: ${e.message}`);
      failed++;
    }
  }

  // Test 7: Empty parts array → throws
  try {
    extractTextFromResponse_({
      candidates: [{
        finishReason: 'STOP',
        content: { parts: [] }
      }]
    });
    logError('Test', 'FAIL: Empty parts - did not throw');
    failed++;
  } catch (e) {
    if (e.message.indexOf('no content parts') !== -1) {
      logInfo('Test', 'PASS: Empty parts → throws correct error');
      passed++;
    } else {
      logError('Test', `FAIL: Empty parts - wrong error: ${e.message}`);
      failed++;
    }
  }

  logInfo('Test', `extractTextFromResponse_ テスト完了: ${passed} passed, ${failed} failed`);
}
