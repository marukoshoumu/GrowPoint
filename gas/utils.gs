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

function callGeminiApi(prompt, options) {
  options = options || {};
  const apiKey = getApiKey();
  const model = options.model || CONFIG.GEMINI_MODEL;

  let url = CONFIG.GEMINI_API_BASE + model;

  let contents;
  if (options.audioFileId) {
    url += `:generateContent?key=${apiKey}`;
    const audioFile = DriveApp.getFileById(options.audioFileId);
    const audioBlob = audioFile.getBlob();
    const base64Audio = Utilities.base64Encode(audioBlob.getBytes());
    const mimeType = audioBlob.getContentType() || 'audio/mp4';

    contents = [{
      parts: [
        { text: prompt },
        {
          inline_data: {
            mime_type: mimeType,
            data: base64Audio
          }
        }
      ]
    }];
  } else {
    url += `:generateContent?key=${apiKey}`;
    contents = [{
      parts: [{ text: prompt }]
    }];
  }

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

  if (!result.candidates || result.candidates.length === 0) {
    throw new Error('Gemini API returned no candidates');
  }

  return result.candidates[0].content.parts[0].text;
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
