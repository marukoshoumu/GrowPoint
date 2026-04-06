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
    moveFileToFolderWithObj_(orig, folderIds.processing);
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

  try {
    const unprocessedFolder = DriveApp.getFolderById(folderIds.unprocessed);
    unprocessedFolder.removeFile(orig);
  } catch (removeErr) {
    logWarn('FileManager', '01_未処理からの除去に失敗。元ファイルが残っています。', {
      originalId: audioFile.id,
      error: removeErr.message
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
  return moveFileToFolderWithObj_(file, targetFolderId);
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

function createUserProcessingFolder(parentFolderId, userName, date) {
  const folderName = `${normalizeSheetDateForFilename_(date)}_${userName}`;
  return createSubfolder(parentFolderId, folderName);
}

function parseFileNameForUser(fileName) {
  const nameWithoutExt = fileName.replace(/\.[^.]+$/, '');

  const underscoreMatch = nameWithoutExt.match(/^(.+?)_(\d{4}[-_]\d{2}[-_]\d{2})/);
  if (underscoreMatch) {
    return {
      userName: underscoreMatch[1],
      date: underscoreMatch[2].replace(/_/g, '-')
    };
  }

  const reverseMatch = nameWithoutExt.match(/^(\d{4}[-_]\d{2}[-_]\d{2})_(.+)/);
  if (reverseMatch) {
    return {
      userName: reverseMatch[2],
      date: reverseMatch[1].replace(/_/g, '-')
    };
  }

  return {
    userName: nameWithoutExt,
    date: formatDate()
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
