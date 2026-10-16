<script setup lang="ts">
import { computed, ref } from "vue";
import { useRouter } from "vue-router";
import {
  ElAlert,
  ElButton,
  ElDialog,
  ElDropdown,
  ElDropdownItem,
  ElDropdownMenu,
  ElMessage,
  ElTable,
  ElTableColumn,
  ElTag,
} from "element-plus";
import { managementApi as api } from "#/api/management";
const router = useRouter();
const referenceLink = (r: any) =>
  ["agent", "skill", "tool"].includes(r.type)
    ? router.resolve(`/${r.type}s/${r.id}`).href
    : undefined;
const props = defineProps<{
  resource: any;
  base: string;
  canManage: boolean;
  canCopy?: boolean;
  beforeAction?: () => Promise<boolean>;
}>();
const emit = defineEmits<{ changed: [action: string]; copy: [] }>();
const open = ref(false),
  busy = ref(false),
  action = ref("archive"),
  references = ref<any[]>([]),
  error = ref("");
const removed = computed(
  () => !!(props.resource.archivedAt || props.resource.deletedAt),
);
const blocked = computed(() =>
  references.value.some((r) => r.usage === "current"),
);
const title = computed(() =>
  action.value === "restore"
    ? "恢复资源"
    : action.value === "delete"
      ? "删除资源"
      : "归档资源",
);
function message(e: any) {
  const value = e.response?.data?.error?.message ?? e.response?.data?.message;
  return Array.isArray(value)
    ? value.join("；")
    : (value ?? "操作失败，请重试");
}
async function choose(value: string) {
  if (busy.value || (props.beforeAction && !(await props.beforeAction())))
    return;
  if (value === "copy") {
    if (props.canCopy && !removed.value) emit("copy");
    return;
  }
  action.value = value;
  open.value = true;
  error.value = "";
  references.value = [];
  if (value === "restore") return;
  busy.value = true;
  try {
    const result = await api.get(
      `${props.base}/${props.resource.id}/references`,
    );
    references.value = result.references;
  } catch (e) {
    error.value = message(e);
  } finally {
    busy.value = false;
  }
}
async function confirm() {
  if (
    busy.value ||
    blocked.value ||
    (error.value && action.value !== "restore")
  )
    return;
  error.value = "";
  busy.value = true;
  try {
    const url = `${props.base}/${props.resource.id}`;
    if (action.value === "restore") await api.post(`${url}/restore`);
    else if (action.value === "delete") await api.delete(url);
    else await api.post(`${url}/archive`);
    open.value = false;
    ElMessage.success(
      action.value === "restore"
        ? "已恢复，当前保持停用"
        : action.value === "delete"
          ? "已移入回收站"
          : "已归档",
    );
    emit("changed", action.value);
  } catch (e: any) {
    error.value = message(e);
    const refs =
      e.response?.data?.error?.references ?? e.response?.data?.references;
    if (refs) references.value = refs;
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
  >
    <ElButton :disabled="busy">更多</ElButton>
    <template #dropdown
      ><ElDropdownMenu>
        <ElDropdownItem v-if="canCopy && !removed" command="copy"
          >复制</ElDropdownItem
        >
        <ElDropdownItem v-if="removed" command="restore">恢复</ElDropdownItem>
        <ElDropdownItem v-if="!removed" command="archive">归档</ElDropdownItem>
        <ElDropdownItem v-if="!resource.deletedAt" command="delete"
          >删除</ElDropdownItem
        >
      </ElDropdownMenu></template
    >
  </ElDropdown>
  <ElDialog
    class="management-dialog"
    body-class="management-dialog-body"
    header-class="management-dialog-header"
    footer-class="management-dialog-footer"
    append-to-body
    v-model="open"
    :title="`${title}：${resource.name}`"
    width="min(760px,95vw)"
    :close-on-click-modal="false"
    :show-close="!busy"
    :close-on-press-escape="!busy"
  >
    <ElAlert
      :closable="false"
      :type="action === 'restore' || blocked ? 'warning' : 'info'"
      :title="
        action === 'restore'
          ? '恢复后保持停用，需检查依赖并明确启用；Agent 不会自动恢复生效版本。'
          : blocked
            ? '仍有使用中的引用，请先替换或解除关联'
            : '移除后默认不展示、不可再使用；保留历史版本与 Trace，可恢复。'
      "
    />
    <ElAlert
      v-if="references.some((r) => r.usage === 'draft')"
      class="mt-3"
      :closable="false"
      type="warning"
      title="存在草稿引用：移除后需修正草稿依赖才能发布。"
    />
    <ElAlert
      v-if="error"
      class="mt-3"
      :closable="false"
      type="error"
      :title="error"
    />
    <ElTable
      v-if="action !== 'restore'"
      class="mt-4"
      :data="references"
      v-loading="busy"
      empty-text="没有关联引用"
    >
      <ElTableColumn label="引用资源"
        ><template #default="{ row }"
          ><a
            v-if="referenceLink(row)"
            :href="referenceLink(row)"
            target="_blank"
            rel="noopener noreferrer"
            class="text-primary underline"
            >{{ row.name }}</a
          ><span v-else
            >{{ row.name
            }}<span
              v-if="row.type === 'application'"
              class="ml-2 text-xs text-muted-foreground"
              >请在接入管理中重新绑定 Agent</span
            ></span
          ></template
        ></ElTableColumn
      ><ElTableColumn label="类型"
        ><template #default="{ row }">{{
          (
            {
              agent: "Agent",
              skill: "Skill",
              tool: "Tool",
              application: "接入应用",
            } as any
          )[row.type] ?? row.type
        }}</template></ElTableColumn
      >
      <ElTableColumn label="引用状态"
        ><template #default="{ row }"
          ><ElTag
            :type="
              row.usage === 'current'
                ? 'danger'
                : row.usage === 'draft'
                  ? 'warning'
                  : 'info'
            "
            >{{
              row.usage === "current"
                ? "使用中"
                : row.usage === "draft"
                  ? "草稿"
                  : "历史"
            }}</ElTag
          ></template
        ></ElTableColumn
      >
    </ElTable>
    <template #footer
      ><ElButton :disabled="busy" @click="open = false">取消</ElButton
      ><ElButton
        :type="
          action === 'restore'
            ? 'primary'
            : action === 'delete'
              ? 'danger'
              : 'warning'
        "
        :disabled="blocked || (!!error && action !== 'restore') || busy"
        :loading="busy"
        @click="confirm"
        >{{
          action === "restore"
            ? error
              ? "重试恢复"
              : "确认恢复"
            : action === "delete"
              ? "确认删除"
              : "确认归档"
        }}</ElButton
      ></template
    >
  </ElDialog>
</template>
