import type { RouteRecordRaw } from "vue-router";
const routes: RouteRecordRaw[] = [
  {
    path: "/workspaces",
    name: "Workspaces",
    component: () => import("#/views/workspaces/index.vue"),
    meta: { title: "工作区管理", icon: "lucide:building-2", order: 1 },
  },
  {
    path: "/workspaces/:id",
    name: "WorkspaceDetail",
    component: () => import("#/views/workspaces/detail.vue"),
    meta: { title: "工作区设置", hideInMenu: true, activePath: "/workspaces" },
  },
];
export default routes;
