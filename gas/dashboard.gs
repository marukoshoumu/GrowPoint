const DASHBOARD_HEADERS = [
  '処理ID', '利用者名', '面談日', '音声ファイル',
  'ステータス', '文字起こし', '構造化抽出',
  'ドキュメントリンク', '処理開始', '処理完了',
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
    'サービスの種類', '計画作成年月日', '同意日',
    '本人の意向', '長期目標',
    '短期目標①', '支援内容①', '期間①',
    '短期目標②', '支援内容②', '期間②',
    '計画特記事項',
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
    '', '', '',
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

  const headers = data[0];
  const col = {};
  headers.forEach((h, i) => col[h] = i);

  for (let i = 1; i < data.length; i++) {
    if (data[i][col['処理ID']] === processId) {
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
  const headers = data[0];
  const col = {};
  headers.forEach(function(h, i) { col[h] = i; });

  for (let i = 1; i < data.length; i++) {
    if (data[i][col['利用者名']] === userName) {
      const row = data[i];
      const prevDate = row[col['前回モニタリング日']];
      const creationDate = row[col['計画作成年月日']];
      const consentDate = row[col['同意日']];
      return {
        name: row[col['利用者名']],
        staff: row[col['担当者名']],
        manager: row[col['サービス管理責任者']],
        serviceType: row[col['サービスの種類']] || '就労継続支援B型',
        creationDate: creationDate ? new Date(creationDate) : null,
        consentDate: consentDate ? new Date(consentDate) : null,
        planNeeds: row[col['本人の意向']] || '',
        longTermGoal: row[col['長期目標']],
        shortTermGoal1: row[col['短期目標①']],
        supportContent1: row[col['支援内容①']],
        goal1Period: row[col['期間①']],
        shortTermGoal2: row[col['短期目標②']],
        supportContent2: row[col['支援内容②']],
        goal2Period: row[col['期間②']],
        planNotes: row[col['計画特記事項']] || '',
        previousMonitoringDate: prevDate ? new Date(prevDate) : null,
        nextMonitoringMonth: row[col['次回モニタリング予定月']],
        previousIssues: row[col['前回の主な課題']] || '',
        attendees: row[col['出席者']] || ''
      };
    }
  }

  logWarn('loadUserMaster', '利用者マスターに「' + userName + '」が見つかりません');
  return null;
}


function getDashboardSummary() {
  const ssId = getSpreadsheetId();
  const ss = SpreadsheetApp.openById(ssId);
  const sheet = ss.getSheetByName(CONFIG.SHEET_NAMES.STATUS);
  const data = sheet.getDataRange().getValues();

  const headers = data[0];
  const col = {};
  headers.forEach((h, i) => col[h] = i);

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
    const status = data[i][col['ステータス']];
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
