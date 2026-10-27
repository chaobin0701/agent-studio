<script setup lang="ts">
import { ref, watch } from "vue";
import { useRouter } from "vue-router";
import { ElAlert, ElButton, ElEmpty, ElPagination, ElTag } from "element-plus";
import { executionsApi, type ExecutionConversation } from "#/api/executions";
import { useWorkspaceStore } from "#/store/workspace";

const props = defineProps<{ traceId: string }>();
const router = useRouter();
const workspace = useWorkspaceStore();
const history = ref<ExecutionConversation>();
const loading = ref(false);
const error = ref("");
let generation = 0;
async function load(page?: number) {
  const request = ++generation;
  loading.value = true;
  error.value = "";
  history.value = undefined;
  try {
    const result = await executionsApi.conversation(props.traceId, page);
    if (request === generation) history.value = result;
  } catch {
    if (request === generation) error.value = "会话对话加载失败，请检查当前工作区和读取权限后重试。";
  } finally {
    if (request === generation) loading.value = false;
  }
}
watch([() => props.traceId, () => workspace.generation], () => load(), { immediate: true });
const date = (time: string) => new Date(time).toLocaleString("zh-CN", { hour12: false });
</script>

<template>
  <section v-loading="loading" class="min-h-40" aria-label="会话对话">
    <ElAlert v-if="error" :title="error" type="error" :closable="false">
      <ElButton link type="primary" @click="load()">重试</ElButton>
    </ElAlert>
    <template v-if="history?.conversation">
      <div class="mb-5 flex flex-wrap items-start justify-between gap-3">
        <div class="min-w-0">
          <h2 class="break-words font-medium">{{ history.conversation.title }}</h2>
          <p class="mt-1 text-xs text-muted-foreground">{{ history.total }} 轮 · 保存的会话历史，模型实际使用的上下文可能经过摘要或裁剪。</p>
        </div>
        <ElButton size="small" @click="load()">定位当前执行</ElButton>
      </div>
      <ElEmpty v-if="!history.items.length" description="此会话暂无已保存的对话" />
      <ol v-else class="divide-y divide-border">
        <li
          v-for="(turn, index) in history.items"
          :key="turn.key"
          class="py-5 first:pt-0"
          :aria-current="turn.traceId === traceId ? 'step' : undefined"
        >
          <div class="mb-3 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <span class="font-medium text-foreground">第 {{ (history.page - 1) * history.pageSize + index + 1 }} 轮</span>
            <ElTag v-if="turn.traceId === traceId" size="small">当前执行</ElTag>
            <ElTag v-if="turn.status === 'failed'" size="small" type="danger">失败</ElTag>
            <ElTag v-else-if="turn.refused" size="small" type="warning">未完成任务</ElTag>
            <span>{{ date(turn.createdAt) }}</span>
            <span v-if="turn.totalTokens != null">{{ turn.totalTokens }} Token</span>
            <ElButton
              v-if="turn.traceId && turn.traceId !== traceId"
              class="ml-auto"
              link type="primary" size="small"
              @click="router.push({ path: `/executions/${turn.traceId}`, query: { view: 'execution' } })"
            >执行详情</ElButton>
            <span v-else-if="!turn.traceId" class="ml-auto">未保存执行记录</span>
          </div>
          <div class="space-y-4" :class="turn.traceId === traceId ? 'border-l-2 border-primary pl-4' : ''">
            <div>
              <h3 class="mb-1 text-xs font-medium text-muted-foreground">用户</h3>
              <p class="whitespace-pre-wrap break-words text-sm">{{ turn.question || '未保存提问正文' }}</p>
            </div>
            <div>
              <h3 class="mb-1 text-xs font-medium text-muted-foreground">助手</h3>
              <p class="whitespace-pre-wrap break-words text-sm">{{ turn.finalAnswer || (turn.status === 'failed' ? '本轮执行失败，未生成回复。' : '未保存回复正文') }}</p>
              <p v-if="turn.errorCode" class="mt-2 text-xs text-muted-foreground">错误分类：{{ turn.errorCode }}</p>
            </div>
          </div>
        </li>
      </ol>
      <div v-if="history.total > history.pageSize" class="mt-4 flex justify-end">
        <ElPagination :current-page="history.page" :page-size="history.pageSize" :total="history.total" layout="prev, pager, next" @current-change="load" />
      </div>
    </template>
    <ElEmpty v-else-if="history && !loading" description="此执行没有关联会话，仅可查看本次任务输入与结果。" />
  </section>
</template>
