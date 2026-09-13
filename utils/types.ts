/**
 * 行為追蹤核心型別定義
 *
 * 設計原則：只描述事實，不做判斷。
 * 所有型別都是為了「記錄網頁做了什麼」，而非「網頁是否安全」。
 */

// ─── 行為分類（純粹用於分組瀏覽，不代表好或壞）─────────────────────

export type BehaviorCategory =
  | 'network-request'     // 外部網路請求（fetch, XHR, sendBeacon）
  | 'event-binding'       // 事件監聽綁定（addEventListener）
  | 'cookie-storage'      // Cookie / localStorage 讀寫
  | 'dynamic-execution'   // eval / Function 動態程式碼執行
  | 'dom-mutation'        // 動態 DOM 插入（script, iframe, form, meta...）
  | 'navigation'          // 跳轉與重導向（window.open, location）
  | 'value-access';       // 表單欄位值讀取（password getter/setter）

// ─── 行為來源層 ─────────────────────────────────────────────────

export type BehaviorSource = 'JS_HOOK' | 'DOM';

// ─── 行為證據（原始事實資料）────────────────────────────────────

export interface BehaviorEvidence {
  /** 相關的 URL（請求目標、腳本來源等）*/
  url?: string;
  /** 是否與當前頁面同源 */
  isSameOrigin?: boolean;
  /** HTTP 方法 */
  method?: string;
  /** 呼叫來源的 Stack Trace */
  stackTrace?: string;
  /** DOM 元素片段 */
  elementSnippet?: string;
  /** Request Body 預覽（前 200 字元）*/
  bodyPreview?: string;
  /** 觸發行為的腳本來源 */
  scriptSource?: string;
  /** 事件綁定的目標元素描述 */
  targetElement?: string;
  /** 關聯的表單欄位類型（如 password, credit-card）*/
  relatedField?: string;
  /** 事件類型（keydown, input, paste 等）*/
  eventType?: string;
  /** Cookie / Storage 的 key 名稱 */
  key?: string;
  /** 被動態執行的程式碼片段預覽 */
  codePreview?: string;
  /** 屬性變更前的值 */
  oldValue?: string;
  /** 屬性變更後的值 */
  newValue?: string;
}

// ─── 行為記錄（核心資料結構）────────────────────────────────────

export interface BehaviorEntry {
  /** 唯一識別碼 */
  id: string;
  /** 發生時間（Unix timestamp ms）*/
  timestamp: number;
  /** 行為大類（用於分組，不含判斷）*/
  category: BehaviorCategory;
  /** 來源層 */
  source: BehaviorSource;
  /** 人類可讀的一行事實描述 */
  summary: string;
  /** 更詳細的行為說明 */
  details: string;
  /** 原始證據 */
  evidence: BehaviorEvidence;
  /** 相同行為的重複次數 */
  count: number;
}

// ─── Injected Script → Content Script 的 postMessage 格式 ──────

export interface InjectedMessage {
  /** 固定通道標識 */
  type: typeof import('./constants').MESSAGE_CHANNEL;
  /** Nonce token 供驗證 */
  nonce: string;
  /** 行為資料 */
  payload: RawBehaviorEvent;
}

// ─── 原始行為事件（由 injected script 產生，尚未聚合）───────────

export interface RawBehaviorEvent {
  category: BehaviorCategory;
  source: BehaviorSource;
  summary: string;
  details: string;
  evidence: BehaviorEvidence;
}

// ─── Background ↔ Sidebar 通訊格式 ─────────────────────────────

export interface BackgroundMessage {
  action: 'behaviors-updated' | 'tab-reset';
  tabId: number;
  behaviors?: BehaviorEntry[];
}

export interface SidebarRequest {
  action: 'get-behaviors';
  tabId: number;
}

// ─── 分類顯示資訊 ──────────────────────────────────────────────

export interface CategoryInfo {
  id: BehaviorCategory;
  label: string;
  icon: string;
  description: string;
}
