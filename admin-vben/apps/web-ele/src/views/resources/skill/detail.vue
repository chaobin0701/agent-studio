<script setup lang="ts">
import {
  computed,
  defineAsyncComponent,
  onBeforeUnmount,
  ref,
  watch,
} from "vue";
import {
  ElAlert,
  ElButton,
  ElDialog,
  ElForm,
  ElTable,
  ElTableColumn,
  ElTabs,
  ElTabPane,
  ElTag,
  ElMessage,
  ElMessageBox,
  ElDropdown,
  ElDropdownMenu,
  ElDropdownItem,
} from "element-plus";
import { LineCounter, parseDocument } from "yaml";
import { managementApi as api } from "#/api/management";
import { useUnsavedChanges } from "#/composables/use-unsaved-changes";
import Fields from "./fields.vue";
import Resources from "./resources.vue";
import { comparableResources } from "./resources";
import { frontmatterSection } from "./frontmatter";
const MarkdownEditor = defineAsyncComponent(
  () => import("./markdown-editor.vue"),
);
const VersionDiff = defineAsyncComponent(
  () => import("../../prompts/components/PromptDiff.vue"),
);
const props = defineProps<{
  detail: any;
  options: any;
  resources: any[];
  canManage: boolean;
}>();
const detail = ref<any>(),
  selected = ref<number>(),
  config = ref<any>({}),
  original = ref(""),
  tab = ref("form"),
  busy = ref(false),
  saving = ref(false),
  saveError = ref(""),
  actionError = ref(""),
  usageError = ref(""),
  conflict = ref(false),
  contentValid = ref(true),
  source = ref(""),
  sourceOriginal = ref(""),
  sourceError = ref(""),
  diagnostics = ref<any[]>([]),
  usage = ref<any[]>([]),
  diffOpen = ref(false),
  historyOpen = ref(false),
  result = ref<any>();
