// TODO(Phase 1): 個人情報マスキング対応（文字起こし・抽出結果の平文保存）
// TODO(Phase 1): Drive共有範囲の制限確認
// TODO(Phase 1): ログシートの個人情報保持期間設定

/**
 * メインエントリポイント：未処理音声ファイルを検出し、ステージ分割でパイプラインを実行する。
 * 時間ベースのトリガーから呼び出される（5分間隔）。
 */
function processNewFiles() {
  const startTime = Date.now();

  // タイムアウトしたジョブを回復
  recoverTimedOutJobs_();

  // 新規音声ファイルを検出し、QUEUEDとして登録
  const audioFiles = detectNewAudioFiles();
  for (let i = 0; i < audioFiles.length; i++) {
    try {
      enqueueFile_(audioFiles[i]);
    } catch (e) {
      logError('Main', `キュー登録失敗: ${audioFiles[i].name}`, { error: e.message });
    }
  }

  // ステージディスパッチ
  dispatchNextStage_(startTime);
}


/**
 * 経過時間をチェックしながら、1ファイルずつ1ステージずつ処理する。
 */
function dispatchNextStage_(startTime) {
  const elapsed = () => Date.now() - startTime;

  // STAGE1_PENDING → 結果ファイルポーリング → STAGE1_DONE or STAGE1_CHUNK_WAIT
  var pendingJobs = sortStage1PendingJobsByChunkIndex_(findRowsByStatus(CONFIG.STATUS.STAGE1_PENDING));
  for (var i = 0; i < pendingJobs.length; i++) {
    if (elapsed() > CONFIG.STAGE_TIME_LIMIT_MS) {
      logInfo('Main', 'タイムリミット到達（Stage1ポーリング中）');
      return;
    }
    try {
      checkTranscribeResult_(pendingJobs[i]);
    } catch (e) {
      logError('Main', 'Stage1結果確認例外: ' + pendingJobs[i].processId, { error: e.message });
    }
  }

  // QUEUED → Stage1
  const queuedJobs = findRowsByStatus(CONFIG.STATUS.QUEUED);
  for (let i = 0; i < queuedJobs.length; i++) {
    if (elapsed() > CONFIG.STAGE_TIME_LIMIT_MS) {
      logInfo('Main', 'タイムリミット到達（Stage1前）');
      return;
    }
    try {
      executeStage1_(queuedJobs[i]);
    } catch (e) {
      logError('Main', `Stage1例外: ${queuedJobs[i].processId}`, { error: e.message });
      handleError_(queuedJobs[i].processId, queuedJobs[i].rowNumber, e.message);
    }
  }

  // STAGE1_DONE → Stage2
  const stage1DoneJobs = findRowsByStatus(CONFIG.STATUS.STAGE1_DONE);
  for (let i = 0; i < stage1DoneJobs.length; i++) {
    if (elapsed() > CONFIG.STAGE_TIME_LIMIT_MS) {
      logInfo('Main', 'タイムリミット到達（Stage2前）');
      return;
    }
    try {
      executeStage2_(stage1DoneJobs[i]);
    } catch (e) {
      logError('Main', `Stage2例外: ${stage1DoneJobs[i].processId}`, { error: e.message });
      handleError_(stage1DoneJobs[i].processId, stage1DoneJobs[i].rowNumber, e.message);
    }
  }

  // STAGE2_DONE → Stage3
  const stage2DoneJobs = findRowsByStatus(CONFIG.STATUS.STAGE2_DONE);
  for (let i = 0; i < stage2DoneJobs.length; i++) {
    if (elapsed() > CONFIG.STAGE_TIME_LIMIT_MS) {
      logInfo('Main', 'タイムリミット到達（Stage3前）');
      return;
    }
    try {
      executeStage3_(stage2DoneJobs[i]);
    } catch (e) {
      logError('Main', `Stage3例外: ${stage2DoneJobs[i].processId}`, { error: e.message });
      handleError_(stage2DoneJobs[i].processId, stage2DoneJobs[i].rowNumber, e.message);
    }
  }
}


/**
 * 新規音声ファイルをキューに登録する。
 * 並行実行でコピー取込が二重になるのを防ぐためスクリプトロックを使用する。
 */
function enqueueFile_(audioFile) {
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(20000);
  } catch (e) {
    logWarn('Main', 'enqueue ロック取得失敗（スキップ）', { file: audioFile.name, error: e.message });
    return;
  }
  try {
    enqueueFileLocked_(audioFile);
  } finally {
    lock.releaseLock();
  }
}

