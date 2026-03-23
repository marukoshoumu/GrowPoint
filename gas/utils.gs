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
  const fileSize = blob.getBytes().length;

  logInfo('FileAPI', `アップロード開始: ${fileName} (${fileSize} bytes)`);

  const uploadUrl = `https://generativelanguage.googleapis.com/upload/v1beta/files?key=${apiKey}`;

  const response = UrlFetchApp.fetch(uploadUrl, {
    method: 'post',
    contentType: blob.getContentType(),
    payload: blob.getBytes(),
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

  const payload = {
    contents: contents,
    generationConfig: {
      temperature: options.temperature || 0.1,
      maxOutputTokens: options.maxTokens || 8192
    }
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
        Utilities.sleep(2000 * (attempt + 1));
      }
    }
  }
  throw lastError;
}

function parseJsonResponse(text) {
  let cleaned = text.trim();

  const jsonMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (jsonMatch) {
    cleaned = jsonMatch[1].trim();
  }

  return JSON.parse(cleaned);
}

function formatDate(date) {
  date = date || new Date();
  return Utilities.formatDate(date, 'Asia/Tokyo', 'yyyy-MM-dd');
}

function formatDateTime(date) {
  date = date || new Date();
  return Utilities.formatDate(date, 'Asia/Tokyo', 'yyyy-MM-dd HH:mm:ss');
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
