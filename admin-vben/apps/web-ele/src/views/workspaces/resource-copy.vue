<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from "vue";
import {
  ElAlert,
  ElButton,
  ElDialog,
  ElForm,
  ElFormItem,
  ElMessage,
  ElOption,
  ElSelect,
} from "element-plus";
import { managementApi as api } from "#/api/management";
import { useWorkspaceStore } from "#/store/workspace";
const props = defineProps<{ initialSource?: number }>();
const open = defineModel<boolean>({ required: true });
const ws = useWorkspaceStore();
const source = ref<number>(),
  target = ref<number>(),
  selected = ref<string>(),
  options = ref<any[]>([]),
  busy = ref(false),
  loading = ref(false),
  error = ref("");
let generation = 0;
const labels: Record<string, string> = {
  agent: "Agent",
  skill: "Skill",
  tool: "Tool",
  prompt: "Prompt",
  model: "模型方案",
  llm: "大语言模型",
  embedding: "向量模型",
  knowledge_base: "知识库",
  knowledge: "知识库",
};
function message(e: any) {
  const text = e.response?.data?.error?.message ?? e.response?.data?.message;
  return typeof text === "string"
    ? text
    : "复制失败，请检查来源和目标工作区权限后重试。";
}
async function loadOptions() {
  const request = ++generation,
    id = source.value;
  selected.value = undefined;
  options.value = [];
  error.value = "";
  if (target.value === id) target.value = undefined;
  if (!id) {
    loading.value = false;
    return;
  }
  loading.value = true;
  try {
    const result = await api.get(`/workspaces/${id}/copy-options`);
    if (request === generation && open.value) options.value = result;
  } catch (e) {
    if (request === generation) error.value = message(e);
  } finally {
    if (request === generation) loading.value = false;
  }
}
async function copy() {
  const item = options.value.find(
      (o) => `${o.kind}:${o.id}` === selected.value,
    ),
    id = source.value,
    destination = target.value;
  if (!item || !id || !destination || id === destination || busy.value) return;
  const request = generation;
  busy.value = true;
  error.value = "";
  try {
    await api.post(`/workspaces/${id}/copy`, {
      targetWorkspaceId: destination,
      kind: item.kind,
      id: item.id,
    });
    if (request !== generation || !open.value) return;
    open.value = false;
    ElMessage.success("已复制为目标工作区的独立配置");
  } catch (e) {
    if (request === generation) error.value = message(e);
  } finally {
    busy.value = false;
  }
}
onBeforeUnmount(() => generation++);
watch(open, (value) => {
  generation++;
  options.value = [];
  error.value = "";
  if (value) {
    source.value = props.initialSource ?? ws.id;
    target.value = undefined;
    void loadOptions();
  }
});
</script>
<template>
  <ElDialog
    class="management-dialog"
    body-class="management-dialog-body"
    header-class="management-dialog-header"
    footer-class="management-dialog-footer"
    append-to-body
    v-model="open"
    title="复制资源到其他工作区"
    width="min(680px,94vw)"
    :close-on-click-modal="false"
    :close-on-press-escape="!busy"
    :show-close="!busy"
  >
    <ElAlert
      v-if="error"
      :title="error"
      type="error"
      :closable="false"
      class="mb-4"
    />
    <ElForm
      label-position="top"
      :disabled="busy"
      class="grid grid-cols-1 gap-x-4 sm:grid-cols-2"
    >
      <ElFormItem label="来源工作区" required
        ><ElSelect
          v-model="source"
          filterable
          class="w-full"
          @change="loadOptions"
          ><ElOption
            v-for="w in ws.items.filter((w) => w.enabled)"
            :key="w.id"
            :value="w.id"
            :label="w.name" /></ElSelect
      ></ElFormItem>
      <ElFormItem label="目标工作区" required
        ><ElSelect v-model="target" filterable class="w-full"
          ><ElOption
            v-for="w in ws.items.filter((w) => w.enabled && w.id !== source)"
            :key="w.id"
            :value="w.id"
            :label="w.name" /></ElSelect
      ></ElFormItem>
      <ElFormItem label="资源" required class="sm:col-span-2"
        ><ElSelect
          v-model="selected"
          filterable
          :loading="loading"
          class="w-full"
          placeholder="选择来源资源"
          ><ElOption
            v-for="o in options"
            :key="`${o.kind}:${o.id}`"
            :value="`${o.kind}:${o.id}`"
            :label="`${labels[o.kind] ?? o.kind} · ${o.name}`" /></ElSelect
      ></ElFormItem>
    </ElForm>
    <template #footer
      ><ElButton :disabled="busy" @click="open = false">取消</ElButton
      ><ElButton
        type="primary"
        :loading="busy"
        :disabled="loading || !selected || !target"
        @click="copy"
        >复制资源</ElButton
      ></template
    >
  </ElDialog>
</template>
