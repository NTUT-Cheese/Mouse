/**
 * Content Script — ISOLATED World
 *
 * 職責：
 * 1. 注入 nonce 到 DOM，供 injected script（MAIN world）讀取
 * 2. 監聽 postMessage 橋接 injected script 的行為日誌
 * 3. 執行 DOM MutationObserver 監控元件動態變化
 * 4. 將所有行為轉發給 Background Service Worker
 */

import { MESSAGE_CHANNEL, NONCE_ATTR, NONCE_ELEMENT_ID, MSG_ACTION } from '@/utils/constants';
import type { InjectedMessage, RawBehaviorEvent } from '@/utils/types';

export default defineContentScript({
  matches: ['<all_urls>'],
  runAt: 'document_start',

  main() {
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

    // ─── 2. postMessage 橋接 ──────────────────────────────────

    function forwardToBackground(event: RawBehaviorEvent) {
      try {
        browser.runtime.sendMessage({
          action: MSG_ACTION.REPORT_BEHAVIOR,
          payload: event,
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

      // 驗證通過，轉發給 background
      forwardToBackground(data.payload);
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
        forwardToBackground({
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
        forwardToBackground({
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
            forwardToBackground({
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
     * MutationObserver：監控動態 DOM 變化
     */
    function startMutationMonitor() {
      const observer = new MutationObserver((mutations) => {
        for (const mutation of mutations) {
          // 新增節點
          for (const node of mutation.addedNodes) {
            if (!(node instanceof Element)) continue;

            const tag = node.tagName.toLowerCase();

            // 動態 <script>
            if (tag === 'script') {
              const src = node.getAttribute('src');
              forwardToBackground({
                category: 'dom-mutation',
                source: 'DOM',
                summary: src
                  ? `動態插入了 <script src="${src}">`
                  : `動態插入了內嵌 <script>`,
                details: src
                  ? `外部腳本來源：${src}`
                  : `內嵌程式碼長度：${(node.textContent || '').length} 字元`,
                evidence: {
                  url: src || undefined,
                  isSameOrigin: src ? checkSameOrigin(src) : undefined,
                  elementSnippet: describeElement(node),
                  codePreview: src ? undefined : (node.textContent || '').slice(0, 200),
                },
              });
            }

            // 動態 <iframe>
            if (tag === 'iframe') {
              const src = node.getAttribute('src') || '';
              const dim = getElementDimensions(node);
              forwardToBackground({
                category: 'dom-mutation',
                source: 'DOM',
                summary: `動態插入了 <iframe src="${src || '(blank)'}"> (尺寸 ${dim || '未知'})`,
                details: describeElement(node),
                evidence: {
                  url: src || undefined,
                  isSameOrigin: src ? checkSameOrigin(src) : undefined,
                  elementSnippet: describeElement(node),
                },
              });
            }

            // 動態 <form>
            if (tag === 'form') {
              const action = node.getAttribute('action') || '';
              forwardToBackground({
                category: 'dom-mutation',
                source: 'DOM',
                summary: `動態插入了表單 ${describeElement(node)}`,
                details: action ? `action="${action}"` : '無 action 屬性',
                evidence: {
                  url: action || undefined,
                  isSameOrigin: action ? checkSameOrigin(action) : undefined,
                  elementSnippet: describeElement(node),
                },
              });
            }

            // 動態 <meta http-equiv="refresh">
            if (tag === 'meta' && node.getAttribute('http-equiv')?.toLowerCase() === 'refresh') {
              const content = node.getAttribute('content') || '';
              forwardToBackground({
                category: 'navigation',
                source: 'DOM',
                summary: `動態插入了 <meta http-equiv="refresh"> 自動跳轉`,
                details: `content="${content}"`,
                evidence: {
                  elementSnippet: describeElement(node),
                },
              });
            }

            // 動態 <link>
            if (tag === 'link') {
              const href = node.getAttribute('href') || '';
              const rel = node.getAttribute('rel') || '';
              forwardToBackground({
                category: 'dom-mutation',
                source: 'DOM',
                summary: `動態插入了 <link rel="${rel}" href="${href}">`,
                details: describeElement(node),
                evidence: {
                  url: href || undefined,
                  isSameOrigin: href ? checkSameOrigin(href) : undefined,
                  elementSnippet: describeElement(node),
                },
              });
            }

            // 檢查 onX 事件處理器屬性
            for (const attr of node.attributes) {
              if (attr.name.startsWith('on')) {
                forwardToBackground({
                  category: 'event-binding',
                  source: 'DOM',
                  summary: `${describeElement(node)} 被添加了 ${attr.name} 屬性`,
                  details: `${attr.name}="${(attr.value || '').slice(0, 100)}"`,
                  evidence: {
                    eventType: attr.name,
                    elementSnippet: describeElement(node),
                    codePreview: (attr.value || '').slice(0, 200),
                  },
                });
              }
            }

            // 遞迴檢查子元素中的上述標籤
            const childScripts = node.querySelectorAll('script, iframe, form, link, meta[http-equiv]');
            childScripts.forEach((child) => {
              // 觸發同樣的邏輯（透過 addedNodes 的方式再次發送）
              const childTag = child.tagName.toLowerCase();
              if (childTag === 'script') {
                const src = child.getAttribute('src');
                forwardToBackground({
                  category: 'dom-mutation',
                  source: 'DOM',
                  summary: src
                    ? `動態插入了 <script src="${src}">`
                    : `動態插入了內嵌 <script>`,
                  details: src
                    ? `外部腳本來源：${src}`
                    : `內嵌程式碼長度：${(child.textContent || '').length} 字元`,
                  evidence: {
                    url: src || undefined,
                    elementSnippet: describeElement(child),
                  },
                });
              }
            });
          }

          // 屬性變更監控
          if (mutation.type === 'attributes' && mutation.target instanceof Element) {
            const attrName = mutation.attributeName || '';
            const el = mutation.target;

            // form action 變更
            if (el.tagName.toLowerCase() === 'form' && attrName === 'action') {
              const oldVal = mutation.oldValue || '(none)';
              const newVal = el.getAttribute('action') || '(none)';
              forwardToBackground({
                category: 'dom-mutation',
                source: 'DOM',
                summary: `表單的 action 屬性從「${oldVal}」變更為「${newVal}」`,
                details: describeElement(el),
                evidence: {
                  oldValue: oldVal,
                  newValue: newVal,
                  elementSnippet: describeElement(el),
                },
              });
            }

            // onX 屬性注入
            if (attrName.startsWith('on')) {
              const newVal = el.getAttribute(attrName) || '';
              forwardToBackground({
                category: 'event-binding',
                source: 'DOM',
                summary: `${describeElement(el)} 的 ${attrName} 屬性被修改`,
                details: `新值：${newVal.slice(0, 100)}`,
                evidence: {
                  eventType: attrName,
                  oldValue: mutation.oldValue || undefined,
                  newValue: newVal || undefined,
                  elementSnippet: describeElement(el),
                },
              });
            }
          }
        }
      });

      observer.observe(document.documentElement || document, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['action', 'src', 'href', ...Array.from({ length: 20 }, (_, i) =>
          ['onclick', 'onload', 'onerror', 'onsubmit', 'onmouseover', 'onfocus',
           'onblur', 'onkeydown', 'onkeyup', 'oninput', 'onchange', 'onpaste',
           'onmousedown', 'onmouseup', 'oncontextmenu', 'ondblclick', 'onscroll',
           'onresize', 'onbeforeunload', 'onunload'][i]
        ).filter((Boolean as unknown) as (x: any) => x is string)],
        attributeOldValue: true,
      });
    }

    // ─── 4. 懸停探針 (Hover Inspector) 浮動 UI ───────────────────────

    let isInspectorEnabled = true;
    let inspectorTooltipEl: HTMLElement | null = null;

    function createInspectorTooltip() {
      if (inspectorTooltipEl) return inspectorTooltipEl;
      const el = document.createElement('div');
      el.id = '__mouse_hover_tooltip__';
      el.style.cssText = `
        position: fixed;
        z-index: 2147483647;
        pointer-events: none;
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
    }

    function updateTooltipPos(e: MouseEvent | PointerEvent) {
      if (!inspectorTooltipEl) return;
      const x = e.clientX + 14;
      const y = e.clientY + 14;
      const rect = inspectorTooltipEl.getBoundingClientRect();
      const maxX = window.innerWidth - rect.width - 16;
      const maxY = window.innerHeight - rect.height - 16;

      inspectorTooltipEl.style.left = `${Math.max(10, Math.min(x, maxX))}px`;
      inspectorTooltipEl.style.top = `${Math.max(10, Math.min(y, maxY))}px`;
    }

    function findInteractiveElement(el: Element | null): Element | null {
      if (!el) return null;

      // 向上遍歷，優先尋找最具代表性的父級互動容器 (a, button, form, [role="button"], [onclick], [href])
      let curr: Element | null = el;
      let fallbackMediaEl: Element | null = null;

      while (curr && curr !== document.documentElement && curr !== document.body) {
        const tag = curr.tagName.toLowerCase();
        
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

        // 3. 若懸停在 img / svg / canvas 上，暫存作為 fallback（如果上方沒有找到 a 或 button 容器）
        if (!fallbackMediaEl && ['img', 'svg', 'canvas'].includes(tag)) {
          fallbackMediaEl = curr;
        }

        curr = curr.parentElement;
      }

      return fallbackMediaEl;
    }

    function handlePointerOver(e: MouseEvent | PointerEvent) {
      if (!isInspectorEnabled) return;
      const path = e.composedPath ? e.composedPath() : [];
      const target = (path[0] || e.target) as Element | null;
      if (!target || !(target instanceof Element)) return;

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
      if (inspectorTooltipEl) {
        inspectorTooltipEl.style.display = 'none';
      }
    }

    function setInspectorEnabled(enabled: boolean) {
      isInspectorEnabled = enabled;
      if (enabled) {
        window.addEventListener('pointerover', handlePointerOver, true);
        window.addEventListener('mouseover', handlePointerOver, true);
        window.addEventListener('pointermove', handlePointerMove, true);
        window.addEventListener('mousemove', handlePointerMove, true);
        window.addEventListener('pointerout', handlePointerOut, true);
        window.addEventListener('mouseout', handlePointerOut, true);
      } else {
        window.removeEventListener('pointerover', handlePointerOver, true);
        window.removeEventListener('mouseover', handlePointerOver, true);
        window.removeEventListener('pointermove', handlePointerMove, true);
        window.removeEventListener('mousemove', handlePointerMove, true);
        window.removeEventListener('pointerout', handlePointerOut, true);
        window.removeEventListener('mouseout', handlePointerOut, true);
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
