<script setup lang="ts">
import { computed, ref, defineAsyncComponent } from "vue";
import { useRouter, useRoute } from "vue-router";
import { useAccessStore } from "@vben/stores";
import { useMediaQuery } from "@vueuse/core";
import {
  ElAlert,
  ElButton,
  ElDialog,
  ElSegmented,
  ElTable,
  ElTableColumn,
  ElTabs,
  ElTabPane,
  ElTag,
  ElSplitter,
  ElSplitterPanel,
  ElScrollbar,
  ElFormItem,
  ElInput,
} from "element-plus";
import Fields from "./fields.vue";
import RunPanel from "../playground/RunPanel.vue";
import type { DraftSaveState } from "#/composables/draft-queue";

const props = defineProps<{
  detail: any;
  selected?: number;
  options: any;
  resources: any[];
  canManage: boolean;
  busy: boolean;
  dirty: boolean;
  contentValid: boolean;
  result?: any;
  saveState: DraftSaveState;
  prepare: () => Promise<boolean>;
}>();
const VersionDiff = defineAsyncComponent(
  () => import("../prompts/components/PromptDiff.vue"),
);
const historyTab = ref("versions"),
  comparisonId = ref<number>();
const comparison = computed(
  () =>
    props.detail.versions.find((v: any) => v.id === comparisonId.value) ??
    props.detail.versions.find(
      (v: any) => v.id === props.detail.currentVersionId,
    ),
);
const config = defineModel<any>({ required: true });
const name = defineModel<string>("name", { required: true });
const emit = defineEmits<{
  version: [id: number];
  edit: [];
  save: [];
  publish: [];
  activate: [id: number];
  toggle: [];
  refreshOptions: [];
  valid: [value: boolean];
}>();
const section = ref<
    "basic" | "abilities" | "collaboration" | "output" | "runtime"
  >("basic"),
  mobile = ref(
    useRoute().query.tab === "preview" ? "preview" : "configuration",
  ),
  history = ref(false),
  testing = ref(false);
const wide = useMediaQuery("(min-width: 1280px)");
const router = useRouter(),
  access = useAccessStore();
