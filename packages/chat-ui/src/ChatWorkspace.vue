<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { Attachments, BubbleList, XSender, Welcome } from "vue-element-plus-x";
import {
  ElAlert,
  ElButton,
  ElDrawer,
  ElUpload,
  ElTooltip,
  type UploadInstance,
  type UploadFile,
} from "element-plus";
import { replaceSenderText, type ChatSender } from "./sender-sync";
import ChatMessage from "./ChatMessage.vue";
import ChatSessions from "./ChatSessions.vue";
import type { ChatAttachment, ChatSession, ChatTurn } from "./types";
import "./styles.css";
const props = withDefaults(
  defineProps<{
    sessions: ChatSession[];
    activeId?: string | null;
    messages: ChatTurn[];
    draft: string;
    attachments?: ChatAttachment[];
    busy?: boolean;
    loading?: boolean;
    disabled?: boolean;
    error?: string;
    title?: string;
    subtitle?: string;
    accept?: string;
    imagesEnabled?: boolean;
    imageInputReason?: string;
    canDelete?: boolean;
    canRename?: boolean;
    showInspect?: boolean;
    compact?: boolean;
    historyOverlay?: boolean;
  }>(),
  {
    attachments: () => [],
    title: "Agent 对话",
    accept: ".md,.pdf,.docx,.png,.jpg,.jpeg,.webp",
    canDelete: true,
    canRename: true,
    showInspect: true,
  },
);
const emit = defineEmits<{
  "update:draft": [value: string];
  select: [id: string];
  search: [query: string];
  create: [];
  rename: [id: string];
  remove: [id: string];
  send: [];
  cancel: [];
  upload: [files: File[]];
  removeAttachment: [id: string];
  download: [id: string];
  inspect: [traceId: string];
}>();
const sidebar = ref(false),
  allSessions = ref(false);
const sender = ref<ChatSender>();
let syncing = false;
const composer = ref<HTMLElement>(),
  filePicker = ref<UploadInstance>(),
  imagePicker = ref<UploadInstance>();
