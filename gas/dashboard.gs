const DASHBOARD_HEADERS = [
  '処理ID', '利用者名', '面談日', '音声ファイル',
  'ステータス', '文字起こし', '構造化抽出',
  'ドキュメントリンク', '処理開始', '処理完了',
  'エラー内容', '担当者承認', 'チャンク'
];

/** 同一実行内で「チャンク」列の存在確認を繰り返さない */
var statusSheetChunkColumnEnsured_ = false;

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

/** 既存シートに「チャンク」列が無ければ最右に追加する */
function ensureStatusSheetChunkColumn_() {
  if (statusSheetChunkColumnEnsured_) return;
  const ssId = getSpreadsheetId();
  if (!ssId) return;
  const ss = SpreadsheetApp.openById(ssId);
  const sheet = ss.getSheetByName(CONFIG.SHEET_NAMES.STATUS);
  if (!sheet || sheet.getLastRow() < 1) return;
  const lastCol = sheet.getLastColumn();
  const headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  if (headers.indexOf('チャンク') !== -1) {
    statusSheetChunkColumnEnsured_ = true;
    return;
  }
  sheet.getRange(1, lastCol + 1).setValue('チャンク');
  statusSheetChunkColumnEnsured_ = true;
}


function formatChunkLabel_(chunkIndex, chunkTotal) {
  if (!chunkIndex || !chunkTotal) return '';
  const zi = chunkIndex < 10 ? '0' + chunkIndex : String(chunkIndex);
  const zt = chunkTotal < 10 ? '0' + chunkTotal : String(chunkTotal);
  return zi + '/' + zt;
}

