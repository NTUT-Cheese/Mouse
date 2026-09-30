/**
 * 共用常數定義
 */

/** postMessage 通道名稱 — 用於 injected script ↔ content script 溝通 */
export const MESSAGE_CHANNEL = '__MOUSE_BEHAVIOR_CHANNEL__' as const;

/** Nonce 注入到 DOM 的 attribute 名稱 */
export const NONCE_ATTR = 'data-mouse-nonce';

/** Nonce 注入的 DOM 元素 ID */
export const NONCE_ELEMENT_ID = '__mouse_nonce_carrier__';

/** Runtime message actions */
export const MSG_ACTION = {
  /** Content script → Background: 回報行為 */
  REPORT_BEHAVIOR: 'report-behavior',
  /** Background → Sidebar: 行為更新推送 */
  BEHAVIORS_UPDATED: 'behaviors-updated',
  /** Sidebar → Background: 取得目前分頁行為 */
  GET_BEHAVIORS: 'get-behaviors',
  /** Background → Sidebar: 分頁重置通知 */
  TAB_RESET: 'tab-reset',
  /** Sidebar → Content: 切換懸停預報開關 */
  TOGGLE_INSPECTOR: 'toggle-inspector',
  /** Sidebar → Content: 查詢懸停預報狀態 */
  GET_INSPECTOR_STATUS: 'get-inspector-status',
  /** Background → Sidebar: LLM 診斷狀態與結果更新 */
  LLM_STATUS_UPDATED: 'llm-status-updated',
  /** Background → Sidebar: 手動觸發 LLM 診斷（測試用） */
  TRIGGER_LLM_TEST: 'trigger-llm-test',
  /** Background → Sidebar: LLM 診斷逾時通知 */
  LLM_TIMEOUT: 'llm-timeout',
} as const;

/** 行為分類的顯示資訊 */
export const CATEGORY_INFO = {
  'network-request': {
    label: '網路請求',
    icon: '🌐',
    description: 'fetch / XHR / sendBeacon 發出的 HTTP 請求',
  },
  'event-binding': {
    label: '事件綁定',
    icon: '🎯',
    description: '透過 addEventListener 註冊的事件監聽器',
  },
  'cookie-storage': {
    label: 'Cookie & Storage',
    icon: '🗄️',
    description: 'Cookie 與 localStorage 的讀取/寫入操作',
  },
  'dynamic-execution': {
    label: '動態執行',
    icon: '⚡',
    description: '透過 eval 或 Function 動態執行的程式碼',
  },
  'dom-mutation': {
    label: 'DOM 變化',
    icon: '🔧',
    description: '動態插入的 script、iframe、form 等 DOM 元素',
  },
  'navigation': {
    label: '跳轉',
    icon: '↗️',
    description: 'window.open、location 跳轉、HTTP 重導向',
  },
  'value-access': {
    label: '欄位值讀取',
    icon: '🔑',
    description: '對密碼框等敏感表單欄位值的讀取操作',
  },
} as const;

/** 追蹤的高關注事件類型 */
export const TRACKED_EVENT_TYPES = [
  'keydown', 'keyup', 'keypress',
  'input', 'change',
  'paste', 'copy', 'cut',
  'submit',
  'click', 'mousedown', 'mouseup',
  'focus', 'blur',
] as const;

/** 行為去重的時間窗口（毫秒）*/
export const DEDUP_WINDOW_MS = 2000;

/** 最大保存行為數量（每個分頁）*/
export const MAX_BEHAVIORS_PER_TAB = 5000;

// ─── Buffer 降頻聚合設定 ────────────────────────────────────────────

/** content.ts 降頻聚合的時間窗口（毫秒） */
export const BUFFER_WINDOW_MS = 3000;

/** 一個 Buffer 周期內最多容納的事件數量（防内存暴谷） */
export const BUFFER_MAX_SIZE = 500;

/**
 * 資安高風險 Storage/Cookie Key 關鍵字（任一匹配即標記 MEDIUM 風險）
 */
export const SENSITIVE_STORAGE_KEYWORDS = [
  'token', 'auth', 'session', 'jwt', 'csrf', 'secret',
  'apikey', 'api_key', 'password', 'passwd', 'credential',
  'access_token', 'refresh_token', 'id_token',
] as const;

/**
 * 同源常態統計/遙測請求的 URL 路徑關鍵字
 * 匹配這些路徑的同源請求將自動標記為 LOW 風險並預設收合
 */
export const LOW_RISK_URL_PATTERNS = [
  '/api/stats', '/stats/', '/telemetry', '/metrics',
  '/analytics', '/logging', '/log/', '/logs/',
  '/heartbeat', '/ping', '/health', '/beacon',
  '/collect', '/event/', '/events/', '/track',
  '/impression', '/perf', '/performance',
  'qoe', 'videoplayback', 'generate_204',
] as const;

/** UI 顯示 URL 的最大字元數（超過則截斷為 truncated + ...） */
export const URL_DISPLAY_MAX_LENGTH = 60;

// ─── LLM Dispatcher 與白名單設定 ────────────────────────────────

/** 基礎靜態白名單網域清單（全名或母網域） */
export const STATIC_WHITELIST = [
  'youtube.com',
  'googlevideo.com',
  'ytimg.com',
  'wikipedia.org',
  'wikimedia.org',
  'google.com',
  'gstatic.com',
  'github.com',
  'githubassets.com',
  'microsoft.com',
  'apple.com',
  'mozilla.org',
] as const;

/** 本地 Ollama API 端點 */
export const OLLAMA_API_URL = 'http://localhost:11434/api/generate';

/** 預設使用的本地 LLM 模型名稱 */
export const OLLAMA_MODEL = 'qwen2.5:3b';

/** LLM 診斷請求逾時時間（毫秒） */
export const LLM_TIMEOUT_MS = 10000;

/** LLM 診斷請求冷卻時間（毫秒） */
export const LLM_COOLDOWN_MS = 15000;

/** Storage 中動態白名單的 key 名稱 */
export const STORAGE_KEY_DYNAMIC_WHITELIST = 'mouse_dynamic_whitelist';

// ─── 高動態 SPA 網站與效能防護設定 ────────────────────────────

/** 高動態 SPA 網站網域名單（降低採樣頻率，加強節流） */
export const HIGH_DYNAMIC_DOMAINS = [
  'youtube.com',
  'googlevideo.com',
  'netflix.com',
  'twitch.tv',
  'bilibili.com',
] as const;

/** DOM MutationObserver 批次節流處理窗口（毫秒） */
export const MUTATION_BATCH_WINDOW_MS = 500;

/** Storage / Cookie 存取節流窗口（毫秒） */
export const STORAGE_THROTTLE_MS = 500;
