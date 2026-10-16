<script setup lang="ts">
import { computed, onBeforeUnmount, reactive, ref, watch } from "vue";
import { useRouter } from "vue-router";
import { useUserStore } from "@vben/stores";
import {
  ElAlert,
  ElButton,
  ElDialog,
  ElEmpty,
  ElForm,
  ElFormItem,
  ElMessage,
  ElMessageBox,
  ElOption,
  ElSelect,
  ElTable,
  ElTableColumn,
  ElTag,
} from "element-plus";
import HelpTip from "#/components/HelpTip.vue";
import { managementApi as api } from "#/api/management";
import { useUnsavedChanges } from "#/composables/use-unsaved-changes";
import {
  workspaceRoles,
  type Permission,
  type PlatformUser,
  type UserWorkspace,
} from "./access-model";

const props = defineProps<{ user?: PlatformUser }>();
const emit = defineEmits<{ close: []; changed: [] }>();
const router = useRouter(),
  userStore = useUserStore();
const rows = ref<UserWorkspace[]>([]),
  permissions = ref<Permission[]>([]);
const loading = ref(false),
  busy = ref(false),
  failed = ref(false);
const form = reactive({
  workspaceId: undefined as number | undefined,
  role: "reader",
  permissionCodes: [] as string[],
});
const baseline = ref("");
const actionError = ref("");
function errorMessage(e: any) {
  const text = e.response?.data?.error?.message ?? e.response?.data?.message;
  return typeof text === "string" ? text : "工作区授权操作失败，请重试。";
}
let disposed = false;
onBeforeUnmount(() => {
  disposed = true;
  generation++;
});
const dirty = computed(
  () => !!props.user && JSON.stringify(form) !== baseline.value,
);
const discard = useUnsavedChanges(dirty);
const self = computed(
  () => props.user?.id === Number(userStore.userInfo?.userId),
);
const selected = computed(() =>
  rows.value.find((row) => row.id === form.workspaceId),
);
const roleLabel = (role: string | null) =>
  workspaceRoles.find((item) => item.value === role)?.label ?? "未加入";
function select(id?: number) {
  const row = rows.value.find((item) => item.id === id);
  Object.assign(form, {
    workspaceId: id,
    role: row?.role ?? "reader",
    permissionCodes: [...(row?.permissionCodes ?? [])],
  });
  baseline.value = JSON.stringify(form);
}
let generation = 0;
async function load() {
  const current = ++generation,
    id = props.user?.id;
  if (!id) return;
  loading.value = true;
  failed.value = false;
  try {
    const result = await api.get<{
      workspaces: UserWorkspace[];
      permissions: Permission[];
    }>(`/admins/${id}/workspaces`);
    if (generation !== current || props.user?.id !== id) return;
    rows.value = result.workspaces;
    permissions.value = result.permissions;
    select(rows.value.find((row) => row.id === form.workspaceId)?.id);
  } catch {
    if (generation === current) failed.value = true;
  } finally {
    if (generation === current) loading.value = false;
  }
}
watch(
  () => props.user?.id,
  () => {
    actionError.value = "";
    busy.value = false;
    rows.value = [];
    permissions.value = [];
    select();
    if (props.user) void load();
    else generation++;
  },
  { immediate: true },
);
async function close(done?: () => void) {
  if (busy.value || !(await discard())) return;
  emit("close");
  done?.();
}
async function back() {
  if (!busy.value && (await discard())) {
    select();
    actionError.value = "";
  }
}
async function edit(row: UserWorkspace) {
  if (busy.value || !(await discard())) return;
  actionError.value = "";
  select(row.id);
}
async function save() {
  if (
    !props.user ||
    !selected.value ||
    busy.value ||
    loading.value ||
    failed.value
  )
    return;
  const id = props.user.id,
    current = generation;
  busy.value = true;
  actionError.value = "";
  try {
    await api.post(`/workspaces/${form.workspaceId}/members`, {
      adminId: id,
      role: form.role,
      permissionCodes: form.role === "custom" ? [...form.permissionCodes] : [],
    });
    if (disposed || current !== generation || props.user?.id !== id) return;
    baseline.value = JSON.stringify(form);
    ElMessage.success("工作区授权已保存");
    await load();
    if (disposed || props.user?.id !== id) return;
    select();
    emit("changed");
  } catch (e) {
    if (!disposed && props.user?.id === id) actionError.value = errorMessage(e);
  } finally {
    if (!disposed && props.user?.id === id) busy.value = false;
  }
}
async function remove(row: UserWorkspace) {
  if (!props.user || busy.value || self.value || !(await discard())) return;
  const id = props.user.id,
    current = generation;
  try {
    await ElMessageBox.confirm(
      `从「${row.name}」移除此用户？其他工作区和平台角色不受影响。`,
      "移除工作区成员",
      { type: "warning" },
    );
  } catch {
    return;
  }
  if (disposed || current !== generation || props.user?.id !== id) return;
  busy.value = true;
  actionError.value = "";
  try {
    await api.delete(`/workspaces/${row.id}/members/${id}`);
    if (disposed || current !== generation || props.user?.id !== id) return;
    select();
    await load();
    if (disposed || props.user?.id !== id) return;
    emit("changed");
    ElMessage.success("已移除工作区授权");
  } catch (e) {
    if (!disposed && props.user?.id === id) actionError.value = errorMessage(e);
  } finally {
    if (!disposed && props.user?.id === id) busy.value = false;
  }
}
</script>

