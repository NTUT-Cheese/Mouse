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
