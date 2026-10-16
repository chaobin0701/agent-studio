import type { RouteRecordRaw } from "vue-router";

const routes: RouteRecordRaw[] = [
  {
    path: "/system/users",
    name: "SystemUsers",
    component: () => import("#/views/system/access.vue"),
    meta: {
      title: "用户管理",
      icon: "lucide:users",
      order: 10,
      authority: ["admins.manage"],
      managementKind: "users",
    },
  },
  {
    path: "/system/roles",
    name: "SystemRoles",
    component: () => import("#/views/system/access.vue"),
    meta: {
      title: "角色管理",
      icon: "lucide:shield-check",
      order: 11,
      authority: ["roles.manage"],
      managementKind: "roles",
    },
  },
];

export default routes;