const active = computed(() =>
  props.detail.versions.find((v: any) => v.id === props.selected),
);
const current = computed(() =>
  props.detail.versions.find(
    (v: any) => v.id === props.detail.currentVersionId,
  ),
);
const editable = computed(
  () =>
    props.canManage &&
    active.value?.status === "draft" &&
    active.value.id ===
      props.detail.versions.find((v: any) => v.status === "draft")?.id,
);
const validName = computed(
  () => !!name.value.trim() && name.value.trim().length <= 160,
);
const hasChanges = computed(
  () =>
    !current.value ||
    JSON.stringify(config.value) !== JSON.stringify(current.value.config) ||
    name.value.trim() !== current.value.name,
);
const status = computed(() =>
  props.saveState.conflict
    ? "保存冲突"
    : props.saveState.error
      ? "保存失败"
      : props.saveState.saving
        ? "正在保存…"
        : props.dirty
          ? "待保存"
          : active.value?.status === "draft"
            ? "草稿已保存"
            : "只读版本",
);
const canExecute = computed(
  () =>
    props.canManage &&
    props.detail.enabled &&
    (editable.value || props.selected === props.detail.currentVersionId) &&
    access.accessCodes.includes("agent_tools.execute"),
);
const date = (v?: string) => (v ? new Date(v).toLocaleString() : "—");
async function selectVersion(id: number) {
  emit("version", id);
  history.value = false;
}
</script>
<template>
  <div class="space-y-4">
    <div class="flex flex-wrap items-center justify-between gap-3">
      <div class="flex flex-wrap items-center gap-2">
        <ElTag :type="detail.enabled ? 'success' : 'info'">{{
          detail.enabled ? "启用" : "停用"
        }}</ElTag>
        <span class="text-sm text-muted-foreground"
          >{{ current ? `当前生效 v${current.version}` : "尚未发布" }} ·
          {{ status }}</span
        >
      </div>
      <div class="flex flex-wrap gap-2">
        <ElButton
          v-if="!editable && canManage"
          :disabled="busy || testing"
          @click="emit('edit')"
          >编辑配置</ElButton
        >
        <ElButton
          v-if="editable"
          type="primary"
          :loading="busy"
          :disabled="
            testing ||
            saveState.conflict ||
            !validName ||
            !contentValid ||
            !hasChanges
          "
          @click="emit('publish')"
          >发布</ElButton
        >
        <ElButton :disabled="busy || testing" @click="history = true"
          >历史与差异</ElButton
        >
        <ElButton
          v-if="access.accessCodes.includes('conversations.read')"
          @click="
            router.push({ path: '/executions', query: { agentId: detail.id } })
          "
          >运行记录</ElButton
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
      <div class="mt-2 flex gap-2">
        <ElButton v-if="!saveState.conflict" size="small" @click="emit('save')"
          >重试保存</ElButton
        >
        <span v-else
          >编辑内容仍在页面，请刷新核对最新草稿，不能直接覆盖其他人的修改。</span
        >
      </div>
    </ElAlert>
    <ElAlert
      v-if="result && !result.ok"
      type="error"
      :closable="false"
      :title="`发布校验失败：${result.errorCode ?? '请检查配置'}`"
    />
    <ElAlert
      v-if="editable && !validName"
      title="请输入 Agent 名称（最多 160 字符）；修正后会继续自动保存。"
      type="warning"
      :closable="false"
    />
    <ElSegmented
      v-if="!wide"
      v-model="mobile"
      :options="[
        { label: '配置', value: 'configuration' },
        { label: '试运行', value: 'preview' },
      ]"
    />
    <ElSplitter
      class="agent-workbench bg-card"
      :layout="wide ? 'horizontal' : 'vertical'"
    >
      <ElSplitterPanel
        :size="wide ? '55%' : mobile === 'configuration' ? '100%' : '0%'"
        :min="wide ? '40%' : undefined"
        :resizable="wide"
        :inert="!wide && mobile !== 'configuration'"
        :aria-hidden="!wide && mobile !== 'configuration'"
      >
        <ElScrollbar height="100%">
          <div class="min-w-0 p-4 md:p-6">
            <ElTabs v-model="section" :before-leave="() => !busy && !testing">
              <ElTabPane name="basic" label="基本配置" />
              <ElTabPane name="abilities" label="能力" />
              <ElTabPane name="collaboration" label="协作" />
              <ElTabPane name="output" label="输出规范" />
              <ElTabPane name="runtime" label="运行设置" />
            </ElTabs>
            <div
              class="mb-4 flex flex-wrap items-center justify-between gap-2 text-sm text-muted-foreground"
            >
              <span>{{
                editable
                  ? "自动保存草稿，发布后生效"
                  : `查看 v${active?.version}，不影响当前生效配置`
              }}</span>
              <ElButton
                v-if="section === 'basic'"
                link
                type="primary"
                @click="router.push('/prompts')"
                >管理 Prompt</ElButton
              >
              <ElButton
                v-if="section === 'abilities'"
                link
                type="primary"
                @click="router.push('/tools')"
                >管理资源</ElButton
              >
            </div>
            <Fields
              :key="`${selected}:${active?.status}`"
              v-model="config"
              kind="agent"
              :section="section"
              :options="options"
              :resources="resources"
              :resource-id="detail.id"
              :disabled="busy || testing || !editable"
              full-width
              @valid="emit('valid', $event)"
              @refresh-options="emit('refreshOptions')"
              ><template #identity
                ><ElFormItem label="Agent 名称" required
                  ><ElInput
                    v-model="name"
                    maxlength="160" /></ElFormItem></template
            ></Fields>
            <div
              v-if="section === 'runtime'"
              class="mt-6 border-t border-border pt-4"
            >
              <h3 class="mb-3 text-sm font-semibold">接入与状态</h3>
              <code class="block break-all text-xs text-muted-foreground"
                >POST /api/v1/agent/{{ detail.id }}/runs</code
              >
              <ElButton
                v-if="
                  access.accessCodes.includes('integrations.read') ||
                  access.accessCodes.includes('integrations.manage')
                "
                class="mt-3"
                link
                type="primary"
                @click="
                  router.push({
                    path: '/integrations',
                    query: { agentId: String(detail.id) },
                  })
                "
                >管理应用接入</ElButton
              >
              <div class="mt-3 flex items-center gap-3">
                <span class="text-xs text-muted-foreground"
                  >{{ detail.key }} · ID {{ detail.id }}</span
                >
                <ElButton
                  v-if="canManage"
                  :disabled="busy || testing"
                  @click="emit('toggle')"
                  >{{ detail.enabled ? "停用 Agent" : "启用 Agent" }}</ElButton
                >
              </div>
            </div>
          </div>
        </ElScrollbar>
      </ElSplitterPanel>
      <ElSplitterPanel
        :size="wide ? '45%' : mobile === 'preview' ? '100%' : '0%'"
        :min="wide ? '32%' : undefined"
        :resizable="wide"
        :inert="!wide && mobile !== 'preview'"
        :aria-hidden="!wide && mobile !== 'preview'"
      >
        <ElScrollbar height="100%">
          <div class="min-w-0 p-4 md:p-6">
            <RunPanel
              v-if="canExecute"
              embedded
              :agent-id="detail.id"
              :draft-version-id="editable ? active.id : undefined"
              :draft-revision="editable ? active.revision : undefined"
              :configuration-key="JSON.stringify({ name, config })"
              :prepare="prepare"
              @running="testing = $event"
            />
            <ElAlert
              v-else
              type="info"
              :closable="false"
              title="试运行需要启用 Agent，并具备配置管理和工具执行权限。"
            />
          </div>
        </ElScrollbar>
      </ElSplitterPanel>
    </ElSplitter>
    <ElDialog
      class="management-dialog"
      body-class="management-dialog-body"
      header-class="management-dialog-header"
      footer-class="management-dialog-footer"
      append-to-body
      v-model="history"
      title="历史与差异"
      width="min(1100px,95vw)"
      destroy-on-close
    >
      <ElTabs v-model="historyTab">
        <ElTabPane name="versions" label="历史版本">
          <ElTable :data="detail.versions">
            <ElTableColumn label="版本" width="100"
              ><template #default="{ row }"
                >v{{ row.version }}</template
              ></ElTableColumn
            >
            <ElTableColumn label="状态" width="140"
              ><template #default="{ row }"
                ><ElTag
                  :type="
                    row.id === detail.currentVersionId
                      ? 'success'
                      : row.status === 'draft'
                        ? 'warning'
                        : 'info'
                  "
                  >{{
                    row.status === "draft"
                      ? "草稿"
                      : row.id === detail.currentVersionId
                        ? "当前生效"
                        : "历史发布"
                  }}</ElTag
                ></template
              ></ElTableColumn
            >
            <ElTableColumn label="创建时间" min-width="180"
              ><template #default="{ row }">{{
                date(row.createdAt)
              }}</template></ElTableColumn
            >
            <ElTableColumn label="发布时间" min-width="180"
              ><template #default="{ row }">{{
                date(row.publishedAt)
              }}</template></ElTableColumn
            >
            <ElTableColumn label="操作" width="230"
              ><template #default="{ row }">
                <ElButton
                  link
                  type="primary"
                  :disabled="busy || testing"
                  @click="selectVersion(row.id)"
                  >查看</ElButton
                >
                <ElButton
                  link
                  :disabled="busy || testing"
                  @click="
                    comparisonId = row.id;
                    historyTab = 'diff';
                  "
                  >比较</ElButton
                >
                <ElButton
                  v-if="
                    canManage &&
                    row.status === 'published' &&
                    row.id !== detail.currentVersionId
                  "
                  link
                  type="warning"
                  :disabled="busy || testing"
                  @click="emit('activate', row.id)"
                  >回滚</ElButton
                >
              </template></ElTableColumn
            >
          </ElTable>
        </ElTabPane>
        <ElTabPane name="diff" label="配置差异">
          <VersionDiff
            v-if="history && historyTab === 'diff'"
            :left="
              JSON.stringify(
                { name: comparison?.name, config: comparison?.config ?? {} },
                null,
                2,
              )
            "
            :right="JSON.stringify({ name, config }, null, 2)"
            :left-label="
              comparison
                ? `v${comparison.version}${comparison.id === detail.currentVersionId ? ' · 当前生效' : ''}`
                : '尚无生效版本'
            "
            :right-label="`当前查看 v${active?.version}`"
            file-name="agent.json"
          />
        </ElTabPane>
      </ElTabs>
    </ElDialog>
  </div>
</template>
<style scoped>
.agent-workbench {
  height: clamp(24rem, calc(100dvh - 16rem), 64rem);
  border: 1px solid hsl(var(--border));
  border-radius: var(--radius);
}
</style>
