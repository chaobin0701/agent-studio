<script setup lang="ts">
import {
  computed,
  defineAsyncComponent,
  onBeforeUnmount,
  ref,
  watch,
} from "vue";
import { useRoute, useRouter } from "vue-router";
import { useAccessStore } from "@vben/stores";
import { Page } from "@vben/common-ui";
import {
  ElAlert,
  ElButton,
  ElDialog,
  ElForm,
  ElFormItem,
  ElInput,
  ElMessage,
  ElMessageBox,
  ElOption,
  ElSelect,
  ElTabPane,
  ElTable,
  ElTableColumn,
  ElTabs,
  ElTag,
} from "element-plus";
import { managementApi as api } from "#/api/management";
import {
  createDraftQueue,
  type DraftSaveState,
} from "#/composables/draft-queue";
import { useUnsavedChanges } from "#/composables/use-unsaved-changes";
import { useWorkspaceStore } from "#/store/workspace";
import ManagementHeader from "#/components/ManagementHeader.vue";
import PagePanel from "#/components/PagePanel.vue";
import HelpTip from "#/components/HelpTip.vue";
import ModelTestResult from "./test-result.vue";
import ResourceActions from "./resource-actions.vue";
const VersionDiff = defineAsyncComponent(
  () => import("../prompts/components/PromptDiff.vue"),
);
const route = useRoute(),
  router = useRouter(),
  access = useAccessStore(),
  workspace = useWorkspaceStore();
const kind = computed(() => String(route.meta.modelKind)),
  base = computed(() => `/model-management/${kind.value}`),
  listPath = computed(() => `/models/${kind.value}`);
const canManage = computed(() =>
  access.accessCodes.includes(
    `${kind.value === "llm" ? "model_profiles" : "embedding_profiles"}.manage`,
  ),
);
const listing = ref<any>({
    plans: [],
    versions: [],
    deployments: [],
    accounts: [],
  }),
  selected = ref<number>(),
  name = ref(""),
  primary = ref<number>(),
  backups = ref<number[]>([]);
const loading = ref(false),
  busy = ref(false),
  error = ref(""),
  result = ref<any>(),
  publishedNotice = ref(false),
  historyOpen = ref(false),
  historyTab = ref("versions"),
  comparisonId = ref<number>();
const saveState = ref<DraftSaveState>({
    saving: false,
    error: "",
    conflict: false,
  }),
  original = ref(""),
  refreshEpoch = ref(0);
let savedRefreshEpoch = 0,
  loadGeneration = 0;
