/**
 * 同一利用者・同一面談日の分割音声について、全チャンクの文字起こしTXTが揃ったら
 * 1本の「…_文字起こし.txt」に結合し、先頭チャンク行のみ STAGE1_DONE に進める。
 *
 * チャンク接尾辞 _NN-MM は「拡張子直前の末尾」のみ（fileManager の parseChunkSuffix と整合）。
 */

function tryMergeChunkGroupAfterStage1_(userName, interviewDate, chunkTotal, extractedUserFolderId) {
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(120000);
  } catch (e) {
    logWarn('ChunkMerge', 'ロック取得失敗、マージスキップ: ' + e.message);
    return;
  }
  try {
    tryMergeChunkGroupAfterStage1Core_(userName, interviewDate, chunkTotal, extractedUserFolderId);
  } finally {
    lock.releaseLock();
  }
}


function tryMergeChunkGroupAfterStage1Core_(userName, interviewDate, chunkTotal, extractedUserFolderId) {
  const folder = DriveApp.getFolderById(extractedUserFolderId);
  const prefix = getChunkTranscriptBasePrefix_(userName, interviewDate);
  const mergedName = getChunkTranscriptBasePrefix_(userName, interviewDate) + '.txt';
  const dateKey = normalizeInterviewDateKey_(interviewDate);

  if (isChunkMergeAlreadyDone_(folder, mergedName, userName, dateKey, chunkTotal)) {
    logInfo('ChunkMerge', 'マージ済みのためスキップ: ' + mergedName);
    return;
  }

  for (let i = 1; i <= chunkTotal; i++) {
    const pad = i < 10 ? '0' + i : String(i);
    const name = prefix + '_' + pad + '.txt';
    if (!getNewestFileByName_(folder, name)) {
      logInfo('ChunkMerge', 'チャンク未そろいのためマージ待ち: ' + name);
      return;
    }
  }

  const parts = [];
  for (let j = 1; j <= chunkTotal; j++) {
    const pad2 = j < 10 ? '0' + j : String(j);
    const fname = prefix + '_' + pad2 + '.txt';
    const file = getNewestFileByName_(folder, fname);
    if (!file) return;
    dedupeFilesByNameKeepNewest_(folder, fname, file.getId());
    parts.push(file.getBlob().getDataAsString());
  }

  const mergedBody = parts.map(function(t, idx) {
    return '--- チャンク ' + (idx + 1) + '/' + chunkTotal + ' ---\n\n' + t;
  }).join('\n\n');

  trashFilesInFolderByName_(extractedUserFolderId, mergedName);
  const mergedFile = folder.createFile(mergedName, mergedBody, MimeType.PLAIN_TEXT);
  const mergedUrl = getFileUrl(mergedFile.getId());
  logInfo('ChunkMerge', 'マージ完了: ' + mergedName);

  const applied = applyChunkMergeToDashboard_(userName, dateKey, chunkTotal, mergedUrl);
  if (applied) {
    trashChunkPartTextFiles_(folder, prefix, chunkTotal);
  } else {
    logWarn('ChunkMerge', '結合ファイルは作成済みだがシート未更新のため、チャンクTXTは削除していません: ' + mergedName);
  }
}


/**
 * マージ済みファイルがあり、かつ当該グループに STAGE1_CHUNK_WAIT が残っていない → 再入不要
 * （ダッシュボード更新まで完了した状態）
 */
function isChunkMergeAlreadyDone_(folder, mergedName, userName, dateKey, chunkTotal) {
  if (!getNewestFileByName_(folder, mergedName)) return false;
  if (hasStage1ChunkWaitForGroup_(userName, dateKey, chunkTotal)) return false;
  return true;
}


function hasStage1ChunkWaitForGroup_(userName, dateKey, chunkTotal) {
  ensureStatusSheetChunkColumn_();
  const ss = SpreadsheetApp.openById(getSpreadsheetId());
  const sheet = ss.getSheetByName(CONFIG.SHEET_NAMES.STATUS);
  const data = sheet.getDataRange().getValues();
  const headers = data[0];
  const col = {};
  headers.forEach(function(h, i) { col[h] = i; });

  for (let r = 1; r < data.length; r++) {
    const row = data[r];
    if (row[col['利用者名']] !== userName) continue;
    if (normalizeInterviewDateKey_(row[col['面談日']]) !== dateKey) continue;
    const cl = parseChunkLabel_(row[col['チャンク']] || '');
    if (!cl || cl.chunkTotal !== chunkTotal) continue;
    if (row[col['ステータス']] === CONFIG.STATUS.STAGE1_CHUNK_WAIT) return true;
  }
  return false;
}


