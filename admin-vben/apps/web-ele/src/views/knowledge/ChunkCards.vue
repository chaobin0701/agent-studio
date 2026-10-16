<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { ElCard, ElEmpty, ElPagination, ElTag } from "element-plus";
import { chunkKind, sourceLocation } from "./display";
const props = withDefaults(
  defineProps<{ chunks: any[]; filename?: string; emptyText?: string }>(),
  { filename: "", emptyText: "暂无分块" },
);
const page = ref(1);
const pageSize = 10;
const visible = computed(() =>
  props.chunks.slice((page.value - 1) * pageSize, page.value * pageSize),
);
watch(
  () => props.chunks,
  () => {
    page.value = 1;
  },
);
</script>
<template>
  <ElEmpty v-if="!chunks.length" :description="emptyText" />
  <template v-else>
    <div class="mb-3">共 {{ chunks.length }} 个分块</div>
    <ElCard
      v-for="chunk in visible"
      :key="chunk.id ?? chunk.ordinal"
      class="mb-3"
      shadow="never"
    >
      <template #header>
        <div class="flex flex-wrap items-center gap-2">
          <span>分块 #{{ chunk.ordinal }}</span>
          <ElTag size="small">{{ chunkKind(chunk.kind) }}</ElTag>
          <ElTag v-if="chunk.parentOrdinal != null" size="small" type="info"
            >所属父分块 #{{ chunk.parentOrdinal }}</ElTag
          >
          <span class="text-sm text-muted-foreground"
            >{{ sourceLocation(chunk, chunk.originalFilename || filename) }} ·
            {{ chunk.content?.length ?? 0 }} 字</span
          >
        </div>
        <div v-if="chunk.headingPath" class="mt-2 font-medium">
          {{ chunk.headingPath }}
        </div>
      </template>
      <div class="whitespace-pre-wrap break-words leading-7">
        {{ chunk.content }}
      </div>
    </ElCard>
    <ElPagination
      v-if="chunks.length > pageSize"
      v-model:current-page="page"
      :page-size="pageSize"
      :total="chunks.length"
      layout="total, prev, pager, next"
    />
  </template>
</template>
