<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useAccessStore } from "@vben/stores";
import { Page } from "@vben/common-ui";
import {
  ElAlert,
  ElButton,
  ElCheckbox,
  ElCheckboxGroup,
  ElDatePicker,
  ElDialog,
  ElForm,
  ElFormItem,
  ElInput,
  ElTabPane,
  ElTable,
  ElTableColumn,
  ElTabs,
  ElTag,
  ElMessage,
  ElMessageBox,
} from "element-plus";
import { managementApi as api } from "#/api/management";
import ManagementHeader from "#/components/ManagementHeader.vue";
import PagePanel from "#/components/PagePanel.vue";
import Fields from "./fields.vue";
import { useWorkspaceStore } from "#/store/workspace";
import { useUnsavedChanges } from "#/composables/use-unsaved-changes";
const workspace = useWorkspaceStore();
const route = useRoute(),
  router = useRouter(),
  access = useAccessStore();
const canManage = computed(() =>
  access.accessCodes.includes("integrations.manage"),
);
const applications = ref<any[]>([]),
  agents = ref<any[]>([]),
  detail = ref<any>(),
  config = ref<any>(),
  original = ref("");
const busy = ref(false),
  loading = ref(false),
  error = ref(""),
  search = ref(""),
  tab = ref("configuration"),
  createOpen = ref(false);
const keyOpen = ref(false),
  secretOpen = ref(false),
  secret = ref(""),
  rotateId = ref<string>();
