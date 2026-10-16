<script setup lang="ts">
import {
  ref,
  computed,
  watch,
  defineAsyncComponent,
  onBeforeUnmount,
} from "vue";
import { useRoute, useRouter } from "vue-router";
import { Page } from "@vben/common-ui";
import { useAccessStore } from "@vben/stores";
import {
  type FormInstance,
  ElTable,
  ElTableColumn,
  ElButton,
  ElDialog,
  ElForm,
  ElFormItem,
  ElInput,
  ElMessage,
  ElMessageBox,
  ElAlert,
  ElTag,
  ElUpload,
  ElCollapse,
  ElCollapseItem,
  type UploadFile,
} from "element-plus";
import { useUnsavedChanges } from "#/composables/use-unsaved-changes";
import { managementApi as api } from "#/api/management";
import ManagementHeader from "#/components/ManagementHeader.vue";
import {
  newResourceKey,
  validResourceKey,
} from "#/components/create-resource-key";
import {
  createDraftQueue,
  type DraftSaveState,
} from "#/composables/draft-queue";
import ResourceLifecycle from "#/components/ResourceLifecycle.vue";
import { ElSegmented } from "element-plus";
import Fields from "./fields.vue";
import { agentSummary } from "./agent-summary";
import { agentCopySource, resourceSummary } from "./resource-summary";
import AgentDetail from "./agent-detail.vue";
import ToolDetail from "./tool-detail.vue";
import PagePanel from "#/components/PagePanel.vue";
import WorkflowTestDialog from "./WorkflowTestDialog.vue";
import HelpTip from "#/components/HelpTip.vue";
import JsonEditor from "#/components/JsonEditor.vue";
import { createSkillDocument, skillCreateKey } from "./skill/create-document";
import { skillResourceLimits, type SkillResource } from "./skill/resources";
const SkillDetail = defineAsyncComponent(() => import("./skill/detail.vue"));
const skillDetail = ref<{ prepareLeave: () => Promise<boolean> }>();
const workflowTestOpen = ref(false);
const importDiagnostics = ref<any[]>([]);
const importError = ref("");
const visibleImportDiagnostics = computed(() =>
  importDiagnostics.value.filter((d) => {
    if (d.field === "allowed-tools")
      return config.value.unresolvedTools?.length;
    if (d.field === "allowed-kbs")
      return config.value.unresolvedKnowledgeBases?.length;
    if (d.field === "disable-model-invocation")
      return config.value.disableModelInvocation;
    if (d.field === "description")
      return config.value.description?.length > 1024;
    return (
      d.field === "name" ||
      Object.hasOwn(config.value.extraFrontmatter ?? {}, d.field)
    );
  }),
);
const route = useRoute(),
  router = useRouter(),
  access = useAccessStore();
const kind = computed(() => String(route.meta.resourceKind));
const label = computed(
  () => ({ agent: "Agent", skill: "Skill", tool: "Tool" })[kind.value],
);
const foundationKeys = ["search_knowledge", "load_skill"];
const manageableOptions = (value: any) => ({
  ...value,
  tools: (value.tools ?? []).filter(
    (tool: any) => !foundationKeys.includes(tool.key),
  ),
});
const canManage = computed(() =>
  access.accessCodes.includes("agent_config.manage"),
);
const lifecycleState = ref("active");
const removed = computed(
  () => !!(detail.value?.archivedAt || detail.value?.deletedAt),
);
const editableManage = computed(() => canManage.value && !removed.value);
const resources = ref<any[]>([]),
  options = ref<any>({
    tools: [],
    knowledgeBases: [],
    prompts: [],
    modelPlans: [],
    embeddingPlans: [],
  }),
  detail = ref<any>(),
  selected = ref<number>(),
  config = ref<any>({}),
  createOpen = ref(false),
  skillCreate = ref({ name: "", key: "", description: "" }),
  skillCreateForm = ref<FormInstance>(),
  importedSkillDocument = ref<string>(),
  importedSkillResources = ref<SkillResource[]>([]),
  importKind = ref<"document" | "bundle">("document"),
  busy = ref(false),
  loading = ref(false),
  failed = ref(false),
  name = ref(""),
  key = ref(""),
  testInput = ref("{}"),
  testOpen = ref(false),
  document = ref(""),
  importOpen = ref(false),
  result = ref<any>();
const actionError = ref("");
const search = ref("");
const saveState = ref<DraftSaveState>({
  saving: false,
  error: "",
  conflict: false,
});
const toolContentValid = ref(true);
const toolTestValid = ref(true);
const generatedCreateKey = ref("");
const skillCreateRules = {
  name: [
    {
      required: true,
      whitespace: true,
      message: "请输入名称",
      trigger: "blur",
    },
    { max: 160, message: "名称最多 160 字符", trigger: "blur" },
  ],
  key: [
    {
      validator: (
        _rule: unknown,
        value: string,
        callback: (error?: Error) => void,
      ) => {
        try {
          if (value.trim()) skillCreateKey(value);
          callback();
        } catch (e) {
          callback(e instanceof Error ? e : new Error("Key 格式不正确"));
        }
      },
      trigger: "blur",
    },
  ],
  description: [
    {
      required: true,
      whitespace: true,
      message: "请输入描述和使用时机",
      trigger: "blur",
    },
    { max: 1024, message: "描述最多 1024 字符", trigger: "blur" },
  ],
};
const original = ref(""),
  active = computed(() =>
    detail.value?.versions.find((v: any) => v.id === selected.value),
  ),
  dirty = computed(
    () =>
      active.value?.status === "draft" &&
      (original.value !== draftPayload() ||
        (["agent", "tool"].includes(kind.value) && !toolContentValid.value)),
  );