<template>
  <ElDialog
    class="management-dialog"
    body-class="management-dialog-body"
    header-class="management-dialog-header"
    footer-class="management-dialog-footer"
    append-to-body
    :model-value="!!user"
    :title="`工作区授权 · ${user?.displayName ?? ''}`"
    width="min(760px,94vw)"
    :before-close="close"
    :close-on-click-modal="false"
    destroy-on-close
  >
    <p class="mb-4 text-sm text-muted-foreground">
      {{
        selected
          ? `调整授权：${selected.name}`
          : "选择工作区以添加或调整成员授权"
      }}
      <HelpTip
        text="仅展示你作为所有者可管理的工作区。平台角色与工作区授权独立。"
      />
    </p>
    <ElAlert
      v-if="actionError"
      :title="actionError"
      type="error"
      :closable="false"
      class="mb-4"
    />
    <ElAlert
      v-if="failed"
      type="error"
      title="加载失败，请重试"
      :closable="false"
      class="mb-4"
    />
    <ElTable v-if="!selected" v-loading="loading" :data="rows" row-key="id">
      <ElTableColumn label="工作区" min-width="160"
        ><template #default="{ row }"
          ><ElButton
            link
            type="primary"
            :disabled="busy"
            @click="edit(row as UserWorkspace)"
            >{{ row.name }}</ElButton
          ></template
        ></ElTableColumn
      >
      <ElTableColumn label="状态" width="90"
        ><template #default="{ row }"
          ><ElTag :type="row.enabled ? 'success' : 'info'">{{
            row.enabled ? "启用" : "停用"
          }}</ElTag></template
        ></ElTableColumn
      >
      <ElTableColumn label="成员角色" width="140"
        ><template #default="{ row }">{{
          roleLabel(row.role)
        }}</template></ElTableColumn
      >
      <ElTableColumn label="操作" width="160"
        ><template #default="{ row }"
          ><ElButton
            link
            type="primary"
            :disabled="busy"
            @click="edit(row as UserWorkspace)"
            >{{ row.role ? "调整授权" : "添加成员" }}</ElButton
          ><ElButton
            v-if="row.role"
            link
            type="danger"
            :disabled="busy || self"
            @click="remove(row as UserWorkspace)"
            >移除</ElButton
          ></template
        ></ElTableColumn
      >
      <template #empty
        ><ElEmpty
          :description="failed ? '加载失败' : '没有可管理的工作区'"
          :image-size="64"
      /></template>
    </ElTable>
    <ElForm
      v-if="selected"
      class="grid grid-cols-1 gap-x-4 sm:grid-cols-2"
      label-position="top"
      :disabled="busy || loading || failed"
      @submit.prevent="save"
    >
      <ElFormItem label="工作区"
        ><span>{{ selected.name }}</span></ElFormItem
      >
      <ElFormItem label="成员角色"
        ><ElSelect v-model="form.role" class="w-full" :disabled="self"
          ><ElOption
            v-for="role in workspaceRoles"
            :key="role.value"
            :value="role.value"
            :label="role.label" /></ElSelect
      ></ElFormItem>
      <ElFormItem
        v-if="form.role === 'custom'"
        label="业务权限"
        class="sm:col-span-2"
        ><ElSelect
          v-model="form.permissionCodes"
          multiple
          filterable
          collapse-tags
          collapse-tags-tooltip
          :max-collapse-tags="3"
          class="w-full"
          ><ElOption
            v-for="permission in permissions"
            :key="permission.code"
            :value="permission.code"
            :label="`${permission.description} · ${permission.code}`" /></ElSelect
      ></ElFormItem>
      <ElAlert
        v-if="user?.disabledAt"
        class="sm:col-span-2"
        type="warning"
        title="该账号已停用；启用账号后才能新增或调整工作区授权。仍可移除现有授权。"
        :closable="false"
      />
    </ElForm>
    <template #footer
      ><ElButton v-if="selected" :disabled="busy" @click="back"
        >返回工作区列表</ElButton
      ><ElButton
        v-else
        :disabled="busy || loading"
        @click="
          async () => {
            if (await discard()) await load();
          }
        "
        >刷新</ElButton
      ><ElButton :disabled="busy" @click="close()">关闭</ElButton>
      <ElButton
        v-if="selected"
        type="primary"
        :loading="busy"
        :disabled="!!user?.disabledAt"
        @click="save"
        >保存工作区授权</ElButton
      >
      <ElButton
        v-if="!rows.length && !loading && !failed"
        type="primary"
        @click="
          async () => {
            if (await discard()) {
              emit('close');
              router.push('/workspaces');
            }
          }
        "
        >前往工作区管理</ElButton
      ></template
    >
  </ElDialog>
</template>
