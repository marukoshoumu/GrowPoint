/**
 * メインエントリポイント：未処理音声ファイルを検出し、パイプラインを実行する。
 * 時間ベースのトリガーから呼び出される。
 */
function processNewFiles() {
  const audioFiles = detectNewAudioFiles();

  if (audioFiles.length === 0) {
    logInfo('Main', '未処理ファイルなし');
    return;
  }

  for (let i = 0; i < audioFiles.length; i++) {
    try {
      processSingleFile(audioFiles[i]);
    } catch (e) {
      logError('Main', `処理失敗: ${audioFiles[i].name}`, { error: e.message, stack: e.stack });
    }
  }
}


/**
 * 単一音声ファイルの全パイプライン処理
 */
function processSingleFile(audioFile) {
  const processId = Utilities.getUuid();
  const parsed = parseFileNameForUser(audioFile.name);
  const userName = parsed.userName;
  const interviewDate = parsed.date;

  logInfo('Main', 'パイプライン開始', {
    processId: processId,
    file: audioFile.name,
    user: userName,
    date: interviewDate
  });

  const dashboardRow = addDashboardRow(
    processId, userName, interviewDate, audioFile.name, CONFIG.STATUS.PROCESSING
  );

  moveToProcessing(audioFile.id);

  let userMaster;
  try {
    userMaster = loadUserMaster(userName);
    userMaster.date = interviewDate;
  } catch (e) {
    handleError_(processId, dashboardRow, audioFile.id, `マスター取得失敗: ${e.message}`);
    return;
  }

  const folderIds = getFolderIds();
  const processingFolder = createUserProcessingFolder(folderIds.extracted, userName, interviewDate);

  // === Stage 1: 文字起こし ===
  updateDashboardStatus(dashboardRow, { 'ステータス': '文字起こし中...' });
  const stage1 = runStage1(audioFile.id);
  if (!stage1.success) {
    handleError_(processId, dashboardRow, audioFile.id, `Stage1失敗: ${stage1.error}`);
    return;
  }

  const transcriptFileId = saveTranscript(processingFolder.getId(), userName, interviewDate, stage1.transcript);
  updateDashboardStatus(dashboardRow, {
    '文字起こし': getFileUrl(transcriptFileId)
  });

  // === Stage 2: 構造化抽出 ===
  updateDashboardStatus(dashboardRow, { 'ステータス': '構造化抽出中...' });
  const stage2 = runStage2(stage1.transcript, userMaster);
  if (!stage2.success) {
    handleError_(processId, dashboardRow, audioFile.id, `Stage2失敗: ${stage2.error}`);
    return;
  }

  const extractionFileId = saveExtraction(processingFolder.getId(), userName, interviewDate, stage2.rawJson);
  updateDashboardStatus(dashboardRow, {
    '構造化抽出': getFileUrl(extractionFileId)
  });

  // === Stage 3-A: モニタリング記録票 ===
  updateDashboardStatus(dashboardRow, { 'ステータス': '記録票生成中...' });
  const stage3a = runStage3A(stage2.data, userMaster);
  if (!stage3a.success) {
    handleError_(processId, dashboardRow, audioFile.id, `Stage3A失敗: ${stage3a.error}`);
    return;
  }

  const recordResult = fillMonitoringRecord(userMaster, stage3a.text);
  updateDashboardStatus(dashboardRow, {
    '記録票リンク': recordResult.url
  });

  // === Stage 3-B: モニタリングシート ===
  updateDashboardStatus(dashboardRow, { 'ステータス': 'シート生成中...' });
  const stage3b = runStage3B(stage2.data, userMaster);
  if (!stage3b.success) {
    handleError_(processId, dashboardRow, audioFile.id, `Stage3B失敗: ${stage3b.error}`);
    return;
  }

  const sheetResult = fillMonitoringSheet(userMaster, stage3b.data);

  // === 完了 ===
  updateDashboardStatus(dashboardRow, {
    'ステータス': CONFIG.STATUS.DRAFT_READY,
    'シートリンク': sheetResult.url,
    '処理完了': formatDateTime()
  });

  logInfo('Main', 'パイプライン完了', {
    processId: processId,
    user: userName,
    recordUrl: recordResult.url,
    sheetUrl: sheetResult.url
  });
}


function handleError_(processId, dashboardRow, audioFileId, errorMessage) {
  logError('Main', errorMessage, { processId: processId });

  updateDashboardStatus(dashboardRow, {
    'ステータス': CONFIG.STATUS.ERROR,
    'エラー内容': errorMessage,
    '処理完了': formatDateTime()
  });

  try {
    moveToError(audioFileId);
  } catch (e) {
    logError('Main', 'エラーフォルダへの移動にも失敗', { error: e.message });
  }
}


// =====================================================
// 手動実行用関数
// =====================================================

/**
 * 特定ファイルIDを指定して処理（デバッグ・テスト用）
 */
function processSpecificFile(fileId) {
  const file = DriveApp.getFileById(fileId);
  processSingleFile({
    id: file.getId(),
    name: file.getName(),
    mimeType: file.getMimeType(),
    createdDate: file.getDateCreated()
  });
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


function setupFolderStructure() {
  const props = PropertiesService.getScriptProperties();
  let rootId = props.getProperty('FOLDER_ID_ROOT');

  if (!rootId) {
    const rootFolder = DriveApp.createFolder(CONFIG.FOLDER_NAMES.ROOT);
    rootId = rootFolder.getId();
    props.setProperty('FOLDER_ID_ROOT', rootId);
    logInfo('Setup', `ルートフォルダ作成: ${rootId}`);
  }

  const folderMap = {
    'FOLDER_ID_MASTER': CONFIG.FOLDER_NAMES.MASTER,
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
    const existing = props.getProperty(propKey);
    if (!existing) {
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
    .timeDriven()
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
    + `未処理: ${summary.unprocessed}件\n`
    + `処理中: ${summary.processing}件\n`
    + `ドラフト完了: ${summary.draftReady}件\n`
    + `承認済み: ${summary.approved}件\n`
    + `エラー: ${summary.error}件`
  );
}


function showTemplateStatus() {
  const status = listTemplatePlaceholders();
  let msg = 'テンプレート状況\n\n';

  msg += '【モニタリング記録票】\n';
  if (status.monitoringRecord.valid) {
    msg += `  OK: ${status.monitoringRecord.name}\n`;
    msg += `  プレースホルダ: ${status.monitoringRecord.placeholders.join(', ')}\n`;
  } else {
    msg += `  NG: ${status.monitoringRecord.error}\n`;
  }

  msg += '\n【モニタリングシート】\n';
  if (status.monitoringSheet.valid) {
    msg += `  OK: ${status.monitoringSheet.name}\n`;
    msg += `  プレースホルダ: ${status.monitoringSheet.placeholders.join(', ')}\n`;
  } else {
    msg += `  NG: ${status.monitoringSheet.error}\n`;
  }

  SpreadsheetApp.getUi().alert(msg);
}
