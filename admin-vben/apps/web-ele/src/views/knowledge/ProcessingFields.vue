<script setup lang="ts">
import { ElFormItem, ElSelect, ElOption, ElInputNumber } from "element-plus";
import HelpTip from "#/components/HelpTip.vue";
const value = defineModel<any>({ required: true });
</script>
<template>
  <ElFormItem
    ><template #label
      >分块方式
      <HelpTip
        text="普通分块适合一般资料；父子分块用较小片段匹配，再返回较完整的父段落。"
        long
    /></template>
    <ElSelect v-model="value.chunkMode"
      ><ElOption value="general" label="普通分块" /><ElOption
        value="parent_child"
        label="父子分块"
    /></ElSelect>
  </ElFormItem>
  <div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
    <ElFormItem
      v-for="field in value.chunkMode === 'general'
        ? [
            { key: 'chunkChars', label: '分块长度', min: 200, max: 4000 },
            { key: 'overlapChars', label: '重叠长度', min: 0, max: 400 },
          ]
        : [
            { key: 'parentChars', label: '父分块长度', min: 500, max: 6000 },
            { key: 'childChars', label: '子分块长度', min: 100, max: 2000 },
            { key: 'childOverlapChars', label: '子分块重叠', min: 0, max: 200 },
          ]"
      :key="field.key"
    >
      <template #label
        >{{ field.label }}
        <HelpTip
          :text="
            field.key.includes('Overlap') || field.key === 'overlapChars'
              ? '相邻分块保留少量重复内容，普通分块建议 60 字。'
              : '按字符计算。普通分块建议 800 字；过短可能丢失上下文，过长可能降低匹配精度。'
          "
          long
      /></template>
      <ElInputNumber
        v-model="value[field.key]"
        class="management-input-number"
        controls-position="right"
        :min="field.min"
        :max="field.max"
      />
    </ElFormItem>
  </div>
</template>
