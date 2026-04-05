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
 */
function enqueueFile_(audioFile) {
  const parsed = parseFileNameForUser(audioFile.name);

  // 重複チェック（取り込み前・同一ファイルID）
  logInfo('Main', `enqueue開始: ${audioFile.name}`, { fileId: audioFile.id, owner: audioFile.driveFile ? audioFile.driveFile.getOwner().getEmail() : '不明' });

  const existingRow = findDashboardRowByProcessId(audioFile.id);
  if (existingRow !== -1) {
    logInfo('Main', `重複スキップ: ${audioFile.name} (${audioFile.id})`);
    return;
  }
  logInfo('Main', '重複チェック通過');

  const claimed = claimAudioForProcessing_(audioFile);
  const processId = claimed.id;
  logInfo('Main', 'claim完了', { processId: processId });

  const dashboardRow = addDashboardRow(
    processId, parsed.userName, parsed.date, claimed.name, CONFIG.STATUS.QUEUED
  );

  logInfo('Main', 'キュー登録完了', {
    processId: processId,
    file: claimed.name,
    user: parsed.userName,
    date: parsed.date,
    row: dashboardRow
  });
}


/**
 * Stage 1: 文字起こし
 */
function executeStage1_(job) {
  logInfo('Main', `Stage1開始: ${job.processId}`);
  updateDashboardStatus(job.rowNumber, {
    'ステータス': CONFIG.STATUS.STAGE1_RUNNING,
    '処理開始': formatDateTime()
  });

  const folderIds = getFolderIds();
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

  const processingFolder = createUserProcessingFolder(folderIds.extracted, userName, interviewDate);

  const stage1 = runStage1(job.processId);
  if (!stage1.success) {
    handleError_(job.processId, job.rowNumber, `Stage1失敗: ${stage1.error}`);
    return;
  }

  const transcriptFileId = saveTranscript(
    processingFolder.getId(), userName, interviewDate, stage1.data.transcript
  );

  updateDashboardStatus(job.rowNumber, {
    'ステータス': CONFIG.STATUS.STAGE1_DONE,
    '文字起こし': getFileUrl(transcriptFileId)
  });

  logInfo('Main', `Stage1完了: ${job.processId}`);
}


/**
 * Stage 2: 構造化抽出
 */
function executeStage2_(job) {
  logInfo('Main', `Stage2開始: ${job.processId}`);
  updateDashboardStatus(job.rowNumber, {
    'ステータス': CONFIG.STATUS.STAGE2_RUNNING
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
    '構造化抽出': getFileUrl(extractionFileId)
  });

  logInfo('Main', `Stage2完了: ${job.processId}`);
}


/**
 * Stage 3: 記録票(3A)とシート(3B)を生成し、1つのテンプレートに統合差し込み
 */
function executeStage3_(job) {
  logInfo('Main', `Stage3開始: ${job.processId}`);
  updateDashboardStatus(job.rowNumber, {
    'ステータス': CONFIG.STATUS.STAGE3_RUNNING
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

  const extractionFileId = extractFileIdFromUrl_(job.extractionUrl);
  const extractionFile = DriveApp.getFileById(extractionFileId);
  const extractionJson = extractionFile.getBlob().getDataAsString();
  const extractionData = JSON.parse(extractionJson);

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
    const docResult = fillMonitoringDocument(userMaster, recordText, sheetData);
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
    tryArchiveAudioToExtractedFolder_(job.processId, userName, interviewDate);
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
 * タイムアウトしたジョブ（_RUNNING状態で一定時間経過）をQUEUEDまたは前ステージ完了に戻す
 */
function recoverTimedOutJobs_() {
  const now = Date.now();
  const runningStatuses = [
    { status: CONFIG.STATUS.STAGE1_RUNNING, recoverTo: CONFIG.STATUS.QUEUED },
    { status: CONFIG.STATUS.STAGE2_RUNNING, recoverTo: CONFIG.STATUS.STAGE1_DONE },
    { status: CONFIG.STATUS.STAGE3_RUNNING, recoverTo: CONFIG.STATUS.STAGE2_DONE }
  ];

  for (let s = 0; s < runningStatuses.length; s++) {
    const jobs = findRowsByStatus(runningStatuses[s].status);
    for (let i = 0; i < jobs.length; i++) {
      const updatedAt = jobs[i].updatedAt;
      if (updatedAt) {
        const updatedTime = new Date(updatedAt).getTime();
        if (now - updatedTime > CONFIG.TIMEOUT_THRESHOLD_MS) {
          logWarn('Main', `タイムアウト回復: ${jobs[i].processId} (${runningStatuses[s].status} → ${runningStatuses[s].recoverTo})`);
          updateDashboardStatus(jobs[i].rowNumber, {
            'ステータス': runningStatuses[s].recoverTo,
            'エラー内容': `タイムアウト回復 (前ステータス: ${runningStatuses[s].status})`
          });
        }
      }
    }
  }
}


function handleError_(processId, dashboardRow, errorMessage) {
  logError('Main', errorMessage, { processId: processId });

  updateDashboardStatus(dashboardRow, {
    'ステータス': CONFIG.STATUS.ERROR,
    'エラー内容': errorMessage,
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
    + '1. Google Drive にフォルダ構成を確認してください\n'
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
    const rootFolder = DriveApp.createFolder(CONFIG.FOLDER_NAMES.ROOT);
    rootId = rootFolder.getId();
    props.setProperty('FOLDER_ID_ROOT', rootId);
    logInfo('Setup', `ルートフォルダ作成: ${rootId}`);
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
