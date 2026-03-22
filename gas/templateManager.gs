function fillTemplate(templateId, replacements, outputFolderId, fileName) {
  const template = DriveApp.getFileById(templateId);
  const outputFolder = DriveApp.getFolderById(outputFolderId);
  const copy = template.makeCopy(fileName, outputFolder);
  const doc = DocumentApp.openById(copy.getId());
  const body = doc.getBody();

  const keys = Object.keys(replacements);
  for (let i = 0; i < keys.length; i++) {
    const placeholder = keys[i];
    const value = replacements[placeholder] || '';
    body.replaceText(`\\{\\{${escapeRegex_(placeholder)}\\}\\}`, value);
  }

  doc.saveAndClose();
  logInfo('Template', `テンプレート生成: ${fileName} (from ${template.getName()})`);
  return copy.getId();
}


function escapeRegex_(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}


function verifyTemplate(templateId) {
  try {
    const file = DriveApp.getFileById(templateId);
    const doc = DocumentApp.openById(templateId);
    const body = doc.getBody();
    const text = body.getText();

    const placeholders = [];
    const regex = /\{\{([^}]+)\}\}/g;
    let match;
    while ((match = regex.exec(text)) !== null) {
      placeholders.push(match[1]);
    }

    return {
      valid: true,
      name: file.getName(),
      placeholders: placeholders,
      charCount: text.length
    };
  } catch (e) {
    return {
      valid: false,
      error: e.message
    };
  }
}


function listTemplatePlaceholders() {
  const templateIds = getTemplateIds();
  const results = {};

  if (templateIds.monitoringRecord) {
    results.monitoringRecord = verifyTemplate(templateIds.monitoringRecord);
  } else {
    results.monitoringRecord = { valid: false, error: 'テンプレートID未設定' };
  }

  if (templateIds.monitoringSheet) {
    results.monitoringSheet = verifyTemplate(templateIds.monitoringSheet);
  } else {
    results.monitoringSheet = { valid: false, error: 'テンプレートID未設定' };
  }

  return results;
}
