import type { RouteRecordRaw } from "vue-router";
const routes: RouteRecordRaw[] = [{
  path: "/system-mcp",
  name: "SystemMcp",
  component: () => import("#/views/system-mcp/index.vue"),
  meta: { title: "系统 MCP", icon: "lucide:plug-zap", order: 7, authority: ["agent_config.read", "agent_config.manage"] },
}];
export default routes;
