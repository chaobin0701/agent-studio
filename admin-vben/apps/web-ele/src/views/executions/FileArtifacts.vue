<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useAccessStore } from "@vben/stores";
import {
  ElAlert,
  ElButton,
  ElEmpty,
  ElMessageBox,
  ElTable,
  ElTableColumn,
  ElTag,
} from "element-plus";
import { managementApi as api } from "#/api/management";
import { requestClient } from "#/api/request";
import { useWorkspaceStore } from "#/store/workspace";
import HelpTip from "#/components/HelpTip.vue";

type FileArtifact = {
  id: string;
  filename: string;
  byteSize: number;
  producerVersionId: number;
  expiresAt: string;
  purgedAt: string | null;
  available: boolean;
};
const props = defineProps<{ traceId: string }>();
const access = useAccessStore(),
  workspace = useWorkspaceStore();
const files = ref<FileArtifact[]>([]),
  loading = ref(false),
  error = ref(""),
  busy = ref<string>();
const canPurge = computed(() =>
  access.accessCodes.includes("executions.artifacts.manage"),
);
let generation = 0;
const endpoint = (trace: string) =>
  `/executions/${encodeURIComponent(trace)}/artifacts`;
async function load() {
  const request = ++generation,
    trace = props.traceId;
  files.value = [];
  loading.value = true;
  error.value = "";
  try {
    const result = await api.get<FileArtifact[]>(endpoint(trace));
    if (request === generation) files.value = result;
  } catch {
    if (request === generation) error.value = "文件产物加载失败，请重试。";
  } finally {
    if (request === generation) loading.value = false;
  }
}
watch([() => props.traceId, () => workspace.generation], load, {
  immediate: true,
});
async function download(id: string) {
  const file = files.value.find((file) => file.id === id);
  if (!file) return;
  if (!file.available || busy.value) return;
  const request = generation,
    trace = props.traceId;
  busy.value = file.id;
  try {
    const blob = await requestClient.get<Blob>(
      `${endpoint(trace)}/${encodeURIComponent(file.id)}`,
      { responseType: "blob" },
    );
    if (request !== generation) return;
    const url = URL.createObjectURL(blob),
      anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = file.filename;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch {
    if (request === generation)
      error.value = "下载失败，文件可能已过期、已清理或权限发生变化。";
  } finally {
    busy.value = undefined;
  }
}
async function purge(id: string) {
  const file = files.value.find((file) => file.id === id);
  if (!file) return;
  if (!canPurge.value || busy.value || file.purgedAt) return;
  const request = generation,
    trace = props.traceId;
  try {
    await ElMessageBox.confirm(
      `不可恢复地清理 ${file.filename} 的文件内容？执行记录和文件元数据仍保留。`,
      "清理文件产物",
      { type: "warning", confirmButtonText: "确认清理" },
    );
  } catch {
    return;
  }
  if (request !== generation) return;
  busy.value = file.id;
  try {
    await api.delete(`${endpoint(trace)}/${encodeURIComponent(file.id)}`);
    if (request === generation) await load();
  } catch {
    if (request === generation) error.value = "清理失败，请重试。";
  } finally {
    busy.value = undefined;
  }
}
</script>
<template>
  <section aria-label="执行文件产物" class="space-y-3">
    <div class="flex items-center gap-2">
      <h2 class="font-medium">文件产物</h2>
      <HelpTip
        text="仅保存完成任务后明确选择的文件，默认保留 7 天。下载需要当前工作区权限；过期或清理后不能再下载，不会自动重新运行任务。文件作为附件下载，不在后台执行或预览。"
        long
      /><ElButton link :loading="loading" @click="load">刷新</ElButton>
    </div>
    <ElAlert v-if="error" :title="error" type="error" :closable="false" />
    <ElTable
      v-loading="loading"
      v-if="files.length || loading"
      :data="files"
      row-key="id"
    >
      <ElTableColumn prop="filename" label="文件" min-width="200" />
      <ElTableColumn label="大小" width="110"
        ><template #default="{ row }"
          >{{ (row.byteSize / 1024).toFixed(1) }} KiB</template
        ></ElTableColumn
      >
      <ElTableColumn
        prop="producerVersionId"
        label="生成 Agent 版本 ID"
        width="170"
      />
      <ElTableColumn label="状态" width="100"
        ><template #default="{ row }"
          ><ElTag :type="row.available ? 'success' : 'info'">{{
            row.purgedAt ? "已清理" : row.available ? "可下载" : "不可用"
          }}</ElTag></template
        ></ElTableColumn
      >
      <ElTableColumn label="到期时间" min-width="190"
        ><template #default="{ row }">{{
          new Date(row.expiresAt).toLocaleString()
        }}</template></ElTableColumn
      >
      <ElTableColumn label="操作" width="160"
        ><template #default="{ row }"
          ><ElButton
            link
            type="primary"
            :disabled="!row.available || !!busy"
            @click="download(row.id)"
            >下载</ElButton
          ><ElButton
            v-if="canPurge"
            link
            type="danger"
            :disabled="!!row.purgedAt || !!busy"
            @click="purge(row.id)"
            >清理</ElButton
          ></template
        ></ElTableColumn
      >
    </ElTable>
    <ElEmpty v-else-if="!error" description="此执行没有保存文件产物" />
  </section>
</template>
