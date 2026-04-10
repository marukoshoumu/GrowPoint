/** コピー取り込み済みの元ファイルID（移動できない所有者別アップロードの重複検知用） */
var CLAIMED_ORIGINAL_FILE_IDS_KEY_ = 'CLAIMED_ORIGINAL_FILE_IDS_JSON';

function getClaimedOriginalIdSet_() {
  const raw = PropertiesService.getScriptProperties().getProperty(CLAIMED_ORIGINAL_FILE_IDS_KEY_);
  if (!raw) return {};
  try {
    const ids = JSON.parse(raw);
    if (!ids || !ids.length) return {};
    const map = {};
    for (let i = 0; i < ids.length; i++) map[ids[i]] = true;
    return map;
  } catch (e) {
    return {};
  }
}

function rememberClaimedOriginalId_(fileId) {
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(5000);
  } catch (e) {
    logWarn('FileManager', `ロック取得失敗（claimedId記録スキップ）: ${e.message}`);
    return;
  }
  try {
    const props = PropertiesService.getScriptProperties();
    let ids = [];
    try {
      const raw = props.getProperty(CLAIMED_ORIGINAL_FILE_IDS_KEY_);
      ids = raw ? JSON.parse(raw) : [];
    } catch (e) {
      ids = [];
    }
    if (!ids) ids = [];
    ids.push(fileId);
    const MAX = 500;
    if (ids.length > MAX) ids = ids.slice(ids.length - MAX);
    props.setProperty(CLAIMED_ORIGINAL_FILE_IDS_KEY_, JSON.stringify(ids));
  } finally {
    lock.releaseLock();
  }
}

function isDrivePermissionDenied_(err) {
  const msg = String(err && err.message ? err.message : err);
  return /アクセスが拒否|見つかりませんでした|Access denied|Permission denied|Forbidden|not found/i.test(msg);
}

/**
 * フォルダからファイルの紐付けを外す。共有ドライブでは DriveApp.removeFile が使えないため Drive API v3 を併用。
 * 共有ドライブのファイルは常に親が1つ必須のため removeParents のみは不可 → 未処理から外す目的ではゴミ箱へ移す。
 * @returns {boolean} 成功したら true
 */
function removeFileFromFolderRobust_(fileId, folderId) {
  const file = DriveApp.getFileById(fileId);
  const folder = DriveApp.getFolderById(folderId);
  try {
    folder.removeFile(file);
    return true;
  } catch (e) {
    try {
      // Drive API v3: update(resource, fileId, mediaData, optionalArgs)。メタデータのみは第3引数 null。
      // removeParents だけだと「A shared drive item must have exactly one parent」になるため、
      // 共有ドライブでは trashed:true で未処理フォルダから実質除去する。
      Drive.Files.update({ trashed: true }, fileId, null, {
        supportsAllDrives: true
      });
      logInfo('FileManager', 'Drive API でゴミ箱へ移動し未処理から除去（共有ドライブ）', { fileId: fileId });
      return true;
    } catch (e2) {
      logWarn('FileManager', '未処理フォルダからの除去に失敗', {
        fileId: fileId,
        driveAppErr: e.message,
        apiErr: e2.message
      });
      return false;
    }
  }
}

/**
 * 未処理→処理中へ取り込む。移動に失敗（他者所有ファイル等）した場合はコピーで取り込み、元IDを記録する。
 * @returns {{ id: string, name: string, mimeType: string, createdDate: Date }}
 */
function claimAudioForProcessing_(audioFile) {
  const folderIds = getFolderIds();
  const orig = audioFile.driveFile || DriveApp.getFileById(audioFile.id);

  // 自分所有ファイルは移動、他者所有はコピーで取り込む
  // （他者所有ファイルを removeFile すると Drive ビューからアクセスを失うため）
  const currentUser = Session.getEffectiveUser().getEmail();
  const owner = orig.getOwner();
  const isOwnFile = owner && owner.getEmail() === currentUser;

  if (isOwnFile) {
    moveFileToFolder(orig.getId(), folderIds.processing);
    return {
      id: audioFile.id,
      name: audioFile.name,
      mimeType: audioFile.mimeType,
      createdDate: audioFile.createdDate
    };
  }

  // 他者所有: コピーしてから元ファイルを除去
  const targetFolder = DriveApp.getFolderById(folderIds.processing);
  const copy = orig.makeCopy(orig.getName(), targetFolder);
  rememberClaimedOriginalId_(audioFile.id);
  logInfo('FileManager', '他者所有ファイルをコピーで取り込み', {
    originalId: audioFile.id,
    copyId: copy.getId(),
    owner: owner ? owner.getEmail() : '不明'
  });

  if (!removeFileFromFolderRobust_(audioFile.id, folderIds.unprocessed)) {
    logWarn('FileManager', '01_未処理からの除去に失敗。元ファイルが残る可能性があります。', {
      originalId: audioFile.id
    });
  }

  return {
    id: copy.getId(),
    name: audioFile.name,
    mimeType: copy.getMimeType(),
    createdDate: copy.getDateCreated()
  };
}