const items = computed(() =>
  resources.value.filter(
    (r) =>
      r.kind === kind.value &&
      (!search.value ||
        `${r.name} ${r.key}`
          .toLowerCase()
          .includes(search.value.toLowerCase())) &&
      (lifecycleState.value === "deleted"
        ? !!r.deletedAt
        : lifecycleState.value === "archived"
          ? !!r.archivedAt && !r.deletedAt
          : !r.archivedAt && !r.deletedAt) &&
      (r.kind !== "tool" ||
        (r.toolType !== "mcp" &&
          !["search_knowledge", "load_skill"].includes(r.key))),
  ),
);
function defaults() {
  if (kind.value === "skill")
    return {
      description: "",
      instructions: "",
      allowedTools: [],
      allowedKnowledgeBaseIds: [],
      permissionMode: "agent",
    };
  if (kind.value === "tool")
    return {
      description: "",
      type: "rest",
      endpoint: {
        url: "",
        method: "GET",
        headers: {},
        mappingMode: "explicit",
        bindings: [],
        resultPath: "",
      },
      parameters: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      timeoutMs: 30000,
      maxRetries: 3,
      readOnly: true,
      requiresApproval: false,
    };
  return {
    responsibility: "",
    output: { mode: "text" },
    promptVersionId: options.value.prompts[0]?.id,
    modelPlanVersionId: options.value.modelPlans[0]?.id ?? null,
    embeddingPlanVersionId: null,
    retrieval: {
      retrievalMode: "fulltext",
      topK: 5,
      lexicalThreshold: 0.15,
      vectorThreshold: 0.65,
      contextChars: 12000,
    },
    executionLimits: {
      maxModelCalls: 32,
      maxToolCalls: 40,
      maxTotalTokens: 120000,
      enabled: {
        maxModelCalls: false,
        maxToolCalls: false,
        maxTotalTokens: false,
      },
    },
    toolVersionIds: [],
    skillVersionIds: [],
    knowledgeBaseIds: [],
    runtime: {
      maxToolCalls: 8,
      maxPlannerRounds: 12,
      toolTimeoutMs: 30000,
      maxToolResultChars: 16000,
    },
    welcome: {
      title: "你好",
      description: "有什么可以帮助你？",
      suggestedQuestions: ["你能帮我做什么？"],
    },
  };
}
function draftPayload() {
  return JSON.stringify(
    kind.value === "agent"
      ? { name: name.value, config: config.value }
      : config.value,
  );
}
const validAgentName = computed(
  () =>
    kind.value !== "agent" ||
    (!!name.value.trim() && name.value.trim().length <= 160),
);
const draftQueue = createDraftQueue({
  read: () =>
    ["agent", "tool"].includes(kind.value) &&
    (!["agent", "tool"].includes(kind.value) || toolContentValid.value) &&
    validAgentName.value &&
    editableManage.value &&
    active.value?.status === "draft" &&
    (kind.value !== "agent" ||
      active.value.id ===
        detail.value?.versions.find((v: any) => v.status === "draft")?.id) &&
    dirty.value &&
    !busy.value
      ? {
          identity: String(selected.value),
          revision: active.value.revision,
          payload: draftPayload(),
        }
      : undefined,
  write: (draft) => {
    const body = JSON.parse(draft.payload);
    return api.patch(`/agent-resources/versions/${draft.identity}`, {
      revision: draft.revision,
      ...(kind.value === "agent" ? body : { config: body }),
    });
  },
  accept: (draft, saved: any) => {
    if (
      String(selected.value) !== draft.identity ||
      active.value?.status !== "draft"
    )
      return;
    const body = JSON.parse(draft.payload);
    active.value.revision = saved.revision;
    active.value.config = kind.value === "agent" ? body.config : body;
    if (kind.value === "agent") {
      active.value.name = saved.name ?? body.name.trim();
      if (name.value === body.name) name.value = active.value.name;
      original.value = JSON.stringify({ ...body, name: active.value.name });
    } else original.value = draft.payload;
    if (saved.updatedAt) active.value.updatedAt = saved.updatedAt;
    active.value.testedRevision = null;
    active.value.testResult = null;
    result.value = undefined;
  },
  state: (value) => {
    saveState.value = value;
  },
});
watch(draftPayload, () => {
  if (["agent", "tool"].includes(kind.value)) draftQueue.schedule();
});
onBeforeUnmount(draftQueue.dispose);
async function preparePreview() {
  if (!["agent", "tool"].includes(kind.value) || busy.value) return false;
  if (!toolContentValid.value) {
    ElMessage.warning("请先修正当前配置或输出规范中的错误");
    return false;
  }
  if (!(await draftQueue.flush()) || dirty.value) return false;
  return true;
}
const createBaseline = ref(""),
  copyOpen = ref(false),
  copyName = ref(""),
  copyBaseline = ref("");
