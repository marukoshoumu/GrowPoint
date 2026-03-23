const DASHBOARD_HEADERS = [
  '処理ID', '利用者名', '面談日', '音声ファイル',
  'ステータス', '文字起こし', '構造化抽出',
  '記録票リンク', 'シートリンク', '処理開始', '処理完了',
  'エラー内容', '担当者承認'
];

function initDashboard() {
  const ssId = getSpreadsheetId();
  const ss = SpreadsheetApp.openById(ssId);

  let sheet = ss.getSheetByName(CONFIG.SHEET_NAMES.STATUS);
  if (!sheet) {
    sheet = ss.insertSheet(CONFIG.SHEET_NAMES.STATUS);
  }

  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, DASHBOARD_HEADERS.length).setValues([DASHBOARD_HEADERS]);
    sheet.getRange(1, 1, 1, DASHBOARD_HEADERS.length)
      .setBackground('#4285f4')
      .setFontColor('#ffffff')
      .setFontWeight('bold');
    sheet.setFrozenRows(1);
  }

  initUserMasterSheet_(ss);
  initGlossarySheet_(ss);
  initLogSheet_(ss);

  logInfo('Dashboard', 'ダッシュボード初期化完了');
  return sheet;
}


function initUserMasterSheet_(ss) {
  let sheet = ss.getSheetByName(CONFIG.SHEET_NAMES.USER_MASTER);
  if (sheet) return;

  sheet = ss.insertSheet(CONFIG.SHEET_NAMES.USER_MASTER);
  const headers = [
    '利用者名', '担当者名', 'サービス管理責任者',
    '長期目標', '短期目標①', '支援内容①', '期間①',
    '短期目標②', '支援内容②', '期間②',
    '前回モニタリング日', '次回モニタリング予定月',
    '前回の主な課題', '出席者'
  ];
  sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  sheet.getRange(1, 1, 1, headers.length)
    .setBackground('#34a853')
    .setFontColor('#ffffff')
    .setFontWeight('bold');
  sheet.setFrozenRows(1);
}


function initGlossarySheet_(ss) {
  let sheet = ss.getSheetByName(CONFIG.SHEET_NAMES.GLOSSARY);
  if (sheet) return;

  sheet = ss.insertSheet(CONFIG.SHEET_NAMES.GLOSSARY);
  const headers = ['用語', '読み', '正式名称', '備考'];
  sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  sheet.getRange(1, 1, 1, headers.length)
    .setBackground('#fbbc04')
    .setFontColor('#000000')
    .setFontWeight('bold');
  sheet.setFrozenRows(1);

  const defaultTerms = [
    ['サビ管', 'さびかん', 'サービス管理責任者', ''],
    ['工賃', 'こうちん', '利用者への作業報酬', ''],
    ['B型', 'びーがた', '就労継続支援B型', ''],
    ['A型', 'えーがた', '就労継続支援A型', '雇用契約あり'],
    ['GH', '', 'グループホーム（共同生活援助）', ''],
    ['就労移行', '', '就労移行支援', '一般就労を目指す訓練']
  ];
  sheet.getRange(2, 1, defaultTerms.length, 4).setValues(defaultTerms);
}


function initLogSheet_(ss) {
  let sheet = ss.getSheetByName(CONFIG.SHEET_NAMES.LOG);
  if (sheet) return;

  sheet = ss.insertSheet(CONFIG.SHEET_NAMES.LOG);
  const headers = ['日時', 'レベル', 'コンテキスト', 'メッセージ', 'データ'];
  sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  sheet.getRange(1, 1, 1, headers.length)
    .setBackground('#ea4335')
    .setFontColor('#ffffff')
    .setFontWeight('bold');
  sheet.setFrozenRows(1);
}


function addDashboardRow(processId, userName, interviewDate, audioFileName, status) {
  const ssId = getSpreadsheetId();
  const ss = SpreadsheetApp.openById(ssId);
  const sheet = ss.getSheetByName(CONFIG.SHEET_NAMES.STATUS);

  const row = [
    processId,
    userName,
    interviewDate,
    audioFileName,
    status,
    '', '', '', '',
    formatDateTime(),
    '', '', ''
  ];

  sheet.appendRow(row);
  return sheet.getLastRow();
}


