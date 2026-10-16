import type { RouteRecordRaw } from "vue-router";
const authority = ["integrations.read", "integrations.manage"];
const routes: RouteRecordRaw[] = [
  {
    path: "/integrations",
    name: "IntegrationList",
    component: () => import("#/views/integrations/index.vue"),
    meta: { title: "应用接入", icon: "lucide:plug", order: 3, authority },
  },
  {
    path: "/integrations/:id",
    name: "IntegrationDetail",
    component: () => import("#/views/integrations/index.vue"),
    meta: {
      title: "应用详情",
      hideInMenu: true,
      activePath: "/integrations",
      authority,
    },
  },
];
export default routes;
