<script setup lang="ts">
import { computed } from "vue";
import { Bubble, FilesCard } from "vue-element-plus-x";
import { ElButton, ElTag, ElMessage, ElImage } from "element-plus";
import DOMPurify from "dompurify";
import { Marked } from "marked";
import ChatInteraction from "./ChatInteraction.vue";
import type { ChatTurn, ChatInteractionResponse } from "./types";
import "./styles.css";
const props = withDefaults(
  defineProps<{
    message: ChatTurn;
    showInspect?: boolean;
    interactionDisabled?: boolean;
    interactionRespondingId?: string;
    interactionErrors?: Record<string, string>;
  }>(),
  { showInspect: true, interactionDisabled: true },
);
defineEmits<{
  download: [id: string];
  inspect: [traceId: string];
  respond: [response: ChatInteractionResponse];
  cancelInteraction: [];
}>();
const markdown = new Marked({ renderer: { html: () => "" } });
const html = computed(() =>
  DOMPurify.sanitize(markdown.parse(props.message.content, { async: false }), {
    FORBID_TAGS: ["img", "style", "iframe", "svg", "math"],
  }),
);
const pendingInteractions = computed(() => props.message.interactions?.filter(item => item.status === 'pending') ?? []);
const resolvedInteractions = computed(() => props.message.interactions?.filter(item => item.status !== 'pending') ?? []);
const activityKey = computed(() => resolvedInteractions.value.map(item => `${item.id}:${item.status}`).join('|'));
async function copy() {
  try {
    await navigator.clipboard.writeText(props.message.content);
    ElMessage.success("已复制");
  } catch {
    ElMessage.warning("复制失败，请手动选择内容");
  }
}
</script>
<template>
  <Bubble
    :placement="message.role === 'user' ? 'end' : 'start'"
    :content="message.content"
    :loading="message.status === 'running' && !message.content"
    :max-width="'90%'"
    :no-style="message.role === 'assistant'"
    :variant="message.role === 'user' ? 'filled' : 'borderless'"
    class="chatbot-message"
  >
    <template #header
      ><span class="chatbot-role"
        >{{ message.role === "user" ? "你" : "Agent"
        }}<span v-if="message.agentVersion">
          · v{{ message.agentVersion }}</span
        ></span
      ></template
    >
    <template #content>
      <details v-if="message.role === 'assistant' && (message.progress?.length || resolvedInteractions.length)" :key="activityKey" class="chatbot-progress">
        <summary>工具调用过程 · {{ (message.progress?.length ?? 0) + resolvedInteractions.length }} 项</summary>
        <p v-for="(item, i) in message.progress" :key="i">{{ typeof item === 'string' ? item : item.text }}</p>
        <ChatInteraction v-for="interaction in resolvedInteractions" :key="interaction.id" :interaction="interaction" disabled />
      </details>
      <div
        v-if="message.role === 'assistant'"
        class="chatbot-markdown"
        v-html="html"
      />
      <div v-else class="chatbot-plain">{{ message.content }}</div>
      <template v-if="message.role === 'assistant'">
        <ChatInteraction
          v-for="interaction in pendingInteractions"
          :key="interaction.id"
          :interaction="interaction"
          :disabled="interactionDisabled || !!interactionRespondingId"
          :submitting="interactionRespondingId === interaction.id"
          :error="interactionErrors?.[interaction.id]"
          @respond="$emit('respond', $event)"
          @cancel="$emit('cancelInteraction')"
        />
      </template>
      <div v-if="message.attachments?.length" class="chatbot-message-files">
        <FilesCard
          v-for="file in message.attachments"
          :key="file.id"
          :name="file.name"
          :file-size="file.size"
          :url="file.previewUrl"
          :thumb-url="file.previewUrl"
          :img-preview="!!file.previewUrl"
          :description="file.status === 'expired' ? '已过期' : undefined"
          :file-type="file.mimeType.startsWith('image/') ? 'image' : 'file'"
          @click="!file.previewUrl && $emit('download', file.id)"
        >
          <template v-if="file.previewUrl" #icon>
            <ElImage
              class="chatbot-image-thumb"
              :src="file.previewUrl"
              :alt="file.name"
              fit="cover"
              :preview-src-list="[file.previewUrl]"
              :preview-teleported="true"
              hide-on-click-modal
            />
          </template>
        </FilesCard>
      </div>
      <div v-if="message.artifacts?.length" class="chatbot-message-files">
        <FilesCard
          v-for="file in message.artifacts.filter(
            (f) => f.kind === 'execution_file' && f.id,
          )"
          :key="file.id"
          :name="String(file.data?.filename ?? '文件产物')"
          :file-size="Number(file.data?.byteSize ?? file.data?.size ?? 0)"
          file-type="file"
          @click="$emit('download', file.id!)"
        />
      </div>
      <div
        v-if="message.references?.length"
        class="chatbot-message-files"
        aria-label="资料来源"
      >
        <ElTag
          v-for="reference in message.references"
          :key="`${reference.kind}:${reference.id}`"
          type="info"
          size="small"
          >{{ reference.title ?? reference.id }}</ElTag
        >
      </div>
      <details
        v-if="
          message.structured !== undefined && message.status === 'completed'
        "
        class="chatbot-progress"
      >
        <summary>结构化 JSON</summary>
        <pre class="chatbot-plain">{{
          JSON.stringify(message.structured, null, 2)
        }}</pre>
      </details>
      <p v-if="message.error" class="chatbot-error" role="alert">
        {{ message.error }}
      </p>
      <ElTag v-if="message.status === 'cancelled'" type="info" size="small"
        >已停止</ElTag
      >
    </template>
    <template #footer
      ><div v-if="message.content" class="chatbot-message-actions">
        <ElButton text size="small" @click="copy">复制</ElButton
        ><ElButton
          v-if="showInspect && message.traceId"
          text
          size="small"
          @click="$emit('inspect', message.traceId)"
          >执行详情</ElButton
        >
      </div></template
    >
  </Bubble>
</template>
