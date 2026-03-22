function detectNewAudioFiles() {
  const folderIds = getFolderIds();
  const unprocessedFolder = DriveApp.getFolderById(folderIds.unprocessed);
  const files = unprocessedFolder.getFiles();
  const audioFiles = [];

  while (files.hasNext()) {
    const file = files.next();
    const mimeType = file.getMimeType();
    if (isAudioFile_(mimeType)) {
      audioFiles.push({
        id: file.getId(),
        name: file.getName(),
        mimeType: mimeType,
        createdDate: file.getDateCreated()
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
  const folderName = `${date}_${userName}`;
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
