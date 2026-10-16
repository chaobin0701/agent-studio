<script setup lang="ts">
import {
  computed,
  onBeforeUnmount,
  onMounted,
  reactive,
  ref,
  watch,
} from "vue";
import { useRoute, useRouter } from "vue-router";
import { Page } from "@vben/common-ui";
import { useAccessStore, useUserStore } from "@vben/stores";
import {
  ElAlert,
  ElButton,
  ElDialog,
  ElEmpty,
  ElDropdown,
  ElDropdownItem,
  ElDropdownMenu,
  ElForm,
  ElFormItem,
  ElInput,
  ElMessage,
  ElMessageBox,
  ElOption,
  ElPagination,
  ElScrollbar,
  ElSelect,
  ElTable,
  ElTableColumn,
  ElTag,
  type FormInstance,
  type FormRules,
} from "element-plus";
import ManagementHeader from "#/components/ManagementHeader.vue";
import PagePanel from "#/components/PagePanel.vue";
import HelpTip from "#/components/HelpTip.vue";
import { managementApi as api } from "#/api/management";
import { useUnsavedChanges } from "#/composables/use-unsaved-changes";
import { useAuthStore } from "#/store";
import UserWorkspaces from "./user-workspaces.vue";
import {
  canAssignRole,
  filterUsers,
  grantablePermissions,
  loginIdentity,
  passwordError,
  type Permission,
  type PlatformRole,
  type PlatformUser,
} from "./access-model";

const route = useRoute(),
  router = useRouter();
const access = useAccessStore(),
  userStore = useUserStore(),
  auth = useAuthStore();
const usersPage = computed(() => route.meta.managementKind === "users");
const allowed = computed(() =>
  access.accessCodes.includes(
    usersPage.value ? "admins.manage" : "roles.manage",
  ),
);
const actorRoles = computed(() => userStore.userInfo?.roles ?? []);
const superAdmin = computed(() => actorRoles.value.includes("super_admin"));
const workspaceUser = ref<PlatformUser>();
const currentUserId = computed(() => Number(userStore.userInfo?.userId));
const users = ref<PlatformUser[]>([]),
  roles = ref<PlatformRole[]>([]),
  permissions = ref<Permission[]>([]);
const loading = ref(false),
  failed = ref(false),
  busy = ref(false);
const actionError = ref("");
function errorMessage(e: any) {
  const text = e.response?.data?.error?.message ?? e.response?.data?.message;
  return typeof text === "string" ? text : "操作失败，请检查权限或稍后重试。";
}
const query = ref(""),
  status = ref(""),
  page = ref(1),
  pageSize = 20;
const filteredUsers = computed(() =>
  filterUsers(users.value, query.value, status.value),
);
const filteredRoles = computed(() =>
  roles.value.filter((role) =>
    `${role.name} ${role.code}`
      .toLowerCase()
      .includes(query.value.trim().toLowerCase()),
  ),
);
const filtered = computed(() =>
  usersPage.value ? filteredUsers.value : filteredRoles.value,
);
const pageUsers = computed(() =>
  filteredUsers.value.slice((page.value - 1) * pageSize, page.value * pageSize),
);
const pageRoles = computed(() =>
  filteredRoles.value.slice((page.value - 1) * pageSize, page.value * pageSize),
);
const grants = computed(() =>
  grantablePermissions(roles.value, actorRoles.value),
);
const roleName = (id: number) =>
  roles.value.find((role) => role.id === id)?.name ?? `角色 #${id}`;
const assignable = (role: PlatformRole) =>
  canAssignRole(role, roles.value, actorRoles.value);