function updateDashboardStatus(rowNumber, updates) {
  const ssId = getSpreadsheetId();
  const ss = SpreadsheetApp.openById(ssId);
  const sheet = ss.getSheetByName(CONFIG.SHEET_NAMES.STATUS);

  const columnMap = {};
  for (let i = 0; i < DASHBOARD_HEADERS.length; i++) {
    columnMap[DASHBOARD_HEADERS[i]] = i + 1;
  }

  const keys = Object.keys(updates);
  for (let j = 0; j < keys.length; j++) {
    const col = columnMap[keys[j]];
    if (col) {
      sheet.getRange(rowNumber, col).setValue(updates[keys[j]]);
    }
  }
}


function findDashboardRowByProcessId(processId) {
  const ssId = getSpreadsheetId();
  const ss = SpreadsheetApp.openById(ssId);
  const sheet = ss.getSheetByName(CONFIG.SHEET_NAMES.STATUS);
  const data = sheet.getDataRange().getValues();

  for (let i = 1; i < data.length; i++) {
    if (data[i][0] === processId) {
      return i + 1;
    }
  }
  return -1;
}


function loadUserMaster(userName) {
  const ssId = getSpreadsheetId();
  const ss = SpreadsheetApp.openById(ssId);
  const sheet = ss.getSheetByName(CONFIG.SHEET_NAMES.USER_MASTER);
  if (!sheet) throw new Error('利用者マスターシートが見つかりません');

  const data = sheet.getDataRange().getValues();

  for (let i = 1; i < data.length; i++) {
    if (data[i][0] === userName) {
      return {
        name: data[i][0],
        staff: data[i][1],
        serviceManager: data[i][2],
        longTermGoal: data[i][3],
        shortTermGoal1: data[i][4],
        supportContent1: data[i][5],
        goal1Period: data[i][6],
        shortTermGoal2: data[i][7],
        supportContent2: data[i][8],
        goal2Period: data[i][9],
        previousMonitoringDate: data[i][10] ? formatDate(new Date(data[i][10])) : '',
        nextMonitoringMonth: data[i][11],
        previousIssues: data[i][12],
        attendees: data[i][13],
        shortTermGoals: [data[i][4], data[i][7]].filter(Boolean)
      };
    }
  }

  throw new Error(`利用者マスターに「${userName}」が見つかりません`);
}


function getDashboardSummary() {
  const ssId = getSpreadsheetId();
  const ss = SpreadsheetApp.openById(ssId);
  const sheet = ss.getSheetByName(CONFIG.SHEET_NAMES.STATUS);
  const data = sheet.getDataRange().getValues();

  const summary = {
    total: data.length - 1,
    queued: 0,
    processing: 0,
    done: 0,
    partial: 0,
    approved: 0,
    error: 0
  };

  for (let i = 1; i < data.length; i++) {
    const status = data[i][4];
    switch (status) {
      case CONFIG.STATUS.QUEUED:         summary.queued++; break;
      case CONFIG.STATUS.STAGE1_RUNNING:
      case CONFIG.STATUS.STAGE1_DONE:
      case CONFIG.STATUS.STAGE2_RUNNING:
      case CONFIG.STATUS.STAGE2_DONE:
      case CONFIG.STATUS.STAGE3_RUNNING: summary.processing++; break;
      case CONFIG.STATUS.STAGE3_DONE:    summary.done++; break;
      case CONFIG.STATUS.STAGE3_PARTIAL: summary.partial++; break;
      case CONFIG.STATUS.APPROVED:       summary.approved++; break;
      case CONFIG.STATUS.ERROR:          summary.error++; break;
    }
  }

  return summary;
}


function findRowsByStatus(targetStatus) {
  const ss = SpreadsheetApp.openById(getSpreadsheetId());
  const sheet = ss.getSheetByName(CONFIG.SHEET_NAMES.STATUS);
  if (!sheet || sheet.getLastRow() < 2) return [];

  const data = sheet.getDataRange().getValues();
  const headers = data[0];
  const col = {};
  headers.forEach((h, i) => { col[h] = i; });

  const results = [];
  for (let i = 1; i < data.length; i++) {
    if (data[i][col['ステータス']] === targetStatus) {
      results.push({
        rowNumber: i + 1,
        processId: data[i][col['処理ID']],
        userName: data[i][col['利用者名']],
        audioFileName: data[i][col['音声ファイル']],
        interviewDate: data[i][col['面談日']],
        transcriptUrl: data[i][col['文字起こし']],
        extractionUrl: data[i][col['構造化抽出']],
        updatedAt: data[i][col['処理開始']]
      });
    }
  }
  return results;
}
