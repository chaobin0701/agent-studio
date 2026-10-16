<script setup lang="ts">
import { computed, onActivated, onBeforeUnmount, ref, watch } from "vue";
import { useRouter } from "vue-router";
import { Page } from "@vben/common-ui";
import { useAccessStore } from "@vben/stores";
import {
  ElAlert,
  ElButton,
  ElEmpty,
  ElTable,
  ElTableColumn,
  ElTag,
} from "element-plus";
import { managementApi as api } from "#/api/management";
import ManagementHeader from "#/components/ManagementHeader.vue";
import PagePanel from "#/components/PagePanel.vue";
import { useWorkspaceStore } from "#/store/workspace";
const router = useRouter(),
  ws = useWorkspaceStore(),
  access = useAccessStore();
type Summary = {
  generatedAt: string;
  agents: null | {
    total: number;
    published: number;
    unpublished: number;
    changed: number;
    recent: any[];
  };
  executions: null | {
    total: number;
    completed: number;
    failed: number;
    recent: any[];
  };
  knowledge: null | {
    processing: number;
    failed: number;
    pendingIndex: number;
    documentFailures: any[];
    indexFailures: any[];
  };
};
const summary = ref<Summary>(),
  loading = ref(false),
  error = ref("");
const workspaceName = computed(
  () => ws.items.find((w) => w.id === ws.id)?.name ?? "工作区",
);
const can = (...codes: string[]) =>
  codes.some((c) => access.accessCodes.includes(c));
