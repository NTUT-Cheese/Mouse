<script setup lang="ts">
import { computed } from 'vue';
import type { BehaviorEntry } from '@/utils/types';
import { CATEGORY_INFO } from '@/utils/constants';
import { parseStackTrace } from '@/utils/stackParser';

const props = defineProps<{
  behavior: BehaviorEntry;
}>();

const isExpanded = defineModel<boolean>('expanded', { default: false });

const categoryInfo = computed(() => CATEGORY_INFO[props.behavior.category]);

const timeStr = computed(() => {
  const d = new Date(props.behavior.timestamp);
  return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}:${d.getSeconds().toString().padStart(2, '0')}`;
});

const parsedStackTrace = computed(() => parseStackTrace(props.behavior.evidence.stackTrace));
</script>

<template>
  <div class="behavior-card" @click="isExpanded = !isExpanded">
    <div class="card-header">
      <div class="card-icon" :title="categoryInfo.label">
        {{ categoryInfo.icon }}
      </div>
      <div class="card-content">
        <div class="card-summary">{{ behavior.summary }}</div>
        
        <div class="card-meta">
          <span class="card-time">{{ timeStr }}</span>
          <span 
            class="card-category"
            :class="`cat-${behavior.category}`"
          >
            {{ categoryInfo.label }}
          </span>
          <span v-if="behavior.count > 1" class="card-count">×{{ behavior.count }}</span>
          <span 
            v-if="behavior.evidence.isSameOrigin !== undefined"
            class="origin-tag"
            :class="behavior.evidence.isSameOrigin ? 'origin-same' : 'origin-cross'"
          >
            {{ behavior.evidence.isSameOrigin ? '同源' : '跨源' }}
          </span>
          <span v-if="behavior.source === 'DOM'" class="card-category" style="color: var(--text-muted)">[DOM]</span>
          <span v-else class="card-category" style="color: var(--text-muted)">[JS]</span>
        </div>
      </div>
    </div>

    <!-- 展開顯示證據詳情 -->
    <div v-if="isExpanded" class="card-evidence" @click.stop>
      <div v-if="behavior.details" class="evidence-row">
        <div class="evidence-label">說明</div>
        <div class="evidence-value">{{ behavior.details }}</div>
      </div>
      
      <div v-if="behavior.evidence.url" class="evidence-row">
        <div class="evidence-label">URL</div>
        <div class="evidence-value">
          {{ behavior.evidence.url }}
          <span 
            v-if="behavior.evidence.isSameOrigin !== undefined"
            class="origin-tag inline-tag"
            :class="behavior.evidence.isSameOrigin ? 'origin-same' : 'origin-cross'"
          >
            {{ behavior.evidence.isSameOrigin ? '同源' : '跨源' }}
          </span>
        </div>
      </div>
      
      <div v-if="behavior.evidence.targetElement || behavior.evidence.elementSnippet" class="evidence-row">
        <div class="evidence-label">目標元素</div>
        <div class="evidence-value stack-trace">{{ behavior.evidence.elementSnippet || behavior.evidence.targetElement }}</div>
      </div>

      <div v-if="behavior.evidence.codePreview" class="evidence-row">
        <div class="evidence-label">程式碼</div>
        <div class="evidence-value stack-trace">{{ behavior.evidence.codePreview }}</div>
      </div>
      
      <div v-if="behavior.evidence.bodyPreview" class="evidence-row">
        <div class="evidence-label">內容</div>
        <div class="evidence-value stack-trace">{{ behavior.evidence.bodyPreview }}</div>
      </div>

      <div v-if="parsedStackTrace.length > 0" class="evidence-row">
        <div class="evidence-label">呼叫來源</div>
        <div class="evidence-value stack-frames">
          <div 
            v-for="(frame, idx) in parsedStackTrace" 
            :key="idx" 
            class="stack-frame"
            :title="frame.fileUrl"
          >
            <span class="frame-index">#{{ idx + 1 }}</span>
            <span class="frame-fn">{{ frame.functionName }}</span>
            <span class="frame-file">{{ frame.fileBasename }}</span>
            <span v-if="frame.isVendor" class="origin-tag inline-tag" style="font-size: 9px; opacity: 0.8;">Vendor</span>
            <span v-if="frame.lineCol" class="frame-line">{{ frame.lineCol }}</span>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
