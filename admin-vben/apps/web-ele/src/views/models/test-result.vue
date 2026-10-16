<script setup lang="ts">
import { ElAlert, ElTag, ElCollapse, ElCollapseItem } from "element-plus";
defineProps<{ result: any; title?: string }>();
const stages: Record<string, string> = {
  credential: "账户凭据",
  structured: "结构化输出",
  tools: "工具调用",
  stream: "流式输出",
  embedding: "向量生成",
  request: "测试请求",
};
</script>
<template>
  <section v-if="result" class="my-4 space-y-3" aria-label="模型测试结果">
    <ElAlert
      :title="`${title || '模型测试'}：${result.ok ? '通过' : '失败'}`"
      :type="result.ok ? 'success' : 'error'"
      :closable="false"
      show-icon
    />
    <div
      v-for="item in result.deployments || [result]"
      :key="item.id || 'request'"
      class="space-y-2 rounded border p-3"
    >
      <div class="flex flex-wrap items-center gap-2">
        <ElTag :type="item.ok ? 'success' : 'danger'">{{
          item.ok ? "通过" : "失败"
        }}</ElTag>
        <span
          >{{ item.name || (item.id ? `部署 ${item.id}` : "测试请求")
          }}{{ item.model ? ` · ${item.model}` : "" }}</span
        >
        <span v-if="item.durationMs !== undefined" class="text-muted-foreground"
          >{{ item.durationMs }} ms</span
        >
      </div>
      <p>{{ item.message }}</p>
      <p v-if="item.stage && !item.ok">
        失败阶段：{{ stages[item.stage] || item.stage }}
      </p>
      <ElCollapse v-if="item.status || item.code || item.providerMessage"
        ><ElCollapseItem title="诊断详情" name="diagnostics">
          <p v-if="item.status || item.code" class="text-muted-foreground">
            {{ item.status ? `HTTP ${item.status} · ` : "" }}{{ item.code }}
          </p>
          <p v-if="item.providerCode">供应商错误码：{{ item.providerCode }}</p>
          <p
            v-if="item.providerMessage"
            class="whitespace-pre-wrap break-words"
          >
            供应商说明：{{ item.providerMessage }}
          </p>
        </ElCollapseItem></ElCollapse
      >
      <div v-if="item.checks?.length" class="flex flex-wrap gap-2">
        <ElTag
          v-for="check in item.checks"
          :key="check.stage"
          :type="check.ok ? 'success' : 'danger'"
          >{{ stages[check.stage] || check.stage }}：{{
            check.ok ? "通过" : "失败"
          }}</ElTag
        >
      </div>
    </div>
  </section>
</template>