function enqueueFileLocked_(audioFile) {
  const parsed = parseFileNameForUser(audioFile.name);

  // 重複チェック（取り込み前・同一ファイルID）
  const ownerEmail = (function() { try { const o = audioFile.driveFile && audioFile.driveFile.getOwner(); return o ? o.getEmail() : '不明'; } catch (_) { return '取得失敗'; } })();
  logInfo('Main', `enqueue開始: ${audioFile.name}`, { fileId: audioFile.id, owner: ownerEmail });

  const existingRow = findDashboardRowByProcessId(audioFile.id);
  if (existingRow !== -1) {
    logInfo('Main', `重複スキップ: ${audioFile.name} (${audioFile.id})`);
    return;
  }
  // 他者所有コピー取込後は処理IDがコピー側になるため、ダッシュボードでは元IDと一致しない。CLAIMED で抑止する。
  if (getClaimedOriginalIdSet_()[audioFile.id]) {
    logInfo('Main', `コピー取込済み元のためスキップ: ${audioFile.name} (${audioFile.id})`);
    return;
  }
  logInfo('Main', '重複チェック通過');

  if (parsed.chunkIndex != null && parsed.chunkTotal != null) {
    supersedeSplitPendingRowsForChunk_(parsed.userName, parsed.date);
  }

  if (shouldRouteToAudioSplitWorker_(audioFile, parsed)) {
    const claimed = claimAudioForProcessing_(audioFile);
    const processId = claimed.id;
    const dashboardRow = addDashboardRow(
      processId,
      parsed.userName,
      parsed.date,
      claimed.name,
      CONFIG.STATUS.SPLIT_PENDING,
      ''
    );
    const ok = requestAudioSplitEnqueue_(claimed, parsed);
    if (!ok) {
      handleAudioSplitEnqueueFailure_(claimed, dashboardRow, '分割ワーカーへの依頼に失敗しました');
    } else {
      logInfo('Main', '分割ワーカーへ投入', { processId: processId, file: claimed.name });
    }
    return;
  }

  const claimed = claimAudioForProcessing_(audioFile);
  const processId = claimed.id;
  logInfo('Main', 'claim完了', { processId: processId });

  var chunkLabel = '';
  if (parsed.chunkIndex && parsed.chunkTotal) {
    chunkLabel = formatChunkLabel_(parsed.chunkIndex, parsed.chunkTotal);
  }

  const dashboardRow = addDashboardRow(
    processId, parsed.userName, parsed.date, claimed.name, CONFIG.STATUS.QUEUED, chunkLabel
  );

  logInfo('Main', 'キュー登録完了', {
    processId: processId,
    file: claimed.name,
    user: parsed.userName,
    date: parsed.date,
    chunk: chunkLabel || '(単一)',
    row: dashboardRow
  });
}

/**
 * Stage 1: Cloud Run に文字起こしを委託
 */
function executeStage1_(job) {
  logInfo('Main', 'Stage1 enqueue開始: ' + job.processId);
  updateDashboardStatus(job.rowNumber, {
    'ステータス': CONFIG.STATUS.STAGE1_PENDING,
    '処理開始': formatDateTime()
  });

  const folderIds = getFolderIds();
  const userName = job.userName;
  const interviewDate = job.interviewDate;

  let userMaster;
  try {
    userMaster = loadUserMaster(userName);
    if (!userMaster) {
      handleError_(job.processId, job.rowNumber, '利用者「' + job.userName + '」がマスターに見つかりません');
      return;
    }
  } catch (e) {
    handleError_(job.processId, job.rowNumber, 'マスター取得失敗: ' + e.message);
    return;
  }

  const processingFolder = createUserProcessingFolder(folderIds.extracted, userName, interviewDate);

  const chunk = parseChunkLabel_(job.chunkLabel || '');
  const chunkIndex = chunk ? chunk.chunkIndex : null;
  const chunkTotal = chunk ? chunk.chunkTotal : null;

  const result = requestTranscribeEnqueue_(
    job.processId, userName, interviewDate, chunkIndex, chunkTotal, processingFolder.getId()
  );

  if (!result.success) {
    handleError_(job.processId, job.rowNumber, 'Stage1 enqueue失敗: ' + result.error);
    return;
  }

  logInfo('Main', 'Stage1 enqueue完了: ' + job.processId);
}


