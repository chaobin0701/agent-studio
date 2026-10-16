<script setup lang="ts">
import { computed, ref } from "vue";
import {
  ElAlert,
  ElButton,
  ElCollapse,
  ElCollapseItem,
  ElDialog,
  ElDropdown,
  ElDropdownItem,
  ElDropdownMenu,
  ElMessage,
  ElTable,
  ElTableColumn,
} from "element-plus";
import { managementApi as api } from "#/api/management";
const props = defineProps<{
  kind: string;
  type: "plans" | "deployments" | "accounts";
  resource: any;
  canManage: boolean;
  beforeAction?: () => Promise<boolean>;
}>();
const emit = defineEmits<{ changed: [action: string] }>();
const open = ref(false),
  busy = ref(false),
  references = ref<any[]>([]),
  error = ref("");
const action = ref("remove");
const removed = computed(
  () => !!(props.resource.deleted_at || props.resource.archived_at),
);
const base = computed(
  () => `/model-management/${props.kind}/${props.type}/${props.resource.id}`,
);
const currentReferences = computed(() =>
  references.value.filter((r) => r.usage === "current"),
);
const historicalReferences = computed(() =>
  references.value.filter((r) => r.usage === "historical"),
);
const automaticReferences = computed(() =>
  references.value.filter((r) => r.usage === "automatic"),
);
const blocked = computed(() => currentReferences.value.length > 0);
const referenceType = (type: string) =>
  ({
    agent: "Agent",
    knowledge: "知识库",
    workspace: "工作区",
    plan: "模型方案",
    deployment: "模型配置",
    binding: "默认选择",
  })[type] ?? type;
function message(e: any) {
  const text = e.response?.data?.error?.message ?? e.response?.data?.message;
  return Array.isArray(text)
    ? text.join("；")
    : typeof text === "string"
      ? text
      : "操作失败，请稍后重试";
}
async function choose(value: string) {
  if (busy.value || (props.beforeAction && !(await props.beforeAction())))
    return;
  error.value = "";
  action.value = value;
  references.value = [];
  open.value = true;
  if (value === "restore") return;
  busy.value = true;
  try {
    references.value = await api.get(`${base.value}/references`);
  } catch (e) {
    error.value = message(e);
    open.value = true;
  } finally {
    busy.value = false;
  }
}
async function confirm() {
  if (
    blocked.value ||
    busy.value ||
    (error.value && action.value !== "restore")
  )
    return;
  error.value = "";
  busy.value = true;
  try {
    const result =
      action.value === "restore"
        ? await api.post(`${base.value}/restore`)
        : await api.delete(base.value);
    open.value = false;
    ElMessage.success(
      action.value === "restore"
        ? "资源已恢复"
        : result.archived
          ? "已归档，历史依赖保留"
          : "已移除，可恢复",
    );
    emit("changed", action.value);
  } catch (e) {
    error.value = message(e);
  } finally {
    busy.value = false;
  }
}
</script>
<template>
  <ElDropdown
    v-if="canManage"
    trigger="click"
    :disabled="busy"
    @command="choose"
    ><ElButton :disabled="busy">更多</ElButton
    ><template #dropdown
      ><ElDropdownMenu
        ><ElDropdownItem v-if="removed" command="restore">恢复</ElDropdownItem
        ><ElDropdownItem v-else command="remove"
          >删除／归档</ElDropdownItem
        ></ElDropdownMenu
      ></template
    ></ElDropdown
  >
  <ElDialog
    class="management-dialog"
    body-class="management-dialog-body"
    header-class="management-dialog-header"
    footer-class="management-dialog-footer"
    append-to-body
    v-model="open"
    :title="`${action === 'restore' ? '恢复' : '移除'}：${resource.name}`"
    width="min(760px,95vw)"
    :close-on-click-modal="false"
    :show-close="!busy"
    :close-on-press-escape="!busy"
  >
    <ElAlert
      v-if="error"
      class="mb-4"
      :title="error"
      type="error"
      :closable="false"
    />
    <ElAlert
      :title="
        action === 'restore'
          ? '恢复后重新显示在默认列表，不会自动替换 Agent 或知识库已经固定的模型版本。'
          : blocked
            ? '仍有当前使用的引用，请先替换或解除关联'
            : historicalReferences.length
              ? '历史记录不阻止移除。将归档模型资源并保留历史，不再出现在正常列表'
              : '没有阻止移除的当前引用，可移除并在之后恢复'
      "
      :type="blocked ? 'warning' : 'info'"
      :closable="false"
    />
    <ElAlert
      v-if="action !== 'restore' && automaticReferences.length"
      class="mt-4"
      title="旧默认模型选择不阻止移除；确认后将同时解除，不会自动改选其他模型。"
      type="info"
      :closable="false"
    />
    <template v-if="action !== 'restore' && currentReferences.length">
      <h3 class="mb-2 mt-4 font-medium">需要先解除的当前引用</h3>
      <ElTable :data="currentReferences">
        <ElTableColumn label="引用对象" prop="name" />
        <ElTableColumn label="类型"
          ><template #default="{ row }">{{
            referenceType(row.type)
          }}</template></ElTableColumn
        >
      </ElTable>
      <p v-if="type !== 'plans'" class="text-muted-foreground mt-2 text-sm">
        模型配置仍被方案引用时，请先从方案中替换该配置，或移除不再使用的方案。
      </p>
    </template>
    <ElCollapse
      v-if="action !== 'restore' && historicalReferences.length"
      class="mt-4"
    >
      <ElCollapseItem
        :title="`历史引用（${historicalReferences.length} 项，不阻止移除）`"
        name="history"
      >
        <ElTable :data="historicalReferences">
          <ElTableColumn label="引用对象" prop="name" />
          <ElTableColumn label="类型"
            ><template #default="{ row }">{{
              referenceType(row.type)
            }}</template></ElTableColumn
          >
          <ElTableColumn label="用途"
            ><template #default>历史追溯</template></ElTableColumn
          >
        </ElTable>
      </ElCollapseItem>
    </ElCollapse>
    <template #footer
      ><ElButton :disabled="busy" @click="open = false">取消</ElButton
      ><ElButton
        :type="action === 'restore' ? 'primary' : 'danger'"
        :loading="busy"
        :disabled="busy || blocked || (!!error && action !== 'restore')"
        @click="confirm"
        >{{
          action === "restore"
            ? error
              ? "重试恢复"
              : "确认恢复"
            : historicalReferences.length
              ? "归档并保留历史"
              : "确认移除"
        }}</ElButton
      ></template
    >
  </ElDialog>
</template>
