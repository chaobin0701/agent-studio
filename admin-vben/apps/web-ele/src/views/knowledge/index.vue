<script setup lang="ts">
import { ref, computed, watch, onMounted, onBeforeUnmount } from "vue";
import { useRoute, useRouter } from "vue-router";
import { Page } from "@vben/common-ui";
import { useAccessStore } from "@vben/stores";
import {
  ElButton,
  ElTable,
  ElTableColumn,
  ElTabs,
  ElTabPane,
  ElDialog,
  ElForm,
  ElFormItem,
  ElInput,
  ElDivider,
  ElAlert,
  ElTag,
  ElMessage,
  ElMessageBox,
  ElDescriptions,
  ElDescriptionsItem,
  ElSegmented,
  ElDropdown,
  ElDropdownMenu,
  ElDropdownItem,
} from "element-plus";
import { managementApi as api } from "#/api/management";
import { requestClient } from "#/api/request";
import { useWorkspaceStore } from "#/store/workspace";
import { useUnsavedChanges } from "#/composables/use-unsaved-changes";
import ManagementHeader from "#/components/ManagementHeader.vue";
import PagePanel from "#/components/PagePanel.vue";
import HelpTip from "#/components/HelpTip.vue";
import ProcessingFields from "./ProcessingFields.vue";
import IndexFields from "./IndexFields.vue";
import UploadDialog from "./UploadDialog.vue";
import ChunkCards from "./ChunkCards.vue";
import RecallResults from "./RecallResults.vue";
import { configSummary, configFields, dateTime } from "./display";
const route = useRoute(),
  router = useRouter(),
  access = useAccessStore(),
  workspace = useWorkspaceStore();
const has = (code: string) => access.accessCodes.includes(code),
  manage = computed(() => has("knowledge_bases.manage")),
  read = computed(() => has("documents.read"));
const base = computed(() => `/knowledge-bases/${route.params.id}`);
const items = ref<any[]>([]),
  detail = ref<any>(),
  documents = ref<any[]>([]),
  versions = ref<any[]>([]),
  profiles = ref<any[]>([]);
const loading = ref(false),
  busy = ref(false),
  failed = ref(false),
  tab = ref("documents"),
  page = ref(1),
  hasNext = ref(false),
  baseState = ref("active"),
  documentState = ref("active"),
  search = ref(""),
  actionError = ref(""),
  selected = ref<any[]>([]);
const saved = ref(""),
  dialog = ref(""),
  form = ref<any>({}),
  formProcessing = ref<any>({}),
  formIndex = ref<any>({});
const defaultProfile = ref<number>(),
  uploadOpen = ref(false),
  segmentsOpen = ref(false),
  segments = ref<any>(),
  segmentsTab = ref("current"),
  selectedVersion = ref<any>(),
  query = ref(""),
  recall = ref<any>();
let loadGeneration = 0;
const visibleBases = computed(() =>
  items.value.filter(
    (k) =>
      (baseState.value === "archived" ? !!k.archivedAt : !k.archivedAt) &&
      `${k.name} ${k.description}`
        .toLocaleLowerCase()
        .includes(search.value.trim().toLocaleLowerCase()),
  ),
);
const trash = computed(() => tab.value === "trash");
const formSnapshot = () =>
  JSON.stringify([form.value, formProcessing.value, formIndex.value]);
