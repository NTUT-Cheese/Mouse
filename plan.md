# 行為追蹤與防護擴充功能：架構藍圖

本專案旨在建立一個以 Vue 3 為基礎的 Firefox/Chrome 擴充功能，核心目標是**精準追蹤與記錄網頁上的 JavaScript 行為與 DOM 元件動態**，將結果以**詳細行為報告**的形式即時呈現給使用者，讓使用者自行判斷網頁是否安全。

> **設計哲學：所做即所見**
> 本系統不依賴風險分數、外部黑名單或不可控的 AI 來「判定」網頁安不安全。
> 取而代之的是，完整且透明地列出「這個網頁做了什麼」——每一次網路請求、每一個鍵盤監聽、每一次敏感資料存取，使用者都看得到。

## 核心攔截機制

透過瀏覽器底層 API 切入，實作全面的行為監控。

### 1. JS 行為攔截 (Monkey Patching)
透過將腳本注入至網頁的 `MAIN` world (與網頁共用執行環境)，覆寫並監聽原生的瀏覽器 API，捕捉所有行為：

*   **網路連線 (Network Monitoring)**：
    *   覆寫 `window.fetch`、`XMLHttpRequest` 與 `navigator.sendBeacon`。
    *   **記錄**：每一次外部請求的目標 URL、HTTP 方法、Body 大小，以及 Body 是否包含頁面上密碼框或信用卡欄位的內容。
*   **鍵盤與事件監聽 (Event Listener Tracking)**：
    *   覆寫 `EventTarget.prototype.addEventListener`。
    *   **記錄**：哪些腳本在哪些元素上綁定了 `keydown`、`keyup`、`input`、`paste`、`submit` 等事件，並標註是否綁定在密碼欄位上。
*   **動態執行 (Dynamic Execution)**：
    *   覆寫 `window.eval` 與 `Function` 建構子。
    *   **記錄**：被動態執行的程式碼片段（前 200 字元），標註其來源 Stack Trace。
*   **Cookie 與 Storage 存取 (Session Monitoring)**：
    *   覆寫 `document.cookie` getter/setter 與 `localStorage` 的 `getItem`/`setItem`/`removeItem`。
    *   **記錄**：哪些腳本讀寫了哪些 Cookie Key / Storage Key，並標註是否為 Session Token 相關。
*   **SPA 框架敏感值讀取 (Value Interception)**：
    *   覆寫 `HTMLInputElement.prototype.value` 的 Getter / Setter（僅限 `type="password"` 與信用卡相關欄位）。
    *   **記錄**：何時有腳本嘗試讀取密碼框的值，即使是 Vue / React 發出的請求也能追蹤。
*   **跳轉與開啟新頁 (Navigation Tracking)**：
    *   覆寫 `window.open`、`window.location.assign/replace`，監控 `location.href` 設值。
    *   **記錄**：未經使用者操作的強制跳轉目標，以及惡意腳本彈出的新視窗。

### 2. DOM 元件追蹤 (Mutation & Structural Analysis)
在 `ISOLATED` world (擴充功能的獨立環境) 中，監控網頁結構的動態變化：

*   **敏感元件識別**：掃描頁面上的 `<input type="password">`、隱藏表單 `<form>` 與 `<iframe>`，記錄其屬性與狀態。
*   **動態變異監控 (MutationObserver)**：
    *   **記錄**：網頁在載入後動態插入的 `<script>`、隱藏 `<iframe>`、外部 `<form action>`、`<meta http-equiv="refresh">` 自動跳轉、`onX` 事件處理器屬性注入等行為。
*   **行為與結構交叉比對**：找出某個密碼框所屬表單的 `action` 屬性是否指向外部網域，並將此事實列入報告。

---

## 系統架構設計

### 1. Injected Script (注入腳本)
*   **職責**：執行於 `MAIN` world，負責執行上述的 JS Monkey Patching。
*   **資料流**：攔截到行為後，透過 `window.postMessage`（附帶 nonce 驗證）將原始行為日誌安全地傳遞給 Content Script。

### 2. Content Script (內容腳本)
*   **職責**：執行於 `ISOLATED` world。
*   **工作**：
    1. 接收來自 Injected Script 的 JS 行為日誌（驗證 nonce 後轉發）。
    2. 執行 DOM MutationObserver 監控元件動態變化。
    3. **敏感值快照**：記錄使用者在密碼、信用卡欄位的輸入特徵，比對攔截到的 `fetch` Payload 中是否夾帶該敏感資訊。
    4. 將行為日誌打包，發送給 Background Service Worker。

