import type { RouteRecordRaw } from "vue-router";
const routes: RouteRecordRaw[] = [
  {
    path: "/prompts",
    name: "Prompts",
    component: () => import("#/views/prompts/index.vue"),
    meta: {
      title: "Prompt 管理",
      icon: "lucide:file-text",
      order: 3,
      authority: ["prompts.read", "prompts.manage"],
    },
  },
  {
    path: "/prompts/:id",
    name: "PromptDetail",
    component: () => import("#/views/prompts/index.vue"),
    meta: {
      title: "Prompt 详情",
      hideInMenu: true,
      activePath: "/prompts",
      authority: ["prompts.read", "prompts.manage"],
    },
  },
];
export default routes;
