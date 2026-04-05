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
    const value = replacementValueForTemplate_(replacements[placeholder]);
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
          const value = replacementValueForTemplate_(replacements[placeholder]);
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

/** 未設定は空欄。数値評価などは文字列化する（テーブルでも「面談中の言及なし」にしない）。 */
function replacementValueForTemplate_(raw) {
  if (raw === undefined || raw === null) return '';
  return String(raw);
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
    const errMsg = e && e.message ? e.message : String(e);
    return {
      success: false,
      error: errMsg
    };
  }
}


function listTemplatePlaceholders() {
  const templateIds = getTemplateIds();
  const results = {};

  if (templateIds.monitoringDocument) {
    results.monitoringDocument = verifyTemplate(templateIds.monitoringDocument);
  } else {
    results.monitoringDocument = { success: false, error: 'テンプレートID未設定 (TEMPLATE_ID_MONITORING_DOCUMENT)' };
  }

  return results;
}