### 3. Background Script (行為彙整器)
*   **職責**：作為系統的中樞，負責彙整所有分頁的行為資料。
*   **行為分類與聚合**：
    *   將來自各攔截源（JS Hook、DOM Mutation、webRequest）的原始事件去重、聚合。
    *   轉換為人類可讀的行為描述。例如：
        *   `「向 tracker.example.com 發送了 POST 請求，Body 中包含與密碼欄位匹配的內容」`
        *   `「在 <input type="password"> 上註冊了 keydown 監聽器，來源：third-party.js:42」`
        *   `「動態插入了隱藏的 <iframe src="tracker.com/collect">（寬高 0x0）」`
        *   `「讀取了 localStorage 中的 accessToken」`
*   **導航追蹤 (Navigation API)**：
    *   利用 `browser.webRequest` API 記錄 HTTP 301/302 跳轉鏈 (Redirect Chains)，還原實際來源。
*   **狀態管理**：維護各個分頁的完整行為紀錄。

### 4. Vue Sidebar (行為報告介面)
*   **職責**：提供直觀的行為報告。
*   **功能**：
    *   **行為時間軸**：按時間順序列出網頁的所有行為，每筆行為附帶類別圖示、人類可讀描述、原始證據（URL、Stack Trace、元素片段）。
    *   **分類檢視**：按行為類別（網路、事件監聽、Cookie/Storage、DOM 變異、動態執行）分組瀏覽。
    *   **元件透視**：列出頁面上的敏感元件（如密碼框），以及與其相關的所有行為。
    *   **AI 行為摘要（可選）**：使用本地 AI 模型對行為列表進行自然語言歸納，例如「這個頁面的第三方腳本讀取了你的密碼並傳送到外部伺服器」。

---

## 行為報告資料結構

每一筆行為記錄遵循統一格式：

```typescript
interface BehaviorEntry {
  id: string;                    // 唯一識別碼
  timestamp: number;             // 發生時間
  category: BehaviorCategory;    // 行為大類
  source: 'JS_HOOK' | 'DOM' | 'API_HOOK' | 'NETWORK';  // 來源層
  level: 'info' | 'warning' | 'danger';                  // 嚴重度（視覺用）
  summary: string;               // 人類可讀的一行摘要
  evidence: {                    // 原始證據
    url?: string;                // 相關 URL
    stackTrace?: string;         // 呼叫來源
    elementSnippet?: string;     // DOM 元素片段
    bodyPreview?: string;        // Request Body 預覽
    oldValue?: string;           // 屬性被篡改前的值
    newValue?: string;           // 屬性被篡改後的值
  };
  count: number;                 // 相同行為的重複次數
}

type BehaviorCategory =
  | 'network-request'            // 一般外部網路請求
  | 'network-exfiltration'       // 含敏感資料的外部請求
  | 'event-listener'             // 高風險事件監聽
  | 'password-keylogger'         // 密碼欄位鍵盤監聽
  | 'cookie-access'              // Cookie 讀寫
  | 'storage-access'             // localStorage 讀寫
  | 'eval-detected'              // 動態程式碼執行
  | 'script-injection'           // 動態 <script> 插入
  | 'iframe-injection'           // 動態 <iframe> 插入
  | 'form-hijack'                // 表單 action 篡改
  | 'meta-redirect'              // <meta> 自動跳轉
  | 'event-handler-injection'    // onX 屬性注入
  | 'navigation-redirect';       // 強制跳轉
```

---

## 階段實作計畫

### Phase 1: 基礎攔截與行為回報管線
- 初始化 Vue 3 + WXT 擴充功能專案。
- 實作 Injected Script（MAIN World），完成 `fetch`、`XHR`、`sendBeacon`、`addEventListener`、`cookie`、`localStorage`、`eval`、`Function` 的攔截與日誌回傳。
- 建立 Content Script ↔ Injected Script 的 nonce 驗證 postMessage 橋接。
- 建立 Background Script 接收並聚合行為日誌。

### Phase 2: DOM 監控與行為彙整
- 在 Content Script 實作雙 MutationObserver（A: 特徵重掃描 / B: 威脅語義分析）。
- 實作動態 `<script>`、`<iframe>`、`<form>`、`<meta>`、`onX`、`<link>` 插入偵測。
- Background 實作行為去重、聚合與即時推送。

### Phase 3: 行為報告介面與進階攔截
- **重構 Sidebar UI**：從分數儀表板改為行為時間軸 + 分類檢視。
- 實作人類可讀的行為描述生成器（將原始事件轉換為自然語言摘要）。
- 實作進階攔截：`HTMLInputElement.prototype.value` getter/setter、`window.open`、`location` 跳轉追蹤。
- 完善白名單過濾機制，允許使用者標記信任網域以減少報告雜訊。

### Phase 4: AI 行為摘要與快取
- 調整 AI 引擎角色：從「打分數」改為「用自然語言歸納行為報告的含義」。
- 實作特徵快取（IndexedDB），已知安全網域跳過重複分析。
- 使用者白/黑名單管理介面。
