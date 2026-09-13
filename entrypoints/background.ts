/**
 * Background Service Worker — 行為彙整器
 *
 * 作為系統中樞，負責：
 * 1. 接收各分頁的行為回報
 * 2. 去重、聚合行為紀錄
 * 3. 維護各分頁的完整行為列表
 * 4. 追蹤 HTTP 重導向鏈
 * 5. 即時推送更新至 Sidebar UI
 */

import { MSG_ACTION, DEDUP_WINDOW_MS, MAX_BEHAVIORS_PER_TAB } from '@/utils/constants';
import type { BehaviorEntry, RawBehaviorEvent } from '@/utils/types';

export default defineBackground(() => {
  // ─── 分頁行為儲存 ──────────────────────────────────────────

  const tabBehaviors = new Map<number, BehaviorEntry[]>();

  function generateId(): string {
    return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }

  /**
   * 計算行為的 dedup key
   * 用於判斷兩筆行為是否為「同一件事」
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

      if (dedupKey({
        category: existing.category,
        source: existing.source,
        summary: existing.summary,
        details: existing.details,
        evidence: existing.evidence,
      }) === key) {
        // 找到重複，增加計數
        existing.count++;
        existing.timestamp = now; // 更新時間戳為最新
        notifySidebar(tabId);
        return;
      }
    }

    // 新行為
    const entry: BehaviorEntry = {
      id: generateId(),
      timestamp: now,
      category: event.category,
      source: event.source,
      summary: event.summary,
      details: event.details,
      evidence: event.evidence,
      count: 1,
    };

    behaviors.push(entry);

    // 限制最大數量
    if (behaviors.length > MAX_BEHAVIORS_PER_TAB) {
      behaviors.splice(0, behaviors.length - MAX_BEHAVIORS_PER_TAB);
    }

    notifySidebar(tabId);
  }

  // ─── 推送更新至 Sidebar ────────────────────────────────────

  function notifySidebar(tabId: number) {
    try {
      browser.runtime.sendMessage({
        action: MSG_ACTION.BEHAVIORS_UPDATED,
        tabId,
        behaviors: tabBehaviors.get(tabId) || [],
      }).catch(() => {
        // Sidebar 可能未開啟
      });
    } catch {
      // silent
    }
  }

  // ─── 接收行為回報 ──────────────────────────────────────────

  browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
    const action = message?.action;

    // Content script 回報行為
    if (action === MSG_ACTION.REPORT_BEHAVIOR && sender.tab?.id) {
      const tabId = sender.tab.id;
      const payload = message.payload as RawBehaviorEvent;
      if (payload && payload.category && payload.summary) {
        addBehavior(tabId, payload);
      }
      return;
    }

    // Sidebar 請求取得行為列表
    if (action === MSG_ACTION.GET_BEHAVIORS) {
      const tabId = message.tabId as number;
      const behaviors = tabBehaviors.get(tabId) || [];
      sendResponse({ behaviors });
      return true; // 同步回應
    }
  });

  // ─── HTTP 重導向追蹤 ───────────────────────────────────────

  // 記錄重導向鏈
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
    // webRequest API 可能不可用
    console.debug('[Mouse] webRequest API 不可用，跳過重導向追蹤');
  }

  // ─── 分頁生命週期管理 ─────────────────────────────────────

  // 分頁關閉時清理
  browser.tabs.onRemoved.addListener((tabId) => {
    tabBehaviors.delete(tabId);
  });

  // 頁面導航時重置
  browser.webNavigation.onCommitted.addListener((details) => {
    // 只處理主框架
    if (details.frameId !== 0) return;

    const tabId = details.tabId;
    tabBehaviors.set(tabId, []);

    // 通知 Sidebar 重置
    try {
      browser.runtime.sendMessage({
        action: MSG_ACTION.TAB_RESET,
        tabId,
      }).catch(() => {});
    } catch {
      // silent
    }
  });

  // ─── 開啟 Sidebar ───────────────────────────────────────────

  // 點擊擴充功能圖示時，自動開啟側邊欄 (SidePanel / Sidebar)
  if (browser.sidePanel?.setPanelBehavior) {
    // Chrome MV3 寫法：設定點擊 Action 時開啟 SidePanel
    browser.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  } else if (browser.action?.onClicked) {
    // Firefox MV2 替代寫法：監聽點擊事件
    browser.action.onClicked.addListener((tab) => {
      if ((browser as any).sidebarAction?.open) {
        (browser as any).sidebarAction.open();
      }
    });
  }

  console.debug('[Mouse] Background service worker 已啟動');
});
