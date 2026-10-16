<script setup lang="ts">
import { ref, computed, watch, onMounted, onBeforeUnmount } from "vue";
import { useRoute, useRouter } from "vue-router";
import { Page } from "@vben/common-ui";
import { Eye, EyeOff } from "@vben/icons";
import { useAccessStore } from "@vben/stores";
import {
  ElTabs,
  ElTabPane,
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
  ElSwitch,
  ElMessage,
  ElMessageBox,
  ElAlert,
  ElTag,
  ElTooltip,
  ElSegmented,
  ElCollapse,
  ElCollapseItem,
} from "element-plus";
import { useUnsavedChanges } from "#/composables/use-unsaved-changes";
import { managementApi as api } from "#/api/management";
import ManagementHeader from "#/components/ManagementHeader.vue";
import ResourceActions from "./resource-actions.vue";
import { useWorkspaceStore } from "#/store/workspace";
import PagePanel from "#/components/PagePanel.vue";
import ModelTestResult from "./test-result.vue";
const workspace = useWorkspaceStore();
const route = useRoute(),
  router = useRouter(),
  access = useAccessStore();
const kind = computed(() => String(route.meta.modelKind)),
  base = computed(() => `/model-management/${kind.value}`),
  canManage = computed(() =>
    access.accessCodes.includes(
      `${kind.value === "llm" ? "model_profiles" : "embedding_profiles"}.manage`,
    ),
  );
const data = ref<any>({ accounts: [], deployments: [], versions: [] }),
  loading = ref(false),
  failed = ref(false),
  busy = ref(false),
  tab = ref("plans"),
  dialog = ref(""),
  editId = ref<number>(),
  form = ref<any>({}),
  modelIds = ref<string[]>([]),
  fetching = ref(false),
  fetched = ref(false),
  result = ref<any>();
const primary = ref<number>(),
  backups = ref<number[]>([]);
const resultTitle = ref("");
const actionError = ref("");
const search = ref("");
const resourceState = ref("active");
const platforms = computed(() => data.value.platforms ?? []);
const deploymentResults = ref<Record<number, any>>({});
const testing = ref("");
const includeRemoved = ref(false);
const resultOpen = ref(false);
const credentialOpen = ref(false);
const credentialPassword = ref("");
const credentialError = ref("");
const credentialAction = ref<"view" | "copy">("view");
const visibleCredential = ref("");
const replacingCredential = ref(false);
const credentialBusy = ref(false);
const credentialGrant = ref<{
  token: string;
  expires: number;
  scope: string;
}>();
let credentialTimer: ReturnType<typeof setTimeout> | undefined;
const canReveal = computed(
  () =>
    canManage.value && access.accessCodes.includes("model_credentials.reveal"),
);
const planRows = computed(() =>
  (data.value.plans ?? []).map((p: any) => {
    const versions = data.value.versions.filter((v: any) => v.plan_id === p.id);
    const published = versions.find((v: any) => v.id === p.current_version_id);
    const editable =
      versions.find((v: any) => v.status === "draft") ??
      published ??
      versions[0];
    return {
      ...editable,
      ...{ name: p.name, deleted_at: p.deleted_at, archived_at: p.archived_at },
      plan_id: p.id,
      published,
    };
  }),
);
const readOnly = computed(() => !!form.value.removed);
function clearCredential() {
  visibleCredential.value = "";
  credentialPassword.value = "";
  if (credentialTimer) clearTimeout(credentialTimer);
}
function toggleCredentialReplacement() {
  clearCredential();
  credentialOpen.value = false;
  form.value.apiKey = "";
  replacingCredential.value = !replacingCredential.value;
}
function hideOnBlur() {
  if (document.hidden) clearCredential();
}
onMounted(() => document.addEventListener("visibilitychange", hideOnBlur));
onBeforeUnmount(() => {
  clearCredential();
  credentialGrant.value = undefined;
  document.removeEventListener("visibilitychange", hideOnBlur);
});
async function credential(action: "view" | "copy") {
  credentialAction.value = action;
  const scope = `${base.value}:${editId.value}`;
  if (
    !credentialGrant.value ||
    credentialGrant.value.scope !== scope ||
    credentialGrant.value.expires < Date.now()
  ) {
    credentialPassword.value = "";
    credentialError.value = "";
    credentialOpen.value = true;
    return;
  }
  await obtainCredential();
}
async function obtainCredential() {
  if (credentialBusy.value) return;
  const accountId = editId.value,
    requestBase = base.value;
  const scope = `${requestBase}:${accountId}`;
  credentialBusy.value = true;
  credentialError.value = "";
  try {
    if (
      !credentialGrant.value ||
      credentialGrant.value.scope !== scope ||
      credentialGrant.value.expires < Date.now()
    ) {
      const grant = await api.post(
        `${requestBase}/accounts/${accountId}/credential/unlock`,
        { password: credentialPassword.value },
      );
      credentialPassword.value = "";
      if (
        base.value !== requestBase ||
        editId.value !== accountId ||
        dialog.value !== "account"
      )
        return;
      credentialGrant.value = {
        token: grant.token,
        expires: Date.now() + grant.expiresIn * 1000,
        scope,
      };
    }
    const response = await api.post(
      `${requestBase}/accounts/${accountId}/credential/reveal`,
      { token: credentialGrant.value.token, action: credentialAction.value },
    );
    if (
      base.value !== requestBase ||
      editId.value !== accountId ||
      dialog.value !== "account" ||
      replacingCredential.value
    )
      return;
    credentialOpen.value = false;
    if (credentialAction.value === "copy") {
      await navigator.clipboard.writeText(response.apiKey);
      ElMessage.success("凭据已复制");
    } else {
      visibleCredential.value = response.apiKey;
      if (credentialTimer) clearTimeout(credentialTimer);
      credentialTimer = setTimeout(clearCredential, 30000);
    }
  } catch {
    credentialGrant.value = undefined;
    credentialError.value =
      "凭据验证、读取或复制失败，请检查密码、凭据权限与浏览器剪贴板权限后重试。";
    actionError.value = credentialError.value;
  } finally {
    credentialPassword.value = "";
    credentialBusy.value = false;
  }
}
function showResult(value: any, title = "模型测试") {
  result.value = value;
  resultTitle.value = title;
  resultOpen.value = true;
}
function platformChanged(key: string) {
  if (editId.value) return;
  form.value.baseUrl =
    platforms.value.find((p: any) => p.key === key)?.baseUrl ?? "";
}
const available = computed(() =>
  data.value.deployments.filter(
    (d: any) => d.enabled && !d.deleted_at && !d.archived_at,
  ),
);
const saved = ref("");
const fingerprint = () =>
  JSON.stringify([form.value, primary.value, backups.value]);
