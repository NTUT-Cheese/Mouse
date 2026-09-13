<script setup lang="ts">
import { computed } from 'vue';
import type { BehaviorEntry } from '@/utils/types';
import { CATEGORY_INFO } from '@/utils/constants';

const props = defineProps<{
  behaviors: BehaviorEntry[];
}>();

// 計算各分類數量
const counts = computed(() => {
  const result: Record<string, number> = {};
  for (const b of props.behaviors) {
    result[b.category] = (result[b.category] || 0) + b.count;
  }
  return result;
});

const total = computed(() => props.behaviors.reduce((acc, b) => acc + b.count, 0));
</script>

<template>
  <div class="stats-bar">
    <div class="stat-chip active">
      <span>所有行為</span>
      <span class="count">{{ total }}</span>
    </div>
    
    <template v-for="(info, key) in CATEGORY_INFO" :key="key">
      <div v-if="counts[key]" class="stat-chip">
        <span class="icon">{{ info.icon }}</span>
        <span>{{ info.label }}</span>
        <span class="count">{{ counts[key] }}</span>
      </div>
    </template>
  </div>
</template>
