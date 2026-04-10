/**
 * 長尺音声を Cloud Run（ffmpeg）で分割するオプション機能。
 * Script Properties: AUDIO_SPLIT_ENABLED, AUDIO_SPLIT_WORKER_URL, AUDIO_SPLIT_SECRET 等
 */

function getAudioSplitSettings_() {
  const props = PropertiesService.getScriptProperties();
  const defMin = 15 * 1024 * 1024;
  return {
    enabled: props.getProperty('AUDIO_SPLIT_ENABLED') === 'true',
    workerUrl: props.getProperty('AUDIO_SPLIT_WORKER_URL') || '',
    secret: props.getProperty('AUDIO_SPLIT_SECRET') || '',
    chunkSeconds: parseInt(props.getProperty('AUDIO_SPLIT_CHUNK_SECONDS') || '1200', 10),
    minBytes: parseInt(props.getProperty('AUDIO_SPLIT_MIN_BYTES') || String(defMin), 10)
  };
}

/**
 * 既に _NN-MM 付きチャンクなら分割不要。しきい値・設定が揃っている場合のみ true。
 * ファイル名だけでチャンクと分かる場合も除外（パース失敗時の再帰分割を防ぐ）。
 */
function shouldRouteToAudioSplitWorker_(audioFile, parsed) {
  const s = getAudioSplitSettings_();
  if (!s.enabled || !s.workerUrl || !s.secret) {
    return false;
  }
  const nameWithoutExt = audioFile.name.replace(/\.[^.]+$/, '');
  const suffixOnly = parseChunkSuffixFromBasename_(nameWithoutExt);
  if (suffixOnly.chunkIndex != null && suffixOnly.chunkTotal != null) {
    return false;
  }
  if (parsed.chunkIndex != null && parsed.chunkTotal != null) {
    return false;
  }
  var size = 0;
  try {
    const f = audioFile.driveFile || DriveApp.getFileById(audioFile.id);
    size = f.getSize();
  } catch (e) {
    logWarn('AudioSplit', 'ファイルサイズ取得失敗', { error: e.message });
    return false;
  }
  if (size < s.minBytes) {
    return false;
  }
  return true;
}

/**
 * @returns {boolean} HTTP 2xx なら true
 */
function requestAudioSplitEnqueue_(claimed, parsed) {
  const s = getAudioSplitSettings_();
  const folderIds = getFolderIds();
  var base = s.workerUrl.replace(/\/$/, '');
  var url = base + '/enqueue';
  var payload = {
    fileId: claimed.id,
    userName: parsed.userName,
    date: parsed.date,
    chunkSeconds: s.chunkSeconds,
    unprocessedFolderId: folderIds.unprocessed,
    processingFolderId: folderIds.processing,
    errorFolderId: folderIds.error
  };
  var options = {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    headers: { Authorization: 'Bearer ' + s.secret },
    muteHttpExceptions: true
  };
  try {
    var res = UrlFetchApp.fetch(url, options);
    var code = res.getResponseCode();
    if (code >= 200 && code < 300) {
      return true;
    }
    logError('AudioSplit', '分割ワーカー enqueue 失敗', {
      code: code,
      body: String(res.getContentText()).substring(0, 500)
    });
    return false;
  } catch (e) {
    logError('AudioSplit', '分割ワーカー UrlFetch 例外', { error: e.message });
    return false;
  }
}

function handleAudioSplitEnqueueFailure_(claimed, dashboardRow, message) {
  updateDashboardStatus(dashboardRow, {
    'ステータス': CONFIG.STATUS.SPLIT_FAILED,
    'エラー内容': message || '分割依頼に失敗しました',
    '処理完了': formatDateTime()
  });
  try {
    moveToError(claimed.id);
  } catch (e) {
    logError('AudioSplit', 'エラーフォルダへの移動失敗', { fileId: claimed.id, error: e.message });
  }
}
