<script setup lang="ts">
import { ElTable, ElTableColumn, ElTag } from "element-plus";
import type { Attempt } from "#/api/executions";
defineProps<{ attempts: Attempt[] }>();
</script>
<template>
  <ElTable :data="attempts" size="small" empty-text="无独立尝试记录">
    <ElTableColumn prop="attempt" label="尝试" width="80" />
    <ElTableColumn prop="model" label="模型" min-width="160" />
    <ElTableColumn label="结果" width="100"
      ><template #default="{ row }"
        ><ElTag :type="row.ok ? 'success' : 'danger'">{{
          row.ok ? "成功" : "失败"
        }}</ElTag></template
      ></ElTableColumn
    >
    <ElTableColumn label="耗时" width="100"
      ><template #default="{ row }"
        >{{ row.durationMs ?? "—" }} ms</template
      ></ElTableColumn
    >
    <ElTableColumn prop="errorCode" label="错误分类" min-width="160" />
    <ElTableColumn label="重试／主备" min-width="180"
      ><template #default="{ row }"
        >{{ row.fallback ? "备用模型" : row.target || "—"
        }}{{ row.retryable ? " · 可重试" : ""
        }}{{ row.delayMs ? ` · 等待 ${row.delayMs} ms` : "" }}</template
      ></ElTableColumn
    >
  </ElTable>
</template>