const plan = computed(() =>
  listing.value.plans.find((p: any) => p.id === Number(route.params.id)),
);
const versions = computed(() =>
  listing.value.versions.filter((v: any) => v.plan_id === plan.value?.id),
);
const active = computed(() =>
  versions.value.find((v: any) => v.id === selected.value),
);
const current = computed(() =>
  versions.value.find((v: any) => v.id === plan.value?.current_version_id),
);
const removed = computed(
  () => !!(plan.value?.deleted_at || plan.value?.archived_at),
);
const editable = computed(
  () =>
    canManage.value &&
    !removed.value &&
    active.value?.status === "draft" &&
    active.value.id ===
      versions.value.find((v: any) => v.status === "draft")?.id,
);
function payload() {
  return JSON.stringify({
    name: name.value,
    primary: primary.value,
    backups:
      kind.value === "llm"
        ? backups.value.filter((id) => id !== primary.value)
        : [],
    refreshEpoch: refreshEpoch.value,
  });
}
const dirty = computed(() => editable.value && payload() !== original.value);
const valid = computed(
  () =>
    !!name.value.trim() && name.value.trim().length <= 120 && !!primary.value,
);
const choices = computed(() =>
  listing.value.deployments.filter(
    (d: any) =>
      d.enabled &&
      !d.deleted_at &&
      !d.archived_at &&
      listing.value.accounts.some(
        (a: any) =>
          a.id === d.account_id && a.enabled && !a.deleted_at && !a.archived_at,
      ),
  ),
);
const chosenIds = computed(() =>
  [primary.value, ...backups.value].filter((id): id is number => !!id),
);
const changedDeployments = computed(() =>
  chosenIds.value.filter((id) => {
    const saved = active.value?.config.deployments.find(
        (d: any) => d.id === id,
      ),
      latest = choices.value.find((d: any) => d.id === id);
    return (
      saved &&
      latest &&
      (JSON.stringify(saved.config) !== JSON.stringify(latest.config) ||
        saved.accountId !== latest.account_id)
    );
  }),
);
const missingDeployments = computed(() =>
  chosenIds.value.filter((id) => !choices.value.some((d: any) => d.id === id)),
);
const snapshotChoices = computed(
  () =>
    active.value?.config.deployments.filter(
      (d: any) => !choices.value.some((n: any) => n.id === d.id),
    ) ?? [],
);
const comparison = computed(
  () =>
    versions.value.find((v: any) => v.id === comparisonId.value) ??
    current.value,
);
const status = computed(() =>
  saveState.value.conflict
    ? "草稿冲突"
    : saveState.value.error
      ? "保存失败"
      : saveState.value.saving
        ? "正在保存…"
        : dirty.value
          ? "等待自动保存…"
          : editable.value
            ? "草稿已保存"
            : active.value?.status === "draft"
              ? "草稿 · 只读"
              : "已发布 · 只读",
);
function message(e: any) {
  const text = e.response?.data?.error?.message ?? e.response?.data?.message;
  return Array.isArray(text)
    ? text.join("；")
    : typeof text === "string"
      ? text
      : (e.message ?? "操作失败，请重试");
}
const queue = createDraftQueue({
  read: () =>
    editable.value &&
    dirty.value &&
    valid.value &&
    !missingDeployments.value.length &&
    !busy.value &&
    !loading.value
      ? {
          identity: String(selected.value),
          revision: active.value.revision,
          payload: payload(),
        }
      : undefined,
  write: async (draft) => {
    const body = JSON.parse(draft.payload);
    const version = await api.patch(
      `${base.value}/plans/${plan.value.id}/draft`,
      {
        sourceVersionId: Number(draft.identity),
        revision: draft.revision,
        name: body.name,
        deploymentIds: [body.primary, ...body.backups],
        refreshDeployments: body.refreshEpoch > savedRefreshEpoch,
      },
    );
    return { ...version, revision: version.revision };
  },
  accept: (draft, saved: any) => {
    if (String(selected.value) !== draft.identity) return;
    const body = JSON.parse(draft.payload);
    const unchanged = payload() === draft.payload;
    Object.assign(active.value, saved);
    plan.value.name = saved.name;
    savedRefreshEpoch = body.refreshEpoch;
    if (unchanged) name.value = saved.name;
    original.value = JSON.stringify({ ...body, name: saved.name });
    result.value = undefined;
    publishedNotice.value = false;
  },
  state: (value) => (saveState.value = value),
});
async function flush() {
  if (busy.value || loading.value) return false;
  return (await queue.flush()) && !dirty.value;
}
const leave = useUnsavedChanges(
  computed(() => dirty.value || saveState.value.saving),
  flush,
);
watch(payload, () => {
  publishedNotice.value = false;
  queue.schedule();
});
onBeforeUnmount(queue.dispose);
function adopt(id: number) {
  queue.reset();
  selected.value = id;
  name.value = plan.value?.name ?? "";
  primary.value = active.value?.config.deployments[0]?.id;
  backups.value =
    active.value?.config.deployments.slice(1).map((d: any) => d.id) ?? [];
  refreshEpoch.value = 0;
  savedRefreshEpoch = 0;
  original.value = payload();
  result.value = active.value?.test_result;
  error.value = "";
}
async function load(preferred?: number, prepare = true) {
  const generation = ++loadGeneration,
    path = route.fullPath,
    scope = workspace.generation;
  loading.value = true;
  error.value = "";
  const fresh = () =>
    generation === loadGeneration &&
    path === route.fullPath &&
    scope === workspace.generation;
  try {
    let value = await api.get(`${base.value}?includeRemoved=true`);
    if (!fresh()) return;
    const target = value.plans.find(
      (p: any) => p.id === Number(route.params.id),
    );
    if (!target) throw Error("模型方案不存在或无权访问");
    let all = value.versions.filter((v: any) => v.plan_id === target.id);
    if (
      !preferred &&
      prepare &&
      canManage.value &&
      !target.deleted_at &&
      !target.archived_at &&
      !all.some((v: any) => v.status === "draft")
    ) {
      const draft = await api.post(`${base.value}/plans/${target.id}/draft`, {
        fromVersionId: target.current_version_id ?? undefined,
      });
      preferred = draft.versionId;
      value = await api.get(`${base.value}?includeRemoved=true`);
      if (!fresh()) return;
      all = value.versions.filter((v: any) => v.plan_id === target.id);
    }
    listing.value = value;
    adopt(
      preferred ??
        all.find((v: any) => v.status === "draft")?.id ??
        target.current_version_id ??
        all[0]?.id,
    );
  } catch (e) {
    if (fresh()) error.value = message(e);
  } finally {
    if (fresh()) loading.value = false;
  }
}
async function refresh() {
  if (await leave()) await load(selected.value, false);
}
async function edit(branch = false) {
  if (!(await leave())) return;
  if (branch) {
    try {
      await ElMessageBox.confirm(
        "基于当前查看的历史配置另建草稿？现有草稿保留，不更改 Agent 或知识库绑定。",
        "新建历史草稿",
      );
    } catch {
      return;
    }
  }
  busy.value = true;
  try {
    const draft = await api.post(`${base.value}/plans/${plan.value.id}/draft`, {
      fromVersionId: selected.value,
      branch,
    });
    await load(draft.versionId, false);
  } catch (e) {
    error.value = message(e);
  } finally {
    busy.value = false;
  }
}
async function selectVersion(id: number) {
  if (!(await leave())) return;
  adopt(id);
  historyOpen.value = false;
}
async function syncDeployments() {
  if (!editable.value) return;
  try {
    await ElMessageBox.confirm(
      "将选中的模型配置同步到此草稿？已发布方案、Agent 绑定和知识库索引不会改变；发布前需要重新测试。",
      "同步最新模型配置",
    );
  } catch {
    return;
  }
  refreshEpoch.value++;
  if (await flush()) ElMessage.success("最新模型配置已保存到草稿");
}
async function execute(publish = false) {
  if (!editable.value || busy.value) return;
  if (!(await flush())) return;
  try {
    await ElMessageBox.confirm(
      publish
        ? "发布前将真实测试主模型和备用模型，可能产生供应商费用。测试成功后发布本方案；已有 Agent 和知识库仍固定原版本，需要另行选择更新。是否继续？"
        : "真实测试当前草稿，可能产生供应商费用；测试不会发布配置。是否继续？",
      publish ? "确认发布" : "模型测试",
    );
  } catch {
    return;
  }
  if (!(await flush())) return;
  const versionId = selected.value,
    revision = active.value.revision,
    requestBase = base.value;
  busy.value = true;
  error.value = "";
  publishedNotice.value = false;
  try {
    const response = await api.post(
      `${requestBase}/versions/${versionId}/${publish ? "test-and-publish" : "test"}`,
    );
    if (requestBase !== base.value || versionId !== selected.value) return;
    result.value = response;
    const value = await api.get(`${requestBase}?includeRemoved=true`);
    if (requestBase !== base.value || versionId !== selected.value) return;
    const recorded = value.versions.find((v: any) => v.id === versionId),
      pointer = value.plans.find((p: any) => p.id === plan.value.id);
    if (
      publish &&
      response.ok &&
      (response.published !== true ||
        recorded?.status !== "published" ||
        pointer?.current_version_id !== versionId ||
        recorded?.revision !== revision)
    )
      throw Error("未确认配置已发布，请刷新检查，不能把测试通过当作发布成功");
    listing.value = value;
    if (publish && response.published && response.ok) {
      publishedNotice.value = true;
      ElMessage.success("模型方案已发布");
    } else if (recorded) {
      Object.assign(active.value, recorded);
    }
    result.value = response;
  } catch (e) {
    error.value = message(e);
    if (!result.value)
      result.value = { ok: false, stage: "request", message: error.value };
  } finally {
    busy.value = false;
  }
}
async function rollback(version: any) {
  if (!(await leave())) return;
  try {
    await ElMessageBox.confirm(
      `将本方案当前发布版本恢复为 v${version.version}？已有 Agent 的固定版本和知识库索引不变。`,
      "回滚方案",
      { type: "warning" },
    );
  } catch {
    return;
  }
  busy.value = true;
  try {
    await api.post(`${base.value}/plans/${plan.value.id}/rollback`, {
      versionId: version.id,
      expectedCurrentVersionId: plan.value.current_version_id,
    });
    await load(version.id, false);
    ElMessage.success("方案当前发布版本已恢复");
  } catch (e) {
    error.value = message(e);
  } finally {
    busy.value = false;
  }
}
async function lifecycle(action: string) {
  if (action === "restore") await load();
  else await router.push(listPath.value);
}
const date = (v?: string) => (v ? new Date(v).toLocaleString() : "—");
watch(
  () => [route.fullPath, workspace.generation],
  () => {
    queue.reset();
    listing.value = { plans: [], versions: [], deployments: [], accounts: [] };
    selected.value = undefined;
    void load();
  },
  { immediate: true },
);
</script>
<template>
  <Page>
    <ManagementHeader :title="plan?.name ?? '模型方案'">
      <ElButton :disabled="busy" @click="router.push(listPath)"
        >返回列表</ElButton
      ><ElButton :disabled="busy || saveState.saving" @click="refresh"
        >刷新</ElButton
      >
      <ElButton
        v-if="plan"
        :disabled="busy || saveState.saving"
        @click="historyOpen = true"
        >历史与差异</ElButton
      >
      <ElButton
        v-if="editable"
        :disabled="busy || !valid || saveState.conflict"
        @click="execute()"
        >测试配置</ElButton
      >
      <ElButton
        v-if="editable"
        type="primary"
        :loading="busy"
        :disabled="!valid || saveState.conflict"
        @click="execute(true)"
        >发布</ElButton
      >
      <ElButton
        v-else-if="canManage && plan && !removed"
        type="primary"
        :disabled="busy || loading"
        @click="edit()"
        >编辑／继续草稿</ElButton
      >
      <ResourceActions
        v-if="plan"
        :resource="plan"
        type="plans"
        :kind="kind"
        :can-manage="canManage"
        :before-action="leave"
        @changed="lifecycle"
      />
    </ManagementHeader>
    <ElAlert
      v-if="error"
      class="mb-4"
      type="error"
      :title="error"
      :closable="false"
    />
    <ElAlert
      v-if="saveState.error"
      class="mb-4"
      type="error"
      :title="saveState.error"
      :closable="false"
      ><ElButton v-if="!saveState.conflict" link type="primary" @click="flush"
        >重试保存</ElButton
      ></ElAlert
    >
    <ElAlert
      v-if="publishedNotice"
      class="mb-4"
      type="success"
      title="方案已发布；已有 Agent 和知识库的固定版本未被替换。"
      :closable="false"
    />
    <PagePanel v-if="plan" v-loading="loading || busy" class="space-y-4">
      <div class="flex flex-wrap items-center gap-3" aria-live="polite">
        <ElTag :type="editable ? 'warning' : 'info'">{{
          removed ? "已移除 · 只读" : status
        }}</ElTag
        ><span class="text-sm text-muted-foreground"
          >{{ current ? `当前发布 v${current.version}` : "尚未发布" }} · 查看
          v{{ active?.version }}</span
        >
      </div>
      <ElForm
        label-position="top"
        :disabled="!editable || busy || loading"
        class="grid grid-cols-1 gap-x-4 sm:grid-cols-2"
      >
        <ElFormItem label="方案名称" required
          ><ElInput v-model="name" maxlength="120"
        /></ElFormItem>
        <ElFormItem label="主模型" required
          ><ElSelect v-model="primary" filterable class="w-full">
            <ElOption
              v-for="d in choices"
              :key="d.id"
              :value="d.id"
              :label="`${d.name} · ${active?.config.deployments.find((s: any) => s.id === d.id)?.config.model ?? d.config.model}`"
            />
            <ElOption
              v-for="d in snapshotChoices"
              :key="d.id"
              :value="d.id"
              :label="`${d.name} · 不可用`"
              disabled
            /> </ElSelect
        ></ElFormItem>
        <ElFormItem
          v-if="kind === 'llm'"
          label="备用模型（可选，按选择顺序）"
          class="sm:col-span-2"
          ><ElSelect
            v-model="backups"
            multiple
            filterable
            :multiple-limit="3"
            class="w-full"
            ><ElOption
              v-for="d in choices.filter((d: any) => d.id !== primary)"
              :key="d.id"
              :value="d.id"
              :label="`${d.name} · ${active?.config.deployments.find((s: any) => s.id === d.id)?.config.model ?? d.config.model}`" /><ElOption
              v-for="d in snapshotChoices.filter((d: any) => d.id !== primary)"
              :key="d.id"
              :value="d.id"
              :label="`${d.name} · 不可用`"
              disabled /></ElSelect
        ></ElFormItem>
      </ElForm>
      <ElAlert
        v-if="missingDeployments.length"
        type="warning"
        :closable="false"
        title="所选模型配置或供应商已停用／移除，请替换后发布。"
      />
      <ElAlert
        v-if="changedDeployments.length"
        type="info"
        :closable="false"
        title="模型配置有较新修改，此方案仍保留原快照。"
        ><ElButton
          v-if="editable"
          link
          type="primary"
          :disabled="busy"
          @click="syncDeployments"
          >同步最新模型配置</ElButton
        ></ElAlert
      >
      <div class="flex flex-wrap items-center gap-3 text-sm">
        <ElButton
          link
          type="primary"
          @click="
            router.push({ path: listPath, query: { tab: 'deployments' } })
          "
          >管理模型配置</ElButton
        ><ElButton
          link
          type="primary"
          @click="router.push({ path: listPath, query: { tab: 'accounts' } })"
          >管理供应商连接</ElButton
        ><HelpTip
          text="模型方案保存主模型和备用模型的配置快照。修改连接或模型配置不会自动替换已发布版本；已有 Agent 与知识库也不会随方案发布自动升级。"
          long
        />
      </div>
      <ElAlert
        v-if="result && dirty"
        title="配置已修改，以下是上次已保存配置的测试结果；需要重新测试。"
        type="warning"
        :closable="false"
      />
      <ModelTestResult :result="result" :title="`${name} · 配置测试`" />
    </PagePanel>
    <ElDialog
      class="management-dialog"
      body-class="management-dialog-body"
      header-class="management-dialog-header"
      footer-class="management-dialog-footer"
      append-to-body
      v-model="historyOpen"
      title="历史与差异"
      width="min(1100px,95vw)"
      destroy-on-close
    >
      <ElTabs v-model="historyTab"
        ><ElTabPane name="versions" label="历史版本"
          ><ElTable :data="versions"
            ><ElTableColumn label="版本"
              ><template #default="{ row }"
                >v{{ row.version }}</template
              ></ElTableColumn
            ><ElTableColumn label="状态"
              ><template #default="{ row }">{{
                row.status === "draft"
                  ? "草稿"
                  : row.id === plan?.current_version_id
                    ? "当前发布"
                    : "历史发布"
              }}</template></ElTableColumn
            ><ElTableColumn label="发布时间"
              ><template #default="{ row }">{{
                date(row.published_at)
              }}</template></ElTableColumn
            ><ElTableColumn label="操作" min-width="220"
              ><template #default="{ row }"
                ><ElButton
                  link
                  type="primary"
                  :disabled="busy || saveState.saving"
                  @click="selectVersion(row.id)"
                  >查看</ElButton
                ><ElButton
                  link
                  :disabled="busy"
                  @click="
                    comparisonId = row.id;
                    historyTab = 'diff';
                  "
                  >比较</ElButton
                ><ElButton
                  v-if="
                    canManage &&
                    !removed &&
                    row.status === 'published' &&
                    row.id !== plan?.current_version_id
                  "
                  link
                  type="warning"
                  :disabled="busy"
                  @click="rollback(row)"
                  >回滚</ElButton
                ></template
              ></ElTableColumn
            ></ElTable
          ><ElButton
            v-if="canManage && !removed && active?.status === 'published'"
            class="mt-4"
            :disabled="busy"
            @click="
              edit(true);
              historyOpen = false;
            "
            >基于此版本另建草稿</ElButton
          ></ElTabPane
        ><ElTabPane name="diff" label="配置差异"
          ><ElAlert
            v-if="dirty || saveState.saving"
            title="以下比较已保存的配置；尚未保存的修改不包含在差异中。"
            type="info"
            :closable="false"
            class="mb-4" /><VersionDiff
            v-if="historyOpen && historyTab === 'diff'"
            :left="JSON.stringify(comparison?.config ?? {}, null, 2)"
            :right="JSON.stringify(active?.config ?? {}, null, 2)"
            :left-label="comparison ? `v${comparison.version}` : '无历史配置'"
            :right-label="`v${active?.version} · ${active?.status === 'draft' ? '已保存草稿' : '已发布配置'}`"
            file-name="model-plan.json" /></ElTabPane
      ></ElTabs>
    </ElDialog>
  </Page>
</template>
