<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { useRouter } from "vue-router";
import { Page } from "@vben/common-ui";
import { useAccessStore } from "@vben/stores";
import {
  ElAlert,
  ElButton,
  ElDialog,
  ElDropdown,
  ElDropdownItem,
  ElDropdownMenu,
  ElForm,
  ElFormItem,
  ElInput,
  ElMessage,
  ElMessageBox,
  ElSegmented,
  ElTable,
  ElTableColumn,
  ElTag,
} from "element-plus";
import { managementApi as api } from "#/api/management";
import ManagementHeader from "#/components/ManagementHeader.vue";
import PagePanel from "#/components/PagePanel.vue";
import { useUnsavedChanges } from "#/composables/use-unsaved-changes";
import { useWorkspaceStore, type Workspace } from "#/store/workspace";
import { workspaceRoles } from "../system/access-model";
import ResourceCopy from "./resource-copy.vue";
const router = useRouter(),
  ws = useWorkspaceStore(),
  access = useAccessStore();
const canCreate = computed(() =>
  access.accessCodes.includes("workspaces.manage"),
);
const search = ref(""),
  status = ref("active"),
  loading = ref(false),
  busy = ref(false),
  error = ref("");
const createOpen = ref(false),
  copyOpen = ref(false),
  name = ref(""),
  description = ref("");
const dirty = computed(
  () => createOpen.value && !!(name.value || description.value),
);
const discard = useUnsavedChanges(dirty);
const rows = computed(() =>
  ws.items.filter(
    (w) =>
      w.enabled === (status.value === "active") &&
      `${w.name} ${w.description}`
        .toLowerCase()
        .includes(search.value.trim().toLowerCase()),
  ),
);
const roleLabel = (role: string) =>
  workspaceRoles.find((r) => r.value === role)?.label ?? role;