const copySource = ref<ReturnType<typeof agentCopySource>>();
const createSnapshot = () =>
  JSON.stringify({
    name: name.value,
    key: key.value,
    config: config.value,
    skill: skillCreate.value,
  });
const formDirty = computed(
  () =>
    (createOpen.value && createSnapshot() !== createBaseline.value) ||
    (copyOpen.value && copyName.value !== copyBaseline.value) ||
    (importOpen.value && !!document.value.trim()),
);
const discardForms = useUnsavedChanges(formDirty);
async function closeCreate(done?: () => void) {
  if (busy.value || !(await discardForms())) return;
  if (busy.value) return;
  createOpen.value = false;
  done?.();
}
async function closeImport(done?: () => void) {
  if (busy.value || !(await discardForms())) return;
  importOpen.value = false;
  done?.();
}
async function closeCopy(done?: () => void) {
  if (busy.value || !(await discardForms())) return;
  copyOpen.value = false;
  done?.();
}
function openCopy(resource: any) {
  const source = agentCopySource(resource);
  if (busy.value || !source) return;
  copySource.value = source;
  copyName.value = `${source.name} 副本`.slice(0, 160);
  copyBaseline.value = copyName.value;
  actionError.value = "";
  copyOpen.value = true;
}
async function copyAgent() {
  if (busy.value || !copySource.value || !copyName.value.trim()) return;
  const path = route.fullPath,
    source = copySource.value;
  await run(async () => {
    const result = await api.post(
      `/agent-resources/versions/${source.versionId}/clone`,
      {
        key: `agent_${crypto.randomUUID().replaceAll("-", "")}`,
        name: copyName.value.trim(),
      },
    );
    if (route.fullPath !== path) return;
    copyOpen.value = false;
    ElMessage.success("已复制为独立草稿，尚未发布");
    await router.push(`/agents/${result.resourceId}`);
  });
}
const leave = useUnsavedChanges(
  computed(() => dirty.value || saveState.value.saving),
  () =>
    ["agent", "tool"].includes(kind.value)
      ? preparePreview()
      : Promise.resolve(false),
);
async function refresh() {
  if (kind.value === "skill" && skillDetail.value) {
    if (await skillDetail.value.prepareLeave()) await load();
    return;
  }
  if (await leave()) await load(selected.value);
}
async function refreshOptions() {
  const target = route.fullPath;
  await run(async () => {
    const latest = await api.get("/agent-resources/options");
    if (route.fullPath !== target) return;
    options.value = manageableOptions(latest);
    ElMessage.success("模型与知识库选项已刷新，未保存的 Agent 配置保持不变");
  });
}
async function run(fn: () => Promise<unknown>) {
  busy.value = true;
  actionError.value = "";
  try {
    await fn();
  } catch (error: any) {
    const message =
      error.response?.data?.error?.message ?? error.response?.data?.message;
    actionError.value =
      typeof message === "string" ? message : "操作失败，请检查配置后重试";
  } finally {
    busy.value = false;
  }
}
function adopt() {
  draftQueue.reset();
  config.value = JSON.parse(JSON.stringify(active.value?.config ?? defaults()));
  toolContentValid.value = true;
  if (kind.value === "agent")
    name.value = active.value?.name ?? detail.value?.name ?? "";
  original.value = draftPayload();
  // Preserve historical policy. Opening a draft must not convert retrieval or budgets.
  result.value = active.value?.testResult;
}
let loadGeneration = 0;
async function load(preferred?: number) {
  const generation = ++loadGeneration,
    path = route.fullPath;
  loading.value = true;
  failed.value = false;
  try {
    const [r, o] = await Promise.all([
      api.get("/agent-resources?state=all"),
      api.get("/agent-resources/options"),
    ]);
    if (generation !== loadGeneration || route.fullPath !== path) return;
    resources.value = r.resources.filter(
      (resource: any) =>
        resource.kind !== "tool" || !foundationKeys.includes(resource.key),
    );
    options.value = manageableOptions(o);
    if (route.params.id) {
      let d = await api.get(`/agent-resources/${route.params.id}`);
      if (generation !== loadGeneration || route.fullPath !== path) return;
      if (
        !preferred &&
        ["agent", "skill", "tool"].includes(d.kind) &&
        canManage.value &&
        !d.archivedAt &&
        !d.deletedAt &&
        !d.versions.some((v: any) => v.status === "draft") &&
        (d.currentVersionId ||
          d.versions.some((v: any) => v.status === "published"))
      ) {
        await api.post(`/agent-resources/${d.kind}s/${d.id}/draft`, {
          fromVersionId:
            d.currentVersionId ??
            d.versions.find((v: any) => v.status === "published")?.id,
        });
        d = await api.get(`/agent-resources/${d.id}`);
      }
      if (generation !== loadGeneration || route.fullPath !== path) return;
      if (d.kind !== kind.value) throw new Error("资源类型不匹配");
      detail.value = d;
      selected.value =
        preferred ??
        d.versions.find((v: any) => v.status === "draft")?.id ??
        d.currentVersionId ??
        d.versions[0]?.id;
      adopt();
    }
  } catch {
    if (generation === loadGeneration && route.fullPath === path)
      failed.value = true;
  } finally {
    if (generation === loadGeneration && route.fullPath === path)
      loading.value = false;
  }
}
function openCreate() {
  if (busy.value) return;
  actionError.value = "";
  generatedCreateKey.value = newResourceKey(
    kind.value === "skill" ? "skill" : kind.value === "tool" ? "tool" : "agent",
  );
  toolContentValid.value = true;
  importDiagnostics.value = [];
  importedSkillDocument.value = undefined;
  importedSkillResources.value = [];
  skillCreate.value = { name: "", key: "", description: "" };
  skillCreateForm.value?.clearValidate();
  name.value = "";
  key.value = "";
  config.value = defaults();
  createBaseline.value = createSnapshot();
  createOpen.value = true;
}
async function create() {
  if (busy.value) return;
  const path = route.fullPath;
  if (["agent", "tool"].includes(kind.value) && !toolContentValid.value) {
    actionError.value = "请修正工具 JSON / Schema 后保存";
    return;
  }
  const createKey =
    kind.value === "tool" && config.value.type === "builtin"
      ? config.value.target
      : key.value.trim() || generatedCreateKey.value;
  if (kind.value !== "skill" && (!createKey || !name.value.trim())) {
    actionError.value = "请输入名称";
    return;
  }
  if (kind.value === "tool" && !validResourceKey(createKey)) {
    actionError.value =
      "自定义标识需以小写字母开头，仅使用小写字母、数字和下划线，最多 80 字符。";
    return;
  }
  if (
    kind.value === "skill" &&
    !(await skillCreateForm.value?.validate().catch(() => false))
  )
    return;
  if (busy.value || route.fullPath !== path || !createOpen.value) return;
  await run(async () => {
    if (kind.value === "skill") {
      const generated = createSkillDocument(
        skillCreate.value.key.trim() || generatedCreateKey.value,
        skillCreate.value.description,
        importedSkillDocument.value,
      );
      key.value = generated.key;
      name.value = skillCreate.value.name.trim();
      config.value = {
        document: generated.document,
        resources: importedSkillResources.value,
      };
    }
    const r = await api.post("/agent-resources", {
      kind: kind.value,
      key: kind.value === "skill" ? key.value : createKey,
      name: name.value.trim(),
      config: config.value,
    });
    if (route.fullPath !== path) return;
    createOpen.value = false;
    await router.push(`/${kind.value}s/${r.resourceId}`);
  });
}
async function save() {
  if (["agent", "tool"].includes(kind.value)) {
    if (await preparePreview()) ElMessage.success("草稿已保存");
    return;
  }
  if (["agent", "tool"].includes(kind.value) && !toolContentValid.value)
    return ElMessage.warning("请修正工具 JSON / Schema 后保存");
  await run(async () => {
    await api.patch(`/agent-resources/versions/${selected.value}`, {
      revision: active.value.revision,
      config: config.value,
    });
    original.value = JSON.stringify(config.value);
    await load(selected.value);
    ElMessage.success("草稿已保存");
  });
}
async function version(id: number) {
  if (await leave()) {
    selected.value = id;
    adopt();
  }
}
async function clone() {
  if (!(await leave())) return;
  try {
    await ElMessageBox.confirm(
      "基于当前查看版本另建草稿？现有草稿会保留，已发布配置不会改变。",
      "新建历史草稿",
    );
  } catch {
    return;
  }
  await run(async () => {
    const v = await api.post(
      `/agent-resources/versions/${selected.value}/clone`,
    );
    await load(v.versionId);
  });
}
async function openToolTest() {
  if (!(await preparePreview())) return;
  if (!toolContentValid.value)
    return ElMessage.warning("请修正工具 JSON / Schema 后测试");
  const workflow = options.value.tools.find(
    (tool: any) => tool.key === active.value?.config.target,
  )?.workflow;
  if (active.value?.config.type === "builtin" && workflow?.requiresAgentContext)
    workflowTestOpen.value = true;
  else testOpen.value = true;
}
async function workflowTested(value: unknown) {
  result.value = value;
  await load(selected.value);
}
async function test(execute = false) {
  if (execute && !toolTestValid.value)
    return ElMessage.warning("请修正测试参数 JSON 后执行");
  if (["agent", "tool"].includes(kind.value) && !toolContentValid.value)
    return ElMessage.warning("请修正工具 JSON / Schema 后测试");
  if (kind.value === "tool" && !(await preparePreview())) return;
  if (dirty.value) return ElMessage.warning("草稿尚未保存，请检查错误");
  let body: any = {};
  if (execute) {
    try {
      body = {
        execute: true,
        input: JSON.parse(testInput.value),
        approved: true,
      };
    } catch {
      return ElMessage.error("输入必须是有效 JSON");
    }
    try {
      await ElMessageBox.confirm(
        "此操作将真实调用工具，是否继续？",
        "工具测试",
      );
    } catch {
      return;
    }
  }
  await run(async () => {
    result.value = await api.post(
      `/agent-resources/versions/${selected.value}/test`,
      body,
    );
    testOpen.value = false;
    await load(selected.value);
  });
}
async function publish() {
  if (["agent", "tool"].includes(kind.value) && !(await preparePreview()))
    return;
  if (["agent", "tool"].includes(kind.value) && !toolContentValid.value)
    return ElMessage.warning("请修正工具 JSON / Schema 后发布");
  if (dirty.value) return ElMessage.warning("草稿尚未保存，请检查错误");
  if (
    kind.value === "tool" &&
    (active.value.testedRevision !== active.value.revision ||
      !active.value.testResult?.ok)
  )
    return ElMessage.warning("请先真实测试当前草稿；修改配置后需要重新测试");
  try {
    await ElMessageBox.confirm(
      kind.value === "agent"
        ? "发布后立即成为当前生效版本，新请求将使用此配置；历史版本仍可恢复。是否继续？"
        : "发布此版本？发布后不可修改。",
      "确认发布",
    );
  } catch {
    return;
  }
  await run(async () => {
    if (kind.value === "agent") {
      result.value = await api.post(
        `/agent-resources/versions/${selected.value}/test`,
      );
      if (!result.value?.ok) return;
    }
    await api.post(`/agent-resources/versions/${selected.value}/publish`);
    await load(selected.value);
  });
}
async function editAgent() {
  if (!(await leave())) return;
  await run(async () => {
    const v = await api.post(
      `/agent-resources/${kind.value}s/${detail.value.id}/draft`,
      { fromVersionId: selected.value },
    );
    await load(v.versionId);
    if (v.reused) ElMessage.info("已打开现有草稿，未重复创建版本");
  });
}
async function activateAgent(id: number) {
  if (!(await leave())) return;
  const target = detail.value.versions.find((v: any) => v.id === id);
  try {
    await ElMessageBox.confirm(
      `将当前生效配置恢复为 v${target.version}？新请求将使用该版本，已有请求不受影响。`,
      "恢复历史版本",
      { type: "warning" },
    );
  } catch {
    return;
  }
  await run(async () => {
    await api.post(`/agent-resources/${detail.value.id}/activate`, {
      versionId: id,
      expectedCurrentVersionId: detail.value.currentVersionId,
    });
    await load(id);
    ElMessage.success("生效版本已切换");
  });
}
async function lifecycleChanged(action: string) {
  if (route.params.id && action !== "restore") {
    original.value = draftPayload();
    await router.push(`/${kind.value}s`);
  } else await load(selected.value);
}
async function prepareLifecycle() {
  return kind.value === "skill" && skillDetail.value
    ? skillDetail.value.prepareLeave()
    : leave();
}
async function toggle() {
  try {
    await ElMessageBox.confirm(
      detail.value.enabled ? "停用此资源？" : "启用此资源？",
      "确认",
    );
  } catch {
    return;
  }
  await run(async () => {
    await api.patch(`/agent-resources/${detail.value.id}/status`, {
      enabled: !detail.value.enabled,
    });
    await load(selected.value);
  });
}
async function importDocument() {
  importError.value = "";
  await run(async () => {
    let r: any;
    try {
      r =
        importKind.value === "bundle"
          ? await api.post(
              "/agent-resources/skill-bundle",
              JSON.parse(document.value),
            )
          : await api.post("/agent-resources/skill-document", {
              document: document.value,
            });
    } catch (e: any) {
      const m = e.response?.data?.error?.message ?? e.response?.data?.message;
      importError.value = Array.isArray(m)
        ? m.join("；")
        : (m ??
          (importKind.value === "bundle"
            ? "解析失败，请检查完整包 JSON"
            : "解析失败，请检查 YAML 和正文"));
      return;
    }
    key.value = r.key;
    generatedCreateKey.value = newResourceKey("skill");
    name.value = r.name;
    skillCreate.value = {
      name: r.name,
      key: r.key,
      description: r.config.description,
    };
    importedSkillDocument.value = r.config.document ?? document.value;
    importedSkillResources.value = r.config.resources ?? [];
    config.value = r.config;
    importDiagnostics.value = r.diagnostics ?? [];
    importOpen.value = false;
    createBaseline.value = createSnapshot();
    createOpen.value = true;
  });
}
async function importSkillFile(file: UploadFile) {
  if (!file.raw || busy.value) return;
  importError.value = "";
  if (file.raw.size > skillResourceLimits.bundleBytes) {
    importError.value = "文件不能超过 384 KiB";
    return;
  }
  busy.value = true;
  try {
    document.value = new TextDecoder("utf-8", { fatal: true }).decode(
      await file.raw.arrayBuffer(),
    );
    importKind.value = file.name.toLowerCase().endsWith(".json")
      ? "bundle"
      : "document";
  } catch {
    importError.value = "文件必须是有效 UTF-8 文本";
  } finally {
    busy.value = false;
  }
}

