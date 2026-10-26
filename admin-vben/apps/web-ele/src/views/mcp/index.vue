<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useAccessStore } from "@vben/stores";
import { Page } from "@vben/common-ui";
import {
  type FormInstance,
  type FormRules,
  ElButton,
  ElDialog,
  ElForm,
  ElFormItem,
  ElInput,
  ElInputNumber,
  ElTable,
  ElTableColumn,
  ElTag,
  ElAlert,
  ElMessageBox,
  ElMessage,
  ElCollapse,
  ElCollapseItem,
  ElTabs,
  ElTabPane,
} from "element-plus";
import ResourceLifecycle from "#/components/ResourceLifecycle.vue";
import { ElSegmented } from "element-plus";
import PagePanel from "#/components/PagePanel.vue";
import ManagementHeader from "#/components/ManagementHeader.vue";
import {
  newResourceKey,
  validResourceKey,
} from "#/components/create-resource-key";
import HelpTip from "#/components/HelpTip.vue";
import JsonEditor from "#/components/JsonEditor.vue";
import CredentialPicker from "../tools/CredentialPicker.vue";
import { managementApi as api } from "#/api/management";
import { useUnsavedChanges } from "#/composables/use-unsaved-changes";
const route = useRoute(),
  router = useRouter(),
  access = useAccessStore();
const canManage = computed(() =>
  access.accessCodes.includes("agent_config.manage"),
);
const canExecute = computed(() =>
  access.accessCodes.includes("agent_tools.execute"),
);
const lifecycleState = ref("active");
const resourceRemoved = computed(
  () => !!(detail.value?.archivedAt || detail.value?.deletedAt),
);
const editableManage = computed(
  () => canManage.value && !resourceRemoved.value,
);
const servers = ref<any[]>([]),
  detail = ref<any>(),
  selected = ref<number>(),
  busy = ref(false),
  loading = ref(false),
  error = ref(""),
  result = ref<any>(),
  createOpen = ref(false);
const draft = ref({
  key: "",
  name: "",
  config: { url: "", credentialId: null as number | null, timeoutMs: 30000 },
});
const createForm = ref<FormInstance>(),
  generatedCreateKey = ref(""),
  createBaseline = ref("");
const createDirty = computed(
  () =>
    createOpen.value && JSON.stringify(draft.value) !== createBaseline.value,
);
const discardCreation = useUnsavedChanges(createDirty);
const createRules: FormRules = {
  name: [
    {
      required: true,
      whitespace: true,
      message: "请输入服务名称",
      trigger: "blur",
    },
    { max: 120, message: "名称最多 120 字符", trigger: "blur" },
  ],
  key: [
    {
      validator: (_rule, value, callback) =>
        callback(
          !value.trim() || validResourceKey(value)
            ? undefined
            : new Error("使用小写字母、数字和下划线，以字母开头，最多 80 字符"),
        ),
      trigger: "blur",
    },
  ],
  "config.url": [
    {
      validator: (_rule, value, callback) => {
        try {
          const url = new URL(value);
          if (
            !["http:", "https:"].includes(url.protocol) ||
            url.username ||
            url.password
          )
            throw new Error();
          callback();
        } catch {
          callback(
            new Error("请输入完整的 HTTP/HTTPS 地址；认证信息请使用凭据"),
          );
        }
      },
      required: true,
      trigger: "blur",
    },
  ],
};
function openCreate() {
  if (busy.value) return;
  draft.value = {
    key: "",
    name: "",
    config: { url: "", credentialId: null, timeoutMs: 30000 },
  };
  generatedCreateKey.value = newResourceKey("mcp");
  createBaseline.value = JSON.stringify(draft.value);
  createForm.value?.clearValidate();
  error.value = "";
  createOpen.value = true;
}
async function closeCreate(done?: () => void) {
  if (busy.value || !(await discardCreation())) return;
  if (busy.value) return;
  createOpen.value = false;
  done?.();
}
const tab = ref("tools"),
  historyOpen = ref(false),
  search = ref("");
