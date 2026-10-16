<script setup lang="ts">
import { computed, ref } from "vue";
import { ElButton, ElInput, ElEmpty } from "element-plus";
import { Conversations } from "vue-element-plus-x";
import type { ChatSession } from "./types";
const props = defineProps<{
  sessions: ChatSession[];
  activeId?: string | null;
  canRename?: boolean;
  canDelete?: boolean;
  loading?: boolean;
  limit?: number;
}>();
const emit = defineEmits<{
  select: [id: string];
  search: [query: string];
  create: [];
  rename: [id: string];
  remove: [id: string];
  more: [];
}>();
const query = ref("");
const items = computed(() =>
  props.sessions
    .slice(0, props.limit || 100)
    .map((s) => ({ ...s, label: s.title, group: s.agentName ?? "会话" })),
);
function select(item: { id?: string; uniqueKey?: string | number }) {
  const id = String(item.id ?? item.uniqueKey ?? "");
  if (id) emit("select", id);
}
function command(command: unknown, item: { id?: string }) {
  if (!item.id) return;
  if (command === "rename") emit("rename", item.id);
  if (command === "remove") emit("remove", item.id);
}
</script>
<template>
  <div class="chatbot-session-menu">
    <ElButton
      type="primary"
      class="chatbot-new"
      :disabled="loading"
      @click="$emit('create')"
      >新建会话</ElButton
    ><ElInput
      v-model="query"
      clearable
      placeholder="搜索会话"
      aria-label="搜索会话"
      @update:model-value="$emit('search', String($event))"
    /><Conversations
      :items="items"
      :active="activeId ?? undefined"
      row-key="id"
      label-key="label"
      :groupable="true"
      :show-built-in-menu="!!(canRename || canDelete)"
      show-built-in-menu-type="always"
      :menu-offset="8"
      :menu="[
        ...(canRename
          ? [{ label: '重命名', key: 'rename', command: 'rename' }]
          : []),
        ...(canDelete
          ? [{ label: '删除会话', key: 'remove', command: 'remove' }]
          : []),
      ]"
      @change="select"
      @menu-command="command"
      ><template #more-filled
        ><ElButton text aria-label="会话操作">···</ElButton></template
      ></Conversations
    ><ElButton
      v-if="limit && sessions.length >= limit"
      text
      @click="$emit('more')"
      >查看更多会话</ElButton
    ><ElEmpty v-if="!items.length" :image-size="48" description="暂无会话" />
  </div>
</template>
