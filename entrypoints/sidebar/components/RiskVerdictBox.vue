<script setup lang="ts">
import { computed } from 'vue';
import type { LLMDiagnosisResult, LLMRiskVerdict } from '@/utils/types';

const props = defineProps<{
  verdict: LLMDiagnosisResult | null;
  isAnalyzing: boolean;
  llmTimeout?: string | null;
  tabId: number | null;
  currentDomain: string;
}>();

const emit = defineEmits<{
  triggerTest: [];
}>();

const verdictConfig = computed<{
  label: string;
  icon: string;
  className: string;
  glowColor: string;
} | null>(() => {
  if (!props.verdict) return null;
  const map: Record<LLMRiskVerdict, { label: string; icon: string; className: string; glowColor: string }> = {
    SAFE:       { label: '安全',   icon: '🛡️',  className: 'verdict-safe',       glowColor: 'rgba(63, 185, 80, 0.25)' },
    SUSPICIOUS: { label: '可疑',   icon: '⚠️',  className: 'verdict-suspicious', glowColor: 'rgba(210, 153, 34, 0.25)' },
    DANGEROUS:  { label: '危險',   icon: '🚨',  className: 'verdict-dangerous',  glowColor: 'rgba(248, 81, 73, 0.30)' },
  };
  return map[props.verdict.risk] ?? null;
});

const timeLabel = computed(() => {
  if (!props.verdict) return '';
  const d = new Date(props.verdict.timestamp);
  return d.toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
});

function handleTriggerTest() {
  emit('triggerTest');
}
</script>

<template>
  <!-- 分析中狀態 -->
  <div v-if="isAnalyzing" class="verdict-box verdict-analyzing">
    <div class="verdict-pulse-ring" />
    <div class="verdict-inner">
      <span class="verdict-spinner">⏳</span>
      <div class="verdict-text-group">
        <span class="verdict-label analyzing-label">LLM 診斷中…</span>
        <span class="verdict-sub">正在向 Ollama (qwen2.5:3b) 發送診斷請求</span>
      </div>
    </div>
  </div>

  <!-- 逾時未回應狀態 -->
  <div v-else-if="llmTimeout" class="verdict-box verdict-timeout">
    <div class="verdict-inner">
      <div class="verdict-icon-wrap">
        <span class="verdict-icon">⏱️</span>
      </div>
      <div class="verdict-text-group">
        <div class="verdict-top-row">
          <span class="verdict-domain">{{ currentDomain }}</span>
          <span class="verdict-badge verdict-timeout-badge">逾時</span>
        </div>
        <span class="verdict-sub">{{ llmTimeout }}（超過 10 秒）</span>
      </div>

      <!-- 重新診斷按鈕 -->
      <button
        v-if="tabId && currentDomain"
        class="verdict-trigger-btn verdict-trigger-btn--retry"
        title="重新發送診斷請求"
        @click="handleTriggerTest"
      >
        🔄 重新診斷
      </button>
    </div>
  </div>

  <!-- 有診斷結果 -->
  <div
    v-else-if="verdict && verdictConfig"
    class="verdict-box"
    :class="verdictConfig.className"
    :style="{ '--glow': verdictConfig.glowColor }"
  >
    <!-- 背景光暈動畫 -->
    <div class="verdict-glow-bg" />

    <div class="verdict-inner">
      <!-- 主圖示 & 域名 -->
      <div class="verdict-icon-wrap">
        <span class="verdict-icon">{{ verdictConfig.icon }}</span>
      </div>

      <div class="verdict-text-group">
        <div class="verdict-top-row">
          <span class="verdict-domain">{{ verdict.domain }}</span>
          <span class="verdict-badge" :class="verdictConfig.className + '-badge'">
            {{ verdictConfig.label }}
          </span>
        </div>
        <span class="verdict-sub">LLM 診斷 · {{ timeLabel }}</span>
      </div>

      <!-- 重新診斷按鈕 -->
      <button
        v-if="tabId && currentDomain"
        class="verdict-trigger-btn"
        title="重新觸發 LLM 診斷"
        @click="handleTriggerTest"
      >🔄</button>
    </div>
  </div>

  <!-- 尚無診斷（待機狀態）-->
  <div v-else class="verdict-box verdict-idle">
    <div class="verdict-inner">
      <span class="verdict-icon verdict-icon--idle">🔬</span>
      <div class="verdict-text-group">
        <span class="verdict-label">等待 LLM 診斷</span>
        <span class="verdict-sub">
          {{ currentDomain ? `目前：${currentDomain}` : '偵測到 HIGH/MED 風險事件時自動觸發' }}
        </span>
      </div>

      <!-- 手動觸發按鈕 -->
      <button
        v-if="tabId && currentDomain"
        class="verdict-trigger-btn verdict-trigger-btn--primary"
        title="手動觸發 LLM 診斷"
        @click="handleTriggerTest"
      >
        ⚡ 立即診斷
      </button>
    </div>
  </div>
</template>

