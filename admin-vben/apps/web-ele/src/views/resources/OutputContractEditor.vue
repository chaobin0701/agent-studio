<script setup lang="ts">
import { computed, ref, watch } from "vue";
import {
  ElAlert,
  ElButton,
  ElDialog,
  ElFormItem,
  ElSegmented,
  ElDropdown,
  ElDropdownMenu,
  ElDropdownItem,
  ElMessage,
  ElMessageBox,
} from "element-plus";
import {
  normalizeSchema,
  parseJson,
  schemaExample,
  validateStructured,
  type Contract,
} from "@agent-studio/output-contract";
import JsonEditor from "#/components/JsonEditor.vue";
import HelpTip from "#/components/HelpTip.vue";
import OutputFieldTree from "./OutputFieldTree.vue";
import {
  addSuggestedFollowUpsField,
  schemaFields,
  fieldsSchema,
  EMPTY_OUTPUT_SCHEMA,
  type OutputField,
} from "./output-editor";
const props = defineProps<{ disabled?: boolean }>();
const output = defineModel<Contract | undefined>();
const emit = defineEmits<{ valid: [value: boolean] }>();
const mode = computed(() => output.value?.mode ?? "text");
const source = ref(""),
  view = ref("fields"),
  rows = ref<OutputField[]>([]),
  rowError = ref(""),
  sampleOpen = ref(false),
  sampleText = ref(""),
  sampleResult = ref("");
