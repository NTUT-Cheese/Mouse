/**
 * Background Service Worker — 行為彙整器 & LLM Dispatcher
 *
 * 核心職責：
 * 1. 接收各分頁的行為回報與去重聚合
 * 2. 知名常態網站白名單降級過濾（避免正常網站觸發警報）
 * 3. LLM Dispatcher 單一任務鎖定機制 (Is Processing Lock)
 * 4. 高/中風險行為極簡化聚合 Buffer (Minimal Payload < 200 Tokens)
 * 5. 本地 Ollama API 調用與超時保護 (Timeout & 15s Cooldown)
 * 6. 動態白名單自動學習機制 (chrome.storage.local 持久化)
 * 7. 即時推送行為與資安診斷結果至 Sidebar UI
 */

import {
  MSG_ACTION,
  DEDUP_WINDOW_MS,
  MAX_BEHAVIORS_PER_TAB,
  STATIC_WHITELIST,
  OLLAMA_API_URL,
  OLLAMA_MODEL,
  LLM_TIMEOUT_MS,
  LLM_COOLDOWN_MS,
  STORAGE_KEY_DYNAMIC_WHITELIST,
} from '@/utils/constants';
import type {
  BehaviorEntry,
  RawBehaviorEvent,
  LLMRiskVerdict,
  LLMDiagnosisResult,
} from '@/utils/types';

