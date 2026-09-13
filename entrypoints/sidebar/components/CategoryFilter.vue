<script setup lang="ts">
import { CATEGORY_INFO } from '@/utils/constants';
import type { BehaviorCategory } from '@/utils/types';

const selectedCategory = defineModel<BehaviorCategory | null>('selected', { default: null });
</script>

<template>
  <div class="category-filter">
    <div 
      class="filter-chip" 
      :class="{ active: selectedCategory === null }"
      @click="selectedCategory = null"
    >
      全部
    </div>
    <div 
      v-for="(info, key) in CATEGORY_INFO" 
      :key="key"
      class="filter-chip"
      :class="{ active: selectedCategory === key }"
      @click="selectedCategory = key as BehaviorCategory"
    >
      <span class="emoji">{{ info.icon }}</span>
      {{ info.label }}
    </div>
  </div>
</template>
