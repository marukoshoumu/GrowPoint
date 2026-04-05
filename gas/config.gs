const CONFIG = {
  GEMINI_MODEL: 'gemini-2.5-flash-lite',
  GEMINI_API_BASE: 'https://generativelanguage.googleapis.com/v1beta/models/',
  MAX_RETRIES: 2,
  POLL_INTERVAL_MINUTES: 5,

  FOLDER_NAMES: {
    ROOT: 'グローポイント_支援記録',
    UNPROCESSED: '01_未処理',
    PROCESSING: '02_処理中',
    EXTRACTED: '03_文字起こし・抽出',
    DRAFT: '04_書類ドラフト',
    APPROVED: '05_承認済み',
    ERROR: '06_エラー'
  },

  SHEET_NAMES: {
    STATUS: '処理状況',
    USER_MASTER: '利用者マスター',
    GLOSSARY: '用語集',
    LOG: '処理ログ'
  },

  STATUS: {
    QUEUED:         'QUEUED',
    STAGE1_RUNNING: 'STAGE1_RUNNING',
    STAGE1_DONE:    'STAGE1_DONE',
    STAGE2_RUNNING: 'STAGE2_RUNNING',
    STAGE2_DONE:    'STAGE2_DONE',
    STAGE3_RUNNING: 'STAGE3_RUNNING',
    STAGE3_DONE:    'STAGE3_DONE',
    STAGE3_PARTIAL: 'STAGE3_PARTIAL',
    ERROR:          'ERROR',
    APPROVED:       'APPROVED'
  },

  /** Stage1: flash-liteは長尺音声で反復ループに陥るため、flashを使用 */
  STAGE1_MODEL: 'gemini-2.5-flash',
  STAGE1_MAX_OUTPUT_TOKENS: 65536,

  STAGE_TIME_LIMIT_MS: 4 * 60 * 1000,   // 4 min (2 min margin from 6 min limit)
  TIMEOUT_THRESHOLD_MS: 30 * 60 * 1000,   // 30 min timeout

  /** Stage2 構造化抽出: flash-liteはJSON出力サイズ制御が不安定なため、flashを使用 */
  STAGE2_MODEL: 'gemini-2.5-flash',
  STAGE2_MAX_OUTPUT_TOKENS: 65536
};

function getApiKey() {
  const key = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');
  if (!key) throw new Error('GEMINI_API_KEY が Script Properties に設定されていません');
  return key;
}

function getFolderIds() {
  const props = PropertiesService.getScriptProperties();
  return {
    root: props.getProperty('FOLDER_ID_ROOT'),
    unprocessed: props.getProperty('FOLDER_ID_UNPROCESSED'),
    processing: props.getProperty('FOLDER_ID_PROCESSING'),
    extracted: props.getProperty('FOLDER_ID_EXTRACTED'),
    draft: props.getProperty('FOLDER_ID_DRAFT'),
    approved: props.getProperty('FOLDER_ID_APPROVED'),
    error: props.getProperty('FOLDER_ID_ERROR')
  };
}

function getTemplateIds() {
  const props = PropertiesService.getScriptProperties();
  return {
    monitoringDocument: props.getProperty('TEMPLATE_ID_MONITORING_DOCUMENT')
  };
}

function getSpreadsheetId() {
  return PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID');
}

function getPromptFileIds() {
  const props = PropertiesService.getScriptProperties();
  return {
    stage1: props.getProperty('PROMPT_FILE_ID_STAGE1'),
    stage2: props.getProperty('PROMPT_FILE_ID_STAGE2'),
    stage3a: props.getProperty('PROMPT_FILE_ID_STAGE3A'),
    stage3b: props.getProperty('PROMPT_FILE_ID_STAGE3B')
  };
}
