<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue';
import type { BehaviorEntry, BehaviorCategory, BackgroundMessage, LLMDiagnosisResult } from '@/utils/types';
import { MSG_ACTION } from '@/utils/constants';
import BehaviorCard from './components/BehaviorCard.vue';
import StatsBar from './components/StatsBar.vue';
import CategoryFilter from './components/CategoryFilter.vue';
import RiskVerdictBox from './components/RiskVerdictBox.vue';
import ThoughtProcessBox from './components/ThoughtProcessBox.vue';

const behaviors = ref<BehaviorEntry[]>([]);
const currentTabId = ref<number | null>(null);
const selectedCategory = ref<BehaviorCategory | null>(null);
const expandedCards = ref<Set<string>>(new Set());

const isInspectorActive = ref(true);

// ─── LLM 診斷結果狀態 ───────────────────────────────────────────
// 當前分頁網域
const currentDomain = ref<string>('');
const llmVerdict = ref<LLMDiagnosisResult | null>(null);
const isAnalyzing = ref(false);
const llmTimeout = ref<string | null>(null);

async function toggleInspector() {
  isInspectorActive.value = !isInspectorActive.value;
  if (currentTabId.value) {
    try {
      await browser.tabs.sendMessage(currentTabId.value, {
        action: MSG_ACTION.TOGGLE_INSPECTOR,
        enabled: isInspectorActive.value,
      });
    } catch {
      // silent
    }
  }
}

async function checkInspectorStatus() {
  if (currentTabId.value) {
    try {
      const res = await browser.tabs.sendMessage(currentTabId.value, {
        action: MSG_ACTION.GET_INSPECTOR_STATUS,
      });
      if (res?.enabled !== undefined) {
        isInspectorActive.value = res.enabled;
      }
    } catch {
      // silent
    }
  }
}

// 取得目前分頁的 tabId，並向 background 請求初始資料
async function init() {
  // 切換分頁時先清除舊診斷結果與逾時錯誤
  llmVerdict.value = null;
  isAnalyzing.value = false;
  llmTimeout.value = null;
  currentDomain.value = '';

  try {
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    if (tab?.id) {
      currentTabId.value = tab.id;
      // 提取當前分頁網域
      if (tab.url) {
        try { currentDomain.value = new URL(tab.url).hostname; } catch {}
      }
      const res = await browser.runtime.sendMessage({
        action: MSG_ACTION.GET_BEHAVIORS,
        tabId: tab.id,
      });
      if (res?.behaviors) {
        behaviors.value = res.behaviors;
      }
      // 恢復該分頁已有的 LLM 診斷結果
      if (res?.verdict) {
        llmVerdict.value = res.verdict as LLMDiagnosisResult;
      }
      checkInspectorStatus();
    }
  } catch (err) {
    console.error('[Mouse UI] 初始化失敗', err);
  }
}

// 監聽 background 推送的更新
function handleMessage(message: any) {
  if (message.tabId !== undefined && message.tabId !== currentTabId.value) return;

  if (message.action === MSG_ACTION.BEHAVIORS_UPDATED) {
    behaviors.value = message.behaviors || [];
  } else if (message.action === MSG_ACTION.TAB_RESET) {
    behaviors.value = [];
    expandedCards.value.clear();
    llmVerdict.value = null;
    isAnalyzing.value = false;
    llmTimeout.value = null;
  } else if (message.action === MSG_ACTION.LLM_STATUS_UPDATED) {
    // 收到 LLM 診斷結果
    isAnalyzing.value = false;
    llmTimeout.value = null;
    if (message.verdict) {
      llmVerdict.value = message.verdict as LLMDiagnosisResult;
    }
  } else if (message.action === 'llm-analyzing') {
    // background 廣播「分析開始中」狀態
    isAnalyzing.value = true;
    llmTimeout.value = null;
  } else if (message.action === MSG_ACTION.LLM_TIMEOUT) {
    // 收到逾時通知：確認網域與當前顯示一致
    if (message.domain && currentDomain.value && message.domain !== currentDomain.value) return;
    isAnalyzing.value = false;
    llmTimeout.value = message.error || 'Ollama 逾時未回應';
  }
}

// ─── 手動觸發 LLM 測試 / 重新診斷 ───────────────────────────
async function triggerLLMTest() {
  console.log('[DEBUG Sidebar] triggerLLMTest 被呼叫', {
    tabId: currentTabId.value,
    domain: currentDomain.value,
    action: MSG_ACTION.TRIGGER_LLM_TEST,
  });

  if (!currentTabId.value || !currentDomain.value) return;
  isAnalyzing.value = true;
  llmTimeout.value = null; // 清除之前的逾時錯誤
  try {
    await browser.runtime.sendMessage({
      action: MSG_ACTION.TRIGGER_LLM_TEST,
      tabId: currentTabId.value,
      domain: currentDomain.value,
    });
  } catch (err) {
    console.error('[Mouse UI] 手動觸發失敗', err);
    isAnalyzing.value = false;
  }
}

onMounted(() => {
  init();
  browser.runtime.onMessage.addListener(handleMessage);
  
  // 監聽分頁切換，更新 sidebar 顯示的資料
  browser.tabs.onActivated.addListener(init);
  browser.tabs.onUpdated.addListener(init);
});

onUnmounted(() => {
  browser.runtime.onMessage.removeListener(handleMessage);
  browser.tabs.onActivated.removeListener(init);
});

// 過濾與排序
const filteredBehaviors = computed(() => {
  let list = behaviors.value;
  if (selectedCategory.value) {
    list = list.filter(b => b.category === selectedCategory.value);
  }
  // 依時間反序排列（最新的在最上面）
  return [...list].sort((a, b) => b.timestamp - a.timestamp);
});
</script>

<template>
  <header class="sidebar-header">
    <div class="header-top">
      <h1>
        <span class="icon">🔍</span>
        Mouse 行為透視
      </h1>

      <!-- 懸停探針 Toggle 開關 -->
      <button 
        class="toggle-button"
        :class="{ active: isInspectorActive }"
        @click="toggleInspector"
        title="切換網頁元素懸停預報"
      >
        <span class="toggle-icon">🎯</span>
        <span class="toggle-text">懸停預報</span>
        <span class="toggle-pill"></span>
      </button>
    </div>
    <div class="subtitle">所見即所做・無判斷的透明報告</div>
  </header>

  <StatsBar :behaviors="behaviors" />
  <RiskVerdictBox
    :verdict="llmVerdict"
    :is-analyzing="isAnalyzing"
    :llm-timeout="llmTimeout"
    :tab-id="currentTabId"
    :current-domain="currentDomain"
    @trigger-test="triggerLLMTest"
  />
  <ThoughtProcessBox
    :thinking="llmVerdict?.thinking"
    :reasoning="llmVerdict?.reasoning"
    :is-analyzing="isAnalyzing"
  />
  <CategoryFilter v-model:selected="selectedCategory" />

  <main class="behavior-list">
    <template v-if="filteredBehaviors.length > 0">
      <BehaviorCard 
        v-for="b in filteredBehaviors" 
        :key="b.id" 
        :behavior="b"
        :expanded="expandedCards.has(b.id)"
        @update:expanded="val => val ? expandedCards.add(b.id) : expandedCards.delete(b.id)"
      />
    </template>
    
    <div v-else class="empty-state">
      <div class="icon">✨</div>
      <div class="title">目前尚未偵測到行為</div>
      <div class="desc">
        網頁的所有網路請求、事件綁定與存取行為都會即時顯示於此。
      </div>
    </div>
  </main>
</template>
