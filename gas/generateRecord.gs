function runStage3A(extractionData, userMaster) {
  logInfo('Stage3A', 'モニタリング記録票生成開始');

  try {
    const extractionJson = JSON.stringify(extractionData, null, 2);
    const prompt = getStage3APrompt(userMaster, extractionJson);

    const recordText = callGeminiWithRetry(prompt, {
      temperature: 0.2,
      maxTokens: 8192
    });

    logInfo('Stage3A', `記録票テキスト生成完了: ${recordText.length}文字`);
    return {
      success: true,
      data: {
        text: recordText
      }
    };
  } catch (e) {
    logError('Stage3A', `記録票生成失敗: ${e.message}`);
    return {
      success: false,
      error: e.message
    };
  }
}


function fillMonitoringRecord(userMaster, recordText) {
  const templateIds = getTemplateIds();
  const folderIds = getFolderIds();

  if (!templateIds.monitoringRecord) {
    logWarn('Stage3A', 'テンプレートID未設定。プレーンテキストで保存します');
    return saveRecordAsPlainText_(userMaster, recordText);
  }

  const sections = parseRecordSections_(recordText);

  const replacements = {
    'user_name': userMaster.name,
    'staff_name': userMaster.staff,
    'service_manager': userMaster.serviceManager,
    'date': userMaster.date,
    'previous_monitoring_date': userMaster.previousMonitoringDate || '初回',
    'next_monitoring_month': userMaster.nextMonitoringMonth || '',
    'long_term_goal': userMaster.longTermGoal,
    'short_term_goal_1': userMaster.shortTermGoal1,
    'support_content_1': userMaster.supportContent1,
    'goal_1_period': userMaster.goal1Period,
    'short_term_goal_2': userMaster.shortTermGoal2 || '',
    'support_content_2': userMaster.supportContent2 || '',
    'goal_2_period': userMaster.goal2Period || '',
    'attendees': userMaster.attendees || '',
    'section_1_intention': sections.intention || '',
    'section_4_status': sections.status || '',
    'section_5_impression': sections.impression || '',
    'section_6_future': sections.future || '',
    'section_7_notes': sections.notes || '',
    'ai_disclaimer': '本記録はAI支援による下書きです。担当者による確認・修正を経て確定してください。'
  };

  const fileName = `${userMaster.date}_${userMaster.name}_モニタリング記録票（下書き）`;

  try {
    const docId = fillTemplate(
      templateIds.monitoringRecord,
      replacements,
      folderIds.draft,
      fileName
    );
    logInfo('Stage3A', `テンプレート差し込み完了: ${docId}`);
    return { docId: docId, url: getDocUrl(docId) };
  } catch (e) {
    logError('Stage3A', `テンプレート差し込み失敗: ${e.message}`);
    return saveRecordAsPlainText_(userMaster, recordText);
  }
}


function parseRecordSections_(text) {
  const sections = {
    intention: '',
    status: '',
    impression: '',
    future: '',
    notes: ''
  };

  const sectionPatterns = [
    { key: 'intention',   pattern: /##\s*1\.\s*本人・家族の意向([\s\S]*?)(?=##\s*2\.|$)/  },
    { key: 'status',      pattern: /##\s*4\.\s*支援の実施状況([\s\S]*?)(?=##\s*5\.|$)/     },
    { key: 'impression',  pattern: /##\s*5\.\s*支援を受けた感想([\s\S]*?)(?=##\s*6\.|$)/   },
    { key: 'future',      pattern: /##\s*6\.\s*今後の支援方針([\s\S]*?)(?=##\s*7\.|$)/     },
    { key: 'notes',       pattern: /##\s*7\.\s*特記事項([\s\S]*?)(?=---|$)/                 }
  ];

  for (let i = 0; i < sectionPatterns.length; i++) {
    const match = text.match(sectionPatterns[i].pattern);
    if (match) {
      let content = match[1].trim();
      content = content.replace(/^データソース:.*$/gm, '');
      content = content.replace(/^applicable_sections:.*$/gm, '');
      sections[sectionPatterns[i].key] = content.trim();
    }
  }

  return sections;
}


function saveRecordAsPlainText_(userMaster, recordText) {
  const folderIds = getFolderIds();
  const fileName = `${userMaster.date}_${userMaster.name}_モニタリング記録票（下書き）.txt`;
  const file = saveTextToFile(folderIds.draft, fileName, recordText);
  logInfo('Stage3A', `プレーンテキストで保存: ${fileName}`);
  return { docId: file.getId(), url: getFileUrl(file.getId()) };
}
