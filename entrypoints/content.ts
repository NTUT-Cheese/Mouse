/**
 * Content Script — ISOLATED World
 *
 * 職責：
 * 1. 注入 nonce 到 DOM，供 injected script（MAIN world）讀取
 * 2. 監聽 postMessage 橋接 injected script 的行為日誌
 * 3. 執行 DOM MutationObserver 監控元件動態變化
 * 4. 將所有行為轉發給 Background Service Worker
 */

import {
  MESSAGE_CHANNEL,
  NONCE_ATTR,
  NONCE_ELEMENT_ID,
  MSG_ACTION,
  BUFFER_WINDOW_MS,
  BUFFER_MAX_SIZE,
  SENSITIVE_STORAGE_KEYWORDS,
  LOW_RISK_URL_PATTERNS,
  MUTATION_BATCH_WINDOW_MS,
  STORAGE_THROTTLE_MS,
  STATIC_WHITELIST,
  HIGH_DYNAMIC_DOMAINS,
} from '@/utils/constants';
import type { InjectedMessage, RawBehaviorEvent, RiskLevel } from '@/utils/types';

export default defineContentScript({
  matches: ['<all_urls>'],
  runAt: 'document_start',

  main() {
    // 判斷是否為 YouTube 等高頻 DOM 變動與串流網站
    const isHighDynamicSite = /(?:^|\.)(youtube\.com|googlevideo\.com|netflix\.com|twitch\.tv|bilibili\.com)$/i.test(location.hostname);

    // ─── 1. 生成 Nonce 並注入 DOM 與 MAIN world 腳本 ──────────────

    const nonce = crypto.randomUUID();

    function injectNonce() {
      const carrier = document.createElement('div');
      carrier.id = NONCE_ELEMENT_ID;
      carrier.setAttribute(NONCE_ATTR, nonce);
      carrier.style.display = 'none';
      (document.documentElement || document.head || document.body).appendChild(carrier);
    }

    function injectMainScript() {
      injectNonce();
      try {
        const script = document.createElement('script');
        script.src = browser.runtime.getURL('/injected.js');
        script.onload = () => script.remove();
        (document.head || document.documentElement).appendChild(script);
      } catch (err) {
        console.error('[Mouse] Failed to inject injected script:', err);
      }
    }

    // 盡早注入 nonce 與 injected.js
    if (document.documentElement) {
      injectMainScript();
    } else {
      // 極早期情況，等 DOM 出現
      const observer = new MutationObserver(() => {
        if (document.documentElement) {
          observer.disconnect();
          injectMainScript();
        }
      });
      observer.observe(document, { childList: true });
    }

    // ─── 2. 降頻聚合 Buffer 層 (Buffer Window + 資安分級) ──────────────────────────────────

    /**
     * 資安風險分層判定器
     * 回傳 { is_security_risk, risk_level } 或 null（無風險）
     */
    function classifyRisk(event: RawBehaviorEvent): { is_security_risk: true; risk_level: RiskLevel } | { is_security_risk: false; risk_level: 'LOW' } | null {
      const ev = event.evidence;
      const cat = event.category;

      // HIGH: 跨源動態腳本 / iframe / link 插入
      if (cat === 'dom-mutation' && ev.isSameOrigin === false) {
        if (
          event.summary.includes('<script') ||
          event.summary.includes('<iframe') ||
          event.summary.includes('<link')
        ) {
          return { is_security_risk: true, risk_level: 'HIGH' };
        }
      }

      // HIGH: 密碼欄位 / 信用卡欄位實際讀取
      if (cat === 'value-access') {
        return { is_security_risk: true, risk_level: 'HIGH' };
      }

      // HIGH: 密碼欄位上的事件綁定
      if (cat === 'event-binding' && ev.relatedField === 'password') {
        return { is_security_risk: true, risk_level: 'HIGH' };
      }

      // HIGH: window/document 層級全域鍵盤監聽
      if (
        cat === 'event-binding' &&
        (ev.eventType === 'keydown' || ev.eventType === 'keyup' || ev.eventType === 'keypress') &&
        (!ev.targetElement ||
          ev.targetElement === '' ||
          ev.targetElement.toLowerCase().includes('window') ||
          ev.targetElement.toLowerCase().includes('document') ||
          ev.targetElement.toLowerCase().includes('htmlelement'))
      ) {
        return { is_security_risk: true, risk_level: 'HIGH' };
      }

      // MEDIUM: 存取含資安敏感關鍵字的 Storage / Cookie key
      if (cat === 'cookie-storage' && ev.key) {
        const keyLower = ev.key.toLowerCase();
        const isSensitive = SENSITIVE_STORAGE_KEYWORDS.some((kw) => keyLower.includes(kw));
        if (isSensitive) return { is_security_risk: true, risk_level: 'MEDIUM' };
      }

      // MEDIUM: 動態 eval / Function 執行
      if (cat === 'dynamic-execution') {
        return { is_security_risk: true, risk_level: 'MEDIUM' };
      }

      // MEDIUM: 跨源頁面跳轉
      if (cat === 'navigation' && ev.isSameOrigin === false) {
        return { is_security_risk: true, risk_level: 'MEDIUM' };
      }

      // LOW: 同源常態統計/遙測請求（減少視覺噪音，預設收合）
      if (cat === 'network-request' && ev.isSameOrigin !== false && ev.url) {
        const urlLower = ev.url.toLowerCase();
        const isNoisyPattern = LOW_RISK_URL_PATTERNS.some((p) => urlLower.includes(p));
        if (isNoisyPattern) {
          return { is_security_risk: false, risk_level: 'LOW' };
        }
      }

      return null;
    }

    /**
     * 決定事件是否應 bypass Buffer，立即處理
     * true = 高風險，直接發送；false = 一般，進入 buffer
     */
    function shouldBypass(event: RawBehaviorEvent, risk: ReturnType<typeof classifyRisk>): boolean {
      // 只有真正具威脅的資安風險（HIGH / MEDIUM）才立即發送
      if (risk && risk.is_security_risk) {
        // 在 YouTube 等高動態 SPA 網站上，全域鍵盤快捷鍵監聽改走 Buffer 聚合，避免頻繁打擾背景
        if (isHighDynamicSite && event.category === 'event-binding') {
          return false;
        }
        return true;
      }
      // 跨源網路請求立即處理
      if (event.category === 'network-request' && event.evidence.isSameOrigin === false) {
        return true;
      }
      return false;
    }

    // Buffer 內部分組結構
    interface BufferGroup {
      key: string;
      isSameOrigin: boolean | undefined;
      representative: RawBehaviorEvent;
      count: number;
    }

    let buffer = new Map<string, BufferGroup>();
    let bufferTimer: ReturnType<typeof setTimeout> | null = null;

    /** 計算 buffer 聚合鍵（相同 category + source + isSameOrigin 視為同類） */
    function bufferGroupKey(event: RawBehaviorEvent): string {
      const origin =
        event.evidence.isSameOrigin === true
          ? 'same'
          : event.evidence.isSameOrigin === false
            ? 'cross'
            : 'unknown';
      return `${event.category}|${event.source}|${origin}`;
    }

    /** 將 buffer 中所有聚合事件批次發送至 background */
    function flushBuffer() {
      bufferTimer = null;
      if (buffer.size === 0) return;

      const groups = Array.from(buffer.values());
      buffer = new Map();

      for (const group of groups) {
        const rep = group.representative;
        const count = group.count;

        if (count === 1) {
          // 單一事件，直接原樣發送
          forwardToBackground(rep);
        } else {
          // 多事件合併：產生聚合摘要
          const originLabel =
            group.isSameOrigin === true ? '同源' : group.isSameOrigin === false ? '跨源' : '';
          const categoryLabels: Record<string, string> = {
            'network-request': '網路請求',
            'event-binding': '事件綁定',
            'cookie-storage': 'Cookie/Storage 操作',
            'dynamic-execution': '動態執行',
            'dom-mutation': 'DOM 變化',
            navigation: '跳轉行為',
            'value-access': '欄位值讀取',
          };
          const catLabel = categoryLabels[rep.category] || rep.category;

          const aggregatedEvent: RawBehaviorEvent = {
            ...rep,
            summary: `[${catLabel}] 3秒內${originLabel ? ` ${originLabel}` : ''}發生 ${count} 次（已自動聚合）`,
            details: `共 ${count} 個相似事件，代表事件：${rep.summary}`,
            evidence: { ...rep.evidence },
          };

          forwardToBackground(aggregatedEvent, {
            is_aggregated: true,
            aggregation_note: `3 秒內自動聚合共 ${count} 個同類${originLabel ? ` ${originLabel}` : ''}事件`,
          });
        }
      }
    }

    /**
     * 事件路由：所有行為事件的唯一入口
     *
     * - 高風險事件 → 立即 bypass，標記資安屬性後直接發送
     * - 一般事件  → 進入 buffer，等待 3 秒後批次聚合發送
     */
    function routeEvent(event: RawBehaviorEvent) {
      const risk = classifyRisk(event);

      // 附加風險標記至事件（不論等級）
      const enriched: RawBehaviorEvent = risk
        ? { ...event, is_security_risk: risk.is_security_risk, risk_level: risk.risk_level }
        : event;

      if (shouldBypass(event, risk)) {
        // HIGH / MEDIUM 風險：立即發送，不進 buffer
        forwardToBackground(enriched);
        return;
      }

      // 一般 / LOW 風險：進入 Buffer（LOW 風險也附帶了 risk_level 標記）
      if (buffer.size >= BUFFER_MAX_SIZE) {
        // 防內存暴谷：超出上限時立即 flush
        flushBuffer();
      }

      const key = bufferGroupKey(enriched);
      const existing = buffer.get(key);
      if (existing) {
        existing.count++;
      } else {
        buffer.set(key, {
          key,
          isSameOrigin: enriched.evidence.isSameOrigin,
          representative: enriched,
          count: 1,
        });
      }

      // 開啟定時器（只在第一個事件時開啟）
      if (!bufferTimer) {
        bufferTimer = setTimeout(flushBuffer, BUFFER_WINDOW_MS);
      }
    }

    // ─── 3. postMessage 橋接 ──────────────────────────────────

    function forwardToBackground(
      event: RawBehaviorEvent,
      extra?: { is_aggregated?: boolean; aggregation_note?: string }
    ) {
      try {
        browser.runtime.sendMessage({
          action: MSG_ACTION.REPORT_BEHAVIOR,
          payload: { ...event, ...extra },
        });
      } catch {
        // 擴充功能被卸載或其他錯誤時靜默失敗
      }
    }

    window.addEventListener('message', (event: MessageEvent) => {
      // 只接受來自同一個 window 的訊息
      if (event.source !== window) return;

      const data = event.data as InjectedMessage;
      if (!data || data.type !== MESSAGE_CHANNEL) return;
      if (data.nonce !== nonce) return;

      // 驗證通過，進入路由決策層
      routeEvent(data.payload);
    });

    // ─── 3. DOM 結構監控（Phase 2）─────────────────────────────

    function describeElement(el: Element): string {
      const tag = el.tagName.toLowerCase();
      const attrs: string[] = [];
      for (const attr of el.attributes) {
        if (['src', 'href', 'action', 'type', 'name', 'id', 'content', 'http-equiv'].includes(attr.name)) {
          attrs.push(`${attr.name}="${attr.value}"`);
        }
      }
      return `<${tag}${attrs.length ? ' ' + attrs.join(' ') : ''}>`;
    }

    function getElementDimensions(el: Element): string {
      if (el instanceof HTMLElement) {
        const w = el.offsetWidth || parseInt(el.getAttribute('width') || '0');
        const h = el.offsetHeight || parseInt(el.getAttribute('height') || '0');
        return `${w}×${h}`;
      }
      return '';
    }

    function checkSameOrigin(urlStr?: string): boolean | undefined {
      if (!urlStr) return undefined;
      try {
        const targetOrigin = new URL(urlStr, window.location.href).origin;
        return targetOrigin === window.location.origin;
      } catch {
        return undefined;
      }
    }

    /**
     * 掃描頁面上的敏感元件（初始掃描 + 定期更新）
     */
    function scanSensitiveElements() {
      // 密碼欄位
      const pwFields = document.querySelectorAll('input[type="password"]');
      if (pwFields.length > 0) {
        routeEvent({
          category: 'dom-mutation',
          source: 'DOM',
          summary: `頁面包含 ${pwFields.length} 個密碼輸入欄位`,
          details: Array.from(pwFields).map(describeElement).join(', '),
          evidence: {
            elementSnippet: Array.from(pwFields).map(describeElement).join('\n'),
          },
        });
      }

      // 隱藏的 iframe
      const iframes = document.querySelectorAll('iframe');
      const hiddenIframes = Array.from(iframes).filter((iframe) => {
        const style = window.getComputedStyle(iframe);
        const w = iframe.offsetWidth;
        const h = iframe.offsetHeight;
        return (
          style.display === 'none' ||
          style.visibility === 'hidden' ||
          (w <= 1 && h <= 1) ||
          style.opacity === '0'
        );
      });
      if (hiddenIframes.length > 0) {
        routeEvent({
          category: 'dom-mutation',
          source: 'DOM',
          summary: `頁面包含 ${hiddenIframes.length} 個隱藏的 iframe`,
          details: hiddenIframes.map((f) => `${describeElement(f)} (尺寸 ${getElementDimensions(f)})`).join('\n'),
          evidence: {
            elementSnippet: hiddenIframes.map(describeElement).join('\n'),
          },
        });
      }

      // 外部 form action
      const forms = document.querySelectorAll('form[action]');
      forms.forEach((form) => {
        const action = form.getAttribute('action') || '';
        try {
          const actionUrl = new URL(action, location.href);
          if (actionUrl.origin !== location.origin) {
            routeEvent({
              category: 'dom-mutation',
              source: 'DOM',
              summary: `表單的 action 指向外部網域：${actionUrl.origin}`,
              details: `${describeElement(form)}，action="${action}"`,
              evidence: {
                url: action,
                isSameOrigin: checkSameOrigin(action),
                elementSnippet: describeElement(form),
              },
            });
          }
        } catch {
          // 無效 URL，忽略
        }
      });
    }

    /**
     * 檢查當前網域是否屬於知名白名單或高動態 SPA 網站
     */
    function isWhitelistedOrHighDynamicSite(): boolean {
      const currentHost = location.hostname.toLowerCase();
      const allBypassDomains = [...STATIC_WHITELIST, ...HIGH_DYNAMIC_DOMAINS];
      for (const domain of allBypassDomains) {
        const d = domain.toLowerCase();
        if (currentHost === d || currentHost.endsWith(`.${d}`)) {
          return true;
        }
      }
      return false;
    }

    /**
     * MutationObserver：監控動態 DOM 變化
     *
     * 1. 知名白名單與高動態網域（如 youtube.com, google.com 等）直接 Bypass，不啟動 MutationObserver，徹底杜絕主線程卡死。
     * 2. 非白名單網站採用極輕量判定：僅使用 mutations.length 統計變更次數，完全不遍歷 addedNodes，避免 Layout Reflow。
     */
    function startMutationMonitor() {
      // 1. 白名單與高動態網域直接 Bypass DOM 樹監聽
      if (isWhitelistedOrHighDynamicSite()) {
        console.debug(`[Mouse] ${location.hostname} 屬於知名白名單或高動態 SPA 網站，直接 Bypass MutationObserver 監聽`);
        return;
      }

      let pendingMutationCount = 0;
      let mutationBatchTimer: ReturnType<typeof setTimeout> | null = null;

      const observer = new MutationObserver((mutations) => {
        // 極輕量判定：僅記錄本次變動數量，完全不存取或遍歷 addedNodes 陣列
        pendingMutationCount += mutations.length;

        // 500ms 節流批次彙整
        if (!mutationBatchTimer) {
          mutationBatchTimer = setTimeout(() => {
            mutationBatchTimer = null;
            const count = pendingMutationCount;
            pendingMutationCount = 0;

            if (count > 0) {
              routeEvent({
                category: 'dom-mutation',
                source: 'DOM',
                summary: `500ms 內發生了 ${count} 次 DOM 結構變動（輕量聚合監控）`,
                details: `共記錄 ${count} 個 Mutation 批次變動記錄`,
                evidence: {
                  elementSnippet: `<mutations count="${count}">`,
                },
              });
            }
          }, MUTATION_BATCH_WINDOW_MS);
        }
      });

      observer.observe(document.documentElement || document, {
        childList: true,
        subtree: true,
        attributes: false, // 關閉高頻 attributes 監控，極致輕量
      });
    }

    // ─── 4. 懸停探針 (Hover Inspector) 浮動 UI ───────────────────────

    let isInspectorEnabled = true;
    let inspectorTooltipEl: HTMLElement | null = null;

    let inspectorTooltipRafId: number | null = null;
    let pendingMousePos = { x: 0, y: 0 };
    let lastInspectedTarget: Element | null = null;

    function injectTooltipGlobalStyle() {
      if (document.getElementById('__mouse_tooltip_style__')) return;
      const style = document.createElement('style');
      style.id = '__mouse_tooltip_style__';
      style.textContent = `
        #__mouse_hover_tooltip__, #__mouse_hover_tooltip__ * {
          pointer-events: none !important;
          user-select: none !important;
        }
      `;
      (document.head || document.documentElement).appendChild(style);
    }

    function createInspectorTooltip() {
      if (inspectorTooltipEl) return inspectorTooltipEl;
      injectTooltipGlobalStyle();

      const el = document.createElement('div');
      el.id = '__mouse_hover_tooltip__';
      el.style.cssText = `
        position: fixed;
        z-index: 2147483647;
        pointer-events: none !important;
        user-select: none !important;
        display: none;
        padding: 10px 14px;
        background: rgba(13, 17, 23, 0.94);
        backdrop-filter: blur(12px);
        border: 1px solid rgba(88, 166, 255, 0.4);
        border-radius: 10px;
        color: #e6edf3;
        font-family: system-ui, -apple-system, sans-serif;
        font-size: 11.5px;
        line-height: 1.5;
        box-shadow: 0 8px 24px rgba(0,0,0,0.5);
        max-width: 320px;
        transition: opacity 150ms ease, transform 150ms ease;
      `;
      (document.body || document.documentElement).appendChild(el);
      inspectorTooltipEl = el;
      return el;
    }

    function removeInspectorTooltip() {
      if (inspectorTooltipEl) {
        inspectorTooltipEl.remove();
        inspectorTooltipEl = null;
      }
      if (inspectorTooltipRafId) {
        cancelAnimationFrame(inspectorTooltipRafId);
        inspectorTooltipRafId = null;
      }
    }

    function updateTooltipPos(e: MouseEvent | PointerEvent) {
      if (!inspectorTooltipEl) return;
      pendingMousePos.x = e.clientX;
      pendingMousePos.y = e.clientY;

      if (!inspectorTooltipRafId) {
        inspectorTooltipRafId = requestAnimationFrame(() => {
          inspectorTooltipRafId = null;
          if (!inspectorTooltipEl) return;

          const x = pendingMousePos.x + 14;
          const y = pendingMousePos.y + 14;
          const width = inspectorTooltipEl.offsetWidth || 280;
          const height = inspectorTooltipEl.offsetHeight || 100;
          const maxX = window.innerWidth - width - 16;
          const maxY = window.innerHeight - height - 16;

          inspectorTooltipEl.style.left = `${Math.max(10, Math.min(x, maxX))}px`;
          inspectorTooltipEl.style.top = `${Math.max(10, Math.min(y, maxY))}px`;
        });
      }
    }

    function findInteractiveElement(el: Element | null): Element | null {
      if (!el) return null;

      // 向上遍歷，優先尋找最具代表性的父級互動容器 (a, button, form, [role="button"], [onclick], [href])
      // 限制最大遍歷深度為 5 層，避免在 YouTube 龐大自訂元件樹上浪費 CPU
      let curr: Element | null = el;
      let fallbackMediaEl: Element | null = null;
      let depth = 0;

      while (curr && curr !== document.documentElement && curr !== document.body && depth < 6) {
        depth++;
        const tag = curr.tagName.toLowerCase();

        // 遇到大型容器時快速終止
        if (tag.startsWith('ytd-app') || tag.startsWith('ytd-browse') || tag.startsWith('ytd-watch')) {
          break;
        }

        // 1. 標準容器 (a, button, form, input, select, textarea, role="button")
        if (['button', 'a', 'input', 'select', 'textarea', 'form', 'option'].includes(tag) || curr.getAttribute('role') === 'button') {
          return curr;
        }

        // 2. 帶有 onclick, href, data-href, data-mouse-handler-info 的任意父級元素
        if (
          curr.hasAttribute('onclick') ||
          curr.hasAttribute('onmousedown') ||
          curr.hasAttribute('data-mouse-handler-info') ||
          curr.hasAttribute('href') ||
          curr.hasAttribute('data-href')
        ) {
          return curr;
        }

        // 3. 若懸停在 img / svg / canvas 上，暫存作為 fallback
        if (!fallbackMediaEl && ['img', 'svg', 'canvas'].includes(tag)) {
          fallbackMediaEl = curr;
        }

        curr = curr.parentElement;
      }

      return fallbackMediaEl;
    }

    function handlePointerOver(e: MouseEvent | PointerEvent) {
      if (!isInspectorEnabled) return;
      const target = e.target as Element | null;
      if (!target || target === lastInspectedTarget) return;
      lastInspectedTarget = target;

      const interactiveEl = findInteractiveElement(target);
      if (!interactiveEl) {
        if (inspectorTooltipEl) inspectorTooltipEl.style.display = 'none';
        return;
      }

      const tooltip = createInspectorTooltip();
      const tag = interactiveEl.tagName.toLowerCase();
      let summaryText = '';
      let targetUrl = '';
      let isSameOriginVal: boolean | undefined = undefined;
      const featuresList: string[] = [];

      // 標籤名稱/標題抽取 (母元素與子元素屬性融合)
      let labelText = (interactiveEl.getAttribute('title') || interactiveEl.getAttribute('alt') || '').trim();
      if (!labelText) {
        labelText = (interactiveEl.textContent || '').trim();
      }
      if (!labelText) {
        const childMeta = interactiveEl.querySelector('[title], [alt], img');
        if (childMeta) {
          labelText = (childMeta.getAttribute('title') || childMeta.getAttribute('alt') || childMeta.getAttribute('src')?.split('/').pop() || '').trim();
        }
      }

      // 1. 連結分析 (<a>)
      if (tag === 'a' || interactiveEl.hasAttribute('href')) {
        const href = interactiveEl.getAttribute('href');
        const downloadAttr = interactiveEl.getAttribute('download');
        const targetAttr = interactiveEl.getAttribute('target');

        if (targetAttr === '_blank') {
          featuresList.push('在新分頁開啟 (target="_blank")');
        }
        if (downloadAttr !== null) {
          featuresList.push(`觸發宣告式檔案下載 (download="${downloadAttr}")`);
        }
        if (href) {
          try {
            const u = new URL(href, location.href);
            targetUrl = u.href;
            isSameOriginVal = u.origin === location.origin;
            const filename = u.pathname.split('/').pop() || '';
            const fileExtMatch = filename.match(/\.(pdf|zip|exe|apk|dmg|csv|xlsx|doc|docx|rar|7z|tar|gz|mp3|mp4)$/i);
            
            if (fileExtMatch && fileExtMatch[1]) {
              featuresList.push(`目標為檔案資源 (*.${fileExtMatch[1].toLowerCase()})`);
              summaryText = `📥 下載檔案：${filename}`;
            } else if (downloadAttr !== null) {
              summaryText = `📥 下載檔案：${downloadAttr || filename || u.pathname}`;
            } else {
              summaryText = `開啟連結：${labelText ? `${labelText} (${u.pathname})` : u.pathname}`;
            }
          } catch {
            targetUrl = href;
          }
        }
      }

      // 2. 表單按鈕分析 (<form> / <button>)
      const form = interactiveEl.closest('form');
      if (form) {
        const action = form.getAttribute('action') || location.href;
        const method = (form.getAttribute('method') || 'GET').toUpperCase();
        try {
          const u = new URL(action, location.href);
          targetUrl = u.href;
          isSameOriginVal = u.origin === location.origin;
          summaryText = `提交表單至 ${u.pathname} (${method})`;
        } catch {
          targetUrl = action;
        }

        const pwFields = form.querySelectorAll('input[type="password"]');
        if (pwFields.length > 0) {
          featuresList.push(`表單含 ${pwFields.length} 個密碼輸入框`);
        }
      }

      // 3. 掃描 DOM data-屬性 (data-href, data-url, data-target, data-navigate)
      const dataUrl = interactiveEl.getAttribute('data-href') || interactiveEl.getAttribute('data-url') || interactiveEl.getAttribute('data-target') || interactiveEl.getAttribute('data-navigate') || interactiveEl.getAttribute('data-path');
      if (dataUrl && !targetUrl) {
        try {
          const u = new URL(dataUrl, location.href);
          targetUrl = u.href;
          isSameOriginVal = u.origin === location.origin;
          summaryText = `JS 跳轉至：${u.pathname}`;
          featuresList.push(`自訂屬性指明跳轉目標 (${dataUrl})`);
        } catch {
          targetUrl = dataUrl;
        }
      }

      // 4. 內嵌 onclick 屬性分析 (例如 <img onclick="location.href='...'">)
      const onclickAttr = interactiveEl.getAttribute('onclick');
      if (onclickAttr) {
        featuresList.push(`內嵌 onclick="${onclickAttr.slice(0, 40)}${onclickAttr.length > 40 ? '…' : ''}"`);
        if (/fetch|XMLHttpRequest|sendBeacon|axios/i.test(onclickAttr)) featuresList.push('包含網路請求 (fetch/XHR)');
        if (/password|credit|card|secret/i.test(onclickAttr)) featuresList.push('讀取密碼/敏感欄位');
        if (/cookie|localStorage|sessionStorage/i.test(onclickAttr)) featuresList.push('讀取 Cookie/Storage');
        if (/location|open\(/i.test(onclickAttr)) featuresList.push('觸發頁面跳轉');
        if (/download|createObjectURL|msSaveBlob|\.(pdf|zip|exe|apk|dmg|csv|xlsx|doc|docx)\b/i.test(onclickAttr)) featuresList.push('📥 包含檔案下載機制 (Blob/Download)');

        // 嘗試從 onclick 字串解析跳轉 URL
        const onclickNavMatch = onclickAttr.match(/(?:location(?:\.href|\.assign|\.replace)?|open|push|navigate)\s*(?:=\s*|\(\s*)['"`]([^'"`]+)['"`]/i);
        if (onclickNavMatch && onclickNavMatch[1] && !targetUrl) {
          try {
            const u = new URL(onclickNavMatch[1], location.href);
            targetUrl = u.href;
            isSameOriginVal = u.origin === location.origin;
            summaryText = `JS 跳轉至：${u.pathname}`;
          } catch {
            targetUrl = onclickNavMatch[1];
          }
        }
      }

      // 5. 讀取 injected script 記錄的事件處理器特徵 (直接綁定 vs 全域委派)
      const handlerInfoRaw = interactiveEl.getAttribute('data-mouse-handler-info');
      const globalHandlerRaw = document.documentElement.getAttribute('data-mouse-global-handler-info');
      
      if (handlerInfoRaw) {
        try {
          const info = JSON.parse(handlerInfoRaw);
          if (info.features?.includes('fetch')) featuresList.push('包含網路請求 (fetch/XHR)');
          if (info.features?.includes('password')) featuresList.push('讀取密碼/敏感欄位');
          if (info.features?.includes('storage')) featuresList.push('讀取 Cookie/Storage');
          if (info.features?.includes('navigation')) featuresList.push('觸發頁面跳轉');
          if (info.features?.includes('download')) featuresList.push('📥 包含檔案下載機制 (Blob/Download)');

          if (info.navUrl && !targetUrl) {
            try {
              const u = new URL(info.navUrl, location.href);
              targetUrl = u.href;
              isSameOriginVal = u.origin === location.origin;
              summaryText = `JS 監聽器跳轉至：${u.pathname}`;
            } catch {
              targetUrl = info.navUrl;
            }
          }
        } catch {
          // ignore
        }
      } else if (globalHandlerRaw && !onclickAttr) {
        try {
          const globalInfo = JSON.parse(globalHandlerRaw);
          featuresList.push('透過全域 Event Delegation 監聽');
          if (globalInfo.features?.includes('fetch')) featuresList.push('全域監聽含網路請求 (fetch/XHR)');
          if (globalInfo.features?.includes('password')) featuresList.push('全域監聽含密碼/敏感欄位存取');
          if (globalInfo.features?.includes('download')) featuresList.push('📥 全域監聽含檔案下載機制');
        } catch {
          // ignore
        }
      }

      if (!summaryText) {
        let labelText = (interactiveEl.textContent || '').trim();
        if (!labelText && tag === 'img') {
          const alt = interactiveEl.getAttribute('alt');
          const title = interactiveEl.getAttribute('title');
          const src = interactiveEl.getAttribute('src');
          labelText = alt || title || (interactiveEl.id ? `#${interactiveEl.id}` : src ? src.split('/').pop() || '圖片' : '圖片');
        }
        labelText = labelText.slice(0, 30);
        summaryText = onclickAttr ? `執行內嵌函式：${onclickAttr.slice(0, 30)}` : `互動元件：${labelText || `<${tag}>`}`;
      }

      const originBadge = isSameOriginVal !== undefined
        ? `<span style="display:inline-block; padding:1px 6px; border-radius:100px; font-size:10px; margin-left:6px; ${isSameOriginVal ? 'background:rgba(88,166,255,0.2); color:#58a6ff;' : 'background:rgba(188,140,255,0.2); color:#bc8cff;'}">${isSameOriginVal ? '同源' : '跨源'}</span>`
        : '';

      tooltip.innerHTML = `
        <div style="font-weight:700; color:#58a6ff; margin-bottom:4px; display:flex; align-items:center; justify-content:space-between;">
          <span>🔍 Mouse 懸停預報</span>
          <span style="font-size:10px; color:#8b949e; font-weight:normal;">&lt;${tag}&gt;</span>
        </div>
        <div style="margin-bottom:4px; font-weight:500;">
          ${summaryText} ${originBadge}
        </div>
        ${targetUrl ? `<div style="font-size:10.5px; color:#8b949e; word-break:break-all; font-family:monospace; margin-bottom:4px;">目標：${targetUrl}</div>` : ''}
        ${featuresList.length > 0 ? `<div style="margin-top:6px; padding-top:6px; border-top:1px solid rgba(255,255,255,0.1); color:#7ee787; font-size:10.5px;">⚡ 特徵：${featuresList.join('、')}</div>` : ''}
      `;

      tooltip.style.display = 'block';
      updateTooltipPos(e);
    }

    function handlePointerMove(e: MouseEvent | PointerEvent) {
      if (isInspectorEnabled && inspectorTooltipEl && inspectorTooltipEl.style.display !== 'none') {
        updateTooltipPos(e);
      }
    }

    function handlePointerOut() {
      lastInspectedTarget = null;
      if (inspectorTooltipEl) {
        inspectorTooltipEl.style.display = 'none';
      }
    }

    function setInspectorEnabled(enabled: boolean) {
      isInspectorEnabled = enabled;
      if (enabled) {
        // 僅註冊單一標準的 pointer 事件，避免雙重註冊 mouse 事件干擾網頁原生滑鼠判定
        window.addEventListener('pointerover', handlePointerOver, true);
        window.addEventListener('pointermove', handlePointerMove, true);
        window.addEventListener('pointerout', handlePointerOut, true);
      } else {
        window.removeEventListener('pointerover', handlePointerOver, true);
        window.removeEventListener('pointermove', handlePointerMove, true);
        window.removeEventListener('pointerout', handlePointerOut, true);
        removeInspectorTooltip();
      }
    }

    // 預設開啟懸停探針
    setInspectorEnabled(true);

    // 監聽來自 Sidebar 的懸停探針控制訊息
    browser.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      if (msg.action === MSG_ACTION.TOGGLE_INSPECTOR) {
        setInspectorEnabled(!!msg.enabled);
        sendResponse({ enabled: isInspectorEnabled });
      } else if (msg.action === MSG_ACTION.GET_INSPECTOR_STATUS) {
        sendResponse({ enabled: isInspectorEnabled });
      }
    });

    // ─── 啟動 ──────────────────────────────────────────────────

    // DOM 載入完成後開始掃描與監控
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => {
        scanSensitiveElements();
        startMutationMonitor();
      });
    } else {
      scanSensitiveElements();
      startMutationMonitor();
    }

    console.debug('[Mouse] Content script 已啟動');
  },
});
