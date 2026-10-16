<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted } from "vue";
import {
  ElButton,
  ElSelect,
  ElOption,
  ElMessageBox,
  ElMessage,
  ElTooltip,
} from "element-plus";
import ChatWorkspace from "./ChatWorkspace.vue";
import type { ChatbotClient } from "./client";
const props = defineProps<{
  client: ChatbotClient;
  compact?: boolean;
  showInspect?: boolean;
  historyOverlay?: boolean;
  canConfigureModels?: boolean;
}>();
defineEmits<{ inspect: [traceId: string]; configureModel: [planId: number] }>();
const buffer = computed(() => props.client.current());
const agent = computed(() =>
  props.client.state.agents.find(
    (a) => a.id === props.client.state.selectedAgentId,
  ),
);
const title = computed(
  () =>
    props.client.state.sessions.find(
      (s) => s.id === props.client.state.activeId,
    )?.title ?? "新会话",
);
let searchTimer: ReturnType<typeof setTimeout> | undefined;
function search(query: string) {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(
    () => void props.client.search(query).catch(() => {}),
    300,
  );
}
async function rename(id: string) {
  try {
    const result = await ElMessageBox.prompt("会话名称", "重命名会话", {
      inputValue: props.client.state.sessions.find((s) => s.id === id)?.title,
      inputValidator: (v) =>
        (!!v.trim() && v.trim().length <= 160) || "请输入 1–160 字的名称",
      confirmButtonText: "保存",
      cancelButtonText: "取消",
    });
    await props.client.rename(id, result.value.trim());
  } catch (error) {
    if (error !== "cancel" && error !== "close")
      ElMessage.error(error instanceof Error ? error.message : "保存失败");
  }
}
async function remove(id: string) {
  try {
    await ElMessageBox.confirm(
      "删除会话后不可再访问其消息和附件，正在生成的任务也会停止。",
      "删除会话",
      { type: "warning", confirmButtonText: "删除", cancelButtonText: "取消" },
    );
    await props.client.remove(id);
  } catch (error) {
    if (error !== "cancel" && error !== "close")
      ElMessage.error(error instanceof Error ? error.message : "删除失败");
  }
}
async function refresh() {
  await props.client.refresh();
}
function updateCapabilities() {
  if (document.visibilityState === "visible")
    void props.client.refreshCapabilities().catch(() => {});
}
onMounted(() => {
  void props.client.initialize();
  window.addEventListener("focus", updateCapabilities);
});
onBeforeUnmount(() => {
  clearTimeout(searchTimer);
  window.removeEventListener("focus", updateCapabilities);
}); // The application owns the client/stream lifetime.
</script>
<template>
  <ChatWorkspace
    :sessions="client.state.sessions"
    :active-id="client.state.activeId"
    :messages="buffer.messages"
    :draft="buffer.draft"
    :attachments="buffer.attachments"
    :images-enabled="!!agent?.supportsImages"
    :image-input-reason="agent?.imageInputReason"
    :busy="!!buffer.runId"
    :loading="client.state.loading || buffer.loading || client.state.creating"
    :disabled="!client.state.ready || !agent || !!buffer.pending"
    :error="buffer.error || client.state.error"
    :title="title"
    :subtitle="
      compact
        ? undefined
        : agent
          ? `${agent.name} · 已发布 v${agent.version}`
          : '请先发布 Agent，再开始对话'
    "
    :compact="compact"
    :history-overlay="historyOverlay"
    :show-inspect="showInspect ?? false"
    :can-delete="client.state.canDelete"
    :can-rename="client.state.canRename"
    :accept="
      agent?.supportsImages
        ? '.md,.pdf,.docx,.png,.jpg,.jpeg,.webp'
        : '.md,.pdf,.docx'
    "
    @update:draft="client.draft"
    @select="client.open"
    @search="search"
    @create="client.newConversation()"
    @rename="rename"
    @remove="remove"
    @send="client.send"
    @cancel="client.cancel"
    @upload="client.upload"
    @remove-attachment="client.removeAttachment"
    @download="client.download"
    @inspect="$emit('inspect', $event)"
  >
    <template #header
      ><ElSelect
        v-if="!compact || client.state.agents.length > 1"
        :model-value="client.state.selectedAgentId"
        filterable
        placeholder="选择 Agent"
        aria-label="选择已发布 Agent"
        class="chatbot-agent-select"
        :disabled="client.state.creating"
        @change="client.newConversation(Number($event))"
        ><ElOption
          v-for="item in client.state.agents"
          :key="item.id"
          :label="item.name"
          :value="item.id" /></ElSelect
      ><ElButton text @click="refresh">刷新</ElButton></template
    >
    <template #actions
      ><ElButton
        v-if="buffer.pending"
        link
        type="primary"
        @click="client.retryPending"
        >重试本次提交</ElButton
      ></template
    >
    <template #hint>
      <div class="chatbot-composer-meta">
        <span>Enter 发送 · Shift+Enter 换行</span>
        <div class="chatbot-composer-status">
          <ElTooltip
            content="文档支持 Markdown/PDF/DOCX，单份 2 MB；图片支持 PNG/JPEG/WebP，单张 5 MB。每轮最多 5 个，仅用于本会话，保留 7 天，不加入知识库。"
            ><ElButton text size="small">附件说明</ElButton></ElTooltip
          >
          <ElTooltip
            v-if="agent && !agent.supportsImages"
            :content="
              agent.imageInputReason ||
              '请发布支持图片的模型方案，并更新 Agent 的发布版本。'
            "
            placement="top"
            ><span class="chatbot-capability-note">图片未启用</span></ElTooltip
          >
          <ElButton
            v-if="
              agent &&
              !agent.supportsImages &&
              canConfigureModels &&
              agent.modelPlanId
            "
            link
            type="primary"
            @click="$emit('configureModel', agent.modelPlanId)"
            >查看模型方案</ElButton
          >
        </div>
      </div>
    </template>
  </ChatWorkspace>
</template>
