/**
 * Injected Script — MAIN World
 *
 * 在網頁的主執行環境中運行，覆寫原生 API 來記錄行為事實。
 * 不做任何判斷，只記錄「做了什麼」。
 *
 * 透過 window.postMessage 將行為日誌發送給 content script。
 */
export default defineUnlistedScript({
  main() {
    // ─── 讀取 nonce（由 content script 注入到 DOM）───────────────
    const nonceEl = document.getElementById('__mouse_nonce_carrier__');
    const NONCE = nonceEl?.getAttribute('data-mouse-nonce') || '';
    const CHANNEL = '__MOUSE_BEHAVIOR_CHANNEL__';

    // ─── 通用工具 ──────────────────────────────────────────────
    function send(payload: Record<string, unknown>) {
      try {
        window.postMessage({ type: CHANNEL, nonce: NONCE, payload }, '*');
      } catch {
        // 靜默失敗，不影響原始網頁
      }
    }

    function getStack(): string {
      try {
        const stack = new Error().stack || '';
        const lines = stack.split('\n');
        // 過濾掉外掛自身的腳本與注入工具，僅保留網頁原始腳本呼叫堆疊
        const filtered = lines.filter((line) => {
          if (!line.trim()) return false;
          if (line.includes('injected.js')) return false;
          if (line.includes('getStack')) return false;
          if (line.includes('moz-extension://') || line.includes('chrome-extension://')) return false;
          return true;
        });
        return filtered.slice(0, 5).join('\n').trim();
      } catch {
        return '';
      }
    }

    function describeElement(el: EventTarget | null): string {
      if (!el || !(el instanceof Element)) return '';
      const tag = el.tagName.toLowerCase();
      const type = el.getAttribute('type') || '';
      const name = el.getAttribute('name') || '';
      const id = el.getAttribute('id') || '';
      const cls = el.className ? `.${el.className.toString().split(' ')[0]}` : '';
      let desc = `<${tag}`;
      if (type) desc += ` type="${type}"`;
      if (name) desc += ` name="${name}"`;
      if (id) desc += ` id="${id}"`;
      else if (cls) desc += ` class="${cls}"`;
      desc += '>';
      return desc;
    }

    function isPasswordField(el: EventTarget | null): boolean {
      if (!el || !(el instanceof HTMLInputElement)) return false;
      return el.type === 'password';
    }

    function isSensitiveField(el: EventTarget | null): boolean {
      if (!el || !(el instanceof HTMLInputElement)) return false;
      if (el.type === 'password') return true;
      const ac = (el.autocomplete || '').toLowerCase();
      return ['cc-number', 'cc-exp', 'cc-csc', 'cc-name', 'credit-card'].some(
        (k) => ac.includes(k)
      );
    }

    function checkSameOrigin(urlStr?: string): boolean | undefined {
      if (!urlStr || urlStr === '(blank)') return undefined;
      try {
        const targetOrigin = new URL(urlStr, window.location.href).origin;
        return targetOrigin === window.location.origin;
      } catch {
        return undefined;
      }
    }

    function truncate(str: string, max = 200): string {
      if (!str || str.length <= max) return str || '';
      return str.slice(0, max) + '…';
    }

    // ─── 1. Hook fetch ─────────────────────────────────────────

    const originalFetch = window.fetch;
    window.fetch = function (input: RequestInfo | URL, init?: RequestInit) {
      try {
        const url =
          typeof input === 'string'
            ? input
            : input instanceof URL
              ? input.href
              : input instanceof Request
                ? input.url
                : String(input);
        const method = init?.method || 'GET';
        const body = init?.body;
        const bodySize = body
          ? typeof body === 'string'
            ? body.length
            : body instanceof Blob
              ? body.size
              : 0
          : 0;

        send({
          category: 'network-request',
          source: 'JS_HOOK',
          summary: `向 ${url} 發送了 ${method.toUpperCase()} 請求`,
          details: bodySize > 0
            ? `Body 大小約 ${bodySize} bytes`
            : '無 Request Body',
          evidence: {
            url,
            isSameOrigin: checkSameOrigin(url),
            method: method.toUpperCase(),
            stackTrace: getStack(),
            bodyPreview: typeof body === 'string' ? truncate(body) : undefined,
          },
        });
      } catch {
        // 不影響原始行為
      }
      return originalFetch.apply(this, arguments as any);
    };

    // ─── 2. Hook XMLHttpRequest ────────────────────────────────

    const originalXHROpen = XMLHttpRequest.prototype.open;
    const originalXHRSend = XMLHttpRequest.prototype.send;
    const xhrMeta = new WeakMap<XMLHttpRequest, { method: string; url: string }>();

    XMLHttpRequest.prototype.open = function (
      method: string,
      url: string | URL
    ) {
      xhrMeta.set(this, { method, url: String(url) });
      return originalXHROpen.apply(this, arguments as any);
    };

    XMLHttpRequest.prototype.send = function (body?: Document | XMLHttpRequestBodyInit | null) {
      const meta = xhrMeta.get(this);
      if (meta) {
        try {
          const bodyStr = body ? String(body) : '';
          send({
            category: 'network-request',
            source: 'JS_HOOK',
            summary: `透過 XHR 向 ${meta.url} 發送了 ${meta.method.toUpperCase()} 請求`,
            details: bodyStr.length > 0
              ? `Body 大小約 ${bodyStr.length} bytes`
              : '無 Request Body',
            evidence: {
              url: meta.url,
              isSameOrigin: checkSameOrigin(meta.url),
              method: meta.method.toUpperCase(),
              stackTrace: getStack(),
              bodyPreview: truncate(bodyStr),
            },
          });
        } catch {
          // silent
        }
      }
      return originalXHRSend.apply(this, arguments as any);
    };

    // ─── 3. Hook sendBeacon ────────────────────────────────────

    const originalSendBeacon = navigator.sendBeacon?.bind(navigator);
    if (originalSendBeacon) {
      navigator.sendBeacon = function (url: string | URL, data?: BodyInit | null) {
        try {
          const urlStr = String(url);
          send({
            category: 'network-request',
            source: 'JS_HOOK',
            summary: `透過 sendBeacon 向 ${urlStr} 發送了資料`,
            details: data ? `資料大小約 ${String(data).length} bytes` : '無資料',
            evidence: {
              url: urlStr,
              isSameOrigin: checkSameOrigin(urlStr),
              method: 'POST',
              stackTrace: getStack(),
              bodyPreview: data ? truncate(String(data)) : undefined,
            },
          });
        } catch {
          // silent
        }
        return originalSendBeacon(url, data);
      };
    }

    // ─── 4. Hook addEventListener ──────────────────────────────

    const trackedEvents = new Set([
      'keydown', 'keyup', 'keypress',
      'input', 'change',
      'paste', 'copy', 'cut',
      'submit',
      'click', 'mousedown', 'mouseup',
      'focus', 'blur',
    ]);

    const originalAddEventListener = EventTarget.prototype.addEventListener;
    EventTarget.prototype.addEventListener = function (
      type: string,
      listener: EventListenerOrEventListenerObject | null,
      options?: boolean | AddEventListenerOptions
    ) {
      if (trackedEvents.has(type) && listener) {
        try {
          const elementDesc = describeElement(this);
          const onPassword = isPasswordField(this);
          const onSensitive = isSensitiveField(this);
          const fieldNote = onPassword
            ? '（此為密碼欄位）'
            : onSensitive
              ? '（此為敏感輸入欄位）'
              : '';

          // 針對 DOM Element 記錄事件處理函式特徵，供 Hover Inspector 懸停預判
          if (['click', 'submit', 'mousedown'].includes(type) && listener) {
            try {
              const fnStr = typeof listener === 'function' ? listener.toString() : (listener.handleEvent ? listener.handleEvent.toString() : '');
              const targetEl = this instanceof Element ? this : (this === window || this === document ? document.documentElement : null);
              
              if (targetEl) {
                const attrName = (this === window || this === document) ? 'data-mouse-global-handler-info' : 'data-mouse-handler-info';
                const existingRaw = targetEl.getAttribute(attrName);
                const existing = existingRaw ? JSON.parse(existingRaw) : { features: [] };
                const features: string[] = existing.features || [];

                if (/fetch|XMLHttpRequest|sendBeacon|axios/i.test(fnStr) && !features.includes('fetch')) features.push('fetch');
                if (/password|credit|card|secret/i.test(fnStr) && !features.includes('password')) features.push('password');
                if (/cookie|localStorage|sessionStorage/i.test(fnStr) && !features.includes('storage')) features.push('storage');
                let navUrl = '';
                const navMatch = fnStr.match(/(?:location(?:\.href|\.assign|\.replace)?|open|push|navigate)\s*(?:=\s*|\(\s*)['"`]([^'"`]+)['"`]/i);
                if (navMatch && navMatch[1]) {
                  navUrl = navMatch[1];
                  if (!features.includes('navigation')) features.push('navigation');
                } else if (/location|open\(/i.test(fnStr) && !features.includes('navigation')) {
                  features.push('navigation');
                }

                if (/download|createObjectURL|msSaveBlob|\.(pdf|zip|exe|apk|dmg|csv|xlsx|doc|docx|rar|7z|tar|gz)\b/i.test(fnStr) && !features.includes('download')) features.push('download');

                targetEl.setAttribute(attrName, JSON.stringify({ type, features, navUrl: navUrl || undefined }));
              }
            } catch {
              // silent
            }
          }

          send({
            category: 'event-binding',
            source: 'JS_HOOK',
            summary: `在 ${elementDesc || this.constructor?.name || 'unknown'} 上註冊了 ${type} 監聽器${fieldNote}`,
            details: `事件類型：${type}，目標：${elementDesc || '(非 DOM 元素)'}`,
            evidence: {
              eventType: type,
              targetElement: elementDesc,
              relatedField: onPassword ? 'password' : onSensitive ? 'sensitive-input' : undefined,
              stackTrace: getStack(),
            },
          });
        } catch {
          // silent
        }
      }
      return originalAddEventListener.apply(this, arguments as any);
    };

    // ─── 4b. Hook HTMLElement.prototype.onclick ────────────────
    try {
      const onclickDesc = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'onclick');
      if (onclickDesc && onclickDesc.set) {
        Object.defineProperty(HTMLElement.prototype, 'onclick', {
          get() {
            return onclickDesc.get?.call(this);
          },
          set(fn) {
            try {
              if (fn && typeof fn === 'function') {
                const fnStr = fn.toString();
                const features: string[] = [];
                if (/fetch|XMLHttpRequest|sendBeacon|axios/i.test(fnStr)) features.push('fetch');
                if (/password|credit|card|secret/i.test(fnStr)) features.push('password');
                if (/cookie|localStorage|sessionStorage/i.test(fnStr)) features.push('storage');
                if (/location|open\(/i.test(fnStr)) features.push('navigation');
                if (/download|createObjectURL|msSaveBlob|\.(pdf|zip|exe|apk|dmg|csv|xlsx|doc|docx)\b/i.test(fnStr)) features.push('download');

                this.setAttribute('data-mouse-handler-info', JSON.stringify({ type: 'onclick', features }));

                const elementDesc = describeElement(this);
                send({
                  category: 'event-binding',
                  source: 'JS_HOOK',
                  summary: `對 ${elementDesc || 'DOM 元素'} 設定了 onclick 處理函式`,
                  details: `函式內容：${truncate(fnStr)}`,
                  evidence: {
                    eventType: 'onclick-set',
                    targetElement: elementDesc,
                    codePreview: truncate(fnStr),
                    stackTrace: getStack(),
                  },
                });
              }
            } catch {
              // silent
            }
            return onclickDesc.set?.call(this, fn);
          },
          configurable: true,
        });
      }
    } catch {
      // silent
    }

    // ─── 4c. 捕獲點擊時內嵌 onclick 的觸發 ───────────────────────
    window.addEventListener(
      'click',
      (e: MouseEvent) => {
        try {
          const target = e.target as Element | null;
          if (!target) return;

          const interactiveEl = target.closest('[onclick], [data-mouse-handler-info], button, a, form');
          if (!interactiveEl) return;

          const onclickAttr = interactiveEl.getAttribute('onclick');
          const elementDesc = describeElement(interactiveEl);

          if (onclickAttr) {
            send({
              category: 'event-binding',
              source: 'JS_HOOK',
              summary: `觸發了 ${elementDesc || interactiveEl.tagName.toLowerCase()} 的內嵌 onclick 處理函式`,
              details: `onclick="${truncate(onclickAttr)}"`,
              evidence: {
                eventType: 'onclick-execute',
                targetElement: elementDesc,
                codePreview: truncate(onclickAttr),
                elementSnippet: describeElement(interactiveEl),
              },
            });
          }
        } catch {
          // silent
        }
      },
      true
    );

    // ─── 5. Hook eval & Function ───────────────────────────────

    const originalEval = window.eval;
    (window as any).eval = function (code: string) {
      try {
        send({
          category: 'dynamic-execution',
          source: 'JS_HOOK',
          summary: `執行了動態程式碼（eval）`,
          details: `程式碼片段：${truncate(String(code))}`,
          evidence: {
            codePreview: truncate(String(code)),
            stackTrace: getStack(),
          },
        });
      } catch {
        // silent
      }
      return originalEval.call(window, code);
    };

    const OriginalFunction = Function;
    try {
      const hookedFunction = function (...args: string[]) {
        try {
          const bodyCode = args.length > 0 ? String(args[args.length - 1] || '') : '';
          send({
            category: 'dynamic-execution',
            source: 'JS_HOOK',
            summary: `透過 Function 建構子建立了動態函式`,
            details: `函式內容：${truncate(bodyCode)}`,
            evidence: {
              codePreview: truncate(bodyCode),
              stackTrace: getStack(),
            },
          });
        } catch {
          // silent
        }
        return new OriginalFunction(...args);
      };
      hookedFunction.prototype = OriginalFunction.prototype;
      Object.defineProperty(window, 'Function', {
        value: hookedFunction,
        writable: true,
        configurable: true,
      });
    } catch {
      // 某些環境不允許覆寫 Function
    }

    // ─── 6. Hook Cookie & localStorage ─────────────────────────

    // Cookie
    const cookieDesc = Object.getOwnPropertyDescriptor(Document.prototype, 'cookie');
    if (cookieDesc) {
      Object.defineProperty(document, 'cookie', {
        get() {
          const val = cookieDesc.get?.call(document) || '';
          try {
            send({
              category: 'cookie-storage',
              source: 'JS_HOOK',
              summary: `讀取了 Cookie`,
              details: `Cookie 包含 ${val.split(';').length} 個項目`,
              evidence: {
                stackTrace: getStack(),
              },
            });
          } catch {
            // silent
          }
          return val;
        },
        set(val: string) {
          try {
            const keyMatch = val.match(/^([^=]+)/);
            const key = keyMatch && keyMatch[1] ? keyMatch[1].trim() : '(unknown)';
            send({
              category: 'cookie-storage',
              source: 'JS_HOOK',
              summary: `寫入了 Cookie「${key}」`,
              details: `設定值：${truncate(val)}`,
              evidence: {
                key,
                stackTrace: getStack(),
              },
            });
          } catch {
            // silent
          }
          cookieDesc.set?.call(document, val);
        },
        configurable: true,
      });
    }

    // localStorage
    const lsProto = Storage.prototype;
    const originalGetItem = lsProto.getItem;
    const originalSetItem = lsProto.setItem;
    const originalRemoveItem = lsProto.removeItem;

    lsProto.getItem = function (key: string) {
      try {
        if (this === localStorage) {
          send({
            category: 'cookie-storage',
            source: 'JS_HOOK',
            summary: `讀取了 localStorage「${key}」`,
            details: `Key: ${key}`,
            evidence: {
              key,
              stackTrace: getStack(),
            },
          });
        }
      } catch {
        // silent
      }
      return originalGetItem.call(this, key);
    };

    lsProto.setItem = function (key: string, value: string) {
      try {
        if (this === localStorage) {
          send({
            category: 'cookie-storage',
            source: 'JS_HOOK',
            summary: `寫入了 localStorage「${key}」`,
            details: `Key: ${key}, Value 大小: ${value.length} bytes`,
            evidence: {
              key,
              stackTrace: getStack(),
            },
          });
        }
      } catch {
        // silent
      }
      return originalSetItem.call(this, key, value);
    };

    lsProto.removeItem = function (key: string) {
      try {
        if (this === localStorage) {
          send({
            category: 'cookie-storage',
            source: 'JS_HOOK',
            summary: `移除了 localStorage「${key}」`,
            details: `Key: ${key}`,
            evidence: {
              key,
              stackTrace: getStack(),
            },
          });
        }
      } catch {
        // silent
      }
      return originalRemoveItem.call(this, key);
    };

    // ─── 7. Hook Navigation ────────────────────────────────────

    const originalOpen = window.open;
    window.open = function (
      url?: string | URL,
      target?: string,
      features?: string
    ) {
      try {
        const urlStr = url ? String(url) : '(blank)';
        send({
          category: 'navigation',
          source: 'JS_HOOK',
          summary: `腳本嘗試開啟新視窗：${urlStr}`,
          details: `target: ${target || '_blank'}, features: ${features || '(none)'}`,
          evidence: {
            url: urlStr,
            isSameOrigin: checkSameOrigin(urlStr),
            stackTrace: getStack(),
          },
        });
      } catch {
        // silent
      }
      return originalOpen.apply(this, arguments as any);
    };

    // location.assign & location.replace
    const originalAssign = location.assign;
    const originalReplace = location.replace;

    location.assign = function (url: string | URL) {
      try {
        send({
          category: 'navigation',
          source: 'JS_HOOK',
          summary: `腳本透過 location.assign 跳轉至 ${String(url)}`,
          details: `目標 URL: ${String(url)}`,
          evidence: {
            url: String(url),
            isSameOrigin: checkSameOrigin(String(url)),
            stackTrace: getStack(),
          },
        });
      } catch {
        // silent
      }
      return originalAssign.call(location, url);
    };

    location.replace = function (url: string | URL) {
      try {
        send({
          category: 'navigation',
          source: 'JS_HOOK',
          summary: `腳本透過 location.replace 跳轉至 ${String(url)}`,
          details: `目標 URL: ${String(url)}（不留下瀏覽歷史）`,
          evidence: {
            url: String(url),
            isSameOrigin: checkSameOrigin(String(url)),
            stackTrace: getStack(),
          },
        });
      } catch {
        // silent
      }
      return originalReplace.call(location, url);
    };

    console.debug('[Mouse] 行為監控已啟動');
  },
});