function detectNewAudioFiles() {
  const folderIds = getFolderIds();
  const skipOriginals = getClaimedOriginalIdSet_();
  const unprocessedFolder = DriveApp.getFolderById(folderIds.unprocessed);
  const files = unprocessedFolder.getFiles();
  const audioFiles = [];

  while (files.hasNext()) {
    const file = files.next();
    if (skipOriginals[file.getId()]) continue;
    const mimeType = file.getMimeType();
    if (isAudioFile_(mimeType)) {
      audioFiles.push({
        id: file.getId(),
        name: file.getName(),
        mimeType: mimeType,
        createdDate: file.getDateCreated(),
        driveFile: file
      });
    }
  }

  logInfo('FileManager', `未処理音声ファイル検出: ${audioFiles.length}件`);
  return audioFiles;
}

function isAudioFile_(mimeType) {
  const audioTypes = [
    'audio/mpeg',
    'audio/mp4',
    'audio/m4a',
    'audio/x-m4a',
    'audio/wav',
    'audio/x-wav',
    'audio/ogg',
    'audio/webm',
    'audio/aac',
    'audio/flac',
    'video/mp4'  // スマホ録音が video/mp4 で保存される場合がある
  ];
  return audioTypes.indexOf(mimeType) !== -1;
}

function moveFileToFolder(fileId, targetFolderId) {
  const file = DriveApp.getFileById(fileId);
  try {
    return moveFileToFolderWithObj_(file, targetFolderId);
  } catch (e) {
    moveFileToFolderByDriveApi_(fileId, targetFolderId);
    return DriveApp.getFileById(fileId);
  }
}

function moveFileToFolderWithObj_(file, targetFolderId) {
  const targetFolder = DriveApp.getFolderById(targetFolderId);

  const parents = file.getParents();
  while (parents.hasNext()) {
    parents.next().removeFile(file);
  }
  targetFolder.addFile(file);

  logInfo('FileManager', `ファイル移動: ${file.getName()} → ${targetFolder.getName()}`);
  return file;
}

/**
 * 共有ドライブでは DriveApp の removeFile/addFile が使えないため、
 * addParents + removeParents を同一リクエストで行う（親は1つのみ想定）。
 */
function moveFileToFolderByDriveApi_(fileId, targetFolderId) {
  const meta = Drive.Files.get(fileId, { fields: 'parents', supportsAllDrives: true });
  const parentIds = meta.parents || [];
  if (!parentIds.length) {
    throw new Error('Drive API 移動: 親フォルダがありません');
  }
  Drive.Files.update({}, fileId, null, {
    addParents: targetFolderId,
    removeParents: parentIds.join(','),
    supportsAllDrives: true
  });
  const f = DriveApp.getFileById(fileId);
  logInfo('FileManager', 'Drive API でファイル移動（共有ドライブ）', {
    fileId: fileId,
    name: f.getName(),
    toFolderId: targetFolderId
  });
}

function createUserProcessingFolder(parentFolderId, userName, date) {
  const folderName = `${normalizeSheetDateForFilename_(date)}_${userName}`;
  return createSubfolder(parentFolderId, folderName);
}

/**
 * ファイル名の「_より後」から面談日を推定する。
 * - YYYY-MM-DD / YYYY_MM_DD 形式を含む
 * - 末尾8桁 YYYYMMDD
 * - 末尾6桁 YYMMDD（2000年代として解釈）
 */
