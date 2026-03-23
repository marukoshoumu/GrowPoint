function fillTemplate(templateId, replacements, outputFolderId, fileName) {
  const template = DriveApp.getFileById(templateId);
  const outputFolder = DriveApp.getFolderById(outputFolderId);
  const copy = template.makeCopy(fileName, outputFolder);
  const doc = DocumentApp.openById(copy.getId());
  const body = doc.getBody();

  // Step 1: Body-level replaceText for all placeholders
  const keys = Object.keys(replacements);
  for (let i = 0; i < keys.length; i++) {
    const placeholder = keys[i];
    const value = replacements[placeholder] || '';
    body.replaceText(`\\{\\{${escapeRegex_(placeholder)}\\}\\}`, value);
  }

  // Step 2: Table cell replacement
  const tables = body.getTables();
  for (let t = 0; t < tables.length; t++) {
    const table = tables[t];
    const numRows = table.getNumRows();
    for (let r = 0; r < numRows; r++) {
      const row = table.getRow(r);
      const numCells = row.getNumCells();
      for (let c = 0; c < numCells; c++) {
        const cell = row.getCell(c);
        const cellText = cell.getText();
        if (cellText.indexOf('{{') === -1) continue;

        for (let i = 0; i < keys.length; i++) {
          const placeholder = keys[i];
          const value = replacements[placeholder] || '面談中の言及なし';
          cell.replaceText(`\\{\\{${escapeRegex_(placeholder)}\\}\\}`, value);
        }
      }
    }
  }

  // Step 3: Check for remaining unfilled placeholders
  const fullText = body.getText();
  const remainingRegex = /\{\{([^}]+)\}\}/g;
  let remaining;
  while ((remaining = remainingRegex.exec(fullText)) !== null) {
    logWarn('Template', `未置換プレースホルダー検出: {{${remaining[1]}}} in ${fileName}`);
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

    const uniquePlaceholders = [...new Set(placeholders)];

    return {
      success: true,
      name: file.getName(),
      placeholders: uniquePlaceholders,
      placeholderCount: uniquePlaceholders.length,
      charCount: text.length
    };
  } catch (e) {
    return {
      success: false,
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
