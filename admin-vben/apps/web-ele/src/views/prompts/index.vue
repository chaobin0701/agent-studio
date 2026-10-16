<script setup lang="ts">
import {
  computed,
  defineAsyncComponent,
  ref,
  watch,
  onBeforeUnmount,
} from "vue";
import { useRoute, useRouter } from "vue-router";
import { Page } from "@vben/common-ui";
import { useAccessStore } from "@vben/stores";
import {
  type FormInstance,
  type FormRules,
  ElTable,
  ElTableColumn,
  ElButton,
  ElDialog,
  ElForm,
  ElFormItem,
  ElInput,
  ElInputNumber,
  ElSelect,
  ElOption,
  ElTabs,
  ElTabPane,
  ElMessage,
  ElAlert,
  ElSwitch,
  ElTag,
  ElCollapse,
  ElCollapseItem,
  ElScrollbar,
} from "element-plus";
import { useUnsavedChanges } from "#/composables/use-unsaved-changes";
import { managementApi as api } from "#/api/management";
import PagePanel from "#/components/PagePanel.vue";
import ManagementHeader from "#/components/ManagementHeader.vue";
import {
  createDraftQueue,
  type DraftSaveState,
} from "#/composables/draft-queue";
import HelpTip from "#/components/HelpTip.vue";
import { newResourceKey } from "#/components/create-resource-key";
import JsonEditor from "#/components/JsonEditor.vue";
import { sameJson, validateJson } from "#/components/json-validation";
import { isBusinessPrompt } from "./prompt-visibility";
const PromptDiff = defineAsyncComponent(
  () => import("./components/PromptDiff.vue"),
);
function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}
type Definition = {
  type: "string" | "number" | "boolean" | "object" | "array";
  required: boolean;
  description?: string;
};
const route = useRoute(),
  router = useRouter(),
  access = useAccessStore();
const canManage = computed(() => access.accessCodes.includes("prompts.manage"));
const list = ref<any[]>([]),
  detail = ref<any>(),
  selected = ref<number>(),
  loading = ref(false),
  busy = ref(false),
  failed = ref(false),
  actionError = ref(""),
  tab = ref("editor"),
  internalTemplate = ref(false),
  search = ref("");
const createOpen = ref(false),
  createForm = ref({ name: "", description: "", promptKey: "", template: "" });
const createFormRef = ref<FormInstance>(),
  generatedCreateKey = ref(""),
  createBaseline = ref("");
const createDirty = computed(
  () =>
    createOpen.value &&
    JSON.stringify(createForm.value) !== createBaseline.value,
);
const discardCreation = useUnsavedChanges(createDirty);
const createRules: FormRules = {
  name: [
    {
      required: true,
      whitespace: true,
      message: "请输入名称",
      trigger: "blur",
    },
    { max: 160, message: "名称最多 160 字符", trigger: "blur" },
  ],
  promptKey: [
    {
      validator: (_rule, value, callback) =>
        callback(
          !value.trim() || /^[a-z][a-z0-9._-]{2,159}$/.test(value.trim())
            ? undefined
            : new Error(
                "使用小写字母、数字、点、下划线或短横线，以字母开头，长度 3–160 字符",
              ),
        ),
      trigger: "blur",
    },
  ],
};
function openCreate() {
  if (busy.value) return;
  createForm.value = { name: "", description: "", promptKey: "", template: "" };
  generatedCreateKey.value = newResourceKey("prompt");
  createBaseline.value = JSON.stringify(createForm.value);
  createFormRef.value?.clearValidate();
  actionError.value = "";
  createOpen.value = true;
}
async function closeCreate(done?: () => void) {
  if (busy.value || !(await discardCreation())) return;
  if (busy.value) return;
  createOpen.value = false;
  done?.();
}
const template = ref(""),
  definitions = ref<Record<string, Definition>>({}),
  variablesJson = ref("{}"),
  variableError = ref(""),
  original = ref("");
const active = computed(() =>
  detail.value?.versions.find((v: any) => v.versionId === selected.value),
);
const snapshot = () =>
  JSON.stringify([template.value, definitions.value, variablesJson.value]);
const dirty = computed(
  () => active.value?.status === "draft" && snapshot() !== original.value,
);
const editable = computed(
  () =>
    canManage.value &&
    !detail.value?.archivedAt &&
    active.value?.status === "draft",
);
const saveState = ref<DraftSaveState>({
  saving: false,
  error: "",
  conflict: false,
});
const historyOpen = ref(false),
  historyTab = ref("history");
