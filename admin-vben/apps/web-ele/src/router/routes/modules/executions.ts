import type { RouteRecordRaw } from "vue-router";
const routes: RouteRecordRaw[] = [
  {
    path: "/executions",
    name: "ExecutionList",
    component: () => import("#/views/executions/index.vue"),
    meta: {
      title: "运行记录",
      icon: "lucide:activity",
      order: 4,
      authority: ["conversations.read"],
    },
  },
  {
    path: "/executions/:id",
    name: "ExecutionDetail",
    component: () => import("#/views/executions/detail.vue"),
    meta: {
      title: "执行详情",
      hideInMenu: true,
      activePath: "/executions",
      authority: ["conversations.read"],
    },
  },
];
export default routes;
