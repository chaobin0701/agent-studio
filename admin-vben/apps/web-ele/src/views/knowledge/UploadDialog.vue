<script setup lang="ts">
import { ref, watch, onBeforeUnmount } from "vue";
import {
  ElDialog,
  ElUpload,
  ElButton,
  ElTable,
  ElTableColumn,
  ElMessage,
  ElTag,
  ElAlert,
} from "element-plus";
import type { UploadUserFile, UploadFile, UploadFiles } from "element-plus";
import { requestClient } from "#/api/request";
import { requestMessage } from "./display";
import { managementApi as api } from "#/api/management";
const props = defineProps<{ base: string }>();
const open = defineModel<boolean>({ required: true });
const emit = defineEmits<{ uploaded: [] }>();
const files = ref<UploadUserFile[]>([]),
  results = ref<any[]>([]),
  busy = ref(false),
  pollError = ref("");
let epoch = 0,
  polling = false;
let timer: ReturnType<typeof setInterval> | undefined;
function clear() {
  if (timer) clearInterval(timer);
  timer = undefined;
}
function exceeded() {
  ElMessage.warning("每批最多选择 20 个文件");
}
function changed(file: UploadFile, _files: UploadFiles) {
  if (
    !/\.(md|markdown|pdf|docx)$/i.test(file.name) ||
    !file.size ||
    file.size > 2 * 1024 * 1024
  ) {
    files.value = files.value.filter((f) => f.uid !== file.uid);
    ElMessage.warning("支持 Markdown、PDF、DOCX，单文件不超过 2 MB");
  }
}
function indexed(row: any) {
  return (
    row.inCurrentIndex &&
    row.indexedRevision === row.indexRevision &&
    row.status === "ready"
  );
}
function state(row: any) {
  if (row.status === "unavailable") return row.message;
  if (row.indexError) return row.indexError;
  return row.ok === false
    ? row.message
    : (
        {
          queued: "等待处理",
          processing: "处理中",
          ready: indexed(row) ? "已加入索引" : "等待索引更新",
          failed: row.errorMessage || "处理失败",
        } as any
      )[row.status] || "上传完成";
}
async function poll() {
  if (polling || !open.value) return;
  const target = props.base,
    generation = epoch;
  const ids = results.value
    .filter((row) => row.ok !== false && row.id)
    .map((row) => row.id);
  if (!ids.length) {
    clear();
    return;
  }
  polling = true;
  pollError.value = "";
  try {
    const [docs, detail] = await Promise.all([
      api.get(`${target}/documents?limit=20&ids=${ids.join(",")}`),
      api.get(target),
    ]);
    if (generation !== epoch || target !== props.base || !open.value) return;
    results.value = results.value.map((row) => {
      if (row.ok === false) return row;
      const doc = docs.find((doc: any) => doc.id === row.id);
      if (!doc || detail.archivedAt)
        return {
          ...row,
          status: "unavailable",
          message: detail.archivedAt
            ? "知识库已归档，不再更新索引"
            : "文档已移除，请在回收站查看",
        };
      return {
        ...row,
        ...doc,
        indexError: !indexed(doc) ? detail.indexError : undefined,
      };
    });
    if (
      detail.indexError ||
      results.value.every(
        (row) =>
          row.ok === false ||
          ["failed", "unavailable"].includes(row.status) ||
          indexed(row),
      )
    ) {
      clear();
      emit("uploaded");
    }
  } catch {
    if (generation === epoch && target === props.base && open.value) {
      pollError.value =
        "进度刷新失败，不代表文档处理失败。可以重新获取进度，或关闭后在文档列表查看。";
      clear();
    }
  } finally {
    if (generation === epoch) polling = false;
  }
}
async function retryProgress() {
  clear();
  timer = setInterval(poll, 3000);
  await poll();
}
async function submit() {
  if (busy.value || polling) return;
  const target = props.base,
    generation = epoch;
  if (!files.value.length) return ElMessage.warning("请选择文件");
  const form = new FormData();
  for (const file of files.value) if (file.raw) form.append("files", file.raw);
  busy.value = true;
  try {
    const data = await requestClient.post<any>(
      `${target}/documents/batch`,
      form,
      { headers: { "Content-Type": "multipart/form-data" }, timeout: 120000 },
    );
    if (generation !== epoch || target !== props.base || !open.value) return;
    results.value = data.files;
    files.value = [];
    emit("uploaded");
    clear();
    timer = setInterval(poll, 3000);
    await poll();
  } catch (error) {
    if (generation !== epoch || target !== props.base || !open.value) return;
    results.value = files.value.map((file) => ({
      name: file.name,
      ok: false,
      message: requestMessage(error, "上传失败，请重试"),
    }));
  } finally {
    if (generation === epoch) busy.value = false;
  }
}
watch(open, (value) => {
  epoch++;
  clear();
  polling = false;
  busy.value = false;
  pollError.value = "";
  if (value) {
    files.value = [];
    results.value = [];
  } else clear();
});
watch(
  () => props.base,
  () => {
    epoch++;
    clear();
    polling = false;
    busy.value = false;
    files.value = [];
    results.value = [];
    pollError.value = "";
    open.value = false;
  },
);
onBeforeUnmount(() => {
  epoch++;
  clear();
});
</script>
<template>
  <ElDialog
    class="management-dialog"
    body-class="management-dialog-body"
    header-class="management-dialog-header"
    footer-class="management-dialog-footer"
    append-to-body
    v-model="open"
    title="上传文档"
    width="min(760px,94vw)"
    :close-on-click-modal="false"
    :show-close="!busy"
    :close-on-press-escape="!busy"
  >
    <ElUpload
      v-model:file-list="files"
      drag
      multiple
      :auto-upload="false"
      :limit="20"
      :on-exceed="exceeded"
      :disabled="busy || !!results.length"
      accept=".md,.markdown,.pdf,.docx"
      :on-change="changed"
    >
      <div>拖放文件到这里，或点击选择文件</div>
      <template #tip
        >支持 Markdown、PDF、DOCX，单文件不超过 2 MB；每批最多 20
        个文件。点击确认后上传。</template
      >
    </ElUpload>
    <ElAlert
      v-if="pollError"
      :title="pollError"
      type="warning"
      :closable="false"
      class="mt-4"
      ><ElButton link type="primary" @click="retryProgress"
        >重新获取进度</ElButton
      ></ElAlert
    >
    <ElTable v-if="results.length" class="mt-4" :data="results"
      ><ElTableColumn prop="name" label="文件" /><ElTableColumn label="状态"
        ><template #default="{ row }"
          ><ElTag
            :type="
              row.ok === false ||
              row.indexError ||
              ['failed', 'unavailable'].includes(row.status)
                ? 'danger'
                : indexed(row)
                  ? 'success'
                  : 'info'
            "
            >{{ state(row) }}</ElTag
          ></template
        ></ElTableColumn
      ></ElTable
    >
    <template #footer
      ><ElButton :disabled="busy" @click="open = false">关闭</ElButton
      ><ElButton
        type="primary"
        :loading="busy"
        :disabled="!files.length"
        @click="submit"
        >确认上传</ElButton
      ></template
    >
  </ElDialog>
</template>
