import type { RouteRecordRaw } from "vue-router";
const routes: RouteRecordRaw[] = [
  {
    path: "/models/llm",
    name: "LlmModels",
    component: () => import("#/views/models/index.vue"),
    meta: {
      title: "大语言模型",
      icon: "lucide:cpu",
      order: 6,
      authority: ["model_profiles.read", "model_profiles.manage"],
      modelKind: "llm",
    },
  },
  {
    path: "/models/embedding",
    name: "EmbeddingModels",
    component: () => import("#/views/models/index.vue"),
    meta: {
      title: "向量模型",
      icon: "lucide:binary",
      order: 7,
      authority: ["embedding_profiles.read", "embedding_profiles.manage"],
      modelKind: "embedding",
    },
  },
  ...(["llm", "embedding"] as const).map(
    (kind): RouteRecordRaw => ({
      path: `/models/${kind}/plans/:id`,
      name: `${kind}PlanDetail`,
      component: () => import("#/views/models/plan-detail.vue"),
      meta: {
        title: "模型方案详情",
        hideInMenu: true,
        activePath: `/models/${kind}`,
        modelKind: kind,
        authority: [
          `${kind === "llm" ? "model_profiles" : "embedding_profiles"}.read`,
          `${kind === "llm" ? "model_profiles" : "embedding_profiles"}.manage`,
        ],
      },
    }),
  ),
];
export default routes;