watch(
  () => [route.params.id, kind.value],
  () => {
    draftQueue.reset();
    detail.value = undefined;
    selected.value = undefined;
    void load();
  },
  { immediate: true },
);
</script>
<template>
  <Page>
    <ManagementHeader
      :title="
        route.params.id && kind === 'agent'
          ? name || detail?.name || 'Agent'
          : detail?.name || `${label} 管理`
      "
    >
      <ElButton v-if="route.params.id" @click="router.push(`/${kind}s`)"
        >返回列表</ElButton
      >
      <ElButton :disabled="busy || saveState.saving" @click="refresh"
        >刷新</ElButton
      >
      <ElButton
        v-if="canManage && !route.params.id"
        type="primary"
        @click="openCreate"
        >新建 {{ label }}</ElButton
      >
      <ElButton
        v-if="canManage && !route.params.id && kind === 'skill'"
        @click="importOpen = true"
        >导入 Skill</ElButton
      >
    </ManagementHeader>
    <ElAlert
      v-if="actionError"
      class="mb-4"
      :title="actionError"
      type="error"
      :closable="false"
    />
    <ElAlert
      v-if="failed"
      title="资源加载失败，请重试"
      type="error"
      :closable="false"
    />
    <ElAlert
      v-if="removed"
      class="mb-4"
      :closable="false"
      type="info"
      :title="
        detail.deletedAt
          ? '资源已删除，仅可查看历史或恢复'
          : '资源已归档，仅可查看历史或恢复'
      "
    />
    <PagePanel v-if="!route.params.id">
      <div
        v-if="!route.params.id"
        class="mb-4 flex flex-wrap items-center justify-between gap-3"
      >
        <ElInput
          v-model="search"
          placeholder="搜索名称或 Key"
          clearable
          class="w-full sm:w-72"
        />
        <ElSegmented
          v-model="lifecycleState"
          :options="[
            { label: '正常资源', value: 'active' },
            { label: '已归档', value: 'archived' },
            { label: '回收站', value: 'deleted' },
          ]"
        />
      </div>
      <ElTable v-if="!route.params.id" :data="items" v-loading="loading"
        ><ElTableColumn
          v-if="kind === 'skill'"
          prop="id"
          label="ID"
          width="80" /><ElTableColumn label="名称" min-width="200"
          ><template #default="{ row }"
            ><ElButton
              link
              type="primary"
              @click="router.push(`/${kind}s/${row.id}`)"
              >{{
                kind === "agent"
                  ? agentSummary(row, options.modelPlans).name
                  : row.name
              }}</ElButton
            >
            <p class="mt-1 max-w-md truncate text-xs text-muted-foreground">
              {{
                kind === "agent"
                  ? agentSummary(row, options.modelPlans).responsibility
                  : resourceSummary(row).description
              }}
            </p></template
          ></ElTableColumn
        ><ElTableColumn
          v-if="kind !== 'agent'"
          prop="key"
          label="Key" /><ElTableColumn label="状态"
          ><template #default="{ row }"
            ><ElTag>{{
              row.deletedAt
                ? "已删除"
                : row.archivedAt
                  ? "已归档"
                  : row.enabled
                    ? "启用"
                    : "停用"
            }}</ElTag></template
          ></ElTableColumn
        ><ElTableColumn v-if="kind === 'agent'" label="执行方式" width="120"
          ><template #default="{ row }">{{
            agentSummary(row, options.modelPlans).mode === "multi"
              ? "多 Agent"
              : "单 Agent"
          }}</template></ElTableColumn
        >
        <ElTableColumn v-if="kind === 'agent'" label="模型" min-width="180"
          ><template #default="{ row }">{{
            agentSummary(row, options.modelPlans).model
          }}</template></ElTableColumn
        >
        <ElTableColumn label="配置状态" min-width="160"
          ><template #default="{ row }">
            <ElTag
              v-if="kind === 'agent'"
              :type="
                agentSummary(row, options.modelPlans).state === 'published'
                  ? 'success'
                  : 'warning'
              "
              >{{
                (
                  {
                    published: "已发布",
                    changed: "有未发布修改",
                    draft: "尚未发布",
                    missing: "生效版本不可用",
                  } as any
                )[agentSummary(row, options.modelPlans).state]
              }}</ElTag
            >
            <ElTag
              v-else
              :type="
                resourceSummary(row).state === 'published'
                  ? 'success'
                  : resourceSummary(row).state === 'changed'
                    ? 'warning'
                    : 'info'
              "
              >{{
                {
                  published: "已发布",
                  changed: "有未发布修改",
                  draft: "尚未发布",
                }[resourceSummary(row).state]
              }}</ElTag
            >
          </template></ElTableColumn
        >
        <ElTableColumn label="最近修改" min-width="180"
          ><template #default="{ row }">{{
            row.updatedAt ? new Date(row.updatedAt).toLocaleString() : "—"
          }}</template></ElTableColumn
        >
        <ElTableColumn label="操作" width="190"
          ><template #default="{ row }"
            ><ElButton
              v-if="
                kind === 'agent' &&
                row.enabled &&
                !row.archivedAt &&
                !row.deletedAt &&
                canManage &&
                access.accessCodes.includes('agent_tools.execute')
              "
              link
              type="primary"
              @click="
                router.push({
                  path: `/agents/${row.id}`,
                  query: { tab: 'preview' },
                })
              "
              >试运行</ElButton
            ><ResourceLifecycle
              :resource="row"
              base="/agent-resources"
              :can-manage="canManage"
              :can-copy="kind === 'agent' && !busy && !!agentCopySource(row)"
              @copy="openCopy(row)"
              @changed="load()" /></template></ElTableColumn
      ></ElTable>
    </PagePanel>
    <div v-else-if="detail" class="space-y-4">
      <PagePanel v-if="kind === 'skill'">
        <SkillDetail
          ref="skillDetail"
          :detail="detail"
          :options="options"
          :resources="resources"
          :can-manage="editableManage"
          ><template #actions
            ><ResourceLifecycle
              :resource="detail"
              base="/agent-resources"
              :can-manage="canManage"
              :before-action="prepareLifecycle"
              @changed="lifecycleChanged" /></template
        ></SkillDetail>
      </PagePanel>
      <AgentDetail
        v-else-if="kind === 'agent'"
        v-model="config"
        v-model:name="name"
        :detail="detail"
        :selected="selected"
        :options="options"
        :resources="resources"
        :can-manage="editableManage"
        :busy="busy"
        :dirty="dirty"
        :content-valid="toolContentValid"
        @valid="
          toolContentValid = $event;
          if ($event) draftQueue.schedule();
        "
        :result="result"
        :save-state="saveState"
        :prepare="preparePreview"
        @version="version"
        @edit="editAgent"
        @save="save"
        @publish="publish"
        @activate="activateAgent"
        @toggle="toggle"
        @refresh-options="refreshOptions"
        ><template #actions
          ><ResourceLifecycle
            :resource="detail"
            base="/agent-resources"
            :can-manage="canManage"
            :before-action="prepareLifecycle"
            :can-copy="!busy && !!agentCopySource(detail)"
            @copy="openCopy(detail)"
            @changed="lifecycleChanged" /></template
      ></AgentDetail>
      <ToolDetail
        v-else
        v-model="config"
        :detail="detail"
        :selected="selected"
        :options="options"
        :can-manage="editableManage"
        :can-execute="access.accessCodes.includes('agent_tools.execute')"
        :busy="busy"
        :dirty="dirty"
        :save-state="saveState"
        :result="result"
        :content-valid="toolContentValid"
        @valid="
          toolContentValid = $event;
          draftQueue.schedule();
        "
        @version="version"
        @edit="editAgent"
        @branch="clone"
        @retry="save"
        @test="openToolTest"
        @publish="publish"
        @toggle="toggle"
        ><template #actions>
          <ResourceLifecycle
            :resource="detail"
            base="/agent-resources"
            :can-manage="canManage"
            :before-action="prepareLifecycle"
            @changed="lifecycleChanged"
          /> </template
      ></ToolDetail>
    </div>
    <ElDialog
      class="management-dialog"
      body-class="management-dialog-body"
      header-class="management-dialog-header"
      footer-class="management-dialog-footer"
      append-to-body
      v-model="createOpen"
      :title="`新建 ${label}`"
      :width="
        kind === 'skill'
          ? 'min(600px, 95vw)'
          : kind === 'agent'
            ? 'min(640px, 95vw)'
            : 'min(760px,95vw)'
      "
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
      <div>
        <ElForm
          v-if="kind === 'skill'"
          ref="skillCreateForm"
          :model="skillCreate"
          :rules="skillCreateRules"
          label-position="top"
          :disabled="busy"
          @submit.prevent="create"
        >
          <ElFormItem label="名称" prop="name" required
            ><ElInput
              v-model="skillCreate.name"
              maxlength="160"
              placeholder="例如：订单异常处理"
          /></ElFormItem>
          <ElFormItem label="描述 / 使用时机" prop="description" required
            ><ElInput
              v-model="skillCreate.description"
              type="textarea"
              :rows="3"
              maxlength="1024"
              placeholder="说明该 Skill 做什么、何时使用；详细步骤在创建后补充。"
          /></ElFormItem>
          <ElCollapse>
            <ElCollapseItem title="自定义标识（可选）" name="key">
              <ElFormItem label="稳定 Key" prop="key">
                <template #label
                  ><span class="inline-flex items-center gap-1"
                    >稳定 Key<HelpTip
                      text="默认自动生成，创建后不可修改。自定义支持小写字母、数字、下划线或短横线，最多 64 字符；SKILL.md 的 name 使用短横线。"
                      long /></span
                ></template>
                <ElInput
                  v-model="skillCreate.key"
                  maxlength="64"
                  placeholder="留空自动生成，例如 order_support"
                />
              </ElFormItem>
            </ElCollapseItem>
          </ElCollapse>
        </ElForm>
        <template v-else>
          <ElForm
            label-position="top"
            class="grid grid-cols-1 gap-x-4 sm:grid-cols-2"
            :disabled="busy"
            ><ElFormItem label="名称" required class="sm:col-span-2"
              ><ElInput v-model="name" maxlength="160"
            /></ElFormItem>
          </ElForm>
          <Fields
            :key="`${selected}:${active?.status}`"
            v-model="config"
            :kind="kind"
            :section="
              kind === 'agent'
                ? 'basic'
                : kind === 'tool'
                  ? 'connection'
                  : 'all'
            "
            :options="options"
            :resources="resources"
            :disabled="busy"
            full-width
            @refresh-options="refreshOptions"
            @valid="(value) => (toolContentValid = value)"
          />
          <ElCollapse v-if="kind === 'tool'">
            <ElCollapseItem title="自定义标识（可选）" name="key">
              <ElForm label-position="top" :disabled="busy">
                <ElFormItem label="稳定 Key">
                  <ElInput
                    :model-value="
                      config.type === 'builtin' ? config.target : key
                    "
                    :disabled="config.type === 'builtin'"
                    maxlength="80"
                    placeholder="留空自动生成；自定义使用小写字母、数字和下划线"
                    @update:model-value="key = $event"
                  />
                </ElFormItem>
              </ElForm>
            </ElCollapseItem>
          </ElCollapse>
        </template>
        <ElAlert
          v-for="(d, i) in visibleImportDiagnostics"
          :key="i"
          :title="d.message"
          :type="d.severity === 'error' ? 'error' : 'warning'"
          :closable="false"
          class="mt-3"
        />
      </div>
      <template #footer
        ><ElButton :disabled="busy" @click="closeCreate()">取消</ElButton
        ><ElButton
          type="primary"
          :loading="busy"
          :disabled="busy"
          @click="create"
          >创建</ElButton
        ></template
      ></ElDialog
    >
    <ElDialog
      class="management-dialog"
      body-class="management-dialog-body"
      header-class="management-dialog-header"
      footer-class="management-dialog-footer"
      append-to-body
      v-model="importOpen"
      title="导入 Skill"
      width="min(760px,95vw)"
      :close-on-click-modal="false"
      :before-close="closeImport"
      :show-close="!busy"
      :close-on-press-escape="!busy"
      ><div class="mb-3 space-y-3">
        <ElSegmented
          v-model="importKind"
          :options="[
            { label: 'SKILL.md', value: 'document' },
            { label: '完整包 JSON', value: 'bundle' },
          ]"
          :disabled="busy"
        />
        <ElUpload
          :auto-upload="false"
          :show-file-list="false"
          :on-change="importSkillFile"
          :disabled="busy"
          accept=".md,.json"
        >
          <ElButton :loading="busy">读取本地文件</ElButton>
          <template #tip
            ><span class="text-muted-foreground text-sm"
              >完整包保留正文与辅助资料，最多 384
              KiB。只解析内容，不执行代码或自动授予权限。</span
            ></template
          >
        </ElUpload>
      </div>
      <ElAlert
        v-if="importError"
        :title="importError"
        type="error"
        :closable="false"
        class="mb-3"
      /><ElInput
        v-model="document"
        type="textarea"
        :rows="18"
        :placeholder="
          importKind === 'bundle'
            ? 'agent-skill-bundle JSON（version: 1、document、resources）'
            : 'YAML frontmatter + Markdown 正文'
        "
        :disabled="busy"
      /><template #footer
        ><ElButton type="primary" :loading="busy" @click="importDocument"
          >解析并检查</ElButton
        ></template
      ></ElDialog
    >
    <ElDialog
      class="management-dialog"
      body-class="management-dialog-body"
      header-class="management-dialog-header"
      footer-class="management-dialog-footer"
      append-to-body
      :model-value="copyOpen"
      title="复制 Agent"
      width="min(600px,95vw)"
      :close-on-click-modal="false"
      :before-close="closeCopy"
    >
      <ElAlert
        v-if="actionError"
        :title="actionError"
        type="error"
        :closable="false"
        class="mb-4"
      />
      <p class="mb-4 text-sm text-muted-foreground">
        {{
          copySource?.published ? "复制当前生效版本" : "复制已保存草稿"
        }}；依赖继续固定版本，原 Agent 不受影响。
      </p>
      <ElForm label-position="top" :disabled="busy" @submit.prevent="copyAgent"
        ><ElFormItem label="新 Agent 名称" required
          ><ElInput v-model="copyName" maxlength="160" /></ElFormItem
      ></ElForm>
      <template #footer
        ><ElButton :disabled="busy" @click="closeCopy()">取消</ElButton
        ><ElButton
          type="primary"
          :loading="busy"
          :disabled="!copyName.trim()"
          @click="copyAgent"
          >复制并编辑</ElButton
        ></template
      >
    </ElDialog>
    <WorkflowTestDialog
      v-model="workflowTestOpen"
      :version-id="selected"
      @tested="workflowTested"
    />
    <ElDialog
      class="management-dialog"
      body-class="management-dialog-body"
      header-class="management-dialog-header"
      footer-class="management-dialog-footer"
      append-to-body
      v-model="testOpen"
      title="真实工具测试"
      width="600"
      ><ElAlert
        title="执行已保存版本，可能产生外部副作用。"
        type="warning"
        :closable="false"
      /><JsonEditor
        v-model="testInput"
        kind="object"
        label="工具测试参数"
        @valid="toolTestValid = $event"
        class="mt-4"
      /><template #footer
        ><ElButton
          type="primary"
          :disabled="busy || !toolTestValid"
          @click="test(true)"
          >确认执行</ElButton
        ></template
      ></ElDialog
    >
  </Page>
</template>
