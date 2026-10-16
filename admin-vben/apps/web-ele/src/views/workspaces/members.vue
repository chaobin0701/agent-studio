<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { useAccessStore } from "@vben/stores";
import { useRouter } from "vue-router";
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
  ElTable,
  ElTableColumn,
  ElTag,
} from "element-plus";
import { managementApi as api } from "#/api/management";
import { useUnsavedChanges } from "#/composables/use-unsaved-changes";
import {
  workspaceRoles,
  type PlatformUser,
  type Permission,
} from "../system/access-model";
const props = defineProps<{ workspaceId: number }>();
const access = useAccessStore(),
  router = useRouter();
const members = ref<any[]>([]),
  accounts = ref<PlatformUser[]>([]),
  permissions = ref<Permission[]>([]);
const search = ref(""),
  loading = ref(false),
  busy = ref(false),
  error = ref(""),
  dialog = ref(false);
const memberId = ref<number>(),
  role = ref("reader"),
  codes = ref<string[]>([]),
  baseline = ref("");
const snapshot = () =>
  JSON.stringify({ id: memberId.value, role: role.value, codes: codes.value });
const dirty = computed(
  () => busy.value || (dialog.value && snapshot() !== baseline.value),
);
const discard = useUnsavedChanges(dirty);
const rows = computed(() =>
  members.value.filter((m) =>
    `${m.displayName} ${m.username || ""} ${m.email || ""}`
      .toLowerCase()
      .includes(search.value.trim().toLowerCase()),
  ),
);
const roleLabel = (value: string) =>
  workspaceRoles.find((r) => r.value === value)?.label ?? value;
