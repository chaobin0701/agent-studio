<script setup lang="ts">
import { computed, defineAsyncComponent, watch } from "vue";
import { ElAlert, ElButton } from "element-plus";
import { validateJson, type JsonKind } from "./json-validation";
const CodeEditor = defineAsyncComponent(() => import("./JsonCodeEditor.vue"));
const props = withDefaults(
  defineProps<{
    readonly?: boolean;
    height?: number;
    label?: string;
    kind?: JsonKind;
    allowEmpty?: boolean;
    validateValue?: (value: unknown) => string | undefined;
  }>(),
  {
    readonly: false,
    height: 240,
    label: "JSON 代码编辑器",
    kind: "any",
    allowEmpty: false,
  },
);
const text = defineModel<string>({ default: "" });
const emit = defineEmits<{
  valid: [value: boolean];
  parsed: [value: any];
  error: [message: string];
}>();
const validation = computed(() => {
  const result = validateJson(text.value, props.kind, props.allowEmpty);
  if (!result.ok) return result;
  const message = props.validateValue?.(result.value);
  return message ? { ok: false as const, message } : result;
});
watch(
  validation,
  (result) => {
    emit("valid", result.ok);
    emit("error", result.ok ? "" : result.message);
    if (result.ok) emit("parsed", result.value);
  },
  { immediate: true, flush: "sync" },
);
function format() {
  if (
    props.readonly ||
    !validation.value.ok ||
    validation.value.value === undefined
  )
    return;
  text.value = JSON.stringify(validation.value.value, null, 2);
}
</script>
<template>
  <div class="w-full min-w-0 space-y-2">
    <div class="json-editor overflow-hidden rounded border">
      <div
        class="editor-toolbar flex flex-wrap items-center justify-between gap-2 border-b px-3 py-1 text-xs"
      >
        <span>{{ label }} · JSON</span>
        <span v-if="readonly">只读，可选择复制</span>
        <ElButton
          v-else
          size="small"
          text
          :disabled="!validation.ok"
          @click="format"
          >格式化</ElButton
        >
      </div>
      <CodeEditor
        v-model="text"
        :readonly="readonly"
        :height="height"
        :label="label"
        :allow-empty="allowEmpty"
        @format="format"
      />
      <div
        class="editor-toolbar flex flex-wrap justify-between gap-2 border-t px-3 py-1 text-xs"
      >
        <span>{{
          validation.ok
            ? allowEmpty && !text.trim()
              ? "未填写（可选）"
              : "JSON 格式有效"
            : "JSON 校验未通过"
        }}</span>
        <span>{{
          readonly
            ? "可折叠对象与数组"
            : "2 空格缩进 · Ctrl / ⌘ + Shift + F 格式化"
        }}</span>
      </div>
    </div>
    <ElAlert
      v-if="!validation.ok"
      :title="validation.message"
      type="error"
      :closable="false"
      role="alert"
    />
  </div>
</template>
<style scoped>
.json-editor,
.editor-toolbar {
  border-color: var(--el-border-color);
}
.editor-toolbar {
  background: var(--el-fill-color-light);
  color: var(--el-text-color-secondary);
}
</style>
