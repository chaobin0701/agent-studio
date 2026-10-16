import type { RouteRecordRaw } from "vue-router";
const routes: RouteRecordRaw[] = [
  {
    path: "/mcp",
    name: "McpList",
    component: () => import("#/views/mcp/index.vue"),
    meta: {
      title: "MCP 管理",
      icon: "lucide:plug",
      order: 6,
      authority: ["agent_config.read", "agent_config.manage"],
    },
  },
  {
    path: "/mcp/:id",
    name: "McpDetail",
    component: () => import("#/views/mcp/index.vue"),
    meta: {
      title: "MCP 服务详情",
      hideInMenu: true,
      activePath: "/mcp",
      authority: ["agent_config.read", "agent_config.manage"],
    },
  },
];
export default routes;