export default defineBackground(() => {
  // ─── 1. 分頁行為儲存 ──────────────────────────────────────────

  const tabBehaviors = new Map<number, BehaviorEntry[]>();
  // 記錄每個分頁最新的 LLM 診斷結果
  const tabLLMVerdicts = new Map<number, LLMDiagnosisResult>();

  function generateId(): string {
    return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }

  /**
   * 計算行為的 dedup key，用於判斷兩筆行為是否為「同一件事」
   */
  function dedupKey(event: RawBehaviorEvent): string {
    const parts: string[] = [event.category, event.source];

    if (event.evidence.url) parts.push(event.evidence.url);
    if (event.evidence.method) parts.push(event.evidence.method);
    if (event.evidence.eventType) parts.push(event.evidence.eventType);
    if (event.evidence.targetElement) parts.push(event.evidence.targetElement);
    if (event.evidence.key) parts.push(event.evidence.key);
    if (event.evidence.elementSnippet) parts.push(event.evidence.elementSnippet);

    return parts.join('|');
  }

  /**
   * 新增行為至指定分頁
   * 包含去重邏輯：時間窗口內的相同行為合併計數
   */
  function addBehavior(tabId: number, event: RawBehaviorEvent) {
    if (!tabBehaviors.has(tabId)) {
      tabBehaviors.set(tabId, []);
    }

    const behaviors = tabBehaviors.get(tabId)!;
    const now = Date.now();
    const key = dedupKey(event);

    // 嘗試去重：在最近的行為中找相同的
    for (let i = behaviors.length - 1; i >= 0; i--) {
      const existing = behaviors[i];
      if (!existing) continue;

      if (now - existing.timestamp > DEDUP_WINDOW_MS) break; // 超出時間窗口

      if (
        dedupKey({
          category: existing.category,
          source: existing.source,
          summary: existing.summary,
          details: existing.details,
          evidence: existing.evidence,
        }) === key
      ) {
        // 找到重複，增加計數
        existing.count++;
        existing.timestamp = now; // 更新時間戳為最新
        notifySidebar(tabId);
        return;
      }
    }

    // 新行為記錄
    const entry: BehaviorEntry = {
      id: generateId(),
      timestamp: now,
      category: event.category,
      source: event.source,
      summary: event.summary,
      details: event.details,
      evidence: event.evidence,
      count: 1,
      // 資安分級標記（由 content buffer 或白名單過濾層決定）
      is_security_risk: (event as any).is_security_risk,
      risk_level: (event as any).risk_level,
      is_aggregated: (event as any).is_aggregated,
      aggregation_note: (event as any).aggregation_note,
    };

    behaviors.push(entry);

    // 限制最大數量
    if (behaviors.length > MAX_BEHAVIORS_PER_TAB) {
      behaviors.splice(0, behaviors.length - MAX_BEHAVIORS_PER_TAB);
    }

    notifySidebar(tabId);
  }

  // ─── 2. 常態知名網站白名單過濾 (Whitelist Noise Reduction) ───

  // 記憶體中的動態學習白名單
  const dynamicWhitelist = new Set<string>();

  /**
   * 初始化：由 chrome.storage.local 載入動態白名單
   */
  async function initDynamicWhitelist() {
    try {
      const res = await browser.storage.local.get(STORAGE_KEY_DYNAMIC_WHITELIST);
      const list = res[STORAGE_KEY_DYNAMIC_WHITELIST];
      if (Array.isArray(list)) {
        list.forEach((domain: string) => {
          if (typeof domain === 'string' && domain.trim()) {
            dynamicWhitelist.add(domain.trim().toLowerCase());
          }
        });
        console.debug('[Mouse LLM] 已載入動態學習白名單:', Array.from(dynamicWhitelist));
      }
    } catch (err) {
      console.warn('[Mouse LLM] 讀取動態白名單失敗:', err);
    }
  }

  /**
   * 將經由 LLM 診斷為 SAFE 的網域自動加入動態白名單並持久化
   */
  async function addDomainToDynamicWhitelist(domain: string) {
    const normalized = domain.toLowerCase().trim();
    if (!normalized || dynamicWhitelist.has(normalized)) return;

    dynamicWhitelist.add(normalized);
    try {
      await browser.storage.local.set({
        [STORAGE_KEY_DYNAMIC_WHITELIST]: Array.from(dynamicWhitelist),
      });
      console.info(`[Mouse LLM] 自動學習成功：已將安全網域 ${normalized} 加入動態白名單`);
    } catch (err) {
      console.warn('[Mouse LLM] 寫入動態白名單失敗:', err);
    }
  }

  /**
   * 從 URL 解析出 Hostname 網域名稱
   */
  function extractDomain(urlStr?: string): string {
    if (!urlStr) return '';
    try {
      const parsed = new URL(urlStr);
      return parsed.hostname.toLowerCase();
    } catch {
      return '';
    }
  }

  /**
   * 檢查網域是否符合白名單規則（支援精確匹配與子網域匹配）
   */
  function isDomainInList(domain: string, list: Iterable<string>): boolean {
    if (!domain) return false;
    const d = domain.toLowerCase();
    for (const item of list) {
      const w = item.toLowerCase();
      if (d === w || d.endsWith(`.${w}`)) {
        return true;
      }
    }
    return false;
  }

  /**
   * 白名單過濾判定：
   * 1. 檢查當前網域是否在靜態或動態白名單中。若不在，回傳 false（不降級）。
   * 2. 解析行為中的目標網域 (targetDomain)，優先順序為 url || scriptSource。
   * 3. 若 targetDomain 存在且與 currentDomain 跨域：
   *    - 若 targetDomain 也在白名單中（如官方子網域/CDN），則允許降級；若不在（未知外站），回傳 false（保留警報）。
   * 4. 其餘所有情況（包含頁面內部 keydown, eval, 同源請求，或目標同為白名單網域）：回傳 true（自動降級為 LOW）。
   */
  function shouldWhitelistDowngrade(currentDomain: string, event: RawBehaviorEvent): boolean {
    if (!currentDomain) return false;

    // 1. 當前網域若不在白名單中，不降級
    const isCurrentWhitelisted =
      isDomainInList(currentDomain, STATIC_WHITELIST) ||
      isDomainInList(currentDomain, dynamicWhitelist);

    if (!isCurrentWhitelisted) return false;

    // 2. 解析目標網域 (url || scriptSource)
    const targetUrl = event.evidence.url || event.evidence.scriptSource;
    const targetDomain = extractDomain(targetUrl);

    // 3. 若目標網域存在且與當前網域不同（跨域行為）
    if (targetDomain && targetDomain.toLowerCase() !== currentDomain.toLowerCase()) {
      const isTargetWhitelisted =
        isDomainInList(targetDomain, STATIC_WHITELIST) ||
        isDomainInList(targetDomain, dynamicWhitelist);

      // 未知跨域外站：保留警報，不降級
      if (!isTargetWhitelisted) {
        return false;
      }
    }

    // 4. 其餘所有情況（頁面內部事件如 keydown/eval/cookie、同源請求、或目標同為白名單網域）：自動降級為 LOW
    return true;
  }

  // ─── 3. LLM Dispatcher (單一任務鎖定 + 暫存聚合 Buffer) ──────────

  // 單一任務鎖定標籤
  let isAnalyzing = false;
  // 冷卻截止時間戳 (毫秒)
  let cooldownUntil = 0;
  // 冷卻喚醒定時器
  let cooldownTimer: ReturnType<typeof setTimeout> | null = null;

  interface RiskActionSummary {
    category: string;
    actionKey: string;
    count: number;
    firstSeen: number;
    lastSeen: number;
  }

  interface PendingDomainGroup {
    domain: string;
    tabId: number;
    actions: Map<string, RiskActionSummary>;
  }

  // 待發送 LLM 的暫存 Buffer（以 domain 分組）
  const llmPendingBuffer = new Map<string, PendingDomainGroup>();

  /**
   * 產生存入 Buffer 的極簡動作特徵鍵，用於同類計數合併
   */
  function getMinimalActionKey(event: RawBehaviorEvent): string {
    const ev = event.evidence;
    switch (event.category) {
      case 'value-access':
        return `read sensitive field (${ev.relatedField || 'password'})`;
      case 'event-binding':
        return `${ev.eventType || 'event'} on ${ev.relatedField || ev.targetElement || 'element'}`;
      case 'cookie-storage':
        return `access key "${ev.key || 'token'}"`;
      case 'dynamic-execution':
        return 'eval/Function dynamic execution';
      case 'dom-mutation':
        return 'inject script/iframe';
      case 'network-request': {
        const targetDom = extractDomain(ev.url) || 'cross-origin';
        return `${ev.method || 'REQ'} to ${targetDom}`;
      }
      case 'navigation': {
        const targetDom = extractDomain(ev.url) || 'external';
        return `redirect to ${targetDom}`;
      }
      default:
        return event.summary.slice(0, 30);
    }
  }

  /**
   * 將 HIGH/MEDIUM 風險行為加入 Local Buffer 中暫存合併
   */
  function bufferRiskEventForLLM(tabId: number, domain: string, event: RawBehaviorEvent) {
    if (!domain) return;

    if (!llmPendingBuffer.has(domain)) {
      llmPendingBuffer.set(domain, {
        domain,
        tabId,
        actions: new Map(),
      });
    }

    const group = llmPendingBuffer.get(domain)!;
    group.tabId = tabId;

    const actionKey = getMinimalActionKey(event);
    const now = Date.now();

    const existing = group.actions.get(actionKey);
    if (existing) {
      existing.count++;
      existing.lastSeen = now;
    } else {
      group.actions.set(actionKey, {
        category: event.category,
        actionKey,
        count: 1,
        firstSeen: now,
        lastSeen: now,
      });
    }

    // 嘗試調度分發
    scheduleLLMDispatch();
  }

  /**
   * 構建極簡 Payload：確保傳給 LLM 的 Prompt 在 200 Tokens 以內
   */
  function buildMinimalPayload(group: PendingDomainGroup) {
    const events: string[] = [];

    for (const item of group.actions.values()) {
      const elapsedSec = Math.max(1, Math.round((item.lastSeen - item.firstSeen) / 1000));
      events.push(
        item.count > 1
          ? `${item.count}x ${item.actionKey} in ${elapsedSec}s`
          : `1x ${item.actionKey}`
      );
    }

    return {
      domain: group.domain,
      events: events.slice(0, 8), // 最多取 8 條同類聚合，嚴格保證在 200 Tokens 內
    };
  }

  /**
   * LLM 調度器核心排程：
   * 遵循單一任務鎖 (isAnalyzing) 與 15 秒冷卻時間 (Cooldown)
   */
  function scheduleLLMDispatch() {

    console.log('[DEBUG Dispatcher] 被呼叫', {
      isAnalyzing,
      cooldownUntil,
      now: Date.now(),
      bufferSize: llmPendingBuffer.size,
    });

    // 1. 若當前已有任務正在分析中，絕對不發送新請求，僅在 buffer 中暫存
    if (isAnalyzing) {
      console.log('[DEBUG Dispatcher] ❌ 被 isAnalyzing 擋住');
      console.debug('[Mouse LLM Dispatcher] 當前正有任務分析中 (isAnalyzing=true)，已安全暫存合併於 Buffer');
      return;
    }

    // 2. 檢查是否在 15 秒冷卻時間內
    const now = Date.now();
    if (now < cooldownUntil) {
      console.log('[DEBUG Dispatcher] ❌ 被 cooldown 擋住');
      const remainingMs = cooldownUntil - now;
      console.debug(`[Mouse LLM Dispatcher] 處於冷卻時間中（尚餘 ${Math.ceil(remainingMs / 1000)}s），暫緩發送`);
      if (!cooldownTimer) {
        cooldownTimer = setTimeout(() => {
          cooldownTimer = null;
          scheduleLLMDispatch();
        }, remainingMs);
      }
      return;
    }

    // 3. 檢查 Buffer 是否有累積的待診斷項目
    if (llmPendingBuffer.size === 0) {
      console.log('[DEBUG Dispatcher] ❌ Buffer 是空的');
      return;
    }

    // 4. 取出第一個待診斷的網域群組
    const [firstDomain, group] = llmPendingBuffer.entries().next().value as [string, PendingDomainGroup];
    llmPendingBuffer.delete(firstDomain);

    console.log('[DEBUG Dispatcher] ✅ 準備執行 executeLLMDiagnosis', {
      domain: firstDomain,
      bufferSize: llmPendingBuffer.size,
    });

    // 啟動分析任務
    executeLLMDiagnosis(group);
  }

  /**
   * 嚴格規範的 System Prompt：要求回傳 verdict + thinking + reasoning
   */
  const SYSTEM_PROMPT =
    '你是一個 JSON API，只輸出合法 JSON，不得輸出 Markdown 或額外文字。\n' +
    '請根據輸入的網頁行為 JSON 進行風險評估。\n' +
    '\n' +
    '判斷規則：\n' +
    '1. 只能根據輸入中實際提供的資訊，不得捏造或假設不存在的行為。\n' +
    '2. event-binding、event listener、event on element 等一般事件本身很常見，不能單獨視為惡意。\n' +
    '3. 沒有具體惡意證據（如資料竊取、鍵盤側錄、惡意 URL、程式碼注入等）時，不得判定為 DANGEROUS。\n' +
    '4. 證據不足時判定為 SUSPICIOUS；thinking 只能描述實際收到的資訊與合理推論。\n' +
    '\n' +
    '輸出格式：\n' +
    '{\n' +
    '  "verdict": "<SAFE|SUSPICIOUS|DANGEROUS>",\n' +
    '  "thinking": "<根據實際輸入的簡短分析>",\n' +
    '  "reasoning": "<中文摘要，30字內>"\n' +
    '}\n' +
    'verdict 只能是 "SAFE"、"SUSPICIOUS" 或 "DANGEROUS"。';


  /**
   * 執行本地 Ollama API 呼叫，含 10 秒 Timeout 與自動解鎖保護
   */
  async function executeLLMDiagnosis(group: PendingDomainGroup) {
    isAnalyzing = true;
    const minimalPayload = buildMinimalPayload(group);
    console.info(`[Mouse LLM Dispatcher] 發送極簡診斷請求至 Ollama:`, minimalPayload);

    // 通知 Sidebar 進入分析中狀態（啟動 Spinner）
    try {
      browser.runtime
        .sendMessage({ action: 'llm-analyzing', tabId: group.tabId })
        .catch(() => { });
    } catch { /* silent */ }

    // 設定 10 秒逾時控制，防止系統死鎖
    const controller = new AbortController();
    const timeoutTimer = setTimeout(() => {
      controller.abort();
    }, LLM_TIMEOUT_MS);

    try {
      const promptPayload = {
        model: OLLAMA_MODEL,
        stream: false,
        format: 'json',
        system: SYSTEM_PROMPT,
        prompt: JSON.stringify(minimalPayload),
      };

      // ✅ Debug: 發送前印出完整 Prompt
      console.log('👉 [Ollama Prompt]:', promptPayload);

      const response = await fetch(OLLAMA_API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(promptPayload),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`Ollama HTTP Error: ${response.status} ${response.statusText}`);
      }

      const data = await response.json();
      let rawOutput = (data.response || '').trim();

      // ✅ Debug: 收到 Ollama 原始回傳
      console.log('👈 [Ollama Raw Response]:', rawOutput);

      // 清除可能殘留的 Markdown 標籤以保證純 JSON
      rawOutput = rawOutput
        .replace(/^```json\s*/i, '')
        .replace(/^```\s*/i, '')
        .replace(/```\s*$/, '')
        .trim();

      let parsed: { domain?: string; risk?: string; verdict?: string; thinking?: string; reasoning?: string };
      let parsedOk = true;
      try {
        parsed = JSON.parse(rawOutput);
      } catch {
        // JSON 解析失敗：直接將原始輸出存入 thinking
        parsed = { thinking: rawOutput };
        parsedOk = false;
      }

      // 相容舊格式 (domain/risk) 和新格式 (verdict)
      const domain = parsed.domain || group.domain;
      const riskRaw = (parsed.verdict || parsed.risk || '').toUpperCase();
      const thinking = parsed.thinking || (parsedOk ? undefined : rawOutput);
      const reasoning = parsed.reasoning;

      if (riskRaw === 'SAFE' || riskRaw === 'SUSPICIOUS' || riskRaw === 'DANGEROUS') {
        const verdict: LLMDiagnosisResult = {
          domain,
          risk: riskRaw as LLMRiskVerdict,
          thinking,
          reasoning,
          timestamp: Date.now(),
        };

        tabLLMVerdicts.set(group.tabId, verdict);
        console.info(`[Mouse LLM Dispatcher] 診斷成功：${domain} 判定為 [${riskRaw}]`, { thinking, reasoning });

        // 若診斷為 SAFE，自動學習加入動態白名單，未來不再重複思考
        if (riskRaw === 'SAFE') {
          await addDomainToDynamicWhitelist(domain);
        }

        // 推送診斷結論至 Sidebar
        notifySidebarLLMVerdict(group.tabId, verdict);
      } else {
        // 就算 risk 不符規範，也將 thinking 推送出去方便除錯
        console.warn('[Mouse LLM Dispatcher] 回傳的 risk/verdict 欄位不符規範:', parsed);
        const fallbackVerdict: LLMDiagnosisResult = {
          domain: group.domain,
          risk: 'SUSPICIOUS',
          thinking: thinking || rawOutput,
          reasoning: '解析异常，請檢查原始輸出',
          timestamp: Date.now(),
        };
        tabLLMVerdicts.set(group.tabId, fallbackVerdict);
        notifySidebarLLMVerdict(group.tabId, fallbackVerdict);
      }
    } catch (err: any) {
      if (err.name === 'AbortError') {
        console.warn(`[Mouse LLM Dispatcher] 請求超時（超過 ${LLM_TIMEOUT_MS / 1000} 秒），已自動中斷`);
        // 通知 Sidebar 逾時未回應狀態（明確判定為逾時，不產生假 verdict）
        try {
          browser.runtime
            .sendMessage({
              action: MSG_ACTION.LLM_TIMEOUT,
              tabId: group.tabId,
              domain: group.domain,
              error: 'Ollama 逾時未回應',
            })
            .catch(() => { });
        } catch { /* silent */ }
      } else {
        console.warn('[Mouse LLM Dispatcher] 連線或診斷發生異常:', err?.message || err);
      }
    } finally {
      // 確保逾時定時器被清除
      clearTimeout(timeoutTimer);

      // 解鎖任務
      isAnalyzing = false;

      // 啟動 15 秒冷卻時間
      cooldownUntil = Date.now() + LLM_COOLDOWN_MS;
      console.debug(`[Mouse LLM Dispatcher] 任務完成，啟動 15 秒冷卻保護（冷卻期至: ${new Date(cooldownUntil).toLocaleTimeString()}）`);

      // 冷卻結束後自動檢查 buffer
      if (cooldownTimer) clearTimeout(cooldownTimer);
      cooldownTimer = setTimeout(() => {
        cooldownTimer = null;
        console.debug(`[Mouse LLM Dispatcher] 冷卻期滿，檢查待診斷隊列 (剩餘網域: ${llmPendingBuffer.size})`);
        scheduleLLMDispatch();
      }, LLM_COOLDOWN_MS);
    }
  }

  // ─── 4. 推送更新至 Sidebar ────────────────────────────────────

  function notifySidebar(tabId: number) {
    try {
      browser.runtime
        .sendMessage({
          action: MSG_ACTION.BEHAVIORS_UPDATED,
          tabId,
          behaviors: tabBehaviors.get(tabId) || [],
        })
        .catch(() => { });
    } catch {
      // silent
    }
  }

  function notifySidebarLLMVerdict(tabId: number, verdict: LLMDiagnosisResult) {
    try {
      browser.runtime
        .sendMessage({
          action: MSG_ACTION.LLM_STATUS_UPDATED,
          tabId,
          verdict,
        })
        .catch(() => { });
    } catch {
      // silent
    }
  }

  // ─── 5. 訊息接收與分發入口 ────────────────────────────────────

  browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
    const action = message?.action;

    // Content script 回報行為
    if (action === MSG_ACTION.REPORT_BEHAVIOR && sender.tab?.id) {
      const tabId = sender.tab.id;
      const payload = message.payload as RawBehaviorEvent;

      if (payload && payload.category && payload.summary) {
        // 1. 解析當前分頁網域
        const currentDomain = extractDomain(sender.tab?.url || sender.url || payload.evidence?.url);

        // 2. 常態知名網站白名單過濾
        if (shouldWhitelistDowngrade(currentDomain, payload)) {
          // 自動降級為 LOW，不觸發 LLM
          payload.risk_level = 'LOW';
          payload.is_security_risk = false;
        }

        // 3. 正常記錄至分頁行為列表
        addBehavior(tabId, payload);

        // 4. 若仍為 HIGH 或 MEDIUM 風險，且未在動態白名單中，送入 LLM 暫存 Buffer
        if (payload.risk_level === 'HIGH' || payload.risk_level === 'MEDIUM') {
          if (!isDomainInList(currentDomain, dynamicWhitelist)) {
            bufferRiskEventForLLM(tabId, currentDomain, payload);
          }
        }
      }
      return;
    }

    // Sidebar 請求取得行為列表
    if (action === MSG_ACTION.GET_BEHAVIORS) {
      const tabId = message.tabId as number;
      const behaviors = tabBehaviors.get(tabId) || [];
      const verdict = tabLLMVerdicts.get(tabId);
      sendResponse({ behaviors, verdict });
      return true; // 同步回應
    }

    // Sidebar 手動觸發 LLM 診斷（測試 / 除錯用）
    if (action === MSG_ACTION.TRIGGER_LLM_TEST) {
      console.log('[DEBUG LLM TEST] 收到 Sidebar 手動診斷請求', message);
      const tabId = message.tabId as number;
      const domain = message.domain as string;
      if (!tabId || !domain) return;

      console.info(`[Mouse LLM] 手動觸發診斷：tabId=${tabId} domain=${domain}`);

      // 重置冷卻與鎖，強制立即執行
      isAnalyzing = false;
      cooldownUntil = 0;
      if (cooldownTimer) { clearTimeout(cooldownTimer); cooldownTimer = null; }

      // 建立一個測試用的合成事件放入 Buffer
      const syntheticEvent: RawBehaviorEvent = {
        category: 'event-binding',
        source: 'JS_HOOK',
        summary: `[手動診斷] ${domain} LLM 連線測試`,
        details: 'Sidebar 手動觸發的 LLM 連線測試診斷',
        evidence: {},
        risk_level: 'HIGH',
        is_security_risk: true,
      };
      bufferRiskEventForLLM(tabId, domain, syntheticEvent);
      return;
    }
  });

  // ─── 6. HTTP 重導向追蹤 ───────────────────────────────────────

  const redirectChains = new Map<string, string[]>();

  try {
    browser.webRequest.onBeforeRedirect.addListener(
      (details) => {
        if (!details.tabId || details.tabId < 0) return;

        const requestId = details.requestId;
        const chain = redirectChains.get(requestId) || [details.url];
        chain.push(details.redirectUrl);
        redirectChains.set(requestId, chain);
      },
      { urls: ['<all_urls>'] }
    );

    browser.webRequest.onCompleted.addListener(
      (details) => {
        if (!details.tabId || details.tabId < 0) return;

        const chain = redirectChains.get(details.requestId);
        if (chain && chain.length > 1) {
          addBehavior(details.tabId, {
            category: 'navigation',
            source: 'JS_HOOK',
            summary: `${chain[0]} 經過 ${chain.length - 1} 次跳轉，最終到達 ${chain[chain.length - 1]}`,
            details: `跳轉鏈：${chain.join(' → ')}`,
            evidence: {
              url: chain[chain.length - 1],
            },
          });
          redirectChains.delete(details.requestId);
        }
      },
      { urls: ['<all_urls>'] }
    );
  } catch {
    console.debug('[Mouse] webRequest API 不可用，跳過重導向追蹤');
  }

  // ─── 7. 分頁生命週期管理 ─────────────────────────────────────

  // 分頁關閉時清理
  browser.tabs.onRemoved.addListener((tabId) => {
    tabBehaviors.delete(tabId);
    tabLLMVerdicts.delete(tabId);
  });

  // 頁面導航時重置
  browser.webNavigation.onCommitted.addListener((details) => {
    if (details.frameId !== 0) return;

    const tabId = details.tabId;
    tabBehaviors.set(tabId, []);
    tabLLMVerdicts.delete(tabId);

    try {
      browser.runtime
        .sendMessage({
          action: MSG_ACTION.TAB_RESET,
          tabId,
        })
        .catch(() => { });
    } catch {
      // silent
    }
  });

  // ─── 8. 開啟 Sidebar 與初始載入 ─────────────────────────────

  if (browser.sidePanel?.setPanelBehavior) {
    browser.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => { });
  } else if (browser.action?.onClicked) {
    browser.action.onClicked.addListener((tab) => {
      if ((browser as any).sidebarAction?.open) {
        (browser as any).sidebarAction.open();
      }
    });
  }

  // 啟動時非同步讀取動態白名單
  initDynamicWhitelist();

  console.info('[Mouse] Background service worker & LLM Dispatcher 已啟動');
});