let loadGeneration = 0;
async function load() {
  const generation = ++loadGeneration;
  if (!allowed.value) return;
  loading.value = true;
  failed.value = false;
  try {
    const [roleRows, userRows, permissionRows] = await Promise.all([
      api.get<PlatformRole[]>("/roles"),
      usersPage.value
        ? api.get<PlatformUser[]>("/admins")
        : Promise.resolve([]),
      usersPage.value
        ? Promise.resolve([])
        : api.get<Permission[]>("/permissions"),
    ]);
    if (generation !== loadGeneration) return;
    roles.value = roleRows;
    users.value = userRows;
    permissions.value = permissionRows;
  } catch {
    if (generation === loadGeneration) failed.value = true;
  } finally {
    if (generation === loadGeneration) loading.value = false;
  }
}
watch([query, status, usersPage], () => {
  page.value = 1;
});
watch(
  () => filtered.value.length,
  (count) => {
    page.value = Math.min(page.value, Math.max(1, Math.ceil(count / pageSize)));
  },
);
watch(usersPage, () => {
  query.value = "";
  status.value = "";
  void load();
});
onMounted(load);
onBeforeUnmount(() => loadGeneration++);

type DialogKind = "create" | "assign" | "role" | "permissions" | "password";
const dialog = ref<DialogKind>(),
  form = ref<FormInstance>();
const targetUser = ref<PlatformUser>(),
  targetRole = ref<PlatformRole>();
const account = reactive({
  displayName: "",
  identity: "",
  password: "",
  confirmPassword: "",
  roleIds: [] as number[],
});
const roleForm = reactive({
  name: "",
  code: "",
  permissionCodes: [] as string[],
});
const baseline = ref("");
const snapshot = () =>
  JSON.stringify(dialog.value === "role" ? roleForm : account);
const dirty = computed(
  () =>
    !!dialog.value &&
    dialog.value !== "permissions" &&
    snapshot() !== baseline.value,
);
const confirmDiscard = useUnsavedChanges(dirty);
const dialogTitle = computed(
  () =>
    ({
      create: "新建用户",
      assign: `分配角色 · ${targetUser.value?.displayName ?? ""}`,
      role: targetRole.value ? "编辑角色" : "新建角色",
      permissions: `角色权限 · ${targetRole.value?.name ?? ""}`,
      password: `修改密码 · ${targetUser.value?.displayName ?? ""}`,
    })[dialog.value ?? "create"],
);
const accountRules: FormRules = {
  displayName: [
    {
      required: true,
      whitespace: true,
      message: "请输入显示名称",
      trigger: "blur",
    },
  ],
  identity: [
    {
      validator: (_rule, value: string, callback) => {
        const text = value.trim();
        const valid = text.includes("@")
          ? /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text)
          : /^[A-Za-z0-9][A-Za-z0-9_.-]{2,63}$/.test(text);
        callback(
          valid
            ? undefined
            : new Error(
                "请输入有效邮箱或 3–64 位账号（字母、数字、点、下划线、短横线）",
              ),
        );
      },
      trigger: "blur",
    },
  ],
  password: [
    {
      validator: (_rule, value: string, callback) => {
        const error = passwordError(value);
        callback(error ? new Error(error) : undefined);
      },
      trigger: "blur",
    },
  ],
  roleIds: [
    {
      type: "array",
      required: true,
      min: 1,
      message: "请选择至少一个角色",
      trigger: "change",
    },
  ],
};
const roleRules: FormRules = {
  name: [
    {
      required: true,
      whitespace: true,
      message: "请输入角色名称",
      trigger: "blur",
    },
  ],
  code: [
    {
      required: true,
      pattern: /^[a-z][a-z0-9_]{2,79}$/,
      message: "3–80 位小写字母、数字或下划线，以字母开头",
      trigger: "blur",
    },
  ],
};

const passwordRules: FormRules = {
  password: accountRules.password,
  confirmPassword: [
    {
      validator: (_rule, value: string, callback) =>
        callback(
          value && value === account.password
            ? undefined
            : new Error("两次输入的密码不一致"),
        ),
      trigger: "blur",
    },
  ],
};

