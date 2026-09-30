<script setup lang="ts">
import { ref, computed } from 'vue';
import type { BehaviorEntry } from '@/utils/types';
import { CATEGORY_INFO, URL_DISPLAY_MAX_LENGTH } from '@/utils/constants';
import { parseStackTrace } from '@/utils/stackParser';

const props = defineProps<{
  behavior: BehaviorEntry;
}>();

const isExpanded = defineModel<boolean>('expanded', { default: false });

// LOW 風險預設收合：點擊才展開 URL，初始不展開
const isUrlExpanded = ref(false);

const categoryInfo = computed(() => CATEGORY_INFO[props.behavior.category]);

const timeStr = computed(() => {
  const d = new Date(props.behavior.timestamp);
  return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}:${d.getSeconds().toString().padStart(2, '0')}`;
});

const parsedStackTrace = computed(() => parseStackTrace(props.behavior.evidence.stackTrace));

// ── 資安等級 ──────────────────────────────────────────────────────
const riskLevel = computed(() => props.behavior.risk_level ?? null);
const isHighRisk = computed(() => riskLevel.value === 'HIGH');
const isMediumRisk = computed(() => riskLevel.value === 'MEDIUM');
const isLowRisk = computed(() => riskLevel.value === 'LOW');

// LOW 風險：預設收合卡片細節（只顯示標頭，不展開 evidence）
const isLowRiskCollapsed = computed(() =>
  isLowRisk.value && !isExpanded.value
);

// ── URL 截斷邏輯 ───────────────────────────────────────────────────
const rawUrl = computed(() => props.behavior.evidence.url ?? '');

const truncatedUrl = computed(() => {
  if (!rawUrl.value || rawUrl.value.length <= URL_DISPLAY_MAX_LENGTH) return rawUrl.value;
  return rawUrl.value.slice(0, URL_DISPLAY_MAX_LENGTH) + '…';
});

const isUrlTruncated = computed(() =>
  rawUrl.value.length > URL_DISPLAY_MAX_LENGTH
);

function toggleUrl(e: MouseEvent) {
  e.stopPropagation();
  isUrlExpanded.value = !isUrlExpanded.value;
}
</script>

<template>
  <div
    class="behavior-card"
    :class="{
      'risk-high': isHighRisk,
      'risk-medium': isMediumRisk,
      'risk-low': isLowRisk,
      'is-aggregated': behavior.is_aggregated,
    }"
    @click="isExpanded = !isExpanded"
  >
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

          <!-- 資安風險徽章 -->
          <span v-if="isHighRisk" class="risk-badge risk-badge-high" title="高風險行為：立即值得關注">
            ⚠ HIGH
          </span>
          <span v-else-if="isMediumRisk" class="risk-badge risk-badge-medium" title="中風險行為：需留意">
            ◆ MED
          </span>
          <span v-else-if="isLowRisk" class="risk-badge risk-badge-low" title="低風險：常態統計請求，預設收合">
            LOW
          </span>

          <!-- 聚合標記 -->
          <span v-if="behavior.is_aggregated" class="aggregated-badge" :title="behavior.aggregation_note">
            📦 聚合
          </span>
        </div>
      </div>
    </div>

    <!-- 展開顯示證據詳情（LOW 風險未點擊時不顯示） -->
    <div v-if="isExpanded" class="card-evidence" @click.stop>
      <!-- 聚合說明 -->
      <div v-if="behavior.aggregation_note" class="evidence-row aggregation-note-row">
        <div class="evidence-label">聚合</div>
        <div class="evidence-value">{{ behavior.aggregation_note }}</div>
      </div>

      <div v-if="behavior.details" class="evidence-row">
        <div class="evidence-label">說明</div>
        <div class="evidence-value">{{ behavior.details }}</div>
      </div>

      <!-- URL 欄位：支援截斷 + 點擊展開 -->
      <div v-if="rawUrl" class="evidence-row">
        <div class="evidence-label">URL</div>
        <div class="evidence-value url-value">
          <span
            class="url-text"
            :class="{ 'url-truncated': isUrlTruncated && !isUrlExpanded }"
          >{{ isUrlExpanded || !isUrlTruncated ? rawUrl : truncatedUrl }}</span>

          <button
            v-if="isUrlTruncated"
            class="url-expand-btn"
            @click="toggleUrl"
            :title="isUrlExpanded ? '收合 URL' : '展開完整 URL'"
          >
            {{ isUrlExpanded ? '收合' : '展開' }}
          </button>

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

    <!-- LOW 風險收合提示（未展開時顯示） -->
    <div v-if="isLowRisk && !isExpanded" class="low-risk-hint">
      點擊展開 · 常態統計請求
    </div>
  </div>
</template>