/**
 * Stage 2: 構造化抽出
 */
function executeStage2_(job) {
  logInfo('Main', `Stage2開始: ${job.processId}`);
  updateDashboardStatus(job.rowNumber, {
    'ステータス': CONFIG.STATUS.STAGE2_RUNNING,
    '処理開始': formatDateTime()
  });

  const userName = job.userName;
  const interviewDate = job.interviewDate;

  let userMaster;
  try {
    userMaster = loadUserMaster(userName);
    if (!userMaster) {
      handleError_(job.processId, job.rowNumber, `利用者「${job.userName}」がマスターに見つかりません`);
      return;
    }
    userMaster.date = interviewDate;
  } catch (e) {
    handleError_(job.processId, job.rowNumber, `マスター取得失敗: ${e.message}`);
    return;
  }

  // 文字起こしファイルからテキストを読み込む
  const transcriptFileId = extractFileIdFromUrl_(job.transcriptUrl);
  const transcriptFile = DriveApp.getFileById(transcriptFileId);
  const transcript = transcriptFile.getBlob().getDataAsString();

  const folderIds = getFolderIds();
  const processingFolder = createUserProcessingFolder(folderIds.extracted, userName, interviewDate);

  const stage2 = runStage2(transcript, userMaster);
  if (!stage2.success) {
    handleError_(job.processId, job.rowNumber, `Stage2失敗: ${stage2.error}`);
    return;
  }

  const extractionFileId = saveExtraction(
    processingFolder.getId(), userName, interviewDate, stage2.data.rawJson
  );

  updateDashboardStatus(job.rowNumber, {
    'ステータス': CONFIG.STATUS.STAGE2_DONE,
    '構造化抽出': getFileUrl(extractionFileId),
    'エラー内容': ''
  });

  logInfo('Main', `Stage2完了: ${job.processId}`);
}


/**
 * Stage 3: 記録票(3A)とシート(3B)を生成し、1つのテンプレートに統合差し込み
 */
function executeStage3_(job) {
  logInfo('Main', `Stage3開始: ${job.processId}`);
  updateDashboardStatus(job.rowNumber, {
    'ステータス': CONFIG.STATUS.STAGE3_RUNNING,
    '処理開始': formatDateTime()
  });

  const userName = job.userName;
  const interviewDate = job.interviewDate;

  let userMaster;
  try {
    userMaster = loadUserMaster(userName);
    if (!userMaster) {
      handleError_(job.processId, job.rowNumber, `利用者「${job.userName}」がマスターに見つかりません`);
      return;
    }
    userMaster.date = interviewDate;
  } catch (e) {
    handleError_(job.processId, job.rowNumber, `マスター取得失敗: ${e.message}`);
    return;
  }

  let extractionData;
  try {
    const extractionFileId = extractFileIdFromUrl_(job.extractionUrl);
    const extractionFile = DriveApp.getFileById(extractionFileId);
    const extractionJson = extractionFile.getBlob().getDataAsString();
    extractionData = JSON.parse(extractionJson);
  } catch (e) {
    handleError_(job.processId, job.rowNumber, `抽出データ読込失敗 (${job.extractionUrl}): ${e.message}`);
    return;
  }

  let recordText = null;
  let sheetData = null;
  let stage3aOk = false;
  let stage3bOk = false;

  // Stage 3-A: 記録票テキスト生成
  try {
    const stage3a = runStage3A(extractionData, userMaster);
    if (stage3a.success) {
      recordText = stage3a.data.text;
      stage3aOk = true;
    } else {
      logError('Main', `Stage3A失敗: ${stage3a.error}`, { processId: job.processId });
    }
  } catch (e) {
    logError('Main', `Stage3A例外: ${e.message}`, { processId: job.processId });
  }

  // Stage 3-B: シートJSON生成
  try {
    const stage3b = runStage3B(extractionData, userMaster);
    if (stage3b.success) {
      sheetData = stage3b.data.parsed;
      stage3bOk = true;
    } else {
      logError('Main', `Stage3B失敗: ${stage3b.error}`, { processId: job.processId });
    }
  } catch (e) {
    logError('Main', `Stage3B例外: ${e.message}`, { processId: job.processId });
  }

  const updates = {};

  if (stage3aOk || stage3bOk) {
    // 1つのテンプレートに統合差し込み（部分成功でも出力する）
    const docResult = fillMonitoringDocument(userMaster, recordText, sheetData, job.chunkLabel || '');
    updates['ドキュメントリンク'] = docResult.url;

    if (stage3aOk && stage3bOk) {
      updates['ステータス'] = CONFIG.STATUS.STAGE3_DONE;
    } else {
      updates['ステータス'] = CONFIG.STATUS.STAGE3_PARTIAL;
      updates['エラー内容'] = stage3aOk ? 'Stage3B失敗（シート部分空欄）' : 'Stage3A失敗（記録票部分空欄）';
    }
    updates['処理完了'] = formatDateTime();
  } else {
    updates['ステータス'] = CONFIG.STATUS.ERROR;
    updates['エラー内容'] = 'Stage3A・Stage3Bともに失敗';
    updates['処理完了'] = formatDateTime();
  }

  updateDashboardStatus(job.rowNumber, updates);

  if (stage3aOk || stage3bOk) {
    const chunkMeta = parseChunkLabel_(normalizeChunkLabel_(job.chunkLabel || ''));
    if (chunkMeta && chunkMeta.chunkTotal > 1) {
      syncChunkGroupAfterLeaderStage3_(userName, interviewDate, chunkMeta.chunkTotal, {
        completedAt: updates['処理完了'],
        docUrl: updates['ドキュメントリンク'] || '',
        extractionUrl: job.extractionUrl || ''
      });
    } else {
      tryArchiveAudioToExtractedFolder_(job.processId, userName, interviewDate);
    }
  }

  logInfo('Main', `Stage3完了: ${job.processId}`, {
    stage3a: stage3aOk,
    stage3b: stage3bOk
  });
}