const keyForm = ref({ name: "", scopes: ["chat:write"], expiresAt: "" });
const scopeOptions = [
  { value: "chat:write", label: "执行任务" },
  { value: "conversations:read", label: "读取会话" },
  { value: "conversations:delete", label: "删除会话" },
  { value: "usage:read", label: "读取用量" },
];
const origins = ref("");
const dirty = computed(
  () =>
    !!detail.value &&
    (JSON.stringify(config.value) !== original.value ||
      origins.value !== (detail.value.app.allowedOrigins ?? []).join("\n")),
);
const leave = useUnsavedChanges(dirty);
const visible = computed(() =>
  applications.value.filter(
    (a) =>
      !search.value ||
      `${a.name} ${agents.value.find((v) => v.id === a.agentId)?.name ?? ""}`
        .toLowerCase()
        .includes(search.value.toLowerCase()),
  ),
);
const dates = (v?: string) => (v ? new Date(v).toLocaleString() : "—");
function defaults() {
  return {
    name: "",
    agentId: Number(route.query.agentId) || undefined,
    enabled: true,
    websiteEnabled: false,
    apiEnabled: false,
    allowedOrigins: [],
    scopes: ["chat:write"],
    requestsPerMinute: 20,
    concurrency: 2,
    dailyRequests: 200,
    dailyTokenLimit: 1000000,
    limitSettings: {
      requestsPerMinute: false,
      concurrency: false,
      dailyRequests: false,
      dailyTokenLimit: false,
    },
  };
}
function fields(a: any) {
  return {
    ...Object.fromEntries(Object.keys(defaults()).map((k) => [k, a[k]])),
    limitSettings: a.limitSettings ?? {
      requestsPerMinute: true,
      concurrency: true,
      dailyRequests: true,
      dailyTokenLimit: a.dailyTokenLimit != null,
    },
  };
}
function message(e: any) {
  const text = e.response?.data?.error?.message ?? e.response?.data?.message;
  return Array.isArray(text)
    ? text.join("；")
    : typeof text === "string"
      ? text
      : "操作失败，请检查配置与权限";
}
async function run(work: () => Promise<void>) {
  if (busy.value) return;
  busy.value = true;
  error.value = "";
  try {
    await work();
  } catch (e) {
    error.value = message(e);
  } finally {
    busy.value = false;
  }
}
let loadGeneration = 0;
async function load() {
  const requestGeneration = ++loadGeneration;
  const path = route.fullPath,
    generation = workspace.generation;
  loading.value = true;
  error.value = "";
  try {
    const [list, choices, value] = await Promise.all([
      api.get("/integrations"),
      api.get("/integrations/agent-options"),
      route.params.id
        ? api.get(`/integrations/${route.params.id}`)
        : Promise.resolve(undefined),
    ]);
    if (
      requestGeneration !== loadGeneration ||
      path !== route.fullPath ||
      generation !== workspace.generation
    )
      return;
    applications.value = list;
    agents.value = choices.resources;
    detail.value = value;
    if (value) {
      config.value = fields(value.app);
      original.value = JSON.stringify(config.value);
      origins.value = value.app.allowedOrigins.join("\n");
    }
  } catch (e) {
    if (
      requestGeneration === loadGeneration &&
      path === route.fullPath &&
      generation === workspace.generation
    )
      error.value = message(e);
  } finally {
    if (
      requestGeneration === loadGeneration &&
      path === route.fullPath &&
      generation === workspace.generation
    )
      loading.value = false;
  }
}
async function refresh() {
  if (await leave()) await load();
}
function openCreate() {
  config.value = defaults();
  origins.value = "";
  error.value = "";
  createOpen.value = true;
}
async function save() {
  await run(async () => {
    const payload = {
      ...config.value,
      allowedOrigins: origins.value
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean),
    };
    const value = detail.value
      ? await api.patch(`/integrations/${detail.value.app.id}`, payload)
      : await api.post("/integrations", payload);
    original.value = JSON.stringify(config.value);
    if (detail.value) detail.value.app.allowedOrigins = payload.allowedOrigins;
    createOpen.value = false;
    if (detail.value) await load();
    else await router.push(`/integrations/${value.id}`);
    ElMessage.success("接入配置已保存");
  });
}
function openKey(key?: any) {
  rotateId.value = key?.id;
  keyForm.value = {
    name: key?.name ?? "",
    scopes: [...(key?.scopes ?? ["chat:write"])],
    expiresAt: "",
  };
  error.value = "";
  keyOpen.value = true;
}
async function createKey() {
  if (dirty.value) return ElMessage.warning("请先保存应用权限与连接设置");
  if (rotateId.value) {
    try {
      await ElMessageBox.confirm(
        "轮换后旧密钥立即失效，是否继续？",
        "轮换密钥",
        { type: "warning" },
      );
    } catch {
      return;
    }
  }
  await run(async () => {
    const { expiresAt, ...payload } = keyForm.value;
    const value = await api.post(
      `/integrations/${detail.value.app.id}/keys${rotateId.value ? `/${rotateId.value}/rotate` : ""}`,
      {
        ...payload,
        ...(expiresAt
          ? { expiresAt: new Date(`${expiresAt}T23:59:59`).toISOString() }
          : {}),
      },
    );
    secret.value = value.apiKey;
    keyOpen.value = false;
    secretOpen.value = true;
    await load();
  });
}
async function revoke(key: any) {
  try {
    await ElMessageBox.confirm(
      `撤销“${key.name}”后无法继续使用，是否确认？`,
      "撤销密钥",
      { type: "warning" },
    );
  } catch {
    return;
  }
  await run(async () => {
    await api.post(
      `/integrations/${detail.value.app.id}/keys/${key.id}/revoke`,
    );
    await load();
  });
}
async function copySecret() {
  try {
    await navigator.clipboard.writeText(secret.value);
    ElMessage.success("密钥已复制");
  } catch {
    ElMessage.warning("无法自动复制，请手动复制输入框内容");
  }
}
watch(
  () => [route.fullPath, workspace.generation],
  () => {
    secret.value = "";
    secretOpen.value = false;
    keyOpen.value = false;
    createOpen.value = false;
    detail.value = undefined;
    applications.value = [];
    agents.value = [];
    void load();
  },
  { immediate: true },
);
</script>
<template>
  <Page>
    <ManagementHeader :title="detail?.app.name ?? '应用接入'">
      <ElButton v-if="route.params.id" @click="router.push('/integrations')"
        >返回列表</ElButton
      >
      <ElButton :disabled="busy || loading" @click="refresh">刷新</ElButton>
      <ElButton
        v-if="canManage && !route.params.id"
        type="primary"
        @click="openCreate"
        >新建应用</ElButton
      >
      <ElButton
        v-if="
          detail &&
          access.accessCodes.includes('agent_config.manage') &&
          access.accessCodes.includes('agent_tools.execute')
        "
        :disabled="busy || loading || !detail.app.enabled || dirty"
        @click="
          router.push({
            path: '/agent-playground',
            query: { agentId: String(detail.app.agentId) },
          })
        "
        >试运行</ElButton
      >
      <ElButton
        v-if="canManage && detail"
        type="primary"
        :disabled="!dirty"
        :loading="busy"
        @click="save"
        >保存设置</ElButton
      >
    </ManagementHeader>
    <ElAlert
      v-if="error"
      class="mb-4"
      type="error"
      :title="error"
      :closable="false"
    />
    <PagePanel v-if="!route.params.id">
      <ElInput
        v-model="search"
        class="mb-4 w-full sm:w-72"
        clearable
        placeholder="搜索应用或 Agent"
      />
      <ElTable :data="visible" v-loading="loading">
        <ElTableColumn label="应用" min-width="180"
          ><template #default="{ row }"
            ><ElButton
              link
              type="primary"
              @click="router.push(`/integrations/${row.id}`)"
              >{{ row.name }}</ElButton
            ></template
          ></ElTableColumn
        >
        <ElTableColumn label="Agent" min-width="180"
          ><template #default="{ row }">{{
            agents.find((a) => a.id === row.agentId)?.name ?? "已移除 Agent"
          }}</template></ElTableColumn
        >
        <ElTableColumn label="接入通道"
          ><template #default="{ row }">{{
            [row.websiteEnabled ? "网站" : "", row.apiEnabled ? "API" : ""]
              .filter(Boolean)
              .join("、") || "仅后台试运行"
          }}</template></ElTableColumn
        >
        <ElTableColumn label="状态" width="100"
          ><template #default="{ row }"
            ><ElTag :type="row.enabled ? 'success' : 'info'">{{
              row.enabled ? "启用" : "停用"
            }}</ElTag></template
          ></ElTableColumn
        >
        <ElTableColumn label="每日请求上限" width="140"
          ><template #default="{ row }">{{
            row.limitSettings?.dailyRequests === false
              ? "未开启"
              : row.dailyRequests
          }}</template></ElTableColumn
        >
        <ElTableColumn label="更新时间" min-width="180"
          ><template #default="{ row }">{{
            dates(row.updatedAt)
          }}</template></ElTableColumn
        >
      </ElTable>
    </PagePanel>
    <PagePanel v-else-if="detail" v-loading="loading">
      <ElTabs v-model="tab">
        <ElTabPane name="configuration" label="接入设置" />
        <ElTabPane name="keys" label="API 密钥" />
        <ElTabPane name="usage" label="用量与调用" />
      </ElTabs>
      <template v-if="tab === 'keys'">
        <ElAlert
          v-if="!detail.app.apiEnabled"
          class="mb-4"
          type="info"
          title="API 通道尚未开启；现有密钥不能发起 API 请求。"
          :closable="false"
        />
        <ElButton
          v-if="canManage"
          class="mb-4"
          :disabled="busy || dirty"
          @click="openKey()"
          >创建密钥</ElButton
        >
        <ElTable :data="detail.keys">
          <ElTableColumn label="名称" prop="name" /><ElTableColumn
            label="密钥"
            prop="maskedKey"
          />
          <ElTableColumn label="状态"
            ><template #default="{ row }">{{
              row.revokedAt
                ? "已撤销"
                : row.expiresAt && Date.parse(row.expiresAt) <= Date.now()
                  ? "已过期"
                  : "有效"
            }}</template></ElTableColumn
          >
          <ElTableColumn label="到期时间"
            ><template #default="{ row }">{{
              dates(row.expiresAt)
            }}</template></ElTableColumn
          >
          <ElTableColumn label="操作"
            ><template #default="{ row }"
              ><template v-if="canManage && !row.revokedAt">
                <ElButton link :disabled="busy || dirty" @click="openKey(row)"
                  >轮换</ElButton
                ><ElButton
                  link
                  type="danger"
                  :disabled="busy || dirty"
                  @click="revoke(row)"
                  >撤销</ElButton
                >
              </template></template
            ></ElTableColumn
          >
        </ElTable>
      </template>
      <template v-else-if="tab === 'usage'">
        <div class="mb-4 grid grid-cols-2 gap-4 sm:grid-cols-4">
          <div
            v-for="item in [
              { label: '今日请求', value: detail.usage.requests },
              { label: '完成', value: detail.usage.completed },
              { label: '失败', value: detail.usage.failed },
              { label: '使用 Token', value: detail.usage.totalTokens },
            ]"
            :key="item.label"
          >
            <p class="text-sm text-muted-foreground">{{ item.label }}</p>
            <p class="mt-1 text-xl font-semibold">{{ item.value }}</p>
          </div>
        </div>
        <ElTable :data="detail.recent"
          ><ElTableColumn label="开始时间"
            ><template #default="{ row }">{{
              dates(row.createdAt)
            }}</template></ElTableColumn
          ><ElTableColumn label="状态" prop="status" /><ElTableColumn
            label="Token"
            prop="totalTokens"
          /><ElTableColumn label="执行记录"
            ><template #default="{ row }"
              ><ElButton
                v-if="
                  row.runId && access.accessCodes.includes('conversations.read')
                "
                link
                type="primary"
                @click="router.push(`/executions/${row.runId}`)"
                >查看</ElButton
              ><span v-else>—</span></template
            ></ElTableColumn
          ></ElTable
        >
      </template>
      <div
        v-if="tab === 'configuration'"
        class="mb-4 text-sm text-muted-foreground"
      >
        应用 ID：{{ detail.app.id }}
        <ElButton
          v-if="
            access.accessCodes.includes('agent_config.read') ||
            access.accessCodes.includes('agent_config.manage')
          "
          link
          type="primary"
          @click="router.push(`/agents/${detail.app.agentId}`)"
          >配置 Agent</ElButton
        >
      </div>
      <Fields
        v-if="tab === 'configuration'"
        v-model="config"
        v-model:origins="origins"
        :agents="agents"
        :disabled="!canManage || busy || loading"
      />
    </PagePanel>
    <ElDialog
      class="management-dialog"
      body-class="management-dialog-body"
      header-class="management-dialog-header"
      footer-class="management-dialog-footer"
      append-to-body
      v-model="createOpen"
      title="新建应用"
      width="min(680px, 95vw)"
      :close-on-click-modal="false"
      ><p class="mb-4 text-sm text-muted-foreground">
        默认仅用于后台试运行；发布 Agent 后可开启网站或 API 接入。
      </p>
      <Fields
        v-if="createOpen"
        v-model="config"
        v-model:origins="origins"
        :agents="agents"
        :disabled="busy"
        basic-only
      /><ElAlert
        v-if="error"
        :title="error"
        type="error"
        :closable="false"
      /><template #footer
        ><ElButton :disabled="busy" @click="createOpen = false">取消</ElButton
        ><ElButton
          type="primary"
          :loading="busy"
          :disabled="!config?.name?.trim() || !config?.agentId"
          @click="save"
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
      v-model="keyOpen"
      :title="rotateId ? '轮换 API 密钥' : '创建 API 密钥'"
      width="min(580px,95vw)"
      :close-on-click-modal="false"
    >
      <ElForm label-position="top" :disabled="busy"
        ><ElFormItem label="名称" required
          ><ElInput v-model="keyForm.name" maxlength="100"
        /></ElFormItem>
        <ElFormItem label="权限" required
          ><ElCheckboxGroup v-model="keyForm.scopes"
            ><ElCheckbox
              v-for="s in scopeOptions.filter((s) =>
                detail?.app.scopes.includes(s.value),
              )"
              :key="s.value"
              :value="s.value"
              >{{ s.label }}</ElCheckbox
            ></ElCheckboxGroup
          ></ElFormItem
        >
        <ElFormItem label="到期日期（可选）"
          ><ElDatePicker
            v-model="keyForm.expiresAt"
            value-format="YYYY-MM-DD"
            type="date"
        /></ElFormItem> </ElForm
      ><ElAlert
        v-if="error"
        :title="error"
        type="error"
        :closable="false"
      /><template #footer
        ><ElButton @click="keyOpen = false">取消</ElButton
        ><ElButton
          type="primary"
          :loading="busy"
          :disabled="!keyForm.name.trim() || !keyForm.scopes.length"
          @click="createKey"
          >确认</ElButton
        ></template
      >
    </ElDialog>
    <ElDialog
      class="management-dialog"
      body-class="management-dialog-body"
      header-class="management-dialog-header"
      footer-class="management-dialog-footer"
      append-to-body
      v-model="secretOpen"
      title="保存 API 密钥"
      width="min(660px,95vw)"
      :close-on-click-modal="false"
      @closed="secret = ''"
    >
      <ElAlert
        class="mb-4"
        type="warning"
        title="完整密钥仅显示这一次，请安全保存；关闭后无法再次查看。"
        :closable="false"
      /><ElInput :model-value="secret" readonly aria-label="新 API 密钥" />
      <template #footer
        ><ElButton @click="copySecret">复制密钥</ElButton
        ><ElButton type="primary" @click="secretOpen = false"
          >已保存，关闭</ElButton
        ></template
      >
    </ElDialog>
  </Page>
</template>