const list = computed(() =>
  props.messages.map((m) => ({
    ...m,
    itemType: "chat-message",
    placement: m.role === "user" ? ("end" as const) : ("start" as const),
  })),
);
const fileItems = computed(() =>
  props.attachments.map((a) => ({
    uid: a.id,
    name: a.name,
    fileSize: a.size,
    fileType: a.mimeType.startsWith("image/")
      ? ("image" as const)
      : ("file" as const),
    showDelIcon: !props.busy,
    url: a.previewUrl,
    thumbUrl: a.previewUrl,
    imgPreview: !!a.previewUrl,
    status:
      a.status === "failed"
        ? ("error" as const)
        : ["uploading", "processing"].includes(a.status ?? "")
          ? ("uploading" as const)
          : ("done" as const),
    errorTip: a.error,
    description:
      a.error ??
      {
        uploading: "上传中",
        processing: "解析中",
        failed: "失败",
        expired: "已过期",
        ready: "已就绪",
      }[a.status ?? "ready"],
  })),
);
const canSend = computed(
  () =>
    !props.disabled &&
    !props.loading &&
    !props.busy &&
    (props.draft.trim().length > 0 || props.attachments.length > 0) &&
    props.attachments.every(
      (a) => a.status === undefined || a.status === "ready",
    ),
);
function changed() {
  if (syncing) return;
  emit("update:draft", sender.value?.getModelValue().text ?? "");
}
async function send() {
  changed();
  await nextTick();
  if (canSend.value) emit("send");
}
function select(id: string) {
  emit("select", id);
  sidebar.value = false;
}
function picked(file: UploadFile) {
  if (file.raw) emit("upload", [file.raw]);
  void nextTick(() => {
    filePicker.value?.clearFiles();
    imagePicker.value?.clearFiles();
  });
}
watch(
  () => [props.draft, sender.value] as const,
  async ([value], _, onCleanup) => {
    let cancelled = false;
    onCleanup(() => {
      cancelled = true;
    });
    await nextTick();
    if (cancelled || !sender.value) return;
    syncing = true;
    try {
      await replaceSenderText(sender.value, value);
    } finally {
      syncing = false;
    }
  },
  { immediate: true },
);
</script>
<template>
  <section
    class="chatbot-shell"
    :class="{ 'is-compact': compact }"
    aria-label="Agent 聊天"
  >
    <aside v-if="!compact && !historyOverlay" class="chatbot-sidebar">
      <ChatSessions
        :sessions="sessions"
        :active-id="activeId"
        :loading="loading"
        :can-delete="canDelete"
        :can-rename="canRename"
        @select="select"
        @search="$emit('search', $event)"
        @create="$emit('create')"
        @rename="$emit('rename', $event)"
        @remove="$emit('remove', $event)"
      />
    </aside>
    <ElDrawer
      v-model="sidebar"
      :title="allSessions ? '会话列表' : '最近会话'"
      direction="ltr"
      size="min(340px,90vw)"
      append-to-body
      ><ChatSessions
        :sessions="sessions"
        :active-id="activeId"
        :limit="historyOverlay && !allSessions ? 10 : undefined"
        :loading="loading"
        :can-delete="canDelete"
        :can-rename="canRename"
        @select="select"
        @search="
          allSessions = true;
          $emit('search', $event);
        "
        @create="
          sidebar = false;
          $emit('create');
        "
        @rename="$emit('rename', $event)"
        @remove="$emit('remove', $event)"
        @more="allSessions = true"
    /></ElDrawer>
    <div class="chatbot-main">
      <header class="chatbot-header">
        <ElButton
          v-if="!compact"
          class="chatbot-history-toggle"
          :class="{ 'is-overlay': historyOverlay }"
          text
          aria-label="打开会话列表"
          @click="sidebar = !sidebar"
          >会话</ElButton
        >
        <div>
          <h1>{{ title }}</h1>
          <p v-if="subtitle">{{ subtitle }}</p>
        </div>
        <div class="chatbot-header-tools"><slot name="header" /></div>
      </header>
      <ElAlert
        v-if="error"
        :title="error"
        type="error"
        :closable="false"
        show-icon
      />
      <div class="chatbot-messages" :aria-busy="loading">
        <div v-if="!messages.length" class="chatbot-welcome">
          <Welcome
            variant="borderless"
            :title="loading ? '正在加载会话…' : '开始新对话'"
            description="发送消息，或添加附件后提问。"
          />
        </div>
        <BubbleList
          v-else
          :list="list"
          item-key="id"
          class="chatbot-message-column"
          :auto-scroll="true"
          :max-height="'100%'"
          :show-back-button="true"
          ><template #item="{ item }"
            ><ChatMessage
              :message="item as ChatTurn"
              :show-inspect="showInspect"
              @download="$emit('download', $event)"
              @inspect="$emit('inspect', $event)" /></template
        ></BubbleList>
      </div>
      <footer ref="composer" class="chatbot-composer">
        <div class="chatbot-composer-column">
          <Attachments
            :items="fileItems"
            :hide-upload="true"
            :drag-target="composer"
            overflow="scrollX"
            class="chatbot-attachments"
            :disabled="busy || disabled || loading"
            :limit="5"
            @upload-drop="$emit('upload', $event)"
            @delete-card="$emit('removeAttachment', String($event.uid))"
          />
          <XSender
            ref="sender"
            variant="updown"
            :custom-style="{ minHeight: '72px', maxHeight: '180px' }"
            :loading="busy"
            :disabled="disabled || loading"
            :max-length="2000"
            placeholder="输入消息，或粘贴图片…"
            @change="changed"
            @submit="send"
            @cancel="$emit('cancel')"
            @paste-file="
              (_file: File, files: FileList) =>
                $emit('upload', Array.from(files))
            "
            ><template #prefix>
              <div
                class="chatbot-upload-tools"
                role="group"
                aria-label="添加附件"
              >
                <ElUpload
                  ref="filePicker"
                  :auto-upload="false"
                  :show-file-list="false"
                  accept=".md,.pdf,.docx"
                  multiple
                  :disabled="busy || disabled || loading"
                  :on-change="picked"
                  ><ElButton
                    text
                    aria-label="上传文档"
                    :disabled="busy || disabled || loading"
                    >文档</ElButton
                  ></ElUpload
                >
                <ElTooltip
                  :content="
                    imagesEnabled
                      ? '支持 PNG、JPEG、WebP，单张不超过 5 MB'
                      : imageInputReason || '当前模型未开启图片输入'
                  "
                  placement="top"
                >
                  <span
                    ><ElUpload
                      ref="imagePicker"
                      :auto-upload="false"
                      :show-file-list="false"
                      accept=".png,.jpg,.jpeg,.webp"
                      multiple
                      :disabled="!imagesEnabled || busy || disabled || loading"
                      :on-change="picked"
                      ><ElButton
                        text
                        aria-label="上传图片"
                        :disabled="
                          !imagesEnabled || busy || disabled || loading
                        "
                        >图片</ElButton
                      ></ElUpload
                    ></span
                  >
                </ElTooltip>
              </div> </template
            ><template #action-list
              ><ElButton v-if="busy" @click="$emit('cancel')">停止生成</ElButton
              ><ElButton
                v-else
                type="primary"
                :disabled="!canSend"
                @click="send"
                >发送</ElButton
              ></template
            ></XSender
          >
          <div class="chatbot-composer-hint">
            <slot name="actions" /><slot name="hint"
              >附件仅用于当前会话，不会加入知识库。</slot
            >
          </div>
        </div>
      </footer>
    </div>
  </section>
</template>