/** 処理状況シートの面談日を YYYY-MM-DD 文字列に揃えて比較する */
function normalizeDashboardDate_(v) {
  if (v === null || v === undefined || v === '') return '';
  if (Object.prototype.toString.call(v) === '[object Date]' && !isNaN(v.getTime())) {
    return Utilities.formatDate(v, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  }
  const s = String(v).trim();
  const iso = s.match(/^(\d{4}-\d{2}-\d{2})/);
  if (iso) return iso[1];
  return s;
}

/**
 * チャンク列の値をファイル名・parseChunkLabel_ 用の文字列に揃える。
 * 「01/02」がシートで日付に解釈されると getValues() が Date になり、String(date) が
 * 「Fri Jan 02 2026 …」のようになるため、Date は MM/dd に戻す。
 */
function normalizeChunkLabel_(v) {
  if (v === null || v === undefined || v === '') return '';
  if (Object.prototype.toString.call(v) === '[object Date]' && !isNaN(v.getTime())) {
    return Utilities.formatDate(v, Session.getScriptTimeZone(), 'MM/dd');
  }
  return String(v).trim();
}

/**
 * 長尺→チャンクに進んだとき、同一利用者・面談日の SPLIT_PENDING 行をクローズする。
 * （チャンク行が enqueue されるタイミングで呼ぶ）
 */
function supersedeSplitPendingRowsForChunk_(userName, interviewDate) {
  const ssId = getSpreadsheetId();
  if (!ssId) return;
  const ss = SpreadsheetApp.openById(ssId);
  const sheet = ss.getSheetByName(CONFIG.SHEET_NAMES.STATUS);
  if (!sheet || sheet.getLastRow() < 2) return;

  const data = sheet.getDataRange().getValues();
  const headers = data[0];
  const col = {};
  headers.forEach(function (h, i) { if (h) col[h] = i; });

  const targetDate = normalizeDashboardDate_(interviewDate);
  const ts = formatDateTime();
  let n = 0;
  for (let i = 1; i < data.length; i++) {
    if (data[i][col['ステータス']] !== CONFIG.STATUS.SPLIT_PENDING) continue;
    if (data[i][col['利用者名']] !== userName) continue;
    if (normalizeDashboardDate_(data[i][col['面談日']]) !== targetDate) continue;
    data[i][col['ステータス']] = CONFIG.STATUS.SPLIT_SUPERSEDED;
    data[i][col['エラー内容']] = 'チャンク処理に引き継ぎ（長尺分割）';
    data[i][col['処理完了']] = ts;
    n++;
  }
  if (n > 0) {
    sheet.getRange(1, 1, data.length, data[0].length).setValues(data);
    logInfo('Dashboard', `SPLIT_PENDING を SPLIT_SUPERSEDED に更新: ${n} 行`, { userName: userName, date: targetDate });
  }
}


function parseChunkLabel_(label) {
  if (!label || typeof label !== 'string') return null;
  const m = String(label).trim().match(/^(\d{1,2})\/(\d{1,2})$/);
  if (!m) return null;
  const idx = parseInt(m[1], 10);
  const tot = parseInt(m[2], 10);
  if (idx < 1 || tot < 1 || idx > tot) return null;
  return { chunkIndex: idx, chunkTotal: tot };
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


function addDashboardRow(processId, userName, interviewDate, audioFileName, status, chunkLabel) {
  ensureStatusSheetChunkColumn_();
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
    '', '', '',
    chunkLabel || ''
  ];

  sheet.appendRow(row);
  return sheet.getLastRow();
}


function updateDashboardStatus(rowNumber, updates) {
  const ssId = getSpreadsheetId();
  const ss = SpreadsheetApp.openById(ssId);
  const sheet = ss.getSheetByName(CONFIG.SHEET_NAMES.STATUS);
  ensureStatusSheetChunkColumn_();

  const hdrRow = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const columnMap = {};
  for (let i = 0; i < hdrRow.length; i++) {
    if (hdrRow[i]) columnMap[hdrRow[i]] = i + 1;
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
      return {
        name: row[col['利用者名']],
        staff: row[col['担当者名']],
        manager: row[col['サービス管理責任者']],
        serviceType: row[col['サービスの種類']] || '就労継続支援B型',
        creationDate: toNativeDate_(row[col['計画作成年月日']]),
        consentDate: toNativeDate_(row[col['同意日']]),
        planNeeds: row[col['本人の意向']] || '',
        longTermGoal: row[col['長期目標']],
        shortTermGoal1: row[col['短期目標①']],
        supportContent1: row[col['支援内容①']],
        goal1Period: row[col['期間①']],
        shortTermGoal2: row[col['短期目標②']],
        supportContent2: row[col['支援内容②']],
        goal2Period: row[col['期間②']],
        planNotes: row[col['計画特記事項']] || '',
        previousMonitoringDate: normalizePreviousMonitoringDateFromSheet_(row[col['前回モニタリング日']]),
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
  ensureStatusSheetChunkColumn_();
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
      case CONFIG.STATUS.STAGE1_PENDING:
      case CONFIG.STATUS.STAGE1_CHUNK_WAIT:
      case CONFIG.STATUS.STAGE1_DONE:
      case CONFIG.STATUS.STAGE2_RUNNING:
      case CONFIG.STATUS.STAGE2_DONE:
      case CONFIG.STATUS.STAGE3_RUNNING: summary.processing++; break;
      case CONFIG.STATUS.STAGE3_DONE:    summary.done++; break;
      case CONFIG.STATUS.STAGE3_PARTIAL: summary.partial++; break;
      case CONFIG.STATUS.CHUNK_MERGED:   summary.done++; break;
      case CONFIG.STATUS.SPLIT_PENDING:  summary.processing++; break;
      case CONFIG.STATUS.SPLIT_SUPERSEDED: summary.done++; break;
      case CONFIG.STATUS.SPLIT_FAILED:   summary.error++; break;
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

  ensureStatusSheetChunkColumn_();
  const data = sheet.getDataRange().getValues();
  const headers = data[0];
  const col = {};
  headers.forEach((h, i) => { col[h] = i; });

  const results = [];
  for (let i = 1; i < data.length; i++) {
    if (data[i][col['ステータス']] === targetStatus) {
      const rawChunk = col['チャンク'] !== undefined ? (data[i][col['チャンク']] || '') : '';
      const chunkLabel = normalizeChunkLabel_(rawChunk);
      results.push({
        rowNumber: i + 1,
        processId: data[i][col['処理ID']],
        userName: data[i][col['利用者名']],
        audioFileName: data[i][col['音声ファイル']],
        interviewDate: data[i][col['面談日']],
        transcriptUrl: data[i][col['文字起こし']],
        extractionUrl: data[i][col['構造化抽出']],
        updatedAt: data[i][col['処理開始']],
        chunkLabel: chunkLabel
      });
    }
  }
  return results;
}