function parseDateFromFileSuffix_(suffix) {
  if (!suffix) return null;

  const iso = suffix.match(/(\d{4})[-_](\d{2})[-_](\d{2})/);
  if (iso) {
    return iso[1] + '-' + iso[2] + '-' + iso[3];
  }

  const end8 = suffix.match(/(\d{4})(\d{2})(\d{2})$/);
  if (end8) {
    const y = parseInt(end8[1], 10);
    if (y >= 1900 && y <= 2100) {
      return end8[1] + '-' + end8[2] + '-' + end8[3];
    }
  }

  // 末尾6桁 YYMMDD: 年は常に 20YY として 2000–2099 にマップ（2100 年以降はこの分岐では解釈しない）
  const end6 = suffix.match(/(\d{2})(\d{2})(\d{2})$/);
  if (end6) {
    const mm = parseInt(end6[2], 10);
    const dd = parseInt(end6[3], 10);
    if (mm >= 1 && mm <= 12 && dd >= 1 && dd <= 31) {
      const yy = parseInt(end6[1], 10);
      const fullY = 2000 + yy;
      return fullY + '-' + end6[2] + '-' + end6[3];
    }
  }

  return null;
}

/**
 * 末尾が _NN-MM（例: _01-03 = 3分割の1番目）なら取り除いたベース名とチャンク情報を返す。
 * 判定は拡張子除去後の文字列の末尾のみ（利用者名に「_12-34」が含まれるだけではマッチしない）。
 * NN/MM は可変桁（Python の f"{n:02d}" が 100 以上で 3 桁になることと整合）。
 */
function parseChunkSuffixFromBasename_(nameWithoutExt) {
  const chunkM = nameWithoutExt.match(/_(\d+)-(\d+)$/);
  if (!chunkM) {
    return { baseName: nameWithoutExt, chunkIndex: null, chunkTotal: null };
  }
  const ci = parseInt(chunkM[1], 10);
  const ct = parseInt(chunkM[2], 10);
  if (ci < 1 || ct < 1 || ci > ct || ct > 999) {
    return { baseName: nameWithoutExt, chunkIndex: null, chunkTotal: null };
  }
  return {
    baseName: nameWithoutExt.substring(0, nameWithoutExt.length - chunkM[0].length),
    chunkIndex: ci,
    chunkTotal: ct
  };
}

function parseFileNameForUser(fileName) {
  const nameWithoutExt = fileName.replace(/\.[^.]+$/, '');
  const chunkInfo = parseChunkSuffixFromBasename_(nameWithoutExt);
  const nameForParse = chunkInfo.baseName;

  const underscoreMatch = nameForParse.match(/^(.+?)_(\d{4}[-_]\d{2}[-_]\d{2})/);
  if (underscoreMatch) {
    return {
      userName: underscoreMatch[1],
      date: underscoreMatch[2].replace(/_/g, '-'),
      chunkIndex: chunkInfo.chunkIndex,
      chunkTotal: chunkInfo.chunkTotal
    };
  }

  const reverseMatch = nameForParse.match(/^(\d{4}[-_]\d{2}[-_]\d{2})_(.+)/);
  if (reverseMatch) {
    return {
      userName: reverseMatch[2],
      date: reverseMatch[1].replace(/_/g, '-'),
      chunkIndex: chunkInfo.chunkIndex,
      chunkTotal: chunkInfo.chunkTotal
    };
  }

  const usIdx = nameForParse.indexOf('_');
  if (usIdx > 0) {
    const userName = nameForParse.substring(0, usIdx);
    const suffix = nameForParse.substring(usIdx + 1);
    const dateFromSuffix = parseDateFromFileSuffix_(suffix);
    return {
      userName: userName,
      date: dateFromSuffix || formatDate(),
      chunkIndex: chunkInfo.chunkIndex,
      chunkTotal: chunkInfo.chunkTotal
    };
  }

  return {
    userName: nameForParse,
    date: formatDate(),
    chunkIndex: chunkInfo.chunkIndex,
    chunkTotal: chunkInfo.chunkTotal
  };
}

function moveToProcessing(fileId) {
  const folderIds = getFolderIds();
  return moveFileToFolder(fileId, folderIds.processing);
}

function moveToError(fileId) {
  const folderIds = getFolderIds();
  return moveFileToFolder(fileId, folderIds.error);
}

function getFileUrl(fileId) {
  return `https://drive.google.com/file/d/${fileId}/view`;
}

function getDocUrl(docId) {
  return `https://docs.google.com/document/d/${docId}/edit`;
}
