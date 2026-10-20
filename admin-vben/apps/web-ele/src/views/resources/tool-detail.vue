<script setup lang="ts">
import { computed, defineAsyncComponent, ref } from "vue";
import {
  ElAlert,
  ElButton,
  ElDialog,
  ElForm,
  ElTabPane,
  ElTable,
  ElTableColumn,
  ElTabs,
  ElTag,
} from "element-plus";
import type { DraftSaveState } from "#/composables/draft-queue";
import PagePanel from "#/components/PagePanel.vue";
import JsonEditor from "#/components/JsonEditor.vue";
import ToolFields from "../tools/ToolFields.vue";
const VersionDiff = defineAsyncComponent(
  () => import("../prompts/components/PromptDiff.vue"),
);
const props = defineProps<{
  detail: any;
  selected?: number;
  options: any;
  canManage: boolean;
  canExecute: boolean;
  busy: boolean;
  dirty: boolean;
  saveState: DraftSaveState;
  result: any;
  contentValid: boolean;
}>();
const config = defineModel<any>({ required: true });
const emit = defineEmits<{
  valid: [value: boolean];
  version: [id: number];
  edit: [];
  branch: [];
  retry: [];
  test: [];
  publish: [];
  toggle: [];
}>();
const section = ref<"connection" | "parameters" | "result" | "runtime">(
  "connection",
);
const historyOpen = ref(false);
const historyTab = ref("versions");
const comparisonId = ref<number>();
const active = computed(() =>
  props.detail.versions.find((v: any) => v.id === props.selected),
);
const editable = computed(
  () => props.canManage && active.value?.status === "draft",
);
const tested = computed(
  () =>
    active.value?.testedRevision === active.value?.revision &&
    props.result?.ok &&
    !props.dirty,
);
const locked = computed(() => props.busy || props.saveState.saving);
const questionTool = computed(
  () => config.value.type === "builtin" && config.value.target === "ask_user",
);
const comparison = computed(
  () =>
    props.detail.versions.find((v: any) => v.id === comparisonId.value) ??
    props.detail.versions.find(
      (v: any) => v.status === "published" && v.id !== props.selected,
    ),
);
const status = computed(() =>
  !editable.value
    ? `已发布 v${active.value?.version} · 只读`
    : props.saveState.conflict
      ? "草稿冲突，请重新加载"
      : props.saveState.error
        ? "草稿保存失败"
        : !props.contentValid
          ? "格式无效，尚未保存"
          : props.saveState.saving
            ? "正在保存草稿…"
            : props.dirty
              ? "等待自动保存…"
              : "草稿已保存",
);
</script>
<template>
  <PagePanel class="space-y-4" aria-label="Tool 编辑工作区">
    <div class="flex flex-wrap items-center justify-between gap-3">
      <div class="flex flex-wrap items-center gap-3" aria-live="polite">
        <ElTag :type="editable ? 'warning' : 'success'">{{ status }}</ElTag>
        <ElTag v-if="tested" type="success">{{
          questionTool ? "交互契约已验证（样例回答）" : "当前配置已通过真实测试"
        }}</ElTag>
      </div>
      <div class="flex flex-wrap items-center gap-2">
        <ElButton :disabled="locked" @click="historyOpen = true"
          >历史与差异</ElButton
        >
        <ElButton
          v-if="canManage && !editable"
          :disabled="locked"
          @click="emit('edit')"
          >编辑／继续草稿</ElButton
        >
        <ElButton
          v-if="editable && canExecute"
          :disabled="busy || saveState.conflict || !contentValid"
          @click="emit('test')"
          >{{ questionTool ? "交互契约测试" : "真实调用测试" }}</ElButton
        >
        <ElButton
          v-if="editable"
          type="primary"
          :disabled="locked || !tested || !contentValid"
          @click="emit('publish')"
          >发布</ElButton
        >
        <slot name="actions" />
      </div>
    </div>
    <ElAlert
      v-if="saveState.error"
      type="error"
      :closable="false"
      :title="saveState.error"
    >
      <ElButton
        v-if="!saveState.conflict"
        link
        type="primary"
        :disabled="locked"
        @click="emit('retry')"
        >重试保存</ElButton
      >
    </ElAlert>
    <ElTabs v-model="section">
      <ElTabPane name="connection" label="基本与连接" />
      <ElTabPane name="parameters" label="输入参数" />
      <ElTabPane name="result" label="返回结果" />
      <ElTabPane name="runtime" label="运行设置" />
    </ElTabs>
    <ElForm label-position="top" :disabled="!editable || busy">
      <ToolFields
        :key="`${selected}:${active?.status}`"
        v-model="config"
        :section="section"
        :options="options"
        :disabled="!editable || busy"
        @valid="emit('valid', $event)"
      />
    </ElForm>
    <ElAlert
      v-if="result"
      :type="result.ok ? 'success' : 'error'"
      :closable="false"
      :title="
        result.ok
          ? questionTool
            ? '交互契约验证通过（样例回答）'
            : '真实测试通过'
          : `测试失败：${result.errorCode ?? '请检查配置'}`
      "
    />
    <details v-if="result">
      <summary class="cursor-pointer text-sm text-muted-foreground">
        测试结果详情
      </summary>
      <JsonEditor
        class="mt-3"
        :model-value="JSON.stringify(result, null, 2)"
        readonly
        label="工具测试结果"
      />
    </details>
    <ElDialog
      class="management-dialog"
      body-class="management-dialog-body"
      header-class="management-dialog-header"
      footer-class="management-dialog-footer"
      append-to-body
      v-model="historyOpen"
      title="历史与差异"
      width="min(1100px, 95vw)"
      destroy-on-close
    >
      <ElTabs v-model="historyTab">
        <ElTabPane name="versions" label="历史版本">
          <ElTable :data="detail.versions">
            <ElTableColumn label="版本"
              ><template #default="{ row }"
                >v{{ row.version }}</template
              ></ElTableColumn
            >
            <ElTableColumn label="状态"
              ><template #default="{ row }">{{
                row.status === "draft" ? "草稿" : "已发布"
              }}</template></ElTableColumn
            >
            <ElTableColumn label="操作"
              ><template #default="{ row }">
                <ElButton
                  link
                  type="primary"
                  :disabled="locked"
                  @click="
                    emit('version', row.id);
                    historyOpen = false;
                  "
                  >查看</ElButton
                >
                <ElButton
                  link
                  :disabled="locked"
                  @click="
                    comparisonId = row.id;
                    historyTab = 'diff';
                  "
                  >比较</ElButton
                >
              </template></ElTableColumn
            >
          </ElTable>
          <div class="mt-4 flex flex-wrap items-center gap-3">
            <span class="text-sm text-muted-foreground"
              >{{ detail.key }} · 当前查看 v{{ active?.version }}</span
            >
            <ElButton
              v-if="canManage && active?.status === 'published'"
              :disabled="locked"
              @click="
                emit('branch');
                historyOpen = false;
              "
              >基于此版本另建草稿</ElButton
            >
            <ElButton
              v-if="canManage"
              :disabled="locked"
              @click="emit('toggle')"
              >{{ detail.enabled ? "停用" : "启用" }}</ElButton
            >
          </div>
        </ElTabPane>
        <ElTabPane name="diff" label="配置差异">
          <VersionDiff
            v-if="historyOpen && historyTab === 'diff'"
            :left="JSON.stringify(comparison?.config ?? {}, null, 2)"
            :right="JSON.stringify(config, null, 2)"
            :left-label="comparison ? `v${comparison.version}` : '无历史版本'"
            :right-label="`当前查看 v${active?.version}`"
            file-name="tool.json"
          />
        </ElTabPane>
      </ElTabs>
    </ElDialog>
  </PagePanel>
</template>