const dirty = computed(() => !!dialog.value && formSnapshot() !== saved.value);
const leave = useUnsavedChanges(dirty);
const modelChanged = computed(
  () =>
    !!detail.value?.activeIndexConfig &&
    JSON.stringify([
      detail.value.indexConfig.indexMode,
      detail.value.indexConfig.embeddingProfileId,
    ]) !==
      JSON.stringify([
        detail.value.activeIndexConfig.indexMode,
        detail.value.activeIndexConfig.embeddingProfileId,
      ]),
);
const defaults = () => ({
  chunkMode: "general",
  chunkChars: 800,
  overlapChars: 60,
  parentChars: 2400,
  childChars: 500,
  childOverlapChars: 50,
});
async function run(fn: () => Promise<unknown>) {
  if (busy.value) return;
  const scope = workspace.generation,
    target = base.value;
  busy.value = true;
  actionError.value = "";
  try {
    await fn();
  } catch (e: any) {
    if (scope === workspace.generation && target === base.value) {
      const text =
        e.response?.data?.error?.message ?? e.response?.data?.message;
      actionError.value =
        typeof text === "string"
          ? text
          : "操作失败，请检查当前状态和权限后重试。";
    }
  } finally {
    if (scope === workspace.generation && target === base.value)
      busy.value = false;
  }
}
async function load() {
  const request = ++loadGeneration,
    target = base.value,
    scope = workspace.generation;
  const current = () =>
    request === loadGeneration &&
    target === base.value &&
    scope === workspace.generation;
  loading.value = true;
  failed.value = false;
  try {
    if (!route.params.id) {
      const result = await api.get("/knowledge-bases");
      if (current()) items.value = result;
      return;
    }
    const result = await api.get(target);
    if (!current()) return;
    detail.value = result;
    if (read.value) {
      const [docs, history] = await Promise.all([
        api.get(
          `${target}/documents?limit=21&offset=${(page.value - 1) * 20}&trash=${trash.value}&state=${documentState.value}`,
        ),
        api.get(`${target}/versions`),
      ]);
      if (!current()) return;
      documents.value = docs.slice(0, 20);
      hasNext.value = docs.length > 20;
      versions.value = history;
      const ids = new Set(documents.value.map((d) => d.id));
      selected.value = selected.value.filter((d) => ids.has(d.id));
    }
  } catch {
    if (current()) failed.value = true;
  } finally {
    if (current()) loading.value = false;
  }
}
async function refresh() {
  if (await leave()) {
    dialog.value = "";
    await load();
  }
}
async function loadChoices() {
  if (!manage.value) return;
  const scope = workspace.generation,
    id = workspace.id;
  const [choices, settings] = await Promise.all([
    api.get("/knowledge-bases/embedding-profiles"),
    api.get(`/workspaces/${id}/settings`),
  ]);
  if (scope !== workspace.generation || id !== workspace.id) return;
  profiles.value = choices;
  defaultProfile.value = settings.embeddingPlans.find(
    (p: any) => p.id === settings.defaultEmbeddingPlanVersionId,
  )?.profileId;
}
async function openBase(edit = false) {
  const scope = workspace.generation,
    target = base.value;
  await run(async () => {
    await loadChoices();
    if (scope !== workspace.generation || target !== base.value) return;
    form.value = edit
      ? {
          name: detail.value.name,
          description: detail.value.description,
        }
      : { name: "", description: "" };
    formProcessing.value = edit
      ? { ...detail.value.processingConfig }
      : defaults();
    formIndex.value = edit
      ? { ...detail.value.indexConfig }
      : { indexMode: "economy", embeddingProfileId: null };
    saved.value = formSnapshot();
    dialog.value = edit ? "edit" : "create";
  });
}
async function saveBase() {
  const scope = workspace.generation,
    target = base.value;
  if (!form.value.name.trim()) return ElMessage.warning("请输入名称");
  await run(async () => {
    if (dialog.value === "create") {
      const result = await api.post("/knowledge-bases", {
        ...form.value,
        processingConfig: formProcessing.value,
        indexConfig: formIndex.value,
      });
      if (scope !== workspace.generation || target !== base.value) return;
      dialog.value = "";
      await router.push(`/knowledge-bases/${result.id}`);
      uploadOpen.value = true;
    } else {
      await api.patch(`${target}/settings`, {
        ...form.value,
        processingConfig: formProcessing.value,
        indexConfig: formIndex.value,
      });
      if (scope !== workspace.generation || target !== base.value) return;
      saved.value = formSnapshot();
      await load();
      ElMessage.success(
        "设置已保存。处理规则用于后续上传，索引模式或模型变更需确认全库重建后生效。",
      );
    }
  });
}
async function closeSettings(done?: () => void) {
  if (busy.value || !(await leave())) return;
  dialog.value = "";
  done?.();
}
async function archiveBase() {
  const target = base.value,
    scope = workspace.generation;
  if (dirty.value) return ElMessage.warning("请先保存或放弃设置修改");
  try {
    await ElMessageBox.confirm(
      "归档后此知识库立即停止召回，文档、索引版本和历史引用会保留。确认归档？",
      "归档知识库",
      { type: "warning" },
    );
  } catch {
    return;
  }
  await run(async () => {
    if (target !== base.value || scope !== workspace.generation) return;
    await api.post(`${target}/archive`, {});
    if (target !== base.value || scope !== workspace.generation) return;
    dialog.value = "";
    await load();
    ElMessage.success("知识库已归档");
  });
}
async function changeBaseState(row: any) {
  if (!manage.value || busy.value || loading.value) return;
  if (dirty.value) return ElMessage.warning("请先保存或放弃设置修改");
  const target = `/knowledge-bases/${row.id}`,
    current = base.value,
    scope = workspace.generation,
    archived = !!row.archivedAt,
    enabled = !row.enabledForChat;
  try {
    await ElMessageBox.confirm(
      archived
        ? "恢复后保留文档和原索引，知识库保持停用，可随后点击启用。确认恢复？"
        : enabled
          ? "启用后允许 Agent 检索此知识库中的可用文档。确认启用？"
          : "停用后立即停止召回，文档和索引会保留。确认停用？",
      archived ? "恢复知识库" : enabled ? "启用知识库" : "停用知识库",
    );
  } catch {
    return;
  }
  if (current !== base.value || scope !== workspace.generation) return;
  await run(async () => {
    if (archived) await api.post(`${target}/unarchive`, {});
    else await api.patch(target, { enabledForChat: enabled });
    if (current !== base.value || scope !== workspace.generation) return;
    await load();
    ElMessage.success(archived ? "知识库已恢复，可按需启用" : enabled ? "知识库已启用" : "知识库已停用");
  });
}
async function action(
  path: string,
  method: "post" | "patch" = "post",
  body: unknown = {},
  message = "确认执行此操作？",
) {
  const target = base.value,
    scope = workspace.generation;
  if (dirty.value) return ElMessage.warning("请先保存或放弃设置修改");
  try {
    await ElMessageBox.confirm(message, "确认");
  } catch {
    return;
  }
  await run(async () => {
    if (target !== base.value || scope !== workspace.generation) return;
    await api[method](`${target}/${path}`, body);
    if (target !== base.value || scope !== workspace.generation) return;
    selected.value = [];
    await load();
  });
}
function documentAction(command: string, doc: any) {
  if (command === "download") return download(doc);
  const path = `documents/${doc.id}`;
  if (command === "archive")
    return action(
      `${path}/${doc.archivedAt ? "unarchive" : "archive"}`,
      "patch",
    );
  if (command === "status")
    return action(`${path}/retrieval-status`, "patch", {
      enabled: !doc.enabledForRetrieval,
    });
  if (command === "delete")
    return action(
      `${path}/delete`,
      "patch",
      {},
      "移入回收站？原文件与历史引用会保留，可恢复。",
    );
}
async function rebuild() {
  if (modelChanged.value)
    return action(
      "versions",
      "post",
      { activateOnReady: true },
      "索引模式或模型已改变，本次将重建全库，成功后切换，继续？",
    );
  return action(
    "documents/rebuild",
    "post",
    { documentIds: selected.value.map((d) => d.id) },
    `重新处理选中的 ${selected.value.length} 份文档并自动更新索引，未选中文档保持不变，继续？`,
  );
}
function retrievalState(doc: any) {
  if (doc.deletedAt) return "回收站";
  if (doc.archivedAt) return "已归档";
  if (!doc.enabledForRetrieval) return "已停用";
  if (doc.inCurrentIndex)
    return doc.indexRevision !== doc.indexedRevision
      ? "待更新"
      : "已在当前索引";
  return doc.indexPending ? "待加入索引" : "未包含在当前版本";
}
function processingState(status: string) {
  return (
    (
      {
        pending: "待处理",
        queued: "等待处理",
        processing: "处理中",
        ready: "处理完成",
        failed: "处理失败",
        extracted: "已提取",
      } as any
    )[status] || status
  );
}
async function inspect(doc: any) {
  const target = base.value,
    scope = workspace.generation;
  segments.value = undefined;
  segmentsOpen.value = true;
  await run(async () => {
    const result = await api.get(`${target}/documents/${doc.id}/segments`);
    if (
      target !== base.value ||
      scope !== workspace.generation ||
      !segmentsOpen.value
    )
      return;
    segments.value = result;
    segmentsTab.value = result.pendingChunks.length ? "pending" : "current";
  });
}
async function download(doc: any) {
  const target = base.value,
    scope = workspace.generation;
  await run(async () => {
    const blob = await requestClient.get<Blob>(
      `${target}/documents/${doc.id}/file`,
      { responseType: "blob" },
    );
    if (target !== base.value || scope !== workspace.generation) return;
    const url = URL.createObjectURL(blob),
      link = document.createElement("a");
    link.href = url;
    link.download = doc.originalFilename;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
}
async function testRecall() {
  if (!query.value.trim()) return;
  const target = base.value,
    scope = workspace.generation,
    text = query.value.trim();
  recall.value = undefined;
  await run(async () => {
    const result = await api.get(
      `${target}/search?q=${encodeURIComponent(text)}&limit=5`,
    );
    if (
      target === base.value &&
      scope === workspace.generation &&
      query.value.trim() === text
    )
      recall.value = result;
  });
}
async function paginate(value: number) {
  page.value = value;
  selected.value = [];
  await load();
}
watch(
  () => [route.params.id, workspace.generation],
  () => {
    loadGeneration++;
    detail.value = undefined;
    items.value = [];
    documents.value = [];
    versions.value = [];
    profiles.value = [];
    defaultProfile.value = undefined;
    busy.value = false;
    segments.value = undefined;
    actionError.value = "";
    uploadOpen.value = false;
    selectedVersion.value = undefined;
    documentState.value = "active";
    page.value = 1;
    dialog.value = "";
    selected.value = [];
    segmentsOpen.value = false;
    tab.value = "documents";
    recall.value = undefined;
    void load();
    void loadChoices().catch(() => {});
  },
  { immediate: true },
);
watch([trash, documentState], () => {
  page.value = 1;
  selected.value = [];
  documents.value = [];
  void load();
});
let timer: ReturnType<typeof setInterval>;
onMounted(() => {
  timer = setInterval(() => {
    if (
      route.params.id &&
      !loading.value &&
      !busy.value &&
      !detail.value?.archivedAt &&
      (documents.value.some(
        (d) =>
          ["queued", "processing"].includes(d.status) ||
          (d.indexPending && d.status === "ready"),
      ) ||
        versions.value.some((v) => v.status === "building") ||
        detail.value?.indexUpdating)
    )
      void load();
  }, 4000);
});
onBeforeUnmount(() => {
  loadGeneration++;
  clearInterval(timer);
});
</script>
<template>
  <Page>
    <ManagementHeader :title="detail?.name || '知识库'">
      <ElButton
        v-if="route.params.id"
        :disabled="busy"
        @click="router.push('/knowledge-bases')"
        >返回列表</ElButton
      >
      <ElButton :loading="loading" :disabled="busy" @click="refresh"
        >刷新</ElButton
      >
      <ElButton
        v-if="manage && !route.params.id"
        type="primary"
        :disabled="busy || loading"
        @click="openBase()"
        >新建知识库</ElButton
      >
      <ElButton
        v-if="manage && detail"
        :type="detail.archivedAt || !detail.enabledForChat ? 'primary' : 'default'"
        :disabled="busy || loading"
        @click="changeBaseState(detail)"
        >{{ detail.archivedAt ? '恢复知识库' : detail.enabledForChat ? '停用知识库' : '启用知识库' }}</ElButton
      >
      <ElButton
        v-if="manage && detail && !detail.archivedAt"
        :disabled="busy"
        @click="openBase(true)"
        >知识库设置</ElButton
      >
    </ManagementHeader>
    <ElAlert
      v-if="actionError"
      :title="actionError"
      type="error"
      :closable="false"
      class="mb-4"
    />
    <ElAlert
      v-if="failed"
      title="加载失败，请刷新重试"
      type="error"
      :closable="false"
    />
    <PagePanel v-if="!route.params.id">
      <div class="mb-4 flex flex-wrap items-center gap-3">
        <ElInput
          v-model="search"
          clearable
          placeholder="搜索名称或用途"
          aria-label="搜索知识库"
          class="w-full sm:w-72"
        />
        <ElSegmented
          v-model="baseState"
          :options="[
            { label: '可用知识库', value: 'active' },
            { label: '已归档', value: 'archived' },
          ]"
          aria-label="知识库状态"
        />
      </div>
      <ElTable
        v-loading="loading"
        :data="visibleBases"
        row-key="id"
        :empty-text="
          baseState === 'archived'
            ? '暂无归档知识库'
            : '暂无知识库，可以先创建再上传资料'
        "
      >
        <ElTableColumn label="知识库" min-width="180"
          ><template #default="{ row }"
            ><ElButton
              link
              type="primary"
              @click="router.push(`/knowledge-bases/${row.id}`)"
              >{{ row.name }}</ElButton
            ></template
          ></ElTableColumn
        >
        <ElTableColumn
          prop="description"
          label="用途"
          min-width="200"
          show-overflow-tooltip
        />
        <ElTableColumn prop="documentCount" label="文档数" width="100" />
        <ElTableColumn label="索引模式" width="160"
          ><template #default="{ row }">{{
            row.indexConfig.indexMode === "economy" ? "全文" : "全文＋向量"
          }}</template></ElTableColumn
        >
        <ElTableColumn label="状态" width="110"
          ><template #default="{ row }"
            ><ElTag
              :type="
                row.archivedAt
                  ? 'info'
                  : row.indexError
                    ? 'danger'
                    : row.enabledForChat
                      ? 'success'
                      : 'warning'
              "
              >{{
                row.archivedAt
                  ? "已归档"
                  : row.indexError
                    ? "索引失败"
                    : row.enabledForChat
                      ? "已启用"
                      : "已停用"
              }}</ElTag
            ></template
          ></ElTableColumn
        >
        <ElTableColumn label="更新时间" min-width="170"
          ><template #default="{ row }">{{
            dateTime(row.updatedAt)
          }}</template></ElTableColumn
        >
        <ElTableColumn v-if="manage" label="操作" width="150"
          ><template #default="{ row }"
            ><ElButton link type="primary" :disabled="busy || loading" @click="changeBaseState(row)">
              {{ row.archivedAt ? '恢复知识库' : row.enabledForChat ? '停用' : '启用' }}
            </ElButton></template
          ></ElTableColumn
        >
      </ElTable>
    </PagePanel>
    <PagePanel v-else-if="detail" v-loading="loading || busy">
      <div class="mb-4 flex flex-wrap items-center gap-3 text-sm">
        <ElTag
          :type="
            detail.archivedAt
              ? 'info'
              : detail.enabledForChat
                ? 'success'
                : 'warning'
          "
          >{{
            detail.archivedAt
              ? "已归档 · 仅供查看"
              : detail.enabledForChat
                ? "已启用"
                : "已停用"
          }}</ElTag
        >
        <span class="text-muted-foreground">{{
          detail.activeIndexConfig
            ? configSummary(detail.activeIndexConfig)
            : "尚无生效索引"
        }}</span>
        <ElTag v-if="detail.indexUpdating" type="warning">索引更新中</ElTag>
        <ElTag v-else-if="modelChanged" type="warning">索引设置待重建</ElTag>
      </div>
      <ElAlert
        v-if="detail.indexError"
        :title="detail.indexError"
        type="error"
        :closable="false"
        class="mb-3"
      />
      <ElButton
        v-if="detail.indexError && manage"
        class="mb-3"
        @click="action('index-update')"
        >重试索引更新</ElButton
      >
      <ElTabs v-model="tab">
        <ElTabPane
          v-for="documentTab in read
            ? [
                { name: 'documents', label: '文档' },
                { name: 'trash', label: '回收站' },
              ]
            : []"
          :key="documentTab.name"
          :label="documentTab.label"
          :name="documentTab.name"
          lazy
          ><template v-if="tab === documentTab.name">
            <div class="mb-4 flex flex-wrap items-center gap-3">
              <ElButton
                v-if="has('documents.upload') && !detail.archivedAt && !trash"
                :type="selected.length ? undefined : 'primary'"
                @click="uploadOpen = true"
                >上传文档</ElButton
              ><HelpTip
                text="归档、停用和移入回收站都会立即停止召回，无需重建。恢复后，当前版本未包含的文档会自动更新索引。"
                long
              /><ElButton
                v-if="selected.length && has('documents.reprocess') && !trash"
                class="ml-auto"
                type="primary"
                @click="rebuild"
                >重新构建索引（已选 {{ selected.length }} 项）</ElButton
              >
            </div>
            <ElSegmented
              v-if="!trash"
              v-model="documentState"
              class="mb-4"
              :options="[
                { label: '文档', value: 'active' },
                { label: '已归档', value: 'archived' },
              ]"
              aria-label="文档状态"
            />
            <ElTable
              v-loading="loading"
              :data="documents"
              :empty-text="trash ? '回收站为空' : '暂无文档，请上传资料'"
              @selection-change="(rows) => (selected = rows)"
              row-key="id"
              ><ElTableColumn
                v-if="!trash && has('documents.reprocess')"
                type="selection"
                width="45"
                :selectable="
                  (doc) =>
                    !doc.archivedAt &&
                    !['processing', 'queued'].includes(doc.status)
                "
              /><ElTableColumn label="文档" min-width="180"
                ><template #default="{ row }"
                  ><ElButton link type="primary" @click="inspect(row)">{{
                    row.title
                  }}</ElButton></template
                ></ElTableColumn
              ><ElTableColumn label="处理状态" width="110"
                ><template #default="{ row }"
                  ><ElTag
                    :type="
                      row.status === 'failed'
                        ? 'danger'
                        : row.status === 'ready'
                          ? 'success'
                          : 'info'
                    "
                    >{{ processingState(row.status) }}</ElTag
                  ></template
                ></ElTableColumn
              ><ElTableColumn label="检索状态" min-width="150"
                ><template #default="{ row }">{{
                  retrievalState(row)
                }}</template></ElTableColumn
              ><ElTableColumn
                prop="errorMessage"
                label="错误"
                show-overflow-tooltip
              /><ElTableColumn label="操作" width="150"
                ><template #default="{ row }">
                  <ElButton
                    v-if="
                      trash && has('documents.archive') && !detail.archivedAt
                    "
                    link
                    type="primary"
                    :disabled="busy"
                    @click="
                      action(
                        `documents/${row.id}/restore`,
                        'patch',
                        {},
                        '从回收站恢复此文档？',
                      )
                    "
                    >恢复</ElButton
                  >
                  <ElDropdown
                    trigger="click"
                    @command="(command) => documentAction(command, row)"
                  >
                    <ElButton
                      link
                      :disabled="busy"
                      :aria-label="`${row.title}的更多操作`"
                      >更多</ElButton
                    >
                    <template #dropdown
                      ><ElDropdownMenu>
                        <ElDropdownItem command="download"
                          >下载原文件</ElDropdownItem
                        >
                        <template
                          v-if="
                            has('documents.archive') &&
                            !detail.archivedAt &&
                            !trash
                          "
                        >
                          <ElDropdownItem command="archive">{{
                            row.archivedAt ? "恢复归档" : "归档"
                          }}</ElDropdownItem>
                          <ElDropdownItem
                            v-if="!row.archivedAt"
                            command="status"
                            >{{
                              row.enabledForRetrieval ? "停用检索" : "启用检索"
                            }}</ElDropdownItem
                          >
                          <ElDropdownItem command="delete" divided
                            >移入回收站</ElDropdownItem
                          >
                        </template>
                      </ElDropdownMenu></template
                    >
                  </ElDropdown>
                </template></ElTableColumn
              ></ElTable
            >
            <div class="mt-4 flex items-center gap-3">
              <ElButton :disabled="page === 1" @click="paginate(page - 1)"
                >上一页</ElButton
              ><span>第 {{ page }} 页</span
              ><ElButton :disabled="!hasNext" @click="paginate(page + 1)"
                >下一页</ElButton
              >
            </div>
          </template></ElTabPane
        >
        <ElTabPane v-if="read" label="索引历史" name="versions"
          ><p class="mb-3">
            当前启用：{{ detail.activeIndexVersionId ?? "无" }}
            <HelpTip
              text="版本保存内容、实际分块、处理规则和向量配置。回滚不回滚 Agent 检索参数，也不能召回已停用、归档或删除的文档。"
              long
            />
          </p>
          <ElTable :data="versions"
            ><ElTableColumn prop="id" label="版本" width="85" /><ElTableColumn
              label="状态"
              ><template #default="{ row }">{{
                row.status === "ready"
                  ? "构建完成"
                  : row.status === "building"
                    ? "构建中"
                    : "构建失败"
              }}</template></ElTableColumn
            ><ElTableColumn prop="chunkCount" label="分块数" /><ElTableColumn
              label="配置"
              ><template #default="{ row }"
                ><ElButton link @click="selectedVersion = row">{{
                  configSummary(row.config)
                }}</ElButton></template
              ></ElTableColumn
            ><ElTableColumn label="创建时间"
              ><template #default="{ row }">{{
                dateTime(row.createdAt)
              }}</template></ElTableColumn
            ><ElTableColumn prop="errorMessage" label="错误" /><ElTableColumn
              label="操作"
              ><template #default="{ row }"
                ><ElTag v-if="row.id === detail.activeIndexVersionId"
                  >当前启用</ElTag
                ><ElButton
                  v-else-if="
                    manage && row.status === 'ready' && !detail.archivedAt
                  "
                  link
                  @click="
                    action(
                      `versions/${row.id}/activate`,
                      'post',
                      {},
                      '切换到此索引版本？未完成的自动更新将取消切换，Agent 检索参数保持不变。',
                    )
                  "
                  >切换／回滚</ElButton
                ></template
              ></ElTableColumn
            ></ElTable
          ></ElTabPane
        >
        <ElTabPane v-if="read" label="召回测试" name="recall"
          ><p class="mb-3">
            按当前索引能力自动适配，测试结果不保存检索策略。<HelpTip
              text="Agent 的正式检索方式、返回数量、阈值和上下文上限在 Agent 管理中设置。"
              long
            />
          </p>
          <div class="mb-4 flex max-w-3xl gap-3">
            <ElInput
              v-model="query"
              placeholder="输入检索问题"
              @keyup.enter="testRecall"
            /><ElButton type="primary" @click="testRecall">检索测试</ElButton>
          </div>
          <RecallResults v-if="recall" :result="recall"
        /></ElTabPane>
      </ElTabs>
    </PagePanel>
    <ElDialog
      class="management-dialog"
      body-class="management-dialog-body"
      header-class="management-dialog-header"
      footer-class="management-dialog-footer"
      append-to-body
      :model-value="!!dialog"
      :title="dialog === 'create' ? '新建知识库' : '知识库设置'"
      width="min(760px, 94vw)"
      :close-on-click-modal="false"
      :before-close="closeSettings"
    >
      <ElAlert
        v-if="actionError"
        :title="actionError"
        type="error"
        :closable="false"
        class="mb-4"
      />
      <div>
        <ElForm label-position="top" :disabled="busy"
          ><ElDivider>基本信息</ElDivider
          ><ElFormItem label="名称" required
            ><ElInput v-model="form.name" maxlength="120" /></ElFormItem
          ><ElFormItem label="描述"
            ><ElInput v-model="form.description" type="textarea" /></ElFormItem
          ><ElDivider
            >文档处理
            <HelpTip
              text="修改默认规则只影响后续上传；已有文档需要选择重新构建才会应用新规则。"
              long /></ElDivider
          ><ProcessingFields v-model="formProcessing" /><ElDivider
            >索引设置</ElDivider
          >
          <p v-if="dialog === 'edit'" class="mb-3 text-sm">
            当前索引：{{
              detail?.activeIndexConfig
                ? configSummary(detail.activeIndexConfig)
                : "尚未构建"
            }}
            <ElTag v-if="modelChanged" type="warning" class="ml-2"
              >待全库重建</ElTag
            >
            <HelpTip
              text="保存模式或模型变更不会立即切换索引。先保存设置，再确认全库重建；构建成功后切换，失败时保留旧版本。"
              long
            />
          </p>
          <IndexFields
            v-model="formIndex"
            :profiles="profiles"
            :default-profile="defaultProfile"
          />
          <template v-if="dialog === 'edit'">
            <ElButton
              :disabled="
                dirty || busy || versions.some((v) => v.status === 'building')
              "
              @click="
                action(
                  'versions',
                  'post',
                  { activateOnReady: true },
                  '确认全库重建？成功后自动切换，失败时保留旧版本。',
                )
              "
              >确认全库重建</ElButton
            >
            <HelpTip
              text="请先保存设置。全库重建使用已保存的索引设置和每份文档的实际处理规则；修改分块规则后，要处理已有资料请在文档列表选中并重新构建。"
              long
            />
            <ElDivider>危险操作</ElDivider>
            <ElButton
              type="danger"
              plain
              :disabled="dirty || busy"
              @click="archiveBase"
              >归档知识库</ElButton
            >
            <HelpTip
              text="归档立即停止召回，但保留文档、索引版本和历史引用。请先保存或放弃未保存修改。"
              long
            />
          </template>
        </ElForm>
      </div>
      <template #footer
        ><ElButton :disabled="busy" @click="closeSettings()">{{
          dialog === "create" ? "取消" : "关闭"
        }}</ElButton
        ><ElButton type="primary" :loading="busy" @click="saveBase">{{
          dialog === "create" ? "创建并上传文档" : "保存设置"
        }}</ElButton></template
      >
    </ElDialog>
    <UploadDialog
      v-if="route.params.id"
      v-model="uploadOpen"
      :base="base"
      @uploaded="load()"
    />
    <ElDialog
      class="management-dialog"
      body-class="management-dialog-body"
      header-class="management-dialog-header"
      footer-class="management-dialog-footer"
      append-to-body
      v-model="segmentsOpen"
      :title="`${segments?.document?.title || '文档'} · 分块`"
      width="min(940px,94vw)"
      ><div>
        <template v-if="segments"
          ><p class="mb-3">
            首次加入版本：{{
              segments.history.firstIndexedVersionId ?? "尚未加入"
            }}
            · 当前：{{ retrievalState(segments.document) }}
          </p>
          <ElTabs v-model="segmentsTab"
            ><ElTabPane label="当前检索内容" name="current"
              ><ChunkCards
                :chunks="segments.chunks"
                :filename="segments.originalFilename"
                empty-text="当前版本不包含此文档" /></ElTabPane
            ><ElTabPane
              v-if="segments.pendingChunks.length"
              label="待生效内容"
              name="pending"
              ><ChunkCards
                :chunks="segments.pendingChunks"
                :filename="segments.document.originalFilename" /></ElTabPane
            ><ElTabPane label="历史版本" name="history"
              ><ElTable :data="segments.history.versions"
                ><ElTableColumn
                  prop="id"
                  label="包含文档的版本"
                /><ElTableColumn label="创建时间"
                  ><template #default="{ row }">{{
                    dateTime(row.createdAt)
                  }}</template></ElTableColumn
                ><ElTableColumn label="当前"
                  ><template #default="{ row }">{{
                    row.active ? "当前启用" : ""
                  }}</template></ElTableColumn
                ></ElTable
              ></ElTabPane
            ></ElTabs
          ></template
        >
      </div></ElDialog
    >
    <ElDialog
      class="management-dialog"
      body-class="management-dialog-body"
      header-class="management-dialog-header"
      footer-class="management-dialog-footer"
      append-to-body
      :model-value="!!selectedVersion"
      :title="`索引 #${selectedVersion?.id} · 构建配置`"
      width="min(700px,94vw)"
      @close="selectedVersion = undefined"
      ><ElDescriptions v-if="selectedVersion" border :column="1"
        ><ElDescriptionsItem
          v-for="field in configFields(selectedVersion.config)"
          :key="field.label"
          :label="field.label"
          >{{ field.value }}</ElDescriptionsItem
        ></ElDescriptions
      ></ElDialog
    >
  </Page>
</template>