let timer: ReturnType<typeof setTimeout> | undefined;
let pending: Promise<boolean> | undefined;
let generation = 0;
const active = computed(() =>
  detail.value?.versions.find((v: any) => v.id === selected.value),
);
const editable = computed(
  () => props.canManage && active.value?.status === "draft",
);
const hasBody = computed(() =>
  Boolean(
    config.value.document
      ? frontmatterSection(config.value.document, "skill")?.body?.trim()
      : config.value.instructions?.trim(),
  ),
);
const sourceDirty = computed(() => source.value !== sourceOriginal.value);
const formDirty = computed(
  () => editable.value && JSON.stringify(config.value) !== original.value,
);
const dirty = computed(() => formDirty.value || sourceDirty.value);
const base = computed(() =>
  detail.value?.versions.find(
    (v: any) =>
      v.status === "published" &&
      v.id !== selected.value &&
      v.version < (active.value?.version ?? Infinity),
  ),
);
const saveStatus = computed(() =>
  conflict.value
    ? "草稿已被其他人修改，请重新加载"
    : saveError.value
      ? "保存失败，内容仍保留在页面"
      : !contentValid.value
        ? "内容格式无效，尚未保存"
        : sourceDirty.value
          ? "源码尚未应用，未保存"
          : saving.value
            ? "保存中…"
            : formDirty.value
              ? "等待自动保存…"
              : "已保存",
);
function errorMessage(e: any) {
  const m = e.response?.data?.error?.message ?? e.response?.data?.message;
  return Array.isArray(m)
    ? m.join("；")
    : typeof m === "string"
      ? m
      : (e.message ?? "操作失败，请重试");
}
function cancelTimer() {
  if (timer) clearTimeout(timer);
  timer = undefined;
}
function adopt(id?: number) {
  cancelTimer();
  generation++;
  selected.value =
    id ??
    detail.value?.versions.find((v: any) => v.status === "draft")?.id ??
    detail.value?.versions[0]?.id;
  config.value = JSON.parse(JSON.stringify(active.value?.config ?? {}));
  original.value = JSON.stringify(config.value);
  saveError.value = "";
  actionError.value = "";
  usageError.value = "";
  conflict.value = false;
  source.value = "";
  sourceOriginal.value = "";
  sourceError.value = "";
  diagnostics.value = [];
  tab.value = "form";
  result.value = active.value?.testResult;
}
watch(
  () => props.detail,
  (value) => {
    detail.value = JSON.parse(JSON.stringify(value));
    adopt();
    void loadUsage();
  },
  { immediate: true },
);
async function loadUsage() {
  const current = generation;
  usageError.value = "";
  try {
    const r = await api.get(`/agent-resources/skills/${detail.value.id}/usage`);
    if (current === generation) usage.value = r.agents;
  } catch (e) {
    if (current === generation) usageError.value = errorMessage(e);
  }
}
function schedule() {
  cancelTimer();
  if (
    !formDirty.value ||
    busy.value ||
    sourceDirty.value ||
    conflict.value ||
    !editable.value
  )
    return;
  timer = setTimeout(() => void persist(), 1200);
}
watch(
  () => JSON.stringify(config.value),
  () => {
    saveError.value = "";
    actionError.value = "";
    result.value = undefined;
    schedule();
  },
);
// A single in-flight write; a newer edit is queued against the returned revision.
async function persist(manual = false): Promise<boolean> {
  cancelTimer();
  if (pending) {
    await pending;
    return persist(manual);
  }
  if (sourceDirty.value) {
    if (manual) ElMessage.warning("请先应用或放弃源码修改");
    return false;
  }
  if (!editable.value || conflict.value) return !dirty.value;
  if (!contentValid.value) return false;
  if (!formDirty.value) return true;
  const current = generation,
    v = active.value,
    payload = JSON.stringify(config.value),
    revision = v.revision;
  saving.value = true;
  saveError.value = "";
  pending = (async () => {
    try {
      const r = await api.patch(`/agent-resources/versions/${v.id}`, {
        revision,
        config: JSON.parse(payload),
      });
      if (current !== generation) return false;
      v.revision = r.revision;
      v.config = JSON.parse(payload);
      v.testedRevision = null;
      v.testResult = null;
      original.value = payload;
      if (r.config && JSON.stringify(config.value) === payload) {
        config.value = r.config;
        original.value = JSON.stringify(r.config);
        v.config = r.config;
      }
      result.value = undefined;
      if (manual) ElMessage.success("草稿已保存");
      return true;
    } catch (e: any) {
      if (current === generation) {
        saveError.value = errorMessage(e);
        conflict.value = e.response?.status === 409;
      }
      return false;
    } finally {
      saving.value = false;
      pending = undefined;
    }
  })();
  const ok = await pending;
  if (ok && current === generation && formDirty.value) schedule();
  return ok;
}
async function flushDraft() {
  if (sourceDirty.value || conflict.value || !contentValid.value) return false;
  cancelTimer();
  if (pending && !(await pending)) return false;
  while (formDirty.value) {
    if (!(await persist())) return false;
    cancelTimer();
  }
  return !dirty.value;
}
const confirmDiscard = useUnsavedChanges(
  computed(() => dirty.value || saving.value),
  flushDraft,
);
async function prepareLeave() {
  cancelTimer();
  if (pending) await pending;
  const okay = await confirmDiscard();
  if (!okay) schedule();
  return okay;
}
defineExpose({ prepareLeave });
onBeforeUnmount(() => {
  cancelTimer();
  generation++;
});
async function switchVersion(id: number) {
  if (!(await prepareLeave())) return;
  adopt(id);
}
async function reload(id = selected.value) {
  detail.value = await api.get(`/agent-resources/${detail.value.id}`);
  adopt(id);
  await loadUsage();
}
async function edit(branch = false) {
  if (!(await prepareLeave())) return;
  if (branch) {
    try {
      await ElMessageBox.confirm(
        "基于此历史版本另建草稿？已有草稿将保留，不会覆盖。",
        "基于历史版本编辑",
      );
    } catch {
      return;
    }
  }
  busy.value = true;
  try {
    const r = await api.post(
      `/agent-resources/skills/${detail.value.id}/draft`,
      { fromVersionId: selected.value, branch },
    );
    await reload(r.versionId);
    if (r.reused) ElMessage.info("已继续编辑现有工作草稿");
  } catch (e) {
    actionError.value = errorMessage(e);
  } finally {
    busy.value = false;
  }
}
async function beforeTab(next: string | number) {
  if (next === "source") {
    if (!(await persist()) || formDirty.value) return false;
    busy.value = true;
    try {
      const r = await api.get(
        `/agent-resources/versions/${selected.value}/skill-document`,
      );
      source.value = r.document;
      sourceOriginal.value = r.document;
      diagnostics.value = r.diagnostics;
      return true;
    } catch (e) {
      sourceError.value = errorMessage(e);
      return false;
    } finally {
      busy.value = false;
    }
  }
  if (sourceDirty.value) {
    ElMessage.warning("请先应用或放弃源码修改");
    return false;
  }
  return true;
}
watch(source, (value) => {
  sourceError.value = "";
  if (!sourceDirty.value) return;
  cancelTimer();
  const match = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(
    value.replace(/^\uFEFF/, ""),
  );
  if (!match) {
    sourceError.value = "源码需要 YAML frontmatter 起止分隔符（---）";
    return;
  }
  const lineCounter = new LineCounter(),
    doc = parseDocument(match[1]!, { lineCounter, uniqueKeys: true });
  if (doc.errors.length) {
    const e = doc.errors[0]!,
      p = lineCounter.linePos(e.pos[0]);
    sourceError.value = `YAML 第 ${p.line + 1} 行、第 ${p.col} 列：${e.message.split("\n")[0]}`;
  }
});
async function applySource() {
  if (!editable.value || sourceError.value) return;
  busy.value = true;
  try {
    const r = await api.post("/agent-resources/skill-document", {
      document: source.value,
      resourceKey: detail.value.key,
    });
    config.value = { ...r.config, resources: config.value.resources ?? [] };
    diagnostics.value = r.diagnostics;
    sourceOriginal.value = source.value;
    tab.value = "form";
    contentValid.value = true;
    busy.value = false;
    await persist(true);
  } catch (e) {
    sourceError.value = errorMessage(e);
  } finally {
    busy.value = false;
  }
}
function discardSource() {
  source.value = sourceOriginal.value;
  sourceError.value = "";
  schedule();
}
function comparable(value: any) {
  if (!value) return "";
  if (value?.document)
    return value.document + comparableResources(value.resources);
  const { instructions, ...settings } = value ?? {};
  return `${JSON.stringify(settings, null, 2)}\n\n${instructions ?? ""}\n`;
}
async function reviewPublish() {
  if (!(await flushDraft()) || dirty.value) return;
  await loadUsage();
  diffOpen.value = true;
}
async function publish() {
  if (!(await flushDraft()) || dirty.value) return;
  busy.value = true;
  try {
    await api.post(`/agent-resources/versions/${selected.value}/test`);
    await api.post(`/agent-resources/versions/${selected.value}/publish`);
    diffOpen.value = false;
    await reload();
    ElMessage.success("Skill 已发布，已有 Agent 绑定保持不变");
  } catch (e) {
    actionError.value = errorMessage(e);
  } finally {
    busy.value = false;
  }
}
async function exportDocument(format: "platform" | "portable", bundle = false) {
  if (sourceDirty.value) {
    ElMessage.warning("请先应用或放弃源码修改");
    return;
  }
  try {
    // Read-only users can export the persisted platform document without manage access.
    const r = props.canManage
      ? await api.post("/agent-resources/skill-document/export", {
          key: detail.value.key,
          name: detail.value.name,
          config: config.value,
          format,
        })
      : await api.get(
          `/agent-resources/versions/${selected.value}/skill-document?format=${format}`,
        );
    const url = URL.createObjectURL(
      new Blob([bundle ? JSON.stringify(r.bundle) : r.document], {
        type: bundle
          ? "application/json;charset=utf-8"
          : "text/markdown;charset=utf-8",
      }),
    );
    const a = document.createElement("a");
    a.href = url;
    a.download = bundle
      ? `${detail.value.key}.skill.json`
      : format === "portable"
        ? "SKILL.md"
        : `${detail.value.key}.SKILL.md`;
    a.click();
    if (!bundle && config.value.resources?.length)
      ElMessage.info("SKILL.md 只包含正文；请用“导出完整包”包含辅助资料。");
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (e) {
    actionError.value = errorMessage(e);
  }
}
async function toggle() {
  try {
    await ElMessageBox.confirm(
      detail.value.enabled ? "停用此 Skill？" : "启用此 Skill？",
      "确认",
    );
    await api.patch(`/agent-resources/${detail.value.id}/status`, {
      enabled: !detail.value.enabled,
    });
    detail.value.enabled = !detail.value.enabled;
  } catch {
    /* Standard request/confirm feedback. */
  }
}
</script>
<template>
  <section v-if="detail" class="space-y-4" aria-label="Skill 编辑工作区">
    <div class="flex flex-wrap items-center justify-between gap-3">
      <div class="flex flex-wrap items-center gap-3" aria-live="polite">
        <ElTag :type="editable ? 'warning' : 'success'">{{
          editable ? saveStatus : `已发布 v${active?.version} · 只读`
        }}</ElTag>
        <span v-if="editable" class="text-sm text-muted-foreground"
          >编辑不会改变已发布内容</span
        >
      </div>
      <div class="flex flex-wrap items-center gap-2">
        <ElButton :disabled="busy || saving" @click="historyOpen = true"
          >历史与引用</ElButton
        >
        <ElDropdown
          trigger="click"
          :disabled="busy || saving || dirty"
          @command="
            (command) => exportDocument('portable', command === 'bundle')
          "
        >
          <ElButton :disabled="busy || saving || dirty">导出</ElButton>
          <template #dropdown
            ><ElDropdownMenu>
              <ElDropdownItem command="document">SKILL.md</ElDropdownItem>
              <ElDropdownItem command="bundle">完整资源包</ElDropdownItem>
            </ElDropdownMenu></template
          >
        </ElDropdown>
        <ElButton
          v-if="canManage && !editable"
          :disabled="busy || saving"
          @click="edit()"
          >编辑／继续草稿</ElButton
        >
        <ElButton
          v-if="editable"
          type="primary"
          :disabled="
            busy ||
            saving ||
            conflict ||
            sourceDirty ||
            !contentValid ||
            !hasBody
          "
          @click="reviewPublish"
          >发布</ElButton
        >
        <slot name="actions" />
      </div>
    </div>
    <ElButton
      v-if="saveError && !conflict"
      link
      type="primary"
      :disabled="busy || saving"
      @click="flushDraft"
      >重试保存</ElButton
    >
    <ElAlert
      v-if="saveError || actionError"
      :title="saveError || actionError"
      type="error"
      :closable="false"
    /><ElAlert
      v-if="result?.ok"
      title="配置校验通过；这不等同于真实模型效果评测。"
      type="success"
      :closable="false"
    />
    <ElTabs v-model="tab" :before-leave="beforeTab">
      <ElTabPane name="form" label="内容"
        ><ElForm label-position="top" :disabled="!editable || busy"
          ><Fields
            v-model="config"
            :options="options"
            :resources="resources"
            :disabled="!editable || busy"
            :resource-key="detail.key"
            can-save
            @valid="contentValid = $event"
            @save="persist(true)" /></ElForm
      ></ElTabPane>
      <ElTabPane
        name="resources"
        :label="`辅助资料（${config.resources?.length ?? 0}）`"
      >
        <Resources
          :key="selected"
          :model-value="config.resources ?? []"
          :disabled="!editable || busy || sourceDirty"
          @update:model-value="config = { ...config, resources: $event }"
        />
      </ElTabPane>
      <ElTabPane name="source" label="SKILL.md 源码" lazy>
        <ElAlert
          v-if="sourceError"
          :title="sourceError"
          type="error"
          :closable="false"
          class="mb-3"
        />
        <ElAlert
          v-for="(d, i) in diagnostics"
          :key="i"
          :title="d.message"
          :type="d.severity === 'error' ? 'error' : 'warning'"
          :closable="false"
          class="mb-3"
        />
        <MarkdownEditor
          v-model="source"
          source
          :readonly="!editable || busy"
          @save="applySource"
        />
        <div v-if="editable" class="mt-3 flex gap-2">
          <ElButton
            type="primary"
            :loading="busy"
            :disabled="!!sourceError"
            @click="applySource"
            >应用源码并保存</ElButton
          ><ElButton :disabled="busy" @click="discardSource"
            >放弃源码修改</ElButton
          >
        </div>
      </ElTabPane>
    </ElTabs>
    <ElDialog
      class="management-dialog"
      body-class="management-dialog-body"
      header-class="management-dialog-header"
      footer-class="management-dialog-footer"
      append-to-body
      v-model="historyOpen"
      title="历史与引用"
      width="min(1000px, 95vw)"
      destroy-on-close
    >
      <ElTabs>
        <ElTabPane label="历史版本" name="history">
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
                  :disabled="busy || saving"
                  @click="
                    switchVersion(row.id);
                    historyOpen = false;
                  "
                  >查看</ElButton
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
              :disabled="busy || saving"
              @click="
                edit(true);
                historyOpen = false;
              "
              >基于此版本另建草稿</ElButton
            >
            <ElButton
              v-if="canManage"
              :disabled="busy || saving"
              @click="toggle"
              >{{ detail.enabled ? "停用" : "启用" }}</ElButton
            >
          </div>
        </ElTabPane>
        <ElTabPane name="usage" label="Agent 引用"
          ><ElTable :data="usage"
            ><ElTableColumn prop="name" label="Agent" /><ElTableColumn
              prop="agentVersion"
              label="Agent 版本"
            /><ElTableColumn
              prop="skillVersion"
              label="使用的 Skill 版本"
            /><ElTableColumn label="引用状态"
              ><template #default="{ row }">{{
                row.isCurrent ? "当前生效" : "历史版本"
              }}</template></ElTableColumn
            ></ElTable
          ></ElTabPane
        >
      </ElTabs>
      <ElAlert
        v-if="usageError"
        :title="usageError"
        type="error"
        :closable="false"
      />
    </ElDialog>
    <ElDialog
      class="management-dialog"
      body-class="management-dialog-body"
      header-class="management-dialog-header"
      footer-class="management-dialog-footer"
      append-to-body
      v-model="diffOpen"
      title="发布 Skill 新版本"
      width="min(1200px, 95vw)"
      destroy-on-close
      :close-on-click-modal="false"
      :close-on-press-escape="!busy"
      :show-close="!busy"
    >
      <p class="mb-3">
        {{
          base ? `与已发布 v${base.version} 对比` : "首次发布"
        }}。发布不会自动修改 Agent 的版本绑定；需要到 Agent
        草稿中选择新版并显式发布。
      </p>
      <VersionDiff
        v-if="diffOpen"
        :left="comparable(base?.config)"
        :right="comparable(config)"
        :left-label="base ? `已发布 v${base.version}` : '尚无发布版本'"
        :right-label="`当前草稿 v${active?.version ?? ''}`"
        file-name="SKILL.md"
      />
      <ElAlert
        v-if="saveError || actionError"
        :title="saveError || actionError"
        type="error"
        :closable="false"
        class="mt-3"
      />
      <template #footer
        ><ElButton :disabled="busy" @click="diffOpen = false">取消</ElButton
        ><ElButton type="primary" :loading="busy" @click="publish"
          >确认发布</ElButton
        ></template
      >
    </ElDialog>
  </section>
</template>
