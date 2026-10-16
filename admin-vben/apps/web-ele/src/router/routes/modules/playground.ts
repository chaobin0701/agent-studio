import type { RouteRecordRaw } from "vue-router";
const routes: RouteRecordRaw[] = [
  {
    path: "/agent-playground",
    name: "AgentPlayground",
    component: () => import("#/views/playground/index.vue"),
    meta: {
      title: "Agent 试运行",
      icon: "lucide:play",
      order: 3,
      authority: ["agent_config.manage"],
    },
  },
];
export default routes;