/**
 * 処理完了後、元音声を 02_処理中 から 03 の利用者サブフォルダへ移動（文字起こし・抽出と同じ場所）
 */
function tryArchiveAudioToExtractedFolder_(audioFileId, userName, interviewDate) {
  try {
    const folderIds = getFolderIds();
    const archiveFolder = createUserProcessingFolder(folderIds.extracted, userName, interviewDate);
    moveFileToFolder(audioFileId, archiveFolder.getId());
    logInfo('Main', `元音声を 03 配下へ移動: ${archiveFolder.getName()}`);
  } catch (e) {
    logWarn('Main', `元音声の移動をスキップ（02に残る可能性）: ${e.message}`);
  }
}


/**
 * Drive URLからファイルIDを抽出する
 */
function extractFileIdFromUrl_(url) {
  if (!url) throw new Error('URLが空です');
  const match = url.match(/\/d\/([^/]+)\//);
  if (match) return match[1];
  // URLがファイルIDそのものの場合
  return url;
}


/**
 * メニューから手動実行: 閾値を無視して停滞ジョブを即座にリカバリする。
 * STAGE1_PENDING → QUEUED, STAGE2_RUNNING → STAGE1_DONE, STAGE3_RUNNING → STAGE2_DONE,
 * および再試行可能な ERROR → STAGE1_DONE。
 */
function manualRecoverStuckJobs() {
  var recovered = 0;

  // STAGE1_PENDING → QUEUED（リトライカウンタ維持）
  var pendingJobs = findRowsByStatus(CONFIG.STATUS.STAGE1_PENDING);
  for (var p = 0; p < pendingJobs.length; p++) {
    var errorContent = pendingJobs[p].errorContent != null ? String(pendingJobs[p].errorContent) : '';
    var recoverCount = parseRecoverCount_(errorContent);
    if (recoverCount >= CONFIG.TRANSCRIBE_MAX_RECOVER_COUNT) continue;
    var newCount = recoverCount + 1;
    logWarn('Main', '手動リカバリ STAGE1_PENDING → QUEUED (' + newCount + '/' + CONFIG.TRANSCRIBE_MAX_RECOVER_COUNT + '): ' + pendingJobs[p].processId);
    updateDashboardStatus(pendingJobs[p].rowNumber, {
      'ステータス': CONFIG.STATUS.QUEUED,
      'エラー内容': '手動リカバリ (' + newCount + '/' + CONFIG.TRANSCRIBE_MAX_RECOVER_COUNT + ')'
    });
    recovered++;
  }

  // STAGE2_RUNNING / STAGE3_RUNNING → 前ステージに戻す
  var runningStatuses = [
    { status: CONFIG.STATUS.STAGE2_RUNNING, recoverTo: CONFIG.STATUS.STAGE1_DONE },
    { status: CONFIG.STATUS.STAGE3_RUNNING, recoverTo: CONFIG.STATUS.STAGE2_DONE }
  ];
  for (var s = 0; s < runningStatuses.length; s++) {
    var jobs = findRowsByStatus(runningStatuses[s].status);
    for (var i = 0; i < jobs.length; i++) {
      logWarn('Main', '手動リカバリ ' + runningStatuses[s].status + ' → ' + runningStatuses[s].recoverTo + ': ' + jobs[i].processId);
      updateDashboardStatus(jobs[i].rowNumber, {
        'ステータス': runningStatuses[s].recoverTo,
        'エラー内容': '手動リカバリ (前ステータス: ' + runningStatuses[s].status + ')'
      });
      recovered++;
    }
  }

  // 再試行可能な ERROR → STAGE1_DONE（カウンタ維持）
  var errorJobs = findRowsByStatus(CONFIG.STATUS.ERROR);
  for (var e = 0; e < errorJobs.length; e++) {
    var errMsg = errorJobs[e].errorContent != null ? String(errorJobs[e].errorContent) : '';
    if (!isRecoverableStage2Error_(errMsg)) continue;
    var s2count = parseStage2ErrorRecoverCount_(errMsg);
    if (s2count >= CONFIG.STAGE2_ERROR_RECOVER_MAX) continue;
    var newS2 = s2count + 1;
    logWarn('Main', '手動リカバリ Stage2 ERROR → STAGE1_DONE (' + newS2 + '/' + CONFIG.STAGE2_ERROR_RECOVER_MAX + '): ' + errorJobs[e].processId);
    updateDashboardStatus(errorJobs[e].rowNumber, {
      'ステータス': CONFIG.STATUS.STAGE1_DONE,
      'エラー内容': 'Stage2再試行 (' + newS2 + '/' + CONFIG.STAGE2_ERROR_RECOVER_MAX + ') 手動リカバリ 前回: ' + errMsg.substring(0, 400)
    });
    recovered++;
  }

  var msg = recovered > 0
    ? recovered + ' 件のジョブをリカバリしました。次回の処理実行で再処理されます。'
    : 'リカバリ対象のジョブはありませんでした。';
  SpreadsheetApp.getUi().alert(msg);
}


/**
 * タイムアウトしたジョブ（_RUNNING/_PENDING 状態で一定時間経過）を前ステージに戻す。
 * STAGE1_PENDING はリトライカウンタ付き: 3回超過で ERROR に落とす。
 */
function recoverTimedOutJobs_() {
  var now = Date.now();

  // Stage2/3 の RUNNING 回復（従来どおり 30 分）
  var runningStatuses = [
    { status: CONFIG.STATUS.STAGE2_RUNNING, recoverTo: CONFIG.STATUS.STAGE1_DONE, threshold: CONFIG.TIMEOUT_THRESHOLD_MS },
    { status: CONFIG.STATUS.STAGE3_RUNNING, recoverTo: CONFIG.STATUS.STAGE2_DONE, threshold: CONFIG.TIMEOUT_THRESHOLD_MS }
  ];

  for (var s = 0; s < runningStatuses.length; s++) {
    var jobs = findRowsByStatus(runningStatuses[s].status);
    for (var i = 0; i < jobs.length; i++) {
      var updatedAt = jobs[i].updatedAt;
      if (updatedAt) {
        var updatedTime = new Date(updatedAt).getTime();
        if (now - updatedTime > runningStatuses[s].threshold) {
          logWarn('Main', 'タイムアウト回復: ' + jobs[i].processId + ' (' + runningStatuses[s].status + ' → ' + runningStatuses[s].recoverTo + ')');
          updateDashboardStatus(jobs[i].rowNumber, {
            'ステータス': runningStatuses[s].recoverTo,
            'エラー内容': 'タイムアウト回復 (前ステータス: ' + runningStatuses[s].status + ')'
          });
        }
      }
    }
  }

  // Stage2 が ERROR かつ JSON/トークン切れ等の一時失敗 → STAGE1_DONE に戻して次回から Stage2 再実行
  var errorJobs = findRowsByStatus(CONFIG.STATUS.ERROR);
  for (var e = 0; e < errorJobs.length; e++) {
    var errMsg = errorJobs[e].errorContent != null ? String(errorJobs[e].errorContent) : '';
    if (!isRecoverableStage2Error_(errMsg)) continue;
    var s2count = parseStage2ErrorRecoverCount_(errMsg);
    if (s2count >= CONFIG.STAGE2_ERROR_RECOVER_MAX) {
      continue;
    }
    var newS2 = s2count + 1;
    logWarn('Main', 'Stage2 ERROR 自動再試行 (' + newS2 + '/' + CONFIG.STAGE2_ERROR_RECOVER_MAX + '): ' + errorJobs[e].processId);
    updateDashboardStatus(errorJobs[e].rowNumber, {
      'ステータス': CONFIG.STATUS.STAGE1_DONE,
      'エラー内容': 'Stage2再試行 (' + newS2 + '/' + CONFIG.STAGE2_ERROR_RECOVER_MAX + ') 前回: ' + errMsg.substring(0, 400)
    });
  }

  // STAGE1_PENDING 回復（60 分、リトライカウンタ付き）
  var pendingJobs = findRowsByStatus(CONFIG.STATUS.STAGE1_PENDING);
  for (var p = 0; p < pendingJobs.length; p++) {
    var pUpdatedAt = pendingJobs[p].updatedAt;
    if (!pUpdatedAt) continue;
    var pUpdatedTime = new Date(pUpdatedAt).getTime();
    if (now - pUpdatedTime <= CONFIG.TRANSCRIBE_TIMEOUT_THRESHOLD_MS) continue;

    // エラー内容からリトライ回数を抽出（findRowsByStatus で一括取得済み）
    var errorContent = pendingJobs[p].errorContent != null ? String(pendingJobs[p].errorContent) : '';
    var recoverCount = parseRecoverCount_(errorContent);

    if (recoverCount >= CONFIG.TRANSCRIBE_MAX_RECOVER_COUNT) {
      logError('Main', 'リトライ上限超過: ' + pendingJobs[p].processId);
      updateDashboardStatus(pendingJobs[p].rowNumber, {
        'ステータス': CONFIG.STATUS.ERROR,
        'エラー内容': 'リトライ上限超過（' + CONFIG.TRANSCRIBE_MAX_RECOVER_COUNT + '回タイムアウト）',
        '処理完了': formatDateTime()
      });
    } else {
      var newCount = recoverCount + 1;
      logWarn('Main', 'STAGE1_PENDING タイムアウト回復 (' + newCount + '/' + CONFIG.TRANSCRIBE_MAX_RECOVER_COUNT + '): ' + pendingJobs[p].processId);
      updateDashboardStatus(pendingJobs[p].rowNumber, {
        'ステータス': CONFIG.STATUS.QUEUED,
        'エラー内容': 'タイムアウト回復 (' + newCount + '/' + CONFIG.TRANSCRIBE_MAX_RECOVER_COUNT + ')'
      });
    }
  }
}


/** "タイムアウト回復 (N/M)" から N を抽出。見つからなければ 0。 */
function parseRecoverCount_(errorContent) {
  if (!errorContent) return 0;
  var m = errorContent.match(/タイムアウト回復\s*\((\d+)\//);
  if (m) return parseInt(m[1], 10);
  return 0;
}

/**
 * Stage2失敗の ERROR で、JSON 切れ・トークン上限・実行時間切れ等の再試行に値するか。
 * マスター不備などの恒久的エラーは false。
 */
function isRecoverableStage2Error_(msg) {
  if (!msg || msg.indexOf('Stage2失敗') === -1) return false;
  if (msg.indexOf('マスターに見つかりません') !== -1) return false;
  if (msg.indexOf('マスター取得失敗') !== -1) return false;
  var markers = ['JSON', 'Unterminated', 'MAX_TOKENS', 'finishReason', 'SyntaxError', 'Unexpected', 'truncat', '起動時間の最大値'];
  for (var i = 0; i < markers.length; i++) {
    if (msg.indexOf(markers[i]) !== -1) return true;
  }
  return false;
}

/** "Stage2再試行 (N/M)" の N の最大値（複数行・追記後も想定）。無ければ 0。 */
function parseStage2ErrorRecoverCount_(errorContent) {
  if (!errorContent) return 0;
  var re = /Stage2再試行\s*\((\d+)\//g;
  var max = 0;
  var m;
  while ((m = re.exec(errorContent)) !== null) {
    var n = parseInt(m[1], 10);
    if (n > max) max = n;
  }
  return max;
}


function handleError_(processId, dashboardRow, errorMessage) {
  logError('Main', errorMessage, { processId: processId });

  var msgOut = String(errorMessage);
  // Stage2再試行 (N/M) のカウント進行は recoverTimedOutJobs_ のみ。ここでは進めない。
  // STAGE1_DONE 直後など、セルに残った「Stage2再試行 (N/M) 前回:…」を追記して recover が N を解釈できるようにする。
  if (msgOut.indexOf('Stage2失敗') !== -1) {
    try {
      var ss = SpreadsheetApp.openById(getSpreadsheetId());
      var sheet = ss.getSheetByName(CONFIG.SHEET_NAMES.STATUS);
      var hdr = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
      var ci = hdr.indexOf('エラー内容');
      if (ci !== -1) {
        var prev = String(sheet.getRange(dashboardRow, ci + 1).getValue() || '');
        if (prev && parseStage2ErrorRecoverCount_(prev) > 0) {
          msgOut = msgOut + '\n---\n' + prev;
        }
      }
    } catch (ignore) {}
  }

  updateDashboardStatus(dashboardRow, {
    'ステータス': CONFIG.STATUS.ERROR,
    'エラー内容': msgOut,
    '処理完了': formatDateTime()
  });
}


// =====================================================
// 手動実行用関数
// =====================================================

/**
 * 特定ファイルIDを指定してキュー登録（デバッグ・テスト用）
 */
function processSpecificFile(fileId) {
  const file = DriveApp.getFileById(fileId);
  enqueueFile_({
    id: file.getId(),
    name: file.getName(),
    mimeType: file.getMimeType(),
    createdDate: file.getDateCreated(),
    driveFile: file
  });
  // 登録後、即座にディスパッチ
  dispatchNextStage_(Date.now());
}

/**
 * 承認処理：ダッシュボードで「承認済み」にマークし、ファイルを移動
 */
function approveRecord(processId) {
  const row = findDashboardRowByProcessId(processId);
  if (row === -1) {
    logError('Main', `処理IDが見つかりません: ${processId}`);
    return;
  }

  updateDashboardStatus(row, {
    'ステータス': CONFIG.STATUS.APPROVED,
    '担当者承認': formatDateTime()
  });

  logInfo('Main', `承認完了: ${processId}`);
}


// =====================================================
// セットアップ・トリガー管理
// =====================================================

/**
 * 初回セットアップ：ダッシュボード初期化 + フォルダ構築 + トリガー設定
 */
function initialSetup() {
  logInfo('Setup', '初回セットアップ開始');

  setupFolderStructure();
  initDashboard();
  setupTrigger();

  const templateCheck = listTemplatePlaceholders();
  logInfo('Setup', 'テンプレート確認', templateCheck);

  logInfo('Setup', '初回セットアップ完了');
  SpreadsheetApp.getUi().alert(
    'セットアップ完了\n\n'
    + '1. Google Drive でフォルダ構成を確認してください（ルートはスプレッドシートと同じフォルダ内に作成されます）\n'
    + '2. 利用者マスターシートにデータを入力してください\n'
    + '3. テンプレートIDをScript Propertiesに設定してください\n'
    + '4. 音声ファイルを「01_未処理」フォルダにアップロードしてください'
  );
}


/**
 * フォルダ関連のスクリプトプロパティをすべて削除（Drive 手動削除後に古いIDが残る場合の対策）
 */
function clearFolderScriptProperties_() {
  const props = PropertiesService.getScriptProperties();
  const keys = [
    'FOLDER_ID_ROOT',
    'FOLDER_ID_MASTER',
    'FOLDER_ID_UNPROCESSED',
    'FOLDER_ID_PROCESSING',
    'FOLDER_ID_EXTRACTED',
    'FOLDER_ID_DRAFT',
    'FOLDER_ID_APPROVED',
    'FOLDER_ID_ERROR'
  ];
  for (let i = 0; i < keys.length; i++) {
    props.deleteProperty(keys[i]);
  }
}
function setupFolderStructure() {
  const props = PropertiesService.getScriptProperties();
  let rootId = props.getProperty('FOLDER_ID_ROOT');

  if (rootId && !folderExists_(rootId)) {
    logWarn('Setup', '保存済みルートフォルダがDrive上にありません。フォルダIDをクリアして再作成します。');
    clearFolderScriptProperties_();
    rootId = null;
  }

  if (!rootId) {
    const parent = getSpreadsheetParentFolder_();
    const rootFolder = createSubfolder(parent.getId(), CONFIG.FOLDER_NAMES.ROOT);
    rootId = rootFolder.getId();
    props.setProperty('FOLDER_ID_ROOT', rootId);
    logInfo('Setup', `ルートフォルダ作成（親: ${parent.getName()}）: ${rootId}`);
  }

  const folderMap = {
    'FOLDER_ID_UNPROCESSED': CONFIG.FOLDER_NAMES.UNPROCESSED,
    'FOLDER_ID_PROCESSING': CONFIG.FOLDER_NAMES.PROCESSING,
    'FOLDER_ID_EXTRACTED': CONFIG.FOLDER_NAMES.EXTRACTED,
    'FOLDER_ID_DRAFT': CONFIG.FOLDER_NAMES.DRAFT,
    'FOLDER_ID_APPROVED': CONFIG.FOLDER_NAMES.APPROVED,
    'FOLDER_ID_ERROR': CONFIG.FOLDER_NAMES.ERROR
  };

  const keys = Object.keys(folderMap);
  for (let i = 0; i < keys.length; i++) {
    const propKey = keys[i];
    let subId = props.getProperty(propKey);
    if (!subId || !folderExists_(subId)) {
      if (subId) {
        logWarn('Setup', `サブフォルダIDが無効のため再作成: ${folderMap[propKey]}`);
        props.deleteProperty(propKey);
      }
      const folder = createSubfolder(rootId, folderMap[propKey]);
      props.setProperty(propKey, folder.getId());
      logInfo('Setup', `サブフォルダ作成: ${folderMap[propKey]} (${folder.getId()})`);
    }
  }
}


function setupTrigger() {
  const triggers = ScriptApp.getProjectTriggers();
  for (let i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'processNewFiles') {
      ScriptApp.deleteTrigger(triggers[i]);
    }
  }

  ScriptApp.newTrigger('processNewFiles')
    .timeBased()
    .everyMinutes(CONFIG.POLL_INTERVAL_MINUTES)
    .create();

  logInfo('Setup', `トリガー設定: ${CONFIG.POLL_INTERVAL_MINUTES}分間隔`);
}


function removeTrigger() {
  const triggers = ScriptApp.getProjectTriggers();
  let removed = 0;
  for (let i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'processNewFiles') {
      ScriptApp.deleteTrigger(triggers[i]);
      removed++;
    }
  }
  logInfo('Setup', `トリガー削除: ${removed}個`);
}


/**
 * カスタムメニュー追加（スプレッドシート用）
 */
function onOpen() {
  const ui = SpreadsheetApp.getUi();
  ui.createMenu('グローポイント AI支援')
    .addItem('初回セットアップ', 'initialSetup')
    .addSeparator()
    .addItem('今すぐ処理実行', 'processNewFiles')
    .addItem('停滞ジョブを手動リカバリ', 'manualRecoverStuckJobs')
    .addItem('ダッシュボードサマリー', 'showSummary')
    .addSeparator()
    .addItem('テンプレート確認', 'showTemplateStatus')
    .addItem('トリガー停止', 'removeTrigger')
    .addToUi();
}


function showSummary() {
  const summary = getDashboardSummary();
  SpreadsheetApp.getUi().alert(
    `処理状況サマリー\n\n`
    + `合計: ${summary.total}件\n`
    + `待機中: ${summary.queued}件\n`
    + `処理中: ${summary.processing}件\n`
    + `完了: ${summary.done}件\n`
    + `部分完了: ${summary.partial}件\n`
    + `承認済み: ${summary.approved}件\n`
    + `エラー: ${summary.error}件`
  );
}


function showTemplateStatus() {
  const status = listTemplatePlaceholders();
  let msg = 'テンプレート状況\n\n';

  msg += '【計画モニタ（統合テンプレート）】\n';
  if (status.monitoringDocument.success) {
    msg += `  OK: ${status.monitoringDocument.name}\n`;
    msg += `  プレースホルダ数: ${status.monitoringDocument.placeholderCount}\n`;
    msg += `  プレースホルダ: ${status.monitoringDocument.placeholders.join(', ')}\n`;
  } else {
    msg += `  NG: ${status.monitoringDocument.error}\n`;
  }

  SpreadsheetApp.getUi().alert(msg);
}