function clearAccount() {
  Object.assign(account, {
    displayName: "",
    identity: "",
    password: "",
    confirmPassword: "",
    roleIds: [],
  });
}
function open(kind: DialogKind, target?: PlatformUser | PlatformRole) {
  actionError.value = "";
  clearAccount();
  targetUser.value =
    kind === "assign" || kind === "password"
      ? (target as PlatformUser)
      : undefined;
  targetRole.value =
    kind === "role" || kind === "permissions"
      ? (target as PlatformRole)
      : undefined;
  if (targetUser.value)
    account.roleIds = targetUser.value.roles.map((role) => role.id);
  Object.assign(roleForm, {
    name: targetRole.value?.name ?? "",
    code: targetRole.value?.code ?? "",
    permissionCodes: [...(targetRole.value?.permissionCodes ?? [])],
  });
  dialog.value = kind;
  baseline.value = snapshot();
}
async function closeDialog(done?: () => void) {
  if (busy.value || !(await confirmDiscard())) return;
  dialog.value = undefined;
  clearAccount();
  done?.();
}
async function refreshIdentity() {
  await auth.fetchUserInfo();
  access.setIsAccessChecked(false);
  await router.replace(allowed.value ? route.fullPath : "/overview");
}
async function submit() {
  if (!allowed.value || busy.value || dialog.value === "permissions") return;
  const valid = await form.value?.validate().catch(() => false);
  if (!valid) return;
  if (dialog.value === "password") {
    if (!superAdmin.value) return;
    try {
      await ElMessageBox.confirm(
        "保存后，该账号的所有旧登录将失效，需要使用新密码重新登录。继续？",
        "确认修改密码",
        { type: "warning" },
      );
    } catch {
      return;
    }
  }
  if (
    dialog.value === "assign" &&
    currentUserId.value === targetUser.value?.id
  ) {
    try {
      await ElMessageBox.confirm(
        "正在修改自己的平台角色，保存后将重新检查权限，可能失去部分管理入口。继续？",
        "修改自己的角色",
        { type: "warning" },
      );
    } catch {
      return;
    }
  }
  busy.value = true;
  actionError.value = "";
  try {
    let createdId: number | undefined;
    const ownRoleChanged =
      dialog.value === "role" &&
      actorRoles.value.includes(targetRole.value?.code ?? "");
    const ownAccountChanged =
      dialog.value === "assign" && currentUserId.value === targetUser.value?.id;
    if (dialog.value === "create") {
      const created = await api.post<{ id: number }>("/admins", {
        displayName: account.displayName.trim(),
        ...loginIdentity(account.identity),
        password: account.password,
        roleIds: [...account.roleIds],
      });
      createdId = created.id;
    } else if (dialog.value === "assign") {
      await api.patch(`/admins/${targetUser.value!.id}/roles`, {
        roleIds: [...account.roleIds],
      });
    } else if (dialog.value === "password") {
      await api.patch(`/admins/${targetUser.value!.id}/password`, {
        password: account.password,
      });
      const own = currentUserId.value === targetUser.value?.id;
      dialog.value = undefined;
      clearAccount();
      ElMessage.success("密码已修改，旧登录已失效");
      if (own) await auth.logout(false);
      return;
    } else if (dialog.value === "role") {
      const data = {
        name: roleForm.name.trim(),
        permissionCodes: [...roleForm.permissionCodes],
      };
      if (targetRole.value)
        await api.patch(`/roles/${targetRole.value.id}`, data);
      else await api.post("/roles", { ...data, code: roleForm.code.trim() });
    }
    dialog.value = undefined;
    clearAccount();
    ElMessage.success("保存成功");
    if (ownAccountChanged || ownRoleChanged) await refreshIdentity();
    if (allowed.value) await load();
    if (createdId)
      workspaceUser.value = users.value.find((user) => user.id === createdId);
  } catch (e) {
    actionError.value = errorMessage(e);
    // The shared request client displays the real backend error; keep the form.
  } finally {
    busy.value = false;
  }
}
async function toggle(user: PlatformUser) {
  if (!allowed.value || busy.value || user.id === currentUserId.value) return;
  const disabled = !user.disabledAt;
  try {
    await ElMessageBox.confirm(
      disabled
        ? "停用后将无法登录后台，已有登录也会失效。继续？"
        : "重新启用此账号？",
      `${disabled ? "停用" : "启用"} · ${user.displayName}`,
      { type: disabled ? "warning" : "info" },
    );
  } catch {
    return;
  }
  busy.value = true;
  actionError.value = "";
  try {
    await api.patch(`/admins/${user.id}/status`, { disabled });
    ElMessage.success(disabled ? "用户已停用" : "用户已启用");
    await load();
  } catch (e) {
    actionError.value = errorMessage(e);
    /* Shared request client displays errors. */
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <Page>
    <ManagementHeader
      :title="usersPage ? '用户管理' : '角色管理'"
      :description="
        usersPage
          ? '平台登录账号与工作区授权分别管理。'
          : '管理平台角色，工作区权限通过成员授权设置。'
      "
    >
      <template v-if="allowed">
        <ElButton :disabled="busy" :loading="loading" @click="load"
          >刷新</ElButton
        >
        <ElButton
          type="primary"
          :disabled="busy || loading || failed"
          @click="open(usersPage ? 'create' : 'role')"
          >{{ usersPage ? "新建用户" : "新建角色" }}</ElButton
        >
      </template>
    </ManagementHeader>
    <ElAlert
      v-if="!allowed"
      type="warning"
      title="没有此页面的管理权限"
      :closable="false"
    />
    <ElAlert
      v-if="actionError && !dialog"
      :title="actionError"
      type="error"
      :closable="false"
      class="mb-4"
    />
    <PagePanel v-if="allowed">
      <div class="mb-4 flex flex-wrap items-center gap-3">
        <div class="w-full sm:w-72">
          <ElInput
            v-model="query"
            clearable
            :placeholder="
              usersPage ? '搜索名称、账号、邮箱或 ID' : '搜索角色名称或代码'
            "
            aria-label="搜索"
          />
        </div>
        <ElSelect
          v-if="usersPage"
          v-model="status"
          clearable
          placeholder="全部状态"
          class="w-32"
          aria-label="账号状态"
        >
          <ElOption value="enabled" label="启用" /><ElOption
            value="disabled"
            label="停用"
          />
        </ElSelect>
      </div>
      <ElAlert
        v-if="failed"
        title="加载失败，请点击刷新重试"
        type="error"
        :closable="false"
        class="mb-4"
      />
      <ElTable
        v-if="usersPage"
        v-loading="loading"
        :data="pageUsers"
        row-key="id"
      >
        <ElTableColumn label="显示名称" min-width="160"
          ><template #default="{ row }"
            ><ElButton
              link
              type="primary"
              :disabled="busy"
              @click="open('assign', row as PlatformUser)"
              >{{ row.displayName }}</ElButton
            ></template
          ></ElTableColumn
        >
        <ElTableColumn label="账号" min-width="150"
          ><template #default="{ row }"
            >{{ row.username || "—"
            }}<ElTag v-if="row.id === currentUserId" size="small" class="ml-2"
              >当前用户</ElTag
            ></template
          ></ElTableColumn
        >
        <ElTableColumn prop="email" label="邮箱" min-width="200"
          ><template #default="{ row }">{{
            row.email || "—"
          }}</template></ElTableColumn
        >
        <ElTableColumn label="平台角色" min-width="200"
          ><template #default="{ row }"
            ><div class="flex flex-wrap gap-1">
              <ElTag v-for="role in row.roles" :key="role.id" size="small">{{
                roleName(role.id)
              }}</ElTag
              ><span v-if="!row.roles.length" class="text-muted-foreground"
                >未分配</span
              >
            </div></template
          ></ElTableColumn
        >
        <ElTableColumn label="状态" width="90"
          ><template #default="{ row }"
            ><ElTag :type="row.disabledAt ? 'info' : 'success'">{{
              row.disabledAt ? "停用" : "启用"
            }}</ElTag></template
          ></ElTableColumn
        >
        <ElTableColumn label="操作" width="180" fixed="right">
          <template #default="{ row }">
            <div class="flex items-center gap-3">
              <ElButton
                link
                type="primary"
                :disabled="busy"
                @click="workspaceUser = row as PlatformUser"
                >工作区授权</ElButton
              >
              <ElDropdown trigger="click">
                <ElButton link :disabled="busy">更多</ElButton>
                <template #dropdown
                  ><ElDropdownMenu>
                    <ElDropdownItem
                      :disabled="busy"
                      @click="open('assign', row as PlatformUser)"
                      >分配平台角色</ElDropdownItem
                    >
                    <ElDropdownItem
                      v-if="superAdmin"
                      :disabled="busy"
                      @click="open('password', row as PlatformUser)"
                      >修改密码</ElDropdownItem
                    >
                    <ElDropdownItem
                      divided
                      :disabled="busy || row.id === currentUserId"
                      @click="toggle(row as PlatformUser)"
                      >{{
                        row.disabledAt ? "启用账号" : "停用账号"
                      }}</ElDropdownItem
                    >
                  </ElDropdownMenu></template
                >
              </ElDropdown>
            </div>
          </template>
        </ElTableColumn>
        <template #empty
          ><ElEmpty
            :description="failed ? '加载失败' : '暂无匹配的用户'"
            :image-size="64"
        /></template>
      </ElTable>
      <ElTable v-else v-loading="loading" :data="pageRoles" row-key="id">
        <ElTableColumn prop="name" label="角色名称" min-width="160" />
        <ElTableColumn prop="code" label="角色代码" min-width="160" />
        <ElTableColumn label="类型" width="110"
          ><template #default="{ row }"
            ><ElTag :type="row.isSystem ? 'warning' : 'info'">{{
              row.isSystem ? "系统角色" : "自定义"
            }}</ElTag></template
          ></ElTableColumn
        >
        <ElTableColumn label="权限数" width="100"
          ><template #default="{ row }">{{
            row.permissionCodes.length
          }}</template></ElTableColumn
        >
        <ElTableColumn label="操作" width="180" fixed="right"
          ><template #default="{ row }"
            ><ElButton
              link
              type="primary"
              @click="open('permissions', row as PlatformRole)"
              >查看权限</ElButton
            ><ElButton
              v-if="!row.isSystem"
              link
              type="primary"
              :disabled="busy"
              @click="open('role', row as PlatformRole)"
              >编辑</ElButton
            ></template
          ></ElTableColumn
        >
        <template #empty
          ><ElEmpty
            :description="failed ? '加载失败' : '暂无匹配的角色'"
            :image-size="64"
        /></template>
      </ElTable>
      <ElPagination
        v-model:current-page="page"
        :page-size="pageSize"
        :total="filtered.length"
        layout="total, prev, pager, next"
        class="mt-4 justify-end"
      />
    </PagePanel>
    <ElDialog
      class="management-dialog"
      body-class="management-dialog-body"
      header-class="management-dialog-header"
      footer-class="management-dialog-footer"
      append-to-body
      :model-value="!!dialog"
      :title="dialogTitle"
      width="min(680px,94vw)"
      :before-close="closeDialog"
      :close-on-click-modal="false"
      destroy-on-close
      @closed="form = undefined"
    >
      <ElAlert
        v-if="actionError"
        :title="actionError"
        type="error"
        :closable="false"
        class="mb-4"
      />
      <ElForm
        v-if="dialog === 'password'"
        ref="form"
        :model="account"
        :rules="passwordRules"
        label-position="top"
        :disabled="busy"
        class="grid grid-cols-1 gap-x-4 sm:grid-cols-2"
        @submit.prevent="submit"
      >
        <ElAlert
          type="warning"
          title="仅超级管理员可修改；保存后该账号的旧登录立即失效。"
          :closable="false"
          class="mb-4 sm:col-span-2"
        />
        <ElFormItem label="新密码" prop="password"
          ><ElInput
            v-model="account.password"
            type="password"
            show-password
            maxlength="72"
            autocomplete="new-password"
            placeholder="10–72 个字符，最多 72 字节"
        /></ElFormItem>
        <ElFormItem label="确认新密码" prop="confirmPassword"
          ><ElInput
            v-model="account.confirmPassword"
            type="password"
            show-password
            maxlength="72"
            autocomplete="new-password"
        /></ElFormItem>
      </ElForm>
      <ElForm
        v-else-if="dialog === 'create' || dialog === 'assign'"
        ref="form"
        :model="account"
        :rules="dialog === 'create' ? accountRules : {}"
        label-position="top"
        :disabled="busy"
        class="grid grid-cols-1 gap-x-4 sm:grid-cols-2"
        @submit.prevent="submit"
      >
        <template v-if="dialog === 'create'">
          <ElFormItem prop="displayName" label="显示名称"
            ><ElInput v-model="account.displayName" maxlength="120"
          /></ElFormItem>
          <ElFormItem prop="identity" label="账号或邮箱"
            ><ElInput
              v-model="account.identity"
              maxlength="320"
              autocomplete="off"
              placeholder="例如 admin-user 或 name@example.com"
          /></ElFormItem>
          <ElFormItem prop="password" label="初始密码"
            ><ElInput
              v-model="account.password"
              type="password"
              show-password
              maxlength="72"
              autocomplete="new-password"
              placeholder="10–72 个字符，最多 72 字节"
          /></ElFormItem>
        </template>
        <ElFormItem prop="roleIds" label="平台角色" class="sm:col-span-2"
          ><ElSelect
            v-model="account.roleIds"
            multiple
            filterable
            class="w-full"
            placeholder="选择角色"
            ><ElOption
              v-for="role in roles"
              :key="role.id"
              :value="role.id"
              :label="role.name"
              :disabled="
                !assignable(role) && !account.roleIds.includes(role.id)
              " /></ElSelect
        ></ElFormItem>
        <p class="sm:col-span-2 text-sm text-muted-foreground">
          工作区访问需单独授权
          <HelpTip
            text="平台角色与工作区授权独立。创建成功后会打开工作区授权，可直接添加成员。"
          />
        </p>
        <ElAlert
          v-if="dialog === 'assign' && !account.roleIds.length"
          class="mt-3 sm:col-span-2"
          type="warning"
          title="保存后此用户将没有平台角色；工作区成员授权不会被移除。"
          :closable="false"
        />
      </ElForm>
      <ElForm
        v-else-if="dialog === 'role'"
        ref="form"
        :model="roleForm"
        :rules="roleRules"
        label-position="top"
        :disabled="busy"
        class="grid grid-cols-1 gap-x-4 sm:grid-cols-2"
        @submit.prevent="submit"
      >
        <ElFormItem label="角色名称" prop="name"
          ><ElInput v-model="roleForm.name" maxlength="120"
        /></ElFormItem>
        <ElFormItem label="角色代码" prop="code"
          ><ElInput
            v-model="roleForm.code"
            maxlength="80"
            :disabled="!!targetRole"
            placeholder="例如 platform_operator"
        /></ElFormItem>
        <ElFormItem label="权限" prop="permissionCodes" class="sm:col-span-2"
          ><ElSelect
            v-model="roleForm.permissionCodes"
            multiple
            filterable
            collapse-tags
            collapse-tags-tooltip
            :max-collapse-tags="4"
            class="w-full"
            placeholder="选择权限"
            ><ElOption
              v-for="permission in permissions"
              :key="permission.code"
              :value="permission.code"
              :label="`${permission.description} · ${permission.code}`"
              :disabled="
                !grants.has(permission.code) &&
                !roleForm.permissionCodes.includes(permission.code)
              " /></ElSelect
        ></ElFormItem>
        <p class="sm:col-span-2 text-sm text-muted-foreground">
          仅可授予自身拥有的权限
          <HelpTip
            text="平台角色不能替代工作区授权；系统角色不可修改，且不能通过编辑角色扩大自身权限。"
          />
        </p>
      </ElForm>
      <ElScrollbar v-else-if="dialog === 'permissions'" max-height="440px"
        ><div class="flex flex-wrap gap-2">
          <ElTag v-for="code in targetRole?.permissionCodes" :key="code"
            >{{
              permissions.find((item) => item.code === code)?.description ||
              code
            }}
            · {{ code }}</ElTag
          ><ElEmpty
            v-if="!targetRole?.permissionCodes.length"
            description="此角色没有权限"
          /></div
      ></ElScrollbar>
      <template #footer
        ><ElButton :disabled="busy" @click="closeDialog()">{{
          dialog === "permissions" ? "关闭" : "取消"
        }}</ElButton
        ><ElButton
          v-if="dialog !== 'permissions'"
          type="primary"
          :loading="busy"
          @click="submit"
          >{{ dialog === "create" ? "创建并配置工作区" : "保存" }}</ElButton
        ></template
      >
    </ElDialog>
    <UserWorkspaces :user="workspaceUser" @close="workspaceUser = undefined" />
  </Page>
</template>