const draftQueue = createDraftQueue({
  read: () =>
    editable.value &&
    dirty.value &&
    !busy.value &&
    !variableError.value &&
    !publishOpen.value
      ? {
          identity: String(selected.value),
          revision: active.value.revision,
          payload: snapshot(),
        }
      : undefined,
  write: (draft) => {
    const [body, variables] = JSON.parse(draft.payload);
    return api.patch(`/prompts/versions/${draft.identity}`, {
      template: body,
      variables,
      changeNote: active.value.changeNote ?? "",
      expectedRevision: draft.revision,
    });
  },
  accept: (draft, saved) => {
    if (
      String(selected.value) !== draft.identity ||
      active.value?.status !== "draft"
    )
      return;
    const [body, variables] = JSON.parse(draft.payload);
    active.value.revision = saved.revision;
    active.value.template = body;
    active.value.variables = variables;
    original.value = draft.payload;
  },
  state: (value) => {
    saveState.value = value;
  },
});
async function flushDraft() {
  if (variableError.value) return false;
  return (await draftQueue.flush()) && !dirty.value;
}
const leave = useUnsavedChanges(
  computed(() => dirty.value || saveState.value.saving),
  flushDraft,
);
onBeforeUnmount(draftQueue.dispose);
const variableNames = computed(() => [
  ...new Set(
    [
      ...template.value.matchAll(
        /\{\{\s*([a-zA-Z][a-zA-Z0-9_.-]{0,79})\s*\}\}/g,
      ),
    ].map((m) => m[1]!),
  ),
]);
const variableRows = computed(() =>
  Object.entries(definitions.value).map(([name, value]) => ({ name, value })),
);
const agentWarning = computed(
  () =>
    variableNames.value.length > 0 ||
    template.value.length > 24000 ||
    Object.values(definitions.value).some((d) => d.required),
);
const visible = computed(() =>
  list.value.filter(
    (p) =>
      isBusinessPrompt(p) &&
      `${p.name} ${p.promptKey} ${p.description}`
        .toLowerCase()
        .includes(search.value.toLowerCase()),
  ),
);
const values = ref<Record<string, any>>({}),
  jsonInput = ref("{}"),
  inputMode = ref("form"),
  rendered = ref(""),
  renderSignature = ref(""),
  renderedOnce = ref(false),
  renderError = ref(""),
  fieldErrors = ref<Record<string, string>>({});
const previewSnapshot = () =>
  JSON.stringify([
    snapshot(),
    inputMode.value,
    inputMode.value === "json" ? jsonInput.value : values.value,
  ]);
const previewStale = computed(
  () => renderedOnce.value && previewSnapshot() !== renderSignature.value,
);
const outputLines = computed(() => rendered.value.split("\n").slice(0, 5000));
const left = ref<number>(),
  right = ref<number>(),
  compared = ref<any>(),
  compareCurrent = ref(false);
const review = ref<any>(),
  publishOpen = ref(false),
  publishPayload = ref<any>(),
  changeNote = ref(""),
  usage = ref<any[]>([]);
const statusLabel = (status: string) =>
  status === "draft" ? "草稿" : "已发布";
const versionLabel = (v: any) =>
  `v${v?.version ?? "—"} · ${statusLabel(v?.status)}`;