const lastSchema = ref(normalizeSchema(EMPTY_OUTPUT_SCHEMA));
const importInput = ref<HTMLInputElement>();
const parsed = computed(() => parseJson(source.value));
const followUpsConfigured = computed(() => {
  const schema = parsed.value.value as { properties?: Record<string, unknown> } | undefined;
  return Boolean(schema?.properties && Object.hasOwn(schema.properties, "suggestedFollowUps"));
});
const validation = computed(() => {
  if (parsed.value.error) return parsed.value.error;
  try {
    normalizeSchema(parsed.value.value);
    return "";
  } catch (e) {
    return e instanceof Error ? e.message : "规范无效";
  }
});
const fieldsAvailable = computed(
  () => !validation.value && schemaFields(parsed.value.value) !== undefined,
);
const valid = computed(
  () => mode.value !== "json" || (!validation.value && !rowError.value),
);
watch(valid, (v) => emit("valid", v), { immediate: true, flush: "sync" });
// Parent v-model updates arrive on the next render, not inside the setter.
// Ignore our own canonical echo so valid keystrokes do not reformat the source,
// reset field rows or move the cursor.
let lastEmitted: string | undefined;
function commit(value: Contract) {
  lastEmitted = JSON.stringify(value);
  output.value = value;
}
watch(
  () => output.value,
  (v) => {
    if (lastEmitted !== undefined && JSON.stringify(v) === lastEmitted) return;
    if (v?.mode === "json") {
      source.value = JSON.stringify(v.schema, null, 2);
      lastSchema.value = normalizeSchema(v.schema);
    }
    else if (!source.value)
      source.value = JSON.stringify(EMPTY_OUTPUT_SCHEMA, null, 2);
    rowError.value = "";
    if (view.value === "fields")
      rows.value =
        schemaFields(v?.mode === "json" ? v.schema : parsed.value.value) ?? [];
  },
  { immediate: true, flush: "sync" },
);
function applySchema(schema: unknown) {
  const normalized = normalizeSchema(schema);
  lastSchema.value = normalized;
  commit({ mode: "json", schema: normalized });
}
watch(source, () => {
  rowError.value = "";
  if (mode.value === "json" && !validation.value)
    applySchema(parsed.value.value);
});
function setMode(value: string | number | boolean) {
  if (value === "text") {
    rowError.value = "";
    commit({ mode: "text" });
    return;
  }
  if (!validation.value) applySchema(parsed.value.value);
  else commit({ mode: "json", schema: lastSchema.value });
}
function schemaMessage(value: unknown) {
  try {
    normalizeSchema(value);
    return undefined;
  } catch (e) {
    return e instanceof Error ? e.message : "规范无效";
  }
}
function setView(value: string | number | boolean) {
  if (rowError.value) {
    ElMessage.warning("请先修正字段错误，避免丢失未完成的编辑");
    return;
  }
  if (value === "fields") {
    if (validation.value) return;
    const fields = schemaFields(parsed.value.value);
    if (!fields) return;
    rows.value = fields;
    rowError.value = "";
  }
  view.value = String(value);
}
function updateRows() {
  try {
    const next = fieldsSchema(parsed.value.value, rows.value);
    rowError.value = "";
    source.value = JSON.stringify(next, null, 2);
    applySchema(next);
  } catch (e) {
    rowError.value = e instanceof Error ? e.message : "字段或枚举格式无效";
  }
}
function addFollowUpsField() {
  if (props.disabled || !fieldsAvailable.value || followUpsConfigured.value) return;
  try {
    rows.value = schemaFields(parsed.value.value) ?? [];
    addSuggestedFollowUpsField(rows.value);
    updateRows();
  } catch (e) {
    rowError.value = e instanceof Error ? e.message : "无法添加追问字段";
  }
}
async function replace(schema: unknown, title: string) {
  const normalized = normalizeSchema(schema);
  try {
    await ElMessageBox.confirm(
      "将替换当前输出规范，其他 Agent 配置保持不变。",
      title,
      { type: "warning", confirmButtonText: "替换", cancelButtonText: "取消" },
    );
  } catch {
    return;
  }
  rowError.value = "";
  source.value = JSON.stringify(normalized, null, 2);
  applySchema(normalized);
  view.value = "source";
}
async function importSchema(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  try {
    if (
      !file ||
      !file.name.endsWith(".schema.json") ||
      file.size > 48_000
    )
      throw new Error(
        "请选择不超过 48 KB 的 .schema.json 文件（规范最多 12000 字符）",
      );
    const result = parseJson(await file.text());
    if (result.error) throw new Error(result.error);
    await replace(normalizeSchema(result.value), "导入输出规范");
  } catch (e) {
    ElMessage.error(
      e instanceof Error ? e.message : "导入失败，未替换当前规范",
    );
  } finally { input.value = ""; }
}
function exportSchema() {
  const blob = new Blob(
      [JSON.stringify(normalizeSchema(parsed.value.value), null, 2)],
      { type: "application/json" },
    ),
    url = URL.createObjectURL(blob),
    a = document.createElement("a");
  a.href = url;
  a.download = "agent-output.schema.json";
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
async function copy() {
  try {
    await navigator.clipboard.writeText(source.value);
    ElMessage.success("已复制");
  } catch {
    ElMessage.error("复制失败，可在源码中手动选择复制");
  }
}
function sample() {
  sampleOpen.value = true;
  sampleResult.value = "";
  const example = schemaExample(parsed.value.value);
  sampleText.value =
    example === undefined ? "" : JSON.stringify(example, null, 2);
  if (example === undefined)
    sampleResult.value = "此规范未能生成合规示例，请手动填写 JSON 进行校验。";
}
function checkSample() {
  if (!valid.value) { sampleResult.value = "Schema 规则尚未通过，请先修正规范。"; return; }
  const data = parseJson(sampleText.value);
  if (data.error) {
    sampleResult.value = "示例 JSON 语法错误：" + data.error;
    return;
  }
  const issues = validateStructured(parsed.value.value, data.value);
  sampleResult.value = issues.length
    ? "示例数据不符合规则：" + issues.map((i) => `${i.path}: ${i.message}`).join("；")
    : "校验通过";
}
</script>
<template>
  <section class="space-y-4">
    <ElFormItem label="输出方式"
      ><ElSegmented
        :model-value="mode"
        :disabled="disabled"
        :options="[
          { label: '文本', value: 'text' },
          { label: '结构化 JSON', value: 'json' },
        ]"
        @change="setMode"
    /></ElFormItem>
    <ElAlert
      v-if="!output"
      type="info"
      :closable="false"
      title="此历史版本尚未配置输出规范，继续兼容调用方传入的 outputSchema；选择输出方式后由 Agent 统一管理。"
      ><ElButton v-if="!disabled" link type="primary" @click="setMode('text')"
        >使用文本规范</ElButton
      ></ElAlert
    >
    <template v-if="mode === 'json'">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <ElSegmented
          :model-value="view"
          :options="[
            { label: '字段', value: 'fields', disabled: !fieldsAvailable },
            { label: '源码', value: 'source' },
          ]"
          @change="setView"
        />
        <div class="flex flex-wrap gap-2">
          <ElButton
            v-if="!disabled && !followUpsConfigured"
            link
            type="primary"
            :disabled="!fieldsAvailable"
            @click="addFollowUpsField"
          >添加“你可能还想问”字段</ElButton>
          <ElButton type="primary" :disabled="!valid" @click="sample">示例与校验</ElButton>
          <ElDropdown trigger="click">
            <ElButton>更多</ElButton>
            <template #dropdown><ElDropdownMenu>
              <ElDropdownItem @click="copy">复制源码</ElDropdownItem>
              <ElDropdownItem :disabled="disabled" @click="importInput?.click()">导入 Schema</ElDropdownItem>
              <ElDropdownItem :disabled="!valid" @click="exportSchema">导出 Schema</ElDropdownItem>
            </ElDropdownMenu></template>
          </ElDropdown>
          <HelpTip long text="规范定义 structured 数据字段；回答正文、引用和用量不受影响。可选的 suggestedFollowUps 字符串数组会显示为回复后的追问建议。只开放当前后端支持的 JSON Schema 子集。字段描述会传给模型。" />
          <input ref="importInput" class="hidden" type="file" accept=".schema.json" :disabled="disabled" @change="importSchema" />
        </div>
      </div>
      <div class="flex flex-wrap gap-x-5 gap-y-1 text-sm" role="status">
        <span>JSON 语法：{{ parsed.error ? '存在错误' : '正确' }}</span>
        <span>Schema 规则：{{ rowError || validation ? '存在错误' : '有效' }}</span>
      </div>
      <ElAlert v-if="!valid" type="error" :closable="false" title="存在错误，尚未保存" :description="rowError || validation" />
      <div v-show="view === 'source'">
        <JsonEditor
          v-model="source"
          :readonly="disabled"
          :height="340"
          label="structured JSON Schema"
          kind="object"
          :validate-value="schemaMessage"
        />
      </div>
      <OutputFieldTree v-if="view === 'fields'" :rows="rows" :disabled="disabled" @change="updateRows" />
    </template>
    <p v-else class="text-sm text-muted-foreground">
      使用自然语言回答，不强制 structured 字段。发布后对新请求生效。
    </p>
    <ElDialog
      class="management-dialog"
      body-class="management-dialog-body"
      header-class="management-dialog-header"
      footer-class="management-dialog-footer"
      v-model="sampleOpen"
      title="示例与 JSON 校验"
      width="min(720px,95vw)"
      append-to-body
      destroy-on-close
    >
      <div class="space-y-4">
        <p class="text-sm text-muted-foreground">
          JSON 语法正确 → Schema 规则有效 → 示例数据符合规则。校验在本地完成，不调用模型。
        </p>
        <JsonEditor
          v-model="sampleText"
          label="structured 示例"
          :height="300"
        />
        <ElAlert
          v-if="sampleResult"
          :type="sampleResult === '校验通过' ? 'success' : 'warning'"
          :title="sampleResult"
          :closable="false"
        />
      </div>
      <template #footer
        ><ElButton @click="sampleOpen = false">关闭</ElButton
        ><ElButton type="primary" @click="checkSample"
          >校验 JSON</ElButton
        ></template
      >
    </ElDialog>
  </section>
</template>