/** 同名が複数ある場合は更新日時が最新の1件を返す */
function getNewestFileByName_(folder, fileName) {
  const it = folder.getFilesByName(fileName);
  let best = null;
  let bestTime = -1;
  while (it.hasNext()) {
    const f = it.next();
    const t = f.getLastUpdated().getTime();
    if (t >= bestTime) {
      bestTime = t;
      best = f;
    }
  }
  return best;
}


/** 指定以外の同名ファイルをゴミ箱へ（読み取り後の整理） */
function dedupeFilesByNameKeepNewest_(folder, fileName, keepFileId) {
  const it = folder.getFilesByName(fileName);
  while (it.hasNext()) {
    const f = it.next();
    if (f.getId() !== keepFileId) f.setTrashed(true);
  }
}


function trashChunkPartTextFiles_(folder, prefix, chunkTotal) {
  for (let i = 1; i <= chunkTotal; i++) {
    const pad = i < 10 ? '0' + i : String(i);
    const name = prefix + '_' + pad + '.txt';
    const it = folder.getFilesByName(name);
    while (it.hasNext()) {
      it.next().setTrashed(true);
    }
  }
  logInfo('ChunkMerge', 'チャンク別文字起こしTXTを削除: ' + chunkTotal + ' パート');
}


/**
 * @returns {boolean} ダッシュボードを更新したか
 */
function applyChunkMergeToDashboard_(userName, dateKey, chunkTotal, mergedUrl) {
  ensureStatusSheetChunkColumn_();
  const ss = SpreadsheetApp.openById(getSpreadsheetId());
  const sheet = ss.getSheetByName(CONFIG.SHEET_NAMES.STATUS);
  const data = sheet.getDataRange().getValues();
  const headers = data[0];
  const col = {};
  headers.forEach(function(h, i) { col[h] = i; });

  const chunkWaitRows = [];
  for (let r = 1; r < data.length; r++) {
    const row = data[r];
    if (row[col['利用者名']] !== userName) continue;
    if (normalizeInterviewDateKey_(row[col['面談日']]) !== dateKey) continue;
    const cl = parseChunkLabel_(row[col['チャンク']] || '');
    if (!cl || cl.chunkTotal !== chunkTotal) continue;
    if (row[col['ステータス']] !== CONFIG.STATUS.STAGE1_CHUNK_WAIT) continue;
    chunkWaitRows.push({
      rowNumber: r + 1,
      chunkIndex: cl.chunkIndex
    });
  }

  if (chunkWaitRows.length === 0) {
    logError('ChunkMerge', 'STAGE1_CHUNK_WAIT の行が0件（チャンクTXTは揃っているのにシート不整合の可能性）', {
      userName: userName,
      dateKey: dateKey,
      chunkTotal: chunkTotal
    });
    return false;
  }

  chunkWaitRows.sort(function(a, b) { return a.chunkIndex - b.chunkIndex; });

  const leader = chunkWaitRows[0];
  const leaderRow = leader.rowNumber;
  const followerRows = [];
  for (let k = 1; k < chunkWaitRows.length; k++) {
    followerRows.push(chunkWaitRows[k].rowNumber);
  }

  if (leader.chunkIndex !== 1) {
    logInfo('ChunkMerge', '01 番行が無い／ERROR のため、チャンク ' +
      leader.chunkIndex + '/' + chunkTotal + ' 行をリーダーに昇格');
  }

  updateDashboardStatus(leaderRow, {
    'ステータス': CONFIG.STATUS.STAGE1_DONE,
    '文字起こし': mergedUrl
  });

  for (let f = 0; f < followerRows.length; f++) {
    updateDashboardStatus(followerRows[f], {
      'ステータス': CONFIG.STATUS.CHUNK_MERGED,
      '文字起こし': mergedUrl
    });
  }

  logInfo('ChunkMerge', 'ダッシュボード更新: リーダー行 ' + leaderRow + ' (chunkIndex=' + leader.chunkIndex + '), 従属 ' + followerRows.length + ' 行');
  return true;
}