function message(e: any) {
  const text = e.response?.data?.error?.message ?? e.response?.data?.message;
  return typeof text === "string" ? text : "工作区操作失败，请重试。";
}
let generation = 0;
async function refresh() {
  const request = ++generation;
  loading.value = true;
  error.value = "";
  try {
    await ws.refresh();
  } catch (e) {
    if (request === generation) error.value = message(e);
  } finally {
    if (request === generation) loading.value = false;
  }
}
function detail(row: Workspace, tab = "general") {
  void router.push({ path: `/workspaces/${row.id}`, query: { tab } });
}
function openCreate() {
  name.value = "";
  description.value = "";
  error.value = "";
  createOpen.value = true;
}
async function close(done?: () => void) {
  if (busy.value || !(await discard())) return;
  createOpen.value = false;
  done?.();
}
async function create() {
  if (busy.value || !name.value.trim()) return;
  const request = generation;
  busy.value = true;
  error.value = "";
  try {
    const result = await api.post<{ id: number }>("/workspaces", {
      name: name.value.trim(),
      description: description.value,
    });
    if (request !== generation) return;
    createOpen.value = false;
    name.value = "";
    description.value = "";
    await ws.refresh();
    ElMessage.success("工作区已创建");
    await router.push(`/workspaces/${result.id}`);
  } catch (e) {
    if (request === generation) error.value = message(e);
  } finally {
    if (request === generation) busy.value = false;
  }
}
async function toggle(row: Workspace) {
  if (busy.value) return;
  try {
    await ElMessageBox.confirm(
      row.enabled
        ? `停用“${row.name}”后，该工作区的新请求将被阻止，配置和历史仍保留。`
        : `恢复“${row.name}”的访问？`,
      "工作区状态",
      { type: "warning" },
    );
  } catch {
    return;
  }
  busy.value = true;
  error.value = "";
  try {
    await api.patch(`/workspaces/${row.id}/status`, { enabled: !row.enabled });
    if (ws.id === row.id && row.enabled) {
      location.reload();
      return;
    }
    await refresh();
  } catch (e) {
    error.value = message(e);
  } finally {
    busy.value = false;
  }
}
onMounted(refresh);
onBeforeUnmount(() => generation++);
</script>
<template>
  <Page>
    <ManagementHeader
      title="工作区"
      description="管理资源范围、默认模型和成员访问。"
    >
      <ElButton :disabled="busy" :loading="loading" @click="refresh"
        >刷新</ElButton
      >
      <ElButton :disabled="busy || loading" @click="copyOpen = true"
        >复制资源</ElButton
      >
      <ElButton
        v-if="canCreate"
        type="primary"
        :disabled="busy"
        @click="openCreate"
        >新建工作区</ElButton
      >
    </ManagementHeader>
    <ElAlert
      v-if="error && !createOpen"
      :title="error"
      type="error"
      :closable="false"
      class="mb-4"
    />
    <PagePanel>
      <div class="mb-4 flex flex-wrap items-center gap-3">
        <ElInput
          v-model="search"
          clearable
          placeholder="搜索名称或描述"
          aria-label="搜索工作区"
          class="w-full sm:w-72"
        />
        <ElSegmented
          v-model="status"
          :options="[
            { label: '使用中', value: 'active' },
            { label: '已停用', value: 'inactive' },
          ]"
        />
      </div>
      <ElTable v-loading="loading" :data="rows" row-key="id">
        <ElTableColumn label="工作区" min-width="220"
          ><template #default="{ row }"
            ><ElButton link type="primary" @click="detail(row as Workspace)">{{
              row.name
            }}</ElButton
            ><ElTag v-if="row.id === ws.id" size="small" class="ml-2"
              >当前</ElTag
            >
            <p
              v-if="row.description"
              class="mt-1 truncate text-sm text-muted-foreground"
            >
              {{ row.description }}
            </p></template
          ></ElTableColumn
        >
        <ElTableColumn label="我的角色" min-width="130"
          ><template #default="{ row }">{{
            roleLabel(row.role)
          }}</template></ElTableColumn
        >
        <ElTableColumn label="状态" width="100"
          ><template #default="{ row }"
            ><ElTag :type="row.enabled ? 'success' : 'info'">{{
              row.enabled ? "使用中" : "已停用"
            }}</ElTag></template
          ></ElTableColumn
        >
        <ElTableColumn label="操作" width="180"
          ><template #default="{ row }"
            ><div class="flex items-center gap-3">
              <ElButton link type="primary" @click="detail(row as Workspace)"
                >设置</ElButton
              ><ElDropdown v-if="row.role === 'owner'" trigger="click"
                ><ElButton link :disabled="busy">更多</ElButton
                ><template #dropdown
                  ><ElDropdownMenu
                    ><ElDropdownItem
                      v-if="row.enabled"
                      @click="detail(row as Workspace, 'members')"
                      >成员管理</ElDropdownItem
                    ><ElDropdownItem
                      :divided="row.enabled"
                      :disabled="busy"
                      @click="toggle(row as Workspace)"
                      >{{
                        row.enabled ? "停用工作区" : "恢复工作区"
                      }}</ElDropdownItem
                    ></ElDropdownMenu
                  ></template
                ></ElDropdown
              >
            </div></template
          ></ElTableColumn
        >
      </ElTable>
    </PagePanel>
    <ElDialog
      class="management-dialog"
      body-class="management-dialog-body"
      header-class="management-dialog-header"
      footer-class="management-dialog-footer"
      append-to-body
      :model-value="createOpen"
      title="新建工作区"
      width="min(600px,94vw)"
      :close-on-click-modal="false"
      :before-close="close"
    >
      <ElAlert
        v-if="error"
        :title="error"
        type="error"
        :closable="false"
        class="mb-4"
      />
      <ElForm label-position="top" :disabled="busy" @submit.prevent="create">
        <ElFormItem label="名称" required
          ><ElInput v-model="name" maxlength="120"
        /></ElFormItem>
        <ElFormItem label="描述"
          ><ElInput
            v-model="description"
            type="textarea"
            :rows="3"
            maxlength="2000"
        /></ElFormItem>
      </ElForm>
      <template #footer
        ><ElButton :disabled="busy" @click="close()">取消</ElButton
        ><ElButton
          type="primary"
          :loading="busy"
          :disabled="!name.trim()"
          @click="create"
          >创建</ElButton
        ></template
      >
    </ElDialog>
    <ResourceCopy v-model="copyOpen" />
  </Page>
</template>
