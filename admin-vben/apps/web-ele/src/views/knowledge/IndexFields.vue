<script setup lang="ts">
import { ElFormItem, ElSelect, ElOption } from "element-plus";
import HelpTip from "#/components/HelpTip.vue";
const props = defineProps<{ profiles: any[]; defaultProfile?: number }>();
const value = defineModel<any>({ required: true });
function changed() {
  value.value.embeddingProfileId =
    value.value.indexMode === "economy"
      ? null
      : (value.value.embeddingProfileId ?? props.defaultProfile ?? null);
}
</script>
<template>
  <ElFormItem
    ><template #label
      >索引模式
      <HelpTip
        text="经济模式提供全文索引；向量模式同时提供全文和向量索引。更换模式或向量模型需确认全库重建。"
        long
    /></template>
    <ElSelect v-model="value.indexMode" @change="changed"
      ><ElOption value="economy" label="经济模式（全文）" /><ElOption
        value="high_quality"
        label="向量模式（全文＋向量）"
    /></ElSelect>
  </ElFormItem>
  <ElFormItem v-if="value.indexMode === 'high_quality'" required
    ><template #label
      >向量模型方案
      <HelpTip
        text="使用已发布方案，默认预填工作区设置。保存新的工作区默认值不会替换已有知识库的方案。"
        long
    /></template>
    <ElSelect v-model="value.embeddingProfileId" filterable
      ><ElOption
        v-for="profile in profiles"
        :key="profile.id"
        :value="profile.id"
        :label="profile.name"
        :disabled="!profile.enabled"
    /></ElSelect>
  </ElFormItem>
</template>