function message(e: any) {
  const response = e?.response?.data;
  return (
    response?.error?.message ??
    response?.message ??
    e?.message ??
    "操作失败，请重试"
  );
}
async function run(task: () => Promise<unknown>) {
  busy.value = true;
  actionError.value = "";
  try {
    await task();
  } catch (e) {
    actionError.value = message(e);
  } finally {
    busy.value = false;
  }
}
function adopt() {
  draftQueue.reset();
  const v = active.value;
  template.value = v?.template ?? "";
  definitions.value = cloneJson(v?.variables ?? {});
  variablesJson.value = JSON.stringify(definitions.value, null, 2);
  variableError.value = "";
  original.value = snapshot();
  rendered.value = "";
  renderedOnce.value = false;
  renderError.value = "";
  fieldErrors.value = {};
  compared.value = undefined;
  compareCurrent.value = false;
  values.value = {};
  jsonInput.value = "{}";
  usage.value = [];
  review.value = undefined;
  changeNote.value = "";
  const source =
    detail.value?.versions.find(
      (x: any) => x.versionId === v?.sourceVersionId,
    ) ??
    detail.value?.versions.find(
      (x: any) =>
        x.status === "published" && x.version < (v?.version ?? Infinity),
    );
  left.value = source?.versionId ?? v?.versionId;
  right.value = v?.versionId;
}
let loadRequest = 0;
async function load(preferred?: number) {
  const request = ++loadRequest,
    id = route.params.id;
  loading.value = true;
  failed.value = false;
  internalTemplate.value = false;
  try {
    if (id) {
      let result = await api.get(`/prompts/${id}`);
      if (
        !preferred &&
        canManage.value &&
        !result.archivedAt &&
        isBusinessPrompt(result) &&
        !result.versions.some((v: any) => v.status === "draft") &&
        result.versions.length
      ) {
        await api.post(
          `/prompts/versions/${result.versions[0].versionId}/draft`,
        );
        result = await api.get(`/prompts/${id}`);
      }
      if (request !== loadRequest) return;
      if (!isBusinessPrompt(result)) {
        detail.value = undefined;
        selected.value = undefined;
        internalTemplate.value = true;
        return;
      }
      detail.value = result;
      selected.value = preferred ?? result.versions[0]?.versionId;
      adopt();
      const references = await api.get(`/prompts/${id}/usage`);
      if (request === loadRequest) usage.value = references;
    } else {
      const result = await api.get("/prompts");
      if (request === loadRequest) list.value = result;
    }
  } catch {
    if (request === loadRequest) failed.value = true;
  } finally {
    if (request === loadRequest) loading.value = false;
  }
}
async function refresh() {
  if (await leave()) await load(selected.value);
}
async function selectVersion(id: number) {
  if (await leave()) {
    await run(async () => {
      selected.value = id;
      adopt();
      const target = detail.value.id;
      const references = await api.get(`/prompts/${target}/usage`);
      if (target === detail.value?.id) usage.value = references;
    });
  }
}
function syncVariables() {
  definitions.value = Object.fromEntries(
    variableNames.value.map((name) => [
      name,
      (Object.hasOwn(definitions.value, name)
        ? definitions.value[name]
        : undefined) ?? {
        type: "string",
        required: true,
        description: "",
      },
    ]),
  );
  variablesJson.value = JSON.stringify(definitions.value, null, 2);
  variableError.value = "";
}
function importVariables() {
  try {
    const result = JSON.parse(variablesJson.value);
    if (!result || Array.isArray(result) || typeof result !== "object")
      throw new Error("变量声明必须为 JSON 对象");
    for (const [name, def] of Object.entries(result) as [string, any][])
      if (
        !/^[a-zA-Z][a-zA-Z0-9_.-]{0,79}$/.test(name) ||
        !def ||
        !["string", "number", "boolean", "object", "array"].includes(
          def.type,
        ) ||
        typeof def.required !== "boolean"
      )
        throw new Error(`变量 ${name} 的声明无效`);
    if (JSON.stringify(definitions.value) !== JSON.stringify(result))
      definitions.value = result;
    variableError.value = "";
  } catch (e) {
    variableError.value = message(e);
  }
}
async function create() {
  if (busy.value) return;
  const path = route.fullPath;
  if (!(await createFormRef.value?.validate().catch(() => false))) return;
  if (busy.value || route.fullPath !== path || !createOpen.value) return;
  await run(async () => {
    const { promptKey, ...body } = createForm.value;
    const r = await api.post("/prompts", {
      ...body,
      name: body.name.trim(),
      promptKey: promptKey.trim() || generatedCreateKey.value,
    });
    if (route.fullPath !== path) return;
    createOpen.value = false;
    createForm.value = {
      name: "",
      description: "",
      promptKey: "",
      template: "",
    };
    await router.push(`/prompts/${r.id}`);
  });
}
async function save() {
  if (await flushDraft()) ElMessage.success("草稿已保存");
}
async function editDraft() {
  if (!(await leave())) return;
  await run(async () => {
    const r = await api.post(`/prompts/versions/${selected.value}/draft`);
    await load(r.versionId);
    tab.value = "editor";
    ElMessage.success(
      r.reused ? "已打开现有草稿" : "已准备新草稿，已发布内容保持不变",
    );
  });
}
async function reviewPublish() {
  if (!(await flushDraft())) return;
  if (variableError.value) return ElMessage.warning("请修正变量声明");
  await run(async () => {
    const body = {
      template: template.value,
      variables: cloneJson(definitions.value),
      expectedRevision: active.value.revision,
    };
    review.value = await api.post(
      `/prompts/versions/${selected.value}/review`,
      body,
    );
    publishPayload.value = {
      ...body,
      reviewHash: review.value.reviewHash,
      versionId: selected.value,
    };
    changeNote.value ||=
      active.value.changeNote === "初始草稿"
        ? review.value.suggestedNote
        : active.value.changeNote || review.value.suggestedNote;
    publishOpen.value = true;
  });
}
async function publish() {
  if (
    JSON.stringify([template.value, definitions.value]) !==
    JSON.stringify([
      publishPayload.value?.template,
      publishPayload.value?.variables,
    ])
  )
    return ElMessage.warning("编辑内容已变化，请返回编辑并重新审阅后发布");
  if (!changeNote.value.trim()) return ElMessage.warning("请填写本次变更说明");
  await run(async () => {
    const { versionId, ...body } = publishPayload.value;
    await api.post(`/prompts/versions/${versionId}/publish`, {
      ...body,
      changeNote: changeNote.value.trim(),
    });
    publishOpen.value = false;
    original.value = snapshot();
    await load(versionId);
    ElMessage.success("版本已发布，已有 Agent 的引用保持不变");
  });
}
function testValues() {
  if (inputMode.value === "json") {
    const parsed = JSON.parse(jsonInput.value);
    if (!parsed || Array.isArray(parsed) || typeof parsed !== "object")
      throw new Error("测试变量必须为 JSON 对象");
    return parsed;
  }
  const result: Record<string, unknown> = {};
  fieldErrors.value = {};
  for (const [name, def] of Object.entries(definitions.value)) {
    const value = values.value[name];
    if (value === undefined || value === null || value === "") {
      if (def.required) fieldErrors.value[name] = "请填写必填变量";
      continue;
    }
    try {
      if (def.type === "object" || def.type === "array") {
        const parsed = validateJson(value, def.type);
        if (!parsed.ok) throw new Error(parsed.message);
        result[name] = parsed.value;
      } else result[name] = value;
    } catch {
      fieldErrors.value[name] = "请输入有效 JSON";
    }
  }
  if (Object.keys(fieldErrors.value).length)
    throw new Error("请修正标记的测试变量");
  return result;
}
async function render() {
  renderedOnce.value = false;
  renderError.value = "";
  fieldErrors.value = {};
  if (variableError.value) {
    renderError.value = variableError.value;
    return;
  }
  await run(async () => {
    try {
      const data = {
          template: template.value,
          variables: cloneJson(definitions.value),
          values: testValues(),
        },
        signature = previewSnapshot(),
        target = detail.value.id;
      const r = await api.post(`/prompts/${target}/preview`, data);
      if (target !== detail.value?.id) return;
      rendered.value = r.text;
      renderSignature.value = signature;
      renderedOnce.value = true;
    } catch (e) {
      renderError.value = message(e);
      for (const name of Object.keys(definitions.value))
        if (renderError.value.includes(name))
          fieldErrors.value[name] = renderError.value;
    }
  });
}
async function copyOutput() {
  try {
    await navigator.clipboard.writeText(rendered.value);
    ElMessage.success("已复制");
  } catch {
    ElMessage.error("复制失败，请手动选择文本");
  }
}
async function compare() {
  if (!left.value || (!right.value && !compareCurrent.value))
    return ElMessage.warning("请选择比较版本");
  await run(async () => {
    if (compareCurrent.value) {
      const v = detail.value.versions.find(
        (x: any) => x.versionId === left.value,
      );
      compared.value = {
        left: v,
        right: {
          version: active.value.version,
          template: template.value,
          variables: cloneJson(definitions.value),
        },
      };
    } else
      compared.value = await api.get(
        `/prompts/versions/${left.value}/diff/${right.value}`,
      );
  });
}
watch(
  () => route.params.id,
  () => {
    draftQueue.reset();
    detail.value = undefined;
    selected.value = undefined;
    publishOpen.value = false;
    tab.value = "editor";
    void load();
  },
  { immediate: true },
);
watch(snapshot, () => draftQueue.schedule());
watch(publishOpen, (open) => {
  if (!open) draftQueue.schedule();
});
watch(
  definitions,
  () => {
    if (
      !variableError.value &&
      !sameJson(variablesJson.value, definitions.value)
    )
      variablesJson.value = JSON.stringify(definitions.value, null, 2);
  },
  { deep: true },
);
</script>
<template>
  <Page>
    <ManagementHeader :title="detail?.name || 'Prompt 管理'">
      <ElButton v-if="route.params.id" @click="router.push('/prompts')"
        >返回列表</ElButton
      >
      <ElButton :disabled="busy || saveState.saving" @click="refresh"
        >刷新</ElButton
      >
      <ElButton
        v-if="canManage && !route.params.id"
        type="primary"
        @click="openCreate"
        >新建 Prompt</ElButton
      >
    </ManagementHeader>
    <ElAlert
      v-if="saveState.error"
      class="mb-4"
      type="error"
      :closable="false"
      :title="saveState.error"
      ><ElButton v-if="!saveState.conflict" size="small" @click="save"
        >重试保存</ElButton
      ><span v-else
        >内容保留在页面，请刷新核对他人的修改后再编辑。</span
      ></ElAlert
    >
    <ElAlert
      v-if="internalTemplate"
      title="这是系统内部模板，不在业务提示词管理中展示。请返回列表选择业务提示词。"
      type="info"
      :closable="false"
      class="mb-3"
    />
    <ElAlert
      v-if="failed"
      title="加载失败，请刷新重试"
      type="error"
      :closable="false"
      class="mb-3"
    /><ElAlert
      v-if="actionError"
      :title="actionError"
      type="error"
      :closable="false"
      class="mb-3"
    />
    <PagePanel v-if="!route.params.id" v-loading="loading"
      ><div class="mb-4 flex flex-wrap gap-3">
        <ElInput
          v-model="search"
          class="max-w-sm"
          placeholder="搜索名称、Key 或描述"
          clearable
        />
      </div>
      <ElTable :data="visible"
        ><ElTableColumn label="提示词"
          ><template #default="{ row }"
            ><ElButton
              link
              type="primary"
              @click="router.push(`/prompts/${row.id}`)"
              >{{ row.name }}</ElButton
            ></template
          ></ElTableColumn
        ><ElTableColumn
          prop="description"
          label="描述"
          show-overflow-tooltip /><ElTableColumn label="最新发布"
          ><template #default="{ row }">{{
            row.publishedVersion ? `v${row.publishedVersion}` : "尚未发布"
          }}</template></ElTableColumn
        ><ElTableColumn label="草稿"
          ><template #default="{ row }">{{
            row.draftVersion ? `v${row.draftVersion}` : "无"
          }}</template></ElTableColumn
        ><ElTableColumn
          prop="promptKey"
          label="稳定 Key"
          show-overflow-tooltip /></ElTable
    ></PagePanel>
    <PagePanel v-else-if="detail" v-loading="loading || busy" class="space-y-4">
      <div class="flex flex-wrap items-center justify-between gap-3">
        <div class="flex items-center gap-2">
          <ElTag>{{ statusLabel(active?.status) }}</ElTag
          ><span class="text-sm text-muted-foreground">{{
            saveState.saving
              ? "正在保存…"
              : dirty
                ? "待保存"
                : editable
                  ? "草稿已保存，发布后可被 Agent 选择"
                  : "只读发布版本"
          }}</span>
        </div>
        <div class="flex flex-wrap gap-2">
          <ElButton
            v-if="canManage && !detail?.archivedAt && !editable"
            :disabled="busy"
            @click="editDraft"
            >编辑配置</ElButton
          ><ElButton :disabled="busy" @click="historyOpen = true"
            >历史与引用</ElButton
          ><ElButton
            v-if="editable"
            type="primary"
            :disabled="busy || saveState.conflict"
            @click="reviewPublish"
            >发布</ElButton
          >
        </div>
      </div>
      <ElTabs v-model="tab">
        <ElTabPane label="内容" name="editor"
          ><ElForm label-position="top"
            ><ElFormItem label="提示词正文"
              ><ElInput
                v-model="template"
                type="textarea"
                :rows="18"
                maxlength="100000"
                show-word-limit
                :readonly="!editable" /></ElFormItem
            ><ElAlert
              v-if="agentWarning"
              title="此模板包含变量或正文超过 24000 字，目前不能直接作为 Agent 业务提示词。可预览测试，变量运行时接入留待后续。"
              type="warning"
              :closable="false"
              class="mb-4" />
            <div class="mb-3 flex items-center gap-3">
              <span>模板变量</span
              ><HelpTip
                text="普通 Agent 业务指导建议直接写正文，不需要声明变量。若正文包含 {{变量名}}，可以识别后调整类型及必填规则。"
                long
              /><ElButton v-if="editable" size="small" @click="syncVariables"
                >从正文识别变量</ElButton
              >
            </div>
            <ElTable v-if="variableRows.length" :data="variableRows"
              ><ElTableColumn prop="name" label="变量名" /><ElTableColumn
                label="类型"
                ><template #default="{ row }"
                  ><ElSelect v-model="row.value.type" :disabled="!editable"
                    ><ElOption
                      v-for="type in [
                        'string',
                        'number',
                        'boolean',
                        'object',
                        'array',
                      ]"
                      :key="type"
                      :value="type"
                      :label="type" /></ElSelect></template></ElTableColumn
              ><ElTableColumn label="必填" width="85"
                ><template #default="{ row }"
                  ><ElSwitch
                    v-model="row.value.required"
                    :disabled="!editable" /></template></ElTableColumn
              ><ElTableColumn label="说明"
                ><template #default="{ row }"
                  ><ElInput
                    v-model="row.value.description"
                    maxlength="500"
                    :readonly="!editable" /></template></ElTableColumn
            ></ElTable>
            <p v-else class="mb-3 text-sm text-muted-foreground">
              无变量，预览直接展示正文。
            </p>
            <ElCollapse class="my-4"
              ><ElCollapseItem title="高级信息与变量 JSON" name="advanced"
                ><p class="mb-3 break-all">稳定 Key：{{ detail.promptKey }}</p>
                <JsonEditor
                  v-model="variablesJson"
                  label="Prompt 变量声明"
                  kind="object"
                  :height="220"
                  :readonly="!editable"
                  @parsed="importVariables"
                  @error="
                    (value) => {
                      if (value) variableError = value;
                    }
                  " /><ElAlert
                  v-if="variableError"
                  :title="variableError"
                  type="error"
                  :closable="false"
                  class="mt-2" /></ElCollapseItem></ElCollapse></ElForm
        ></ElTabPane>
        <ElTabPane label="预览与测试" name="render"
          ><div class="grid grid-cols-1 gap-6 lg:grid-cols-2">
            <div>
              <div class="mb-3 flex flex-wrap items-center gap-3">
                <ElTag :type="dirty ? 'warning' : 'info'">{{
                  dirty ? "未保存预览" : versionLabel(active)
                }}</ElTag
                ><ElSelect
                  v-if="variableRows.length"
                  v-model="inputMode"
                  class="w-40"
                  ><ElOption value="form" label="变量表单" /><ElOption
                    value="json"
                    label="JSON 输入"
                /></ElSelect>
              </div>
              <ElForm
                v-if="inputMode === 'form' && variableRows.length"
                label-position="top"
                ><ElFormItem
                  v-for="row in variableRows"
                  :key="row.name"
                  :label="`${row.name}${row.value.description ? ' · ' + row.value.description : ''}`"
                  :required="row.value.required"
                  :error="fieldErrors[row.name]"
                  ><ElInputNumber
                    v-if="row.value.type === 'number'"
                    v-model="values[row.name]" /><ElSelect
                    v-else-if="row.value.type === 'boolean'"
                    v-model="values[row.name]"
                    clearable
                    ><ElOption :value="true" label="true" /><ElOption
                      :value="false"
                      label="false" /></ElSelect
                  ><JsonEditor
                    v-else-if="
                      row.value.type === 'object' || row.value.type === 'array'
                    "
                    v-model="values[row.name]"
                    :kind="row.value.type"
                    :allow-empty="!row.value.required"
                    :label="`${row.name} 测试值`"
                    :height="160" /><ElInput
                    v-else
                    v-model="values[row.name]"
                    type="textarea"
                    :rows="3"
                    placeholder="输入测试值" /></ElFormItem></ElForm
              ><JsonEditor
                v-else-if="variableRows.length"
                v-model="jsonInput"
                kind="object"
                label="测试变量 JSON"
              />
              <p v-else class="mb-3 text-sm text-muted-foreground">
                无须提供变量，点击预览即可检查当前正文。
              </p>
              <ElButton type="primary" :loading="busy" @click="render"
                >生成预览</ElButton
              ><HelpTip
                text="仅检查正文和变量替换，不调用大模型。回答效果请在 Agent 调试中验证。"
                long
              /><ElAlert
                v-if="renderError"
                :title="renderError"
                type="error"
                :closable="false"
                class="mt-3"
              />
            </div>
            <div>
              <div class="mb-3 flex items-center gap-3">
                <span>渲染结果</span
                ><ElTag v-if="renderedOnce">{{ rendered.length }} 字符</ElTag
                ><ElTag v-if="previewStale" type="warning"
                  >结果已过期，请重新生成</ElTag
                ><ElButton
                  v-if="renderedOnce"
                  class="ml-auto"
                  @click="copyOutput"
                  >复制</ElButton
                >
              </div>
              <ElScrollbar
                v-if="renderedOnce"
                max-height="60vh"
                class="rounded border p-3"
                ><div
                  v-for="(line, index) in outputLines"
                  :key="index"
                  class="flex gap-3"
                >
                  <span
                    class="w-10 shrink-0 select-none text-right text-xs text-muted-foreground"
                    >{{ index + 1 }}</span
                  >
                  <pre
                    class="min-w-0 whitespace-pre-wrap break-words font-mono text-sm"
                    >{{ line || " " }}</pre
                  >
                </div></ElScrollbar
              >
              <p v-else class="text-sm text-muted-foreground">
                生成后在这里展示，不会保存为版本内容。
              </p>
              <p v-if="rendered.split('\n').length > 5000" class="mt-2 text-sm">
                仅展示前 5000 行，复制包含完整内容。
              </p>
            </div>
          </div></ElTabPane
        >
      </ElTabs>
    </PagePanel>
    <ElDialog
      class="management-dialog"
      body-class="management-dialog-body"
      header-class="management-dialog-header"
      footer-class="management-dialog-footer"
      append-to-body
      v-model="historyOpen"
      title="历史版本与引用"
      width="min(1000px,95vw)"
    >
      <ElSelect
        :model-value="selected"
        class="mb-4 w-full sm:w-72"
        :disabled="busy || saveState.saving"
        @change="selectVersion"
        ><ElOption
          v-for="v in detail?.versions ?? []"
          :key="v.versionId"
          :value="v.versionId"
          :label="versionLabel(v)"
      /></ElSelect>
      <ElTabs v-if="detail" v-model="historyTab">
        <ElTabPane label="版本对比" name="diff"
          ><div class="mb-4 flex flex-wrap items-center gap-3">
            <ElSelect v-model="left" placeholder="旧版本"
              ><ElOption
                v-for="v in detail.versions"
                :key="v.versionId"
                :value="v.versionId"
                :label="versionLabel(v)" /></ElSelect
            ><span>→</span
            ><ElSelect
              v-model="right"
              :disabled="compareCurrent"
              placeholder="新版本"
              ><ElOption
                v-for="v in detail.versions"
                :key="v.versionId"
                :value="v.versionId"
                :label="versionLabel(v)" /></ElSelect
            ><ElSwitch
              v-if="editable"
              v-model="compareCurrent"
              active-text="当前编辑内容"
            /><ElButton @click="compare">比较</ElButton>
          </div>
          <template v-if="compared"
            ><PromptDiff
              :left="compared.left.template"
              :right="compared.right.template"
              :left-label="`v${compared.left.version}`"
              :right-label="
                compareCurrent ? '当前编辑' : `v${compared.right.version}`
              " /><ElCollapse class="mt-4"
              ><ElCollapseItem title="变量定义差异" name="variables"
                ><PromptDiff
                  :left="JSON.stringify(compared.left.variables ?? {}, null, 2)"
                  :right="
                    JSON.stringify(compared.right.variables ?? {}, null, 2)
                  " /></ElCollapseItem></ElCollapse></template
        ></ElTabPane>
        <ElTabPane label="版本记录与引用" name="history"
          ><ElTable :data="detail.versions"
            ><ElTableColumn label="版本" width="85"
              ><template #default="{ row }"
                >v{{ row.version }}</template
              ></ElTableColumn
            ><ElTableColumn label="状态"
              ><template #default="{ row }">{{
                statusLabel(row.status)
              }}</template></ElTableColumn
            ><ElTableColumn prop="changeNote" label="变更说明" /><ElTableColumn
              prop="publishedBy"
              label="发布人"
            /><ElTableColumn label="发布时间"
              ><template #default="{ row }">{{
                row.publishedAt
                  ? new Date(row.publishedAt).toLocaleString()
                  : "—"
              }}</template></ElTableColumn
            ></ElTable
          >
          <h3 class="my-4">Agent 引用（新版本发布不会自动替换）</h3>
          <ElTable :data="usage" empty-text="暂无 Agent 引用"
            ><ElTableColumn prop="name" label="Agent" /><ElTableColumn
              label="Agent 版本"
              ><template #default="{ row }"
                >v{{ row.version }} · {{ statusLabel(row.status) }}</template
              ></ElTableColumn
            ><ElTableColumn label="引用状态"
              ><template #default="{ row }">{{
                row.isCurrent ? "当前生效" : "历史版本"
              }}</template></ElTableColumn
            ></ElTable
          ></ElTabPane
        >
      </ElTabs>
    </ElDialog>
    <ElDialog
      class="management-dialog"
      body-class="management-dialog-body"
      header-class="management-dialog-header"
      footer-class="management-dialog-footer"
      append-to-body
      v-model="createOpen"
      title="新建提示词"
      width="min(720px,94vw)"
      :close-on-click-modal="false"
      :before-close="closeCreate"
      :show-close="!busy"
      :close-on-press-escape="!busy"
      ><ElAlert
        v-if="actionError"
        :title="actionError"
        type="error"
        :closable="false"
        class="mb-4"
      />
      <ElForm
        ref="createFormRef"
        :model="createForm"
        :rules="createRules"
        label-position="top"
        :disabled="busy"
        @submit.prevent="create"
        ><ElFormItem label="名称" prop="name" required
          ><ElInput v-model="createForm.name" maxlength="160" /></ElFormItem
        ><ElFormItem label="提示词正文"
          ><ElInput
            v-model="createForm.template"
            type="textarea"
            :rows="8"
            maxlength="100000"
            placeholder="可以先创建草稿，再完善正文" /></ElFormItem
        ><ElFormItem label="描述（可选）"
          ><ElInput
            v-model="createForm.description"
            type="textarea"
            :rows="2"
            maxlength="2000" /></ElFormItem
        ><ElCollapse
          ><ElCollapseItem title="自定义标识（可选）" name="key"
            ><ElFormItem label="稳定 Key" prop="promptKey"
              ><ElInput
                v-model="createForm.promptKey"
                maxlength="160"
                placeholder="留空自动生成，例如 support.business" /></ElFormItem></ElCollapseItem></ElCollapse></ElForm
      ><template #footer
        ><ElButton :disabled="busy" @click="closeCreate()">取消</ElButton
        ><ElButton
          type="primary"
          :loading="busy"
          :disabled="busy"
          @click="create"
          >创建草稿</ElButton
        ></template
      ></ElDialog
    >
    <ElDialog
      class="management-dialog"
      body-class="management-dialog-body"
      header-class="management-dialog-header"
      footer-class="management-dialog-footer"
      append-to-body
      v-model="publishOpen"
      title="审阅并发布提示词"
      width="min(1160px,96vw)"
      :close-on-click-modal="false"
      :close-on-press-escape="!busy"
      :show-close="!busy"
      ><div>
        <template v-if="review"
          ><ElAlert
            title="发布后此版本不可修改；已有 Agent 继续使用原版本，需在 Agent 中明确选择新版本。"
            type="info"
            :closable="false"
            class="mb-4" /><ElAlert
            v-if="!review.agentSelectable && !review.isPlatform"
            title="该版本包含变量或正文过长，发布后暂不能直接用于 Agent 业务指导。"
            type="warning"
            :closable="false"
            class="mb-4" /><ElForm label-position="top"
            ><ElFormItem label="本次变更说明" required
              ><ElInput
                v-model="changeNote"
                type="textarea"
                :rows="2"
                maxlength="1000"
                show-word-limit
                placeholder="例如：补充退换货边界，明确需要人工介入的情况" /></ElFormItem></ElForm
          ><PromptDiff
            :left="review.source.template"
            :right="review.target.template"
            :left-label="
              review.source.version
                ? `来源 v${review.source.version}`
                : '首次发布（空白基线）'
            "
            :right-label="`待发布 v${review.target.version}`" /><ElCollapse
            class="mt-4"
            ><ElCollapseItem title="变量定义差异" name="variables"
              ><PromptDiff
                :left="JSON.stringify(review.source.variables, null, 2)"
                :right="
                  JSON.stringify(review.target.variables, null, 2)
                " /></ElCollapseItem
            ><ElCollapseItem
              :title="`引用此提示词的 Agent 版本（${review.usage.length}）`"
              name="usage"
              ><ElTable :data="review.usage"
                ><ElTableColumn prop="name" label="Agent" /><ElTableColumn
                  label="版本"
                  ><template #default="{ row }"
                    >v{{ row.version }}</template
                  ></ElTableColumn
                ><ElTableColumn label="引用状态"
                  ><template #default="{ row }">{{
                    row.isCurrent ? "当前生效" : "历史版本"
                  }}</template></ElTableColumn
                ></ElTable
              ></ElCollapseItem
            ></ElCollapse
          ><ElAlert
            v-if="actionError"
            :title="actionError"
            type="error"
            :closable="false"
            class="mt-3"
        /></template>
      </div>
      <template #footer
        ><ElButton :disabled="busy" @click="publishOpen = false"
          >返回编辑</ElButton
        ><ElButton type="primary" :loading="busy" @click="publish"
          >确认发布</ElButton
        ></template
      ></ElDialog
    >
  </Page>
</template>
