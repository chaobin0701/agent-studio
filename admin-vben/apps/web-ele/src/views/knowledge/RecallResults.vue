<script setup lang="ts">
import { computed } from "vue";
import {
  ElCard,
  ElDescriptions,
  ElDescriptionsItem,
  ElEmpty,
  ElTag,
} from "element-plus";
import { sourceLocation } from "./display";
const props = defineProps<{ result: any }>();
const hits = computed<any[]>(() => props.result.hits || []);
function matches(hit: any) {
  if (hit.matchType) return hit.matchType;
  const lexical =
    hit.lexicalRank != null ||
    props.result.lexicalResults?.some((v: any) => v.chunkId === hit.chunkId);
  const vector =
    hit.vectorRank != null ||
    props.result.vectorResults?.some((v: any) => v.chunkId === hit.chunkId);
  return lexical && vector
    ? "全文 + 向量"
    : vector
      ? "向量"
      : lexical
        ? "全文"
        : "检索命中";
}
function score(value: unknown) {
  return typeof value === "number" && Number.isFinite(value)
    ? value.toFixed(4)
    : "—";
}
</script>
<template>
  <ElDescriptions class="mb-4" border :column="2">
    <ElDescriptionsItem label="命中分块">{{
      result.hits?.length ?? 0
    }}</ElDescriptionsItem>
    <ElDescriptionsItem label="检索耗时"
      >{{ result.durationMs ?? "—" }} ms</ElDescriptionsItem
    >
    <ElDescriptionsItem label="全文 / 向量候选"
      >{{ result.lexicalResults?.length ?? 0 }} /
      {{ result.vectorResults?.length ?? 0 }}</ElDescriptionsItem
    >
    <ElDescriptionsItem label="向量模型调用次数">{{
      result.embeddingCalls ?? 0
    }}</ElDescriptionsItem>
  </ElDescriptions>
  <ElEmpty
    v-if="!result.hits?.length"
    description="未找到匹配内容，可以换个问题或检查当前索引与检索阈值"
  />
  <ElCard
    v-for="(hit, index) in hits"
    :key="hit.chunkId"
    class="mb-3"
    shadow="never"
  >
    <template #header>
      <div class="flex flex-wrap items-center gap-2">
        <span class="font-medium"
          >{{ index + 1 }}. {{ hit.documentTitle || "未命名文档" }}</span
        >
        <ElTag size="small">{{ matches(hit) }}</ElTag>
        <ElTag v-if="hit.indexVersionId" type="info" size="small"
          >索引 #{{ hit.indexVersionId }}</ElTag
        >
        <span class="text-sm text-muted-foreground"
          >{{ hit.fusionScore != null ? "融合分数" : "检索分数" }}
          {{ score(hit.fusionScore ?? hit.score) }}</span
        >
      </div>
      <div class="mt-2 text-sm text-muted-foreground">
        {{ hit.originalFilename }} · 分块 #{{ hit.ordinal }} ·
        {{ sourceLocation(hit, hit.originalFilename) }}
      </div>
      <div v-if="hit.headingPath" class="mt-2 font-medium">
        {{ hit.headingPath }}
      </div>
    </template>
    <div class="whitespace-pre-wrap break-words leading-7">
      {{ hit.content }}
    </div>
  </ElCard>
</template>
