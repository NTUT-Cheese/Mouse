<script setup lang="ts">
import { computed } from 'vue';

const props = defineProps<{
  thinking: string | undefined;
  reasoning: string | undefined;
  isAnalyzing: boolean;
}>();

const hasContent = computed(() => !!props.thinking || !!props.reasoning);

/** 格式化 thinking — 保留換行 */
const formattedThinking = computed(() => props.thinking?.trim() ?? '');
</script>

<template>
  <section class="thought-box">
    <div class="thought-header">
      <span class="thought-header-icon">🧠</span>
      <span class="thought-header-title">LLM 思考與分析過程</span>
      <span v-if="isAnalyzing" class="thought-status-pill analyzing">分析中</span>
      <span v-else-if="hasContent" class="thought-status-pill done">完成</span>
    </div>

    <!-- 分析中 -->
    <div v-if="isAnalyzing" class="thought-body thought-body--loading">
      <span class="thought-loader">⏳</span>
      <span class="thought-loading-text">正在分析頁面傳入的事件與特徵...</span>
    </div>

    <!-- 有內容 -->
    <template v-else-if="hasContent">
      <!-- reasoning 摘要 -->
      <div v-if="reasoning" class="thought-reasoning">
        <span class="thought-label">結論摘要</span>
        <span class="thought-reasoning-text">{{ reasoning }}</span>
      </div>

      <!-- thinking 完整過程 -->
      <div v-if="formattedThinking" class="thought-content">
        <span class="thought-label">思考過程</span>
        <pre class="thought-pre">{{ formattedThinking }}</pre>
      </div>
    </template>

    <!-- 尚無內容 -->
    <div v-else class="thought-body thought-body--empty">
      尚未收到診斷資料，等待 HIGH/MED 風險事件觸發...
    </div>
  </section>
</template>