const visibleServers = computed(() =>
  servers.value.filter(
    (s: any) =>
      !search.value ||
      `${s.name} ${s.key} ${s.config.url}`
        .toLowerCase()
        .includes(search.value.toLowerCase()),
  ),
);
const config = ref<any>({ url: "", credentialId: null, timeoutMs: 30000 }),
  original = ref("");
const active = computed(() =>
  detail.value?.versions.find((version: any) => version.id === selected.value),
);
const dirty = computed(
  () => !!detail.value && original.value !== JSON.stringify(config.value),
);
const activeBinding = computed(() => detail.value?.bindings?.find((binding:any) => binding.id === selected.value));
const leave = useUnsavedChanges(dirty);
const oldCatalog = computed(
  () =>
    detail.value?.versions.find(
      (version: any) =>
        version.version < (active.value?.version ?? 0) &&
        version.catalog.length,
    )?.catalog ?? [],
);
const changes = computed(() => {
  const current = active.value?.catalog ?? [],
    before = oldCatalog.value;
  return current.map((tool: any) => {
    const old = before.find((item: any) => item.name === tool.name);
    return {
      ...tool,
      change: !old
        ? "新增"
        : JSON.stringify(old) !== JSON.stringify(tool)
          ? "已变化"
          : "未变化",
    };
  });
});
const removedTools = computed(() =>
  oldCatalog.value.filter(
    (tool: any) =>
      !active.value?.catalog.some((item: any) => item.name === tool.name),
  ),
);
function message(e: any) {
  return String(
    e.response?.data?.error?.message ??
      e.response?.data?.message ??
      "MCP 操作失败，请检查服务和权限",
  );
}
async function run(work: () => Promise<void>) {
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
function adopt() {
  config.value = JSON.parse(
    JSON.stringify(
      active.value?.config ?? { url: "", credentialId: null, timeoutMs: 30000 },
    ),
  );
  original.value = JSON.stringify(config.value);
}

async function load(preferred?: number) {
  const path = route.fullPath;
  loading.value = true;
  error.value = "";
  try {
    if (route.params.id) {
      const value = await api.get(`/external-tools/mcp/${route.params.id}`);
      if (route.fullPath !== path) return;
      detail.value = value;
      selected.value = preferred ?? value.versions[0]?.id;
      adopt();
    } else {
      const value = await api.get(
        `/external-tools/mcp?state=${lifecycleState.value}`,
      );
      if (route.fullPath !== path) return;
      servers.value = value.servers;
    }
  } catch (e) {
    error.value = message(e);
  } finally {
    loading.value = false;
  }
}
async function lifecycleChanged(action: string) {
  if (route.params.id && action !== "restore") {
    original.value = JSON.stringify(config.value);
    await router.push("/mcp");
  } else await load(selected.value);
}
watch(lifecycleState, () => {
  if (!route.params.id) void load();
});
async function refresh() {
  if (await leave()) await load(selected.value);
}
async function create() {
  if (busy.value) return;
  const path = route.fullPath;
  if (!(await createForm.value?.validate().catch(() => false))) return;
  if (busy.value || route.fullPath !== path || !createOpen.value) return;
  await run(async () => {
    const value = await api.post("/external-tools/mcp", {
      ...draft.value,
      key: draft.value.key.trim() || generatedCreateKey.value,
      name: draft.value.name.trim(),
      config: { ...draft.value.config, url: draft.value.config.url.trim() },
    });
    if (route.fullPath !== path) return;
    createOpen.value = false;
    await router.push(`/mcp/${value.id}`);
    ElMessage.success("服务已创建，请测试连接并获取能力目录");
  });
}
async function save() {
  await run(async () => {
    const value = await api.post(
      `/external-tools/mcp/${detail.value.id}/versions`,
      { versionId: detail.value.versions[0].id, config: config.value },
    );
    original.value = JSON.stringify(config.value);
    await load(value.id);
    ElMessage.success("已保存新连接版本，不改变已有 Agent 的工具绑定");
  });
}
async function select(id: number) {
  if (await leave()) {
    selected.value = id;
    adopt();
  }
}
async function probe(discover = false) {
  if (dirty.value) return ElMessage.warning("请先保存连接配置");
  await run(async () => {
    result.value = await api.post(
      `/external-tools/mcp/${detail.value.id}/${discover ? "discover" : "test"}`,
      { versionId: selected.value },
    );
    if (discover && result.value.ok) await load(result.value.id);
  });
}
async function publishService() {
  if (dirty.value) return ElMessage.warning("请先保存连接设置并刷新能力目录");
  try {
    await ElMessageBox.confirm("将此版本的完整目录发布为一个 MCP 服务供 Agent 整体接入。已有能力保留原审批策略，新增能力默认需要审批；不会执行业务方法或自动绑定 Agent。", "发布 MCP 服务");
  } catch { return; }
  await run(async () => {
    await api.post(`/external-tools/mcp/${detail.value.id}/publish`, { versionId: selected.value });
    await load(selected.value);
    ElMessage.success("MCP 服务目录已发布，可在 Agent 中整体接入");
  });
}
async function toggle() {
  try {
    await ElMessageBox.confirm(
      detail.value.enabled
        ? "停用后，所有引用此服务的工具都将不可调用。是否继续？"
        : "启用此 MCP 服务？",
      "确认",
    );
  } catch {
    return;
  }
  await run(async () => {
    await api.patch(`/external-tools/mcp/${detail.value.id}/status`, {
      enabled: !detail.value.enabled,
    });
    await load(selected.value);
  });
}
watch(
  () => route.params.id,
  () => {
    detail.value = undefined;
    result.value = undefined;
    void load();
  },
  { immediate: true },
);
</script>
<template>
  <Page>
    <ManagementHeader :title="detail?.name ?? 'MCP 管理'">
      <ElButton v-if="route.params.id" @click="router.push('/mcp')"
        >返回列表</ElButton
      ><ElButton @click="refresh">刷新</ElButton
      ><ElButton
        v-if="canManage && !route.params.id"
        type="primary"
        @click="openCreate"
        >新建 MCP 服务</ElButton
      >
    </ManagementHeader>
    <ElAlert
      v-if="error"
      :title="error"
      type="error"
      :closable="false"
      class="mb-4"
    />
    <ElAlert
      v-if="resourceRemoved"
      class="mb-4"
      :closable="false"
      type="info"
      title="资源已移除，仅可查看历史或恢复"
    />
    <PagePanel v-if="!route.params.id">
      <div
        v-if="!route.params.id"
        class="mb-4 flex flex-wrap items-center justify-between gap-3"
      >
        <ElInput
          v-model="search"
          class="w-full sm:w-72"
          placeholder="搜索名称、Key 或连接地址"
          clearable
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
      <ElTable
        v-if="!route.params.id"
        :data="visibleServers"
        v-loading="loading"
        ><ElTableColumn prop="name" label="名称"
          ><template #default="{ row }"
            ><ElButton
              link
              type="primary"
              @click="router.push(`/mcp/${row.id}`)"
              >{{ row.name }}</ElButton
            ></template
          ></ElTableColumn
        ><ElTableColumn prop="key" label="稳定 Key" /><ElTableColumn
          label="连接"
          ><template #default="{ row }">{{
            row.config.url
          }}</template></ElTableColumn
        ><ElTableColumn
          prop="toolCount"
          label="已发现能力"
          width="120" /><ElTableColumn label="状态" width="110"
          ><template #default="{ row }"
            ><ElTag :type="row.enabled ? 'success' : 'info'">{{
              row.deletedAt
                ? "已删除"
                : row.archivedAt
                  ? "已归档"
                  : row.enabled
                    ? "启用"
                    : "停用"
            }}</ElTag></template
          ></ElTableColumn
        ><ElTableColumn label="操作" width="150"
          ><template #default="{ row }"
            ><ResourceLifecycle
              :resource="row"
              base="/external-tools/mcp"
              :can-manage="canManage"
              @changed="load()" /></template></ElTableColumn
      ></ElTable>
    </PagePanel>
    <PagePanel v-else-if="detail" v-loading="busy || loading" class="space-y-4">
      <div class="flex flex-wrap items-center justify-between gap-3">
        <div class="flex flex-wrap items-center gap-3">
          <ElTag
            :type="detail.enabled && !resourceRemoved ? 'success' : 'info'"
            >{{
              resourceRemoved
                ? "已移除"
                : detail.enabled
                  ? "服务启用"
                  : "服务停用"
            }}</ElTag
          >
          <span class="text-sm text-muted-foreground">{{
            dirty
              ? "连接有未保存修改"
              : `连接 v${active?.version} · ${active?.catalog.length ?? 0} 项能力`
          }}</span>
        </div>
        <div class="flex flex-wrap items-center gap-2">
          <ElButton :disabled="busy" @click="historyOpen = true"
            >连接历史</ElButton
          >
          <ElButton
            v-if="canExecute"
            :disabled="busy || dirty || !detail.enabled || resourceRemoved"
            @click="probe()"
            >测试连接</ElButton
          >
          <ElButton
            v-if="editableManage && dirty"
            type="primary"
            :disabled="busy"
            @click="save"
            >保存连接</ElButton
          >
          <ElButton
            v-else-if="canExecute && editableManage"
            type="primary"
            :disabled="
              busy || !detail.enabled || selected !== detail.versions[0].id
            "
            @click="probe(true)"
            >获取／刷新能力</ElButton
          >
          <ResourceLifecycle
            :resource="detail"
            base="/external-tools/mcp"
            :can-manage="canManage"
            :before-action="leave"
            @changed="lifecycleChanged"
          />
        </div>
      </div>
      <ElAlert
        v-if="result"
        :type="result.ok ? 'success' : 'error'"
        :closable="false"
        :title="
          result.ok
            ? `连接验证成功 · ${result.toolCount ?? 0} 项能力 · ${result.durationMs} ms`
            : `${result.content}（${result.errorCode}）`
        "
      />
      <ElTabs v-model="tab">
        <ElTabPane name="tools" label="能力目录" />
        <ElTabPane name="connection" label="连接设置" />
      </ElTabs>
      <div v-show="tab === 'connection'">
        <ElForm
          label-position="top"
          :disabled="!editableManage || busy"
          class="grid grid-cols-1 gap-x-4 sm:grid-cols-2"
          ><ElFormItem
            label="Streamable HTTP 地址"
            class="sm:col-span-2"
            required
            ><ElInput
              v-model="config.url"
              placeholder="https://example.com/mcp" /></ElFormItem
          ><ElFormItem label="认证凭证" class="sm:col-span-2"
            ><CredentialPicker
              :model-value="config.credentialId ?? undefined"
              @update:model-value="
                (value) => (config.credentialId = value ?? null)
              " /></ElFormItem
          ><ElFormItem label="连接与调用超时（毫秒）"
            ><ElInputNumber
              v-model="config.timeoutMs"
              :min="1000"
              :max="120000" /><HelpTip
              text="支持公网 HTTPS。内网或 HTTP 主机由部署端白名单控制；不支持在后台启动任意本地命令。"
              long /></ElFormItem
        ></ElForm>
      </div>
      <div v-show="tab === 'tools'" class="space-y-4">
        <div class="flex flex-wrap items-center justify-between gap-3">
          <p class="text-sm text-muted-foreground">本版本包含 {{ active?.catalog.length ?? 0 }} 项原生能力，Agent 按整个 MCP 服务接入。</p>
          <ElButton v-if="canManage" type="primary" :loading="busy" :disabled="dirty || !detail.enabled || resourceRemoved || !active?.catalog.length || selected !== detail.versions[0]?.id || activeBinding?.ready" @click="publishService">{{ activeBinding?.ready ? '已发布，可整体接入' : '发布整个 MCP 服务' }}</ElButton>
        </div>
        <ElAlert
          v-if="!active?.catalog.length"
          type="info"
          :closable="false"
          title="尚未发现能力目录；保存连接后获取目录，再按整个服务发布和接入。"
        />
        <ElTable :data="changes"
          ><ElTableColumn prop="name" label="原生名称" /><ElTableColumn
            prop="description"
            label="描述" /><ElTableColumn label="变更" width="100"
            ><template #default="{ row }"
              ><ElTag :type="row.change === '未变化' ? 'info' : 'warning'">{{
                row.change
              }}</ElTag></template
            ></ElTableColumn
          ><ElTableColumn type="expand"
            ><template #default="{ row }">
              <JsonEditor
                class="p-4"
                readonly
                label="MCP 能力契约"
                :model-value="
                  JSON.stringify(
                    {
                      inputSchema: row.inputSchema,
                      outputSchema: row.outputSchema,
                    },
                    null,
                    2,
                  )
                "
              /> </template></ElTableColumn
        ></ElTable>
        <ElAlert
          v-if="removedTools.length"
          :title="`此目录不再提供：${removedTools.map((tool: any) => tool.name).join('、')}。旧绑定不会被自动删除，调用时会检查远端契约。`"
          type="warning"
          :closable="false"
        />
      </div>
    </PagePanel>
    <ElDialog
      class="management-dialog"
      body-class="management-dialog-body"
      header-class="management-dialog-header"
      footer-class="management-dialog-footer"
      append-to-body
      v-model="historyOpen"
      title="连接历史"
      width="min(900px, 95vw)"
      destroy-on-close
    >
      <ElTable :data="detail?.versions ?? []">
        <ElTableColumn label="连接版本"
          ><template #default="{ row }"
            >v{{ row.version }}</template
          ></ElTableColumn
        >
        <ElTableColumn label="能力目录"
          ><template #default="{ row }"
            >{{ row.catalog.length }} 项能力</template
          ></ElTableColumn
        >
        <ElTableColumn label="操作"
          ><template #default="{ row }">
            <ElButton
              link
              type="primary"
              :disabled="busy"
              @click="
                select(row.id);
                historyOpen = false;
              "
              >查看</ElButton
            >
          </template></ElTableColumn
        >
      </ElTable>
      <div v-if="detail" class="mt-4 flex flex-wrap items-center gap-3">
        <span class="text-sm text-muted-foreground"
          >{{ detail.key }} · 历史连接版本与已有 Agent 绑定保持不变</span
        >
        <ElButton v-if="editableManage" :disabled="busy" @click="toggle">{{
          detail.enabled ? "停用服务" : "启用服务"
        }}</ElButton>
      </div>
    </ElDialog>
    <ElDialog
      class="management-dialog"
      body-class="management-dialog-body"
      header-class="management-dialog-header"
      footer-class="management-dialog-footer"
      append-to-body
      v-model="createOpen"
      title="新建 MCP 服务"
      width="min(640px, 95vw)"
      :close-on-click-modal="false"
      :before-close="closeCreate"
      :show-close="!busy"
      :close-on-press-escape="!busy"
      ><ElForm
        ref="createForm"
        :model="draft"
        :rules="createRules"
        label-position="top"
        :disabled="busy"
        class="grid grid-cols-1 gap-x-4 sm:grid-cols-2"
        @submit.prevent="create"
        ><ElFormItem label="名称" prop="name" required
          ><ElInput v-model="draft.name" maxlength="120" /></ElFormItem
        ><ElFormItem label="认证凭据"
          ><CredentialPicker
            :model-value="draft.config.credentialId ?? undefined"
            @update:model-value="
              (value) => (draft.config.credentialId = value ?? null)
            " /></ElFormItem
        ><ElFormItem
          label="Streamable HTTP 地址"
          prop="config.url"
          class="sm:col-span-2"
          required
          ><ElInput
            v-model="draft.config.url"
            maxlength="2000"
            placeholder="https://example.com/mcp" /></ElFormItem
        ><ElCollapse class="sm:col-span-2"
          ><ElCollapseItem title="更多连接设置（可选）" name="connection">
            <div class="grid grid-cols-1 gap-x-4 sm:grid-cols-2">
              <ElFormItem label="自定义稳定 Key" prop="key"
                ><ElInput
                  v-model="draft.key"
                  maxlength="80"
                  placeholder="留空自动生成，创建后不可修改"
              /></ElFormItem>
              <ElFormItem label="超时（毫秒）"
                ><ElInputNumber
                  v-model="draft.config.timeoutMs"
                  class="management-input-number"
                  :min="1000"
                  :max="120000"
                  controls-position="right"
              /></ElFormItem>
            </div> </ElCollapseItem></ElCollapse></ElForm
      ><ElAlert
        v-if="error"
        :title="error"
        type="error"
        :closable="false"
      /><template #footer
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
  </Page>
</template>
