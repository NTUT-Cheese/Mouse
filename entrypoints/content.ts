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