const entrances = computed(() =>
  [
    {
      label: "Agent",
      path: "/agents",
      codes: ["agent_config.read", "agent_config.manage"],
    },
    {
      label: "Prompt",
      path: "/prompts",
      codes: ["prompts.read", "prompts.manage"],
    },
    {
      label: "Skill",
      path: "/skills",
      codes: ["agent_config.read", "agent_config.manage"],
    },
    {
      label: "Tool",
      path: "/tools",
      codes: ["agent_config.read", "agent_config.manage"],
    },
    {
      label: "MCP",
      path: "/mcp",
      codes: ["agent_config.read", "agent_config.manage"],
    },
    {
      label: "知识库",
      path: "/knowledge-bases",
      codes: ["documents.read", "knowledge_bases.manage"],
    },
    {
      label: "大语言模型",
      path: "/models/llm",
      codes: ["model_profiles.read", "model_profiles.manage"],
    },
    {
      label: "向量模型",
      path: "/models/embedding",
      codes: ["embedding_profiles.read", "embedding_profiles.manage"],
    },
    {
      label: "应用接入",
      path: "/integrations",
      codes: ["integrations.read", "integrations.manage"],
    },
  ].filter((item) => can(...item.codes)),
);
const attention = computed(() => {
  const k = summary.value?.knowledge;
  if (!k) return [];
  return [
    ...k.documentFailures.map((d) => ({
      key: `doc:${d.id}`,
      name: d.title,
      baseId: d.baseId,
      baseName: d.baseName,
      type: "文档处理失败",
    })),
    ...k.indexFailures.map((i) => ({
      key: `index:${i.versionId}`,
      name: `索引版本 #${i.versionId}`,
      baseId: i.baseId,
      baseName: i.baseName,
      type: "索引构建失败",
    })),
  ];
});
let generation = 0;
async function load() {
  const request = ++generation,
    scope = ws.generation;
  summary.value = undefined;
  error.value = "";
  if (!ws.id) {
    loading.value = false;
    return;
  }
  loading.value = true;
  try {
    const result = await api.get<Summary>("/dashboard/management");
    if (request === generation && scope === ws.generation)
      summary.value = result;
  } catch {
    if (request === generation && scope === ws.generation)
      error.value = "概览加载失败，请刷新重试。";
  } finally {
    if (request === generation) loading.value = false;
  }
}
const date = (value: string) => new Date(value).toLocaleString();
watch(
  [() => ws.id, () => ws.generation, () => access.accessCodes.join("|")],
  load,
  { immediate: true },
);
onActivated(() => {
  if (summary.value || error.value) void load();
});
onBeforeUnmount(() => generation++);
</script>
<template>
  <Page>
    <ManagementHeader
      title="管理首页"
      :description="`当前工作区：${workspaceName}`"
    >
      <ElButton v-if="ws.id" :loading="loading" @click="load">刷新</ElButton>
      <ElButton
        v-if="can('agent_config.read', 'agent_config.manage')"
        type="primary"
        @click="router.push('/agents')"
        >管理 Agent</ElButton
      >
      <ElButton v-else @click="router.push('/workspaces')">工作区设置</ElButton>
    </ManagementHeader>
    <ElAlert
      v-if="error"
      :title="error"
      type="error"
      :closable="false"
      class="mb-4"
    />
    <PagePanel v-if="!ws.id"
      ><ElEmpty description="暂无可访问的工作区"
        ><ElButton @click="router.push('/workspaces')"
          >查看工作区</ElButton
        ></ElEmpty
      ></PagePanel
    >
    <div v-else v-loading="loading" class="space-y-4">
      <PagePanel>
        <h2 class="mb-3 text-base font-medium">常用入口</h2>
        <div class="flex flex-wrap gap-2">
          <ElButton
            v-for="item in entrances"
            :key="item.path"
            @click="router.push(item.path)"
            >{{ item.label }}</ElButton
          ><ElButton @click="router.push('/workspaces')">工作区设置</ElButton>
        </div>
      </PagePanel>
      <div v-if="summary" class="grid min-w-0 grid-cols-1 gap-4 xl:grid-cols-2">
        <PagePanel v-if="summary.agents">
          <div class="mb-4 flex flex-wrap items-center justify-between gap-2">
            <h2 class="text-base font-medium">最近编辑的 Agent</h2>
            <ElButton link type="primary" @click="router.push('/agents')"
              >查看全部</ElButton
            >
          </div>
          <p class="mb-3 text-sm text-muted-foreground">
            已生效 {{ summary.agents.published }} · 未发布
            {{ summary.agents.unpublished }} · 有待发布修改
            {{ summary.agents.changed }}
          </p>
          <ElTable :data="summary.agents.recent" row-key="id"
            ><ElTableColumn label="Agent" min-width="170"
              ><template #default="{ row }"
                ><ElButton
                  link
                  type="primary"
                  @click="router.push(`/agents/${row.id}`)"
                  >{{ row.name }}</ElButton
                ></template
              ></ElTableColumn
            ><ElTableColumn label="状态" min-width="150"
              ><template #default="{ row }"
                ><ElTag
                  :type="
                    !row.published
                      ? 'info'
                      : row.changed
                        ? 'warning'
                        : 'success'
                  "
                  >{{
                    !row.published
                      ? "尚未发布"
                      : row.changed
                        ? "有未发布修改"
                        : "已生效"
                  }}</ElTag
                ></template
              ></ElTableColumn
            ><ElTableColumn label="最近更新" min-width="170"
              ><template #default="{ row }">{{
                date(row.updatedAt)
              }}</template></ElTableColumn
            ></ElTable
          >
        </PagePanel>
        <PagePanel v-if="summary.executions">
          <div class="mb-4 flex flex-wrap items-center justify-between gap-2">
            <h2 class="text-base font-medium">近期执行</h2>
            <ElButton link type="primary" @click="router.push('/executions')"
              >查看全部</ElButton
            >
          </div>
          <p class="mb-3 text-sm text-muted-foreground">
            最近 24 小时 {{ summary.executions.total }} 次 · 失败
            <ElButton
              link
              :type="summary.executions.failed ? 'danger' : 'primary'"
              @click="
                router.push({
                  path: '/executions',
                  query: { status: 'failed' },
                })
              "
              >{{ summary.executions.failed }}</ElButton
            >
            次
          </p>
          <ElTable :data="summary.executions.recent" row-key="id"
            ><ElTableColumn label="任务" min-width="170"
              ><template #default="{ row }"
                ><ElButton
                  link
                  type="primary"
                  @click="router.push(`/executions/${row.id}`)"
                  >{{ row.agentName || `执行 ${row.id.slice(0, 8)}` }}</ElButton
                ></template
              ></ElTableColumn
            ><ElTableColumn label="结果" min-width="130"
              ><template #default="{ row }"
                ><ElTag
                  :type="row.status === 'failed' ? 'danger' : 'success'"
                  >{{ row.status === "failed" ? "失败" : "已完成" }}</ElTag
                >
                <p
                  v-if="row.errorCode"
                  class="mt-1 text-xs text-muted-foreground"
                >
                  {{ row.errorCode }}
                </p></template
              ></ElTableColumn
            ><ElTableColumn label="时间" min-width="170"
              ><template #default="{ row }">{{
                date(row.createdAt)
              }}</template></ElTableColumn
            ></ElTable
          >
        </PagePanel>
      </div>
      <PagePanel v-if="summary?.knowledge">
        <div class="mb-4 flex flex-wrap items-center justify-between gap-2">
          <h2 class="text-base font-medium">知识库处理</h2>
          <ElButton link type="primary" @click="router.push('/knowledge-bases')"
            >管理文档</ElButton
          >
        </div>
        <p class="mb-3 text-sm text-muted-foreground">
          处理中 {{ summary.knowledge.processing }} · 待更新索引
          {{ summary.knowledge.pendingIndex }} · 处理失败
          {{ summary.knowledge.failed }}
        </p>
        <ElTable v-if="attention.length" :data="attention" row-key="key"
          ><ElTableColumn
            prop="name"
            label="待处理事项"
            min-width="220"
            show-overflow-tooltip
          /><ElTableColumn
            prop="type"
            label="状态"
            min-width="150"
          /><ElTableColumn label="知识库" min-width="170"
            ><template #default="{ row }"
              ><ElButton
                link
                type="primary"
                @click="router.push(`/knowledge-bases/${row.baseId}`)"
                >{{ row.baseName }}</ElButton
              ></template
            ></ElTableColumn
          ></ElTable
        >
        <p v-else class="text-sm text-muted-foreground">暂无处理失败事项。</p>
      </PagePanel>
      <p v-if="summary" class="text-right text-xs text-muted-foreground">
        更新于 {{ date(summary.generatedAt) }}
      </p>
    </div>
  </Page>
</template>