const dirty = computed(
  () =>
    !!dialog.value &&
    canManage.value &&
    !readOnly.value &&
    fingerprint() !== saved.value,
);
const leave = useUnsavedChanges(dirty);
const visible = (rows: any[]) =>
  rows.filter(
    (row: any) =>
      Boolean(row.deleted_at || row.archived_at) === includeRemoved.value &&
      (!search.value ||
        `${row.name} ${row.config?.model ?? ""}`
          .toLowerCase()
          .includes(search.value.toLowerCase())),
  );
function remember() {
  saved.value = fingerprint();
}
async function closeDialog(done?: () => void) {
  if (await leave()) {
    clearCredential();
    credentialOpen.value = false;
    dialog.value = "";
    done?.();
  }
}
let loadGeneration = 0;
async function load() {
  const generation = ++loadGeneration,
    scope = workspace.generation;
  loading.value = true;
  failed.value = false;
  try {
    const requestBase = base.value;
    const response = await api.get(
      `${requestBase}?includeRemoved=${includeRemoved.value}`,
    );
    if (
      generation === loadGeneration &&
      scope === workspace.generation &&
      requestBase === base.value
    )
      data.value = response;
  } catch {
    if (generation === loadGeneration && scope === workspace.generation)
      failed.value = true;
  } finally {
    if (generation === loadGeneration && scope === workspace.generation)
      loading.value = false;
  }
}
async function run(fn: () => Promise<unknown>) {
  if (busy.value) return;
  busy.value = true;
  actionError.value = "";
  try {
    await fn();
  } catch (error: any) {
    const text =
      error.response?.data?.error?.message ?? error.response?.data?.message;
    actionError.value = Array.isArray(text)
      ? text.join("；")
      : typeof text === "string"
        ? text
        : (error.message ?? "操作失败，请重试");
  } finally {
    busy.value = false;
  }
}
function openAccount(a?: any) {
  actionError.value = "";
  clearCredential();
  replacingCredential.value = false;
  editId.value = a?.id;
  form.value = {
    name: a?.name ?? "",
    removed: !!(a?.deleted_at || a?.archived_at),
    keySource: a?.keySource,
    apiKeyPreview: a?.apiKeyPreview,
    platformKey: a?.platform_key ?? platforms.value[0]?.key ?? "custom",
    baseUrl: a?.base_url ?? platforms.value[0]?.baseUrl ?? "",
    apiKey: "",
    enabled: a?.enabled ?? true,
  };
  dialog.value = "account";
  remember();
}
function openDeployment(d?: any) {
  actionError.value = "";
  clearCredential();
  editId.value = d?.id;
  modelIds.value = [];
  fetched.value = false;
  form.value = {
    name: d?.name ?? "",
    removed: !!(d?.deleted_at || d?.archived_at),
    accountId:
      d?.account_id ??
      data.value.accounts.find(
        (a: any) => a.enabled && !a.deleted_at && !a.archived_at,
      )?.id,
    enabled: d?.enabled ?? true,
    config: JSON.parse(
      JSON.stringify(
        d?.config ??
          (kind.value === "llm"
            ? {
                provider: "openai-compatible",
                model: "",
                timeoutMs: 20000,
                contextWindowTokens: 32000,
                maxOutputTokens: 1200,
                maxRetries: 3,
                streamUsage: true,
                supportsImageInput: false,
              }
            : {
                provider: "openai-compatible",
                model: "",
                timeoutMs: 30000,
                dimensions: 1024,
                maxInputChars: 8000,
                batchSize: 16,
              }),
      ),
    ),
  };
  if (kind.value === "llm") {
    form.value.config.streamUsage ??= true;
    form.value.config.supportsImageInput ??= false;
  }
  dialog.value = "deployment";
  remember();
}
function openPlan(v?: any) {
  if (v) {
    void router.push(`/models/${kind.value}/plans/${v.plan_id}`);
    return;
  }
  clearCredential();
  actionError.value = "";
  editId.value = undefined;
  form.value = { name: "", removed: false };
  primary.value = available.value[0]?.id;
  backups.value = [];
  dialog.value = "plan";
  remember();
}
async function fetchModels() {
  if (!form.value.accountId) return ElMessage.warning("请先选择供应商");
  const requestForm = form.value;
  const accountId = requestForm.accountId;
  const requestBase = base.value;
  const isCurrent = () =>
    dialog.value === "deployment" &&
    form.value === requestForm &&
    form.value.accountId === accountId &&
    base.value === requestBase;
  fetching.value = true;
  try {
    const r = await api.get(`${requestBase}/accounts/${accountId}/models`);
    if (!isCurrent()) return;
    modelIds.value = r.models ?? [];
    fetched.value = true;
    ElMessage.success(
      modelIds.value.length
        ? "已获取模型，可搜索或自行输入"
        : "没有可用列表，请自行填写",
    );
  } catch {
    if (!isCurrent()) return;
    modelIds.value = [];
    fetched.value = true;
    ElMessage.info("获取失败，请自行输入模型 ID");
  } finally {
    fetching.value = false;
  }
}
async function persist() {
  if (dialog.value === "plan") {
    if (!primary.value) throw new Error("请选择主模型部署");
    const deploymentIds = [
      primary.value,
      ...(kind.value === "llm"
        ? backups.value.filter((id) => id !== primary.value)
        : []),
    ];
    const created = await api.post(`${base.value}/plans`, {
      name: form.value.name,
      deploymentIds,
    });
    await load();
    const version = data.value.versions.find((v: any) => v.id === created.id);
    if (!version) throw new Error("方案已创建，请刷新列表确认");
    editId.value = version.id;
    remember();
    return version.plan_id;
  }
  if (dialog.value === "account") {
    if (editId.value)
      await api.patch(`${base.value}/accounts/${editId.value}`, {
        name: form.value.name,
        enabled: form.value.enabled,
        ...(form.value.apiKey ? { apiKey: form.value.apiKey } : {}),
      });
    else
      await api.post(`${base.value}/accounts`, {
        name: form.value.name,
        platformKey: form.value.platformKey,
        baseUrl: form.value.baseUrl,
        apiKey: form.value.apiKey,
      });
    clearCredential();
    credentialGrant.value = undefined;
  } else {
    const body = {
      name: form.value.name,
      accountId: form.value.accountId,
      enabled: form.value.enabled,
      config: form.value.config,
    };
    if (editId.value)
      await api.patch(`${base.value}/deployments/${editId.value}`, body);
    else await api.post(`${base.value}/deployments`, body);
  }
  remember();
  return undefined;
}
async function save() {
  await run(async () => {
    const planId = await persist();
    dialog.value = "";
    if (planId) await router.push(`/models/${kind.value}/plans/${planId}`);
    else await load();
    ElMessage.success("已保存");
  });
}
async function test(path: string, confirm = true) {
  if (confirm)
    try {
      await ElMessageBox.confirm("测试会真实调用供应商，继续？", "模型测试");
    } catch {
      return;
    }
  const requestBase = base.value;
  const id = Number(path.split("/")[1]);
  const isPlan = path.startsWith("versions/");
  const target = (isPlan ? data.value.versions : data.value.deployments).find(
    (item: any) => item.id === id,
  );
  resultTitle.value = target?.name || form.value.name || "模型测试";
  result.value = undefined;
  resultOpen.value = true;
  testing.value = path;
  busy.value = true;
  try {
    const response = await api.post(`${requestBase}/${path}/test`);
    if (base.value !== requestBase) return;
    result.value = response;
    if (!isPlan) deploymentResults.value[id] = response;
    await load();
  } catch (error: any) {
    if (base.value !== requestBase) return;
    const message =
      error.response?.data?.error?.message ?? error.response?.data?.message;
    result.value = {
      ok: false,
      stage: "request",
      status: error.response?.status,
      message:
        typeof message === "string"
          ? message
          : "测试请求失败，请检查网络或稍后重试",
    };
    if (!isPlan) deploymentResults.value[id] = result.value;
  } finally {
    testing.value = "";
    busy.value = false;
  }
}
watch(
  () => [kind.value, workspace.generation],
  () => {
    clearCredential();
    credentialGrant.value = undefined;
    credentialOpen.value = false;
    resultOpen.value = false;
    dialog.value = "";
    data.value = { accounts: [], deployments: [], versions: [], plans: [] };
    tab.value = ["plans", "deployments", "accounts"].includes(
      String(route.query.tab),
    )
      ? String(route.query.tab)
      : "plans";
    result.value = undefined;
    deploymentResults.value = {};
    void load();
  },
  { immediate: true },
);
watch(resourceState, () => {
  includeRemoved.value = resourceState.value === "removed";
  void load();
});
watch(
  () => route.query.tab,
  (value) => {
    if (["plans", "deployments", "accounts"].includes(String(value)))
      tab.value = String(value);
  },
);
</script>
<template>
  <Page>
    <ManagementHeader :title="kind === 'llm' ? '大语言模型' : '向量模型'">
      <ElButton :disabled="busy || loading" @click="load">刷新</ElButton>
      <ElButton
        v-if="canManage"
        type="primary"
        :disabled="busy"
        @click="
          tab === 'plans'
            ? openPlan()
            : tab === 'deployments'
              ? openDeployment()
              : openAccount()
        "
        >{{
          tab === "plans"
            ? "新建方案"
            : tab === "deployments"
              ? "新增模型配置"
              : "新增供应商"
        }}</ElButton
      >
    </ManagementHeader>
    <ElAlert
      v-if="failed"
      title="模型配置加载失败，请重试"
      type="error"
      :closable="false"
      class="mb-4"
    />
    <ElAlert
      v-if="actionError && !dialog"
      :title="actionError"
      type="error"
      :closable="false"
      class="mb-4"
    />
    <PagePanel v-loading="loading">
      <ElTabs v-model="tab"
        ><ElTabPane label="模型方案" name="plans" /><ElTabPane
          label="模型配置"
          name="deployments" /><ElTabPane label="供应商连接" name="accounts"
      /></ElTabs>
      <div class="mb-4 flex flex-wrap items-center justify-between gap-3">
        <ElInput
          v-model="search"
          clearable
          class="max-w-xs"
          placeholder="搜索名称或模型"
        /><ElSegmented
          v-model="resourceState"
          :options="[
            { label: '正常资源', value: 'active' },
            { label: '已移除', value: 'removed' },
          ]"
        />
      </div>
      <ElTable v-if="tab === 'plans'" :data="visible(planRows)">
        <ElTableColumn label="方案名称" min-width="180"
          ><template #default="{ row }"
            ><ElButton link type="primary" @click="openPlan(row)">{{
              row.name
            }}</ElButton></template
          ></ElTableColumn
        >
        <ElTableColumn label="配置状态" min-width="150"
          ><template #default="{ row }"
            ><ElTag
              :type="
                row.deleted_at || row.archived_at
                  ? 'info'
                  : !row.published ||
                      (row.status === 'draft' &&
                        JSON.stringify(row.config) !==
                          JSON.stringify(row.published.config))
                    ? 'warning'
                    : 'success'
              "
              >{{
                row.deleted_at
                  ? "已删除"
                  : row.archived_at
                    ? "已归档"
                    : !row.published
                      ? "尚未发布"
                      : row.status === "draft" &&
                          JSON.stringify(row.config) !==
                            JSON.stringify(row.published.config)
                        ? "有未发布修改"
                        : "已发布"
              }}</ElTag
            ></template
          ></ElTableColumn
        >
        <ElTableColumn label="当前主模型" min-width="200"
          ><template #default="{ row }"
            >{{ (row.published ?? row).config.deployments[0]?.name }} ·
            {{
              (row.published ?? row).config.deployments[0]?.config.model
            }}</template
          ></ElTableColumn
        >
        <ElTableColumn v-if="kind === 'llm'" label="备用模型" width="110"
          ><template #default="{ row }"
            >{{
              Math.max(0, (row.published ?? row).config.deployments.length - 1)
            }}
            个</template
          ></ElTableColumn
        >
        <ElTableColumn label="最近测试" min-width="120"
          ><template #default="{ row }"
            ><ElButton
              v-if="row.test_result"
              link
              :type="row.test_result.ok ? 'success' : 'danger'"
              @click="showResult(row.test_result, row.name)"
              >{{ row.test_result.ok ? "通过" : "失败" }}</ElButton
            ><span v-else>—</span></template
          ></ElTableColumn
        >
        <ElTableColumn label="操作" width="100"
          ><template #default="{ row }"
            ><ResourceActions
              :resource="{ ...row, id: row.plan_id }"
              :kind="kind"
              type="plans"
              :can-manage="canManage"
              @changed="load" /></template
        ></ElTableColumn>
      </ElTable>
      <ElTable
        v-else-if="tab === 'deployments'"
        :data="visible(data.deployments)"
      >
        <ElTableColumn label="名称" min-width="180"
          ><template #default="{ row }"
            ><ElButton link type="primary" @click="openDeployment(row)">{{
              row.name
            }}</ElButton></template
          ></ElTableColumn
        >
        <ElTableColumn label="模型" min-width="190"
          ><template #default="{ row }">{{
            row.config.model
          }}</template></ElTableColumn
        >
        <ElTableColumn label="供应商" min-width="150"
          ><template #default="{ row }">{{
            data.accounts.find((a: any) => a.id === row.account_id)?.name ??
            "已移除连接"
          }}</template></ElTableColumn
        >
        <ElTableColumn label="状态" width="100"
          ><template #default="{ row }">{{
            row.deleted_at
              ? "已删除"
              : row.archived_at
                ? "已归档"
                : row.enabled
                  ? "启用"
                  : "停用"
          }}</template></ElTableColumn
        >
        <ElTableColumn label="操作" min-width="150"
          ><template #default="{ row }"
            ><ElButton
              v-if="canManage && !row.deleted_at && !row.archived_at"
              link
              :disabled="busy"
              @click="test(`deployments/${row.id}`)"
              >测试</ElButton
            ><ResourceActions
              :resource="row"
              :kind="kind"
              type="deployments"
              :can-manage="canManage"
              @changed="load" /></template
        ></ElTableColumn>
      </ElTable>
      <ElTable v-else :data="visible(data.accounts)">
        <ElTableColumn label="名称" min-width="150"
          ><template #default="{ row }"
            ><ElButton link type="primary" @click="openAccount(row)">{{
              row.name
            }}</ElButton></template
          ></ElTableColumn
        >
        <ElTableColumn label="平台" min-width="110"
          ><template #default="{ row }">{{
            platforms.find((p: any) => p.key === row.platform_key)?.label ??
            row.platform_key
          }}</template></ElTableColumn
        >
        <ElTableColumn
          label="API 地址"
          prop="base_url"
          min-width="230"
          show-overflow-tooltip
        /><ElTableColumn label="凭据" prop="apiKeyPreview" width="150" />
        <ElTableColumn label="状态" width="100"
          ><template #default="{ row }">{{
            row.deleted_at
              ? "已删除"
              : row.archived_at
                ? "已归档"
                : row.enabled
                  ? "启用"
                  : "停用"
          }}</template></ElTableColumn
        >
        <ElTableColumn label="操作" width="100"
          ><template #default="{ row }"
            ><ResourceActions
              :resource="row"
              :kind="kind"
              type="accounts"
              :can-manage="canManage"
              @changed="load" /></template
        ></ElTableColumn>
      </ElTable>
    </PagePanel>
    <ElDialog
      class="management-dialog"
      body-class="management-dialog-body"
      header-class="management-dialog-header"
      footer-class="management-dialog-footer"
      append-to-body
      :model-value="!!dialog"
      :title="`${editId ? '查看 / 编辑' : '新建'}${dialog === 'account' ? '供应商' : dialog === 'deployment' ? '模型部署' : '模型方案'}`"
      width="min(760px,95vw)"
      :close-on-click-modal="false"
      :before-close="closeDialog"
      @close="dialog = ''"
      ><div>
        <ElForm
          label-position="top"
          :disabled="!canManage || readOnly || busy"
          class="grid grid-cols-1 gap-x-4 sm:grid-cols-2"
          ><ElFormItem label="名称" required
            ><ElInput v-model="form.name" :disabled="readOnly"
          /></ElFormItem>
          <template v-if="dialog === 'account'">
            <ElFormItem label="平台"
              ><ElSelect
                v-model="form.platformKey"
                :disabled="!!editId"
                @change="platformChanged"
                ><ElOption
                  v-for="p in platforms"
                  :key="p.key"
                  :value="p.key"
                  :label="p.label" /></ElSelect></ElFormItem
            ><ElFormItem label="Base URL" class="sm:col-span-2" required
              ><ElInput
                v-model.trim="form.baseUrl"
                type="url"
                :disabled="!!editId"
                placeholder="填写 HTTP 或 HTTPS API 地址" /></ElFormItem
            ><ElFormItem
              :label="
                replacingCredential ? '更换 API Key（留空保留）' : 'API Key'
              "
              :required="!editId"
            >
              <div class="flex w-full items-center gap-2">
                <ElInput
                  v-if="editId && !replacingCredential"
                  :model-value="
                    visibleCredential || form.apiKeyPreview || '未配置'
                  "
                  readonly
                  autocomplete="off"
                  aria-label="当前 API Key"
                  class="flex-1"
                >
                  <template #suffix>
                    <ElTooltip
                      :content="
                        form.keySource === 'environment'
                          ? '环境凭据在部署配置中维护，不能查看完整 Key'
                          : !canReveal
                            ? '查看完整 Key 需要独立凭据权限'
                            : visibleCredential
                              ? '隐藏 API Key'
                              : '验证身份后查看完整 API Key'
                      "
                    >
                      <ElButton
                        link
                        :icon="visibleCredential ? EyeOff : Eye"
                        :loading="credentialBusy"
                        :disabled="!canReveal || form.keySource !== 'managed'"
                        :aria-label="
                          visibleCredential
                            ? '隐藏 API Key'
                            : '查看完整 API Key'
                        "
                        :aria-pressed="!!visibleCredential"
                        @click="
                          visibleCredential
                            ? clearCredential()
                            : credential('view')
                        "
                      />
                    </ElTooltip>
                  </template>
                </ElInput>
                <ElInput
                  v-else
                  v-model="form.apiKey"
                  type="password"
                  show-password
                  autocomplete="new-password"
                  :placeholder="
                    editId ? '输入新 Key，留空保留当前凭据' : '输入 API Key'
                  "
                  class="flex-1"
                />
                <ElButton
                  v-if="
                    editId &&
                    !replacingCredential &&
                    canReveal &&
                    form.keySource === 'managed'
                  "
                  :loading="credentialBusy"
                  @click="credential('copy')"
                  >复制</ElButton
                >
                <ElTooltip v-if="editId" content="未更换或留空时保留当前凭据">
                  <ElButton
                    :disabled="credentialBusy"
                    @click="toggleCredentialReplacement"
                  >
                    {{ replacingCredential ? "取消更换" : "更换" }}
                  </ElButton>
                </ElTooltip>
              </div>
            </ElFormItem>
            <ElFormItem v-if="editId" label="启用"
              ><ElSwitch v-model="form.enabled" /></ElFormItem
          ></template>
          <template v-if="dialog === 'deployment'"
            ><ElFormItem label="供应商" required
              ><ElSelect
                v-model="form.accountId"
                filterable
                @change="
                  modelIds = [];
                  fetched = false;
                "
                ><ElOption
                  v-for="a in data.accounts"
                  :key="a.id"
                  :value="a.id"
                  :label="a.name"
                  :disabled="
                    !a.enabled || !!a.deleted_at || !!a.archived_at
                  " /></ElSelect></ElFormItem
            ><ElFormItem label="模型" class="sm:col-span-2" required
              ><div class="flex w-full gap-2">
                <ElSelect
                  v-if="fetched && modelIds.length"
                  v-model="form.config.model"
                  filterable
                  allow-create
                  default-first-option
                  class="flex-1"
                  ><ElOption
                    v-for="m in modelIds"
                    :key="m"
                    :value="m"
                    :label="m" /></ElSelect
                ><ElInput
                  v-else
                  v-model="form.config.model"
                  placeholder="输入模型 ID"
                  class="flex-1"
                /><ElButton :loading="fetching" @click="fetchModels"
                  >获取模型列表</ElButton
                >
              </div></ElFormItem
            >
            <ElFormItem label="提供协议"
              ><ElSelect v-model="form.config.provider"
                ><ElOption
                  value="openai-compatible"
                  label="OpenAI 兼容" /><ElOption
                  v-if="kind === 'embedding'"
                  value="volcengine-multimodal"
                  label="火山多模态" /></ElSelect
            ></ElFormItem>
            <ElFormItem
              v-for="field in kind === 'llm'
                ? ['contextWindowTokens', 'maxOutputTokens']
                : ['dimensions']"
              :key="field"
            >
              <template #label>
                {{
                  (
                    {
                      contextWindowTokens: "上下文 Token 上限",
                      maxOutputTokens: "输出 Token 上限",
                      dimensions: "向量维度",
                    } as any
                  )[field]
                }}
                <ElTooltip
                  v-if="field === 'maxOutputTokens'"
                  content="输出预算包含推理 Token。推理模型预算过小时，可能只有推理内容而没有最终回答。"
                >
                  <span
                    class="ml-1 cursor-help text-muted-foreground"
                    tabindex="0"
                    aria-label="输出 Token 预算说明"
                    >ⓘ</span
                  >
                </ElTooltip>
              </template>
              <ElInputNumber
                v-model="form.config[field]"
                :min="1"
                class="w-full"
              />
            </ElFormItem>
            <ElCollapse class="mb-4 sm:col-span-2">
              <ElCollapseItem title="运行设置" name="runtime">
                <div class="grid grid-cols-1 gap-x-4 pt-2 sm:grid-cols-2">
                  <ElFormItem
                    v-for="field in kind === 'llm'
                      ? ['timeoutMs', 'maxRetries']
                      : ['timeoutMs', 'maxInputChars', 'batchSize']"
                    :key="field"
                    :label="
                      (
                        {
                          timeoutMs: '超时（毫秒）',
                          maxRetries: '最大重试次数',
                          maxInputChars: '输入字数上限',
                          batchSize: '批量大小',
                        } as any
                      )[field]
                    "
                  >
                    <ElInputNumber
                      v-model="form.config[field]"
                      :min="field === 'maxRetries' ? 0 : 1"
                      :max="field === 'maxRetries' ? 3 : undefined"
                    />
                  </ElFormItem>
                  <ElFormItem v-if="kind === 'llm'" label="流式返回 Token 用量">
                    <ElTooltip
                      content="默认开启。供应商不支持 stream_options 时可关闭；不会自动重发请求。缺失的流式用量标为未知，额度仍保守核算。"
                      placement="top"
                    >
                      <ElSwitch
                        v-model="form.config.streamUsage"
                        aria-label="流式返回 Token 用量"
                      />
                    </ElTooltip>
                  </ElFormItem>
                  <ElFormItem v-if="kind === 'llm'" label="支持图片输入">
                    <ElTooltip
                      content="仅在模型支持图片理解时开启。更新后发布模型方案，并在 Agent 中选择该方案版本再发布。方案内所有主备部署均需支持图片输入。"
                      placement="top"
                      ><ElSwitch
                        v-model="form.config.supportsImageInput"
                        aria-label="支持图片输入"
                    /></ElTooltip>
                  </ElFormItem>
                </div>
              </ElCollapseItem>
            </ElCollapse>
            <ElFormItem label="启用"
              ><ElSwitch v-model="form.enabled" /></ElFormItem
          ></template>
          <template v-if="dialog === 'plan'"
            ><ElFormItem label="主模型" required
              ><ElSelect v-model="primary" filterable class="w-full"
                ><ElOption
                  v-for="d in available"
                  :key="d.id"
                  :value="d.id"
                  :label="`${d.name} · ${d.config.model}`" /></ElSelect></ElFormItem
            ><ElFormItem
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
                  v-for="d in available.filter((d: any) => d.id !== primary)"
                  :key="d.id"
                  :value="d.id"
                  :label="`${d.name} · ${d.config.model}`" /></ElSelect
            ></ElFormItem>
          </template>
          <ElButton
            v-if="
              dialog === 'deployment' &&
              editId &&
              (deploymentResults[editId] ??
                data.deployments.find((d: any) => d.id === editId)?.test_result)
            "
            link
            @click="
              showResult(
                deploymentResults[editId] ??
                  data.deployments.find((d: any) => d.id === editId)
                    ?.test_result,
                form.name,
              )
            "
            >查看最近测试结果</ElButton
          >
        </ElForm>
      </div>
      <ElAlert
        v-if="actionError"
        :title="actionError"
        type="error"
        :closable="false"
        class="mt-4"
      />
      <ElAlert
        v-if="dialog === 'plan' && !available.length"
        title="暂无可用模型配置，请先配置供应商连接和模型。"
        type="info"
        :closable="false"
        class="mt-4"
        ><ElButton
          link
          type="primary"
          @click="
            dialog = '';
            tab = data.accounts.length ? 'deployments' : 'accounts';
          "
          >去配置</ElButton
        ></ElAlert
      >
      <template #footer
        ><ElButton @click="closeDialog()">关闭</ElButton
        ><ElButton
          v-if="canManage && !readOnly"
          type="primary"
          :loading="busy"
          :disabled="dialog === 'plan' && (!form.name?.trim() || !primary)"
          @click="save"
          >{{ dialog === "plan" ? "创建" : "保存" }}</ElButton
        >
      </template>
    </ElDialog>
    <ElDialog
      class="management-dialog"
      body-class="management-dialog-body"
      header-class="management-dialog-header"
      footer-class="management-dialog-footer"
      v-model="resultOpen"
      :title="resultTitle"
      width="min(760px,95vw)"
      append-to-body
      :close-on-click-modal="!testing"
      :close-on-press-escape="!testing"
      :show-close="!testing"
    >
      <ElAlert
        v-if="testing"
        title="正在验证模型配置，请稍候…"
        type="info"
        :closable="false"
        show-icon
      />
      <ModelTestResult :result="result" :title="resultTitle" />
      <template #footer
        ><ElButton :disabled="!!testing" @click="resultOpen = false"
          >关闭</ElButton
        ></template
      >
    </ElDialog>
    <ElDialog
      class="management-dialog"
      body-class="management-dialog-body"
      header-class="management-dialog-header"
      footer-class="management-dialog-footer"
      v-model="credentialOpen"
      title="验证身份后查看凭据"
      width="min(420px,95vw)"
      append-to-body
      destroy-on-close
      :close-on-click-modal="false"
      @close="credentialPassword = ''"
    >
      <ElAlert
        v-if="credentialError"
        :title="credentialError"
        type="error"
        :closable="false"
        class="mb-4"
      />
      <ElForm label-position="top" @submit.prevent="obtainCredential"
        ><ElFormItem label="当前管理员密码"
          ><ElInput
            v-model="credentialPassword"
            type="password"
            autocomplete="off"
            @keyup.enter="obtainCredential" /></ElFormItem
      ></ElForm>
      <template #footer
        ><ElButton @click="credentialOpen = false">取消</ElButton
        ><ElButton
          type="primary"
          :loading="credentialBusy"
          :disabled="!credentialPassword"
          @click="obtainCredential"
          >验证并{{ credentialAction === "copy" ? "复制" : "查看" }}</ElButton
        ></template
      >
    </ElDialog>
  </Page>
</template>