function message(e: any) {
  const text = e.response?.data?.error?.message ?? e.response?.data?.message;
  return typeof text === "string" ? text : "成员操作失败，请检查权限后重试。";
}
let generation = 0;
async function load() {
  const request = ++generation,
    id = props.workspaceId;
  loading.value = true;
  error.value = "";
  try {
    const [list, choices] = await Promise.all([
      api.get(`/workspaces/${id}/members`),
      api.get(`/workspaces/${id}/member-options`),
    ]);
    if (request !== generation || id !== props.workspaceId) return;
    members.value = list;
    accounts.value = choices.accounts;
    permissions.value = choices.permissions;
  } catch (e) {
    if (request === generation) error.value = message(e);
  } finally {
    if (request === generation) loading.value = false;
  }
}
function selectMember(id?: number) {
  const member = members.value.find((m) => m.id === id);
  role.value = member?.role ?? "reader";
  codes.value = [...(member?.permissionCodes ?? [])];
}
function open(member?: any) {
  error.value = "";
  memberId.value = member?.id;
  selectMember(member?.id);
  dialog.value = true;
  baseline.value = snapshot();
}
async function close(done?: () => void) {
  if (busy.value || !(await discard())) return;
  dialog.value = false;
  done?.();
}
async function save() {
  if (!memberId.value || busy.value) return;
  const request = generation,
    id = props.workspaceId,
    body = {
      adminId: memberId.value,
      role: role.value,
      permissionCodes: role.value === "custom" ? [...codes.value] : [],
    };
  busy.value = true;
  error.value = "";
  try {
    await api.post(`/workspaces/${id}/members`, body);
    if (request !== generation || id !== props.workspaceId) return;
    baseline.value = snapshot();
    dialog.value = false;
    await load();
    ElMessage.success("成员授权已保存");
  } catch (e) {
    if (id === props.workspaceId) error.value = message(e);
  } finally {
    if (id === props.workspaceId) busy.value = false;
  }
}
async function remove(member: any) {
  const id = props.workspaceId;
  try {
    await ElMessageBox.confirm(
      `移除 ${member.displayName} 的工作区访问权限？平台账号不会被删除。`,
      "移除成员",
      { type: "warning" },
    );
  } catch {
    return;
  }
  if (id !== props.workspaceId || busy.value) return;
  busy.value = true;
  error.value = "";
  try {
    await api.delete(`/workspaces/${id}/members/${member.id}`);
    if (id === props.workspaceId) await load();
  } catch (e) {
    if (id === props.workspaceId) error.value = message(e);
  } finally {
    if (id === props.workspaceId) busy.value = false;
  }
}
onBeforeUnmount(() => generation++);
watch(
  () => props.workspaceId,
  () => {
    generation++;
    members.value = [];
    accounts.value = [];
    permissions.value = [];
    dialog.value = false;
    busy.value = false;
    void load();
  },
  { immediate: true },
);
</script>
<template>
  <ElAlert
    v-if="error"
    :title="error"
    type="error"
    :closable="false"
    class="mb-4"
  />
  <div class="mb-4 flex flex-wrap items-center justify-between gap-3">
    <ElInput
      v-model="search"
      clearable
      placeholder="搜索成员名称、账号或邮箱"
      aria-label="搜索工作区成员"
      class="w-full sm:w-72"
    />
    <div class="flex gap-2">
      <ElButton :disabled="busy" :loading="loading" @click="load"
        >刷新成员</ElButton
      ><ElButton
        type="primary"
        :disabled="busy || loading || !!error"
        @click="open()"
        >添加成员</ElButton
      >
    </div>
  </div>
  <ElTable v-loading="loading" :data="rows" row-key="id">
    <ElTableColumn label="成员" min-width="170"
      ><template #default="{ row }"
        ><ElButton link type="primary" :disabled="busy" @click="open(row)">{{
          row.displayName
        }}</ElButton></template
      ></ElTableColumn
    >
    <ElTableColumn label="账号" min-width="210" show-overflow-tooltip
      ><template #default="{ row }">{{
        row.username || row.email || "未设置"
      }}</template></ElTableColumn
    >
    <ElTableColumn label="角色" min-width="140"
      ><template #default="{ row }"
        ><ElTag :type="row.role === 'owner' ? 'warning' : 'info'">{{
          roleLabel(row.role)
        }}</ElTag></template
      ></ElTableColumn
    >
    <ElTableColumn label="操作" width="100"
      ><template #default="{ row }"
        ><ElButton link type="danger" :disabled="busy" @click="remove(row)"
          >移除</ElButton
        ></template
      ></ElTableColumn
    >
  </ElTable>
  <ElDialog
    class="management-dialog"
    body-class="management-dialog-body"
    header-class="management-dialog-header"
    footer-class="management-dialog-footer"
    append-to-body
    :model-value="dialog"
    title="成员授权"
    width="min(680px,94vw)"
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
    <ElForm
      label-position="top"
      :disabled="busy"
      class="grid grid-cols-1 gap-x-4 sm:grid-cols-2"
    >
      <ElFormItem label="平台账号" required
        ><ElSelect
          v-model="memberId"
          filterable
          class="w-full"
          @change="selectMember"
          ><ElOption
            v-for="account in accounts"
            :key="account.id"
            :value="account.id"
            :label="`${account.displayName} · ${account.username || account.email || account.id}`" /></ElSelect
      ></ElFormItem>
      <ElFormItem label="工作区角色" required
        ><ElSelect v-model="role" class="w-full"
          ><ElOption
            v-for="r in workspaceRoles"
            :key="r.value"
            :value="r.value"
            :label="r.label" /></ElSelect
      ></ElFormItem>
      <ElFormItem
        v-if="role === 'custom'"
        label="业务权限"
        class="sm:col-span-2"
        ><ElSelect
          v-model="codes"
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
    </ElForm>
    <template #footer
      ><ElButton
        v-if="access.accessCodes.includes('admins.manage')"
        :disabled="busy"
        @click="router.push('/system/users')"
        >管理平台账号</ElButton
      ><ElButton :disabled="busy" @click="close()">取消</ElButton
      ><ElButton
        type="primary"
        :loading="busy"
        :disabled="!memberId"
        @click="save"
        >保存授权</ElButton
      ></template
    >
  </ElDialog>
</template>
